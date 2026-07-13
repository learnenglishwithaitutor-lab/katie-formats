#!/usr/bin/env python3
"""
omni-generate pipeline: submit baked base-video clips to the katie-formats
Vercel app's /api/omni endpoint (Gemini Omni via kie.ai), poll each to
completion, and stitch multiple results into one final video.

Pure pass-through — no prompt writing, no first-frame swap. Each clip is
already a baked base video (prompt burned into the frame). Submission body
is just { action: 'generate', baseVideo: <base64 mp4> }.

Usage:
    python3 run_pipeline.py --clips a.mp4 b.mp4 c.mp4 --output final.mp4
"""
import argparse
import base64
import json
import os
import sys
import time
import urllib.request
import urllib.error

BASE_URL = "https://katie-formats-app.vercel.app/api/omni"
# The Vercel function has a hard 4.5MB request-body cap (FUNCTION_PAYLOAD_TOO_LARGE).
# base64 inflates bytes ~33%, so a clip must stay under ~3.3MB raw to fit in one
# request. submit_clip re-encodes any clip over this target before sending. Rule 0
# trimming shrinks clips but is NOT a body-cap guard (a re-encode can even grow a
# file), so this stays as the dedicated size safety net.
RAW_TARGET   = 3_200_000   # aim the re-encode here (×1.34 ≈ 4.29MB encoded)
MAX_B64_BODY = 4_300_000   # keep the encoded body safely under Vercel's 4.5MB
POLL_INTERVAL = 6          # seconds between polls
POLL_TIMEOUT = 600         # give up on a single clip after this long
SUBMIT_RETRIES = 2         # total attempts per clip (1 original + 1 retry)

# Rule 0 (base-length == schedule): a base video longer than the scene's
# schedule is the #1 babble cause — when conditioning slips, Omni recites the
# base clip's ORIGINAL speech. We trim a per-scene copy of the base to its
# schedule end before submitting. Precise trim lengths come from --base-trims
# (emitted by omni-skill-20's scene map); absent that, we approximate the last
# beat as duration - BASE_TRIM_FALLBACK_PAD.
BASE_TRIM_FALLBACK_PAD = 0.5   # seconds subtracted from #duration when no --base-trims given


def _post(payload, timeout=60):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        BASE_URL, data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def _post_binary(payload, timeout=120):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        BASE_URL, data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def _get_status(task_id, timeout=30):
    url = f"{BASE_URL}?action=status&taskId={task_id}"
    req = urllib.request.Request(url, method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def trim_base_to_schedule(base_path, trim_len):
    """Return a path to a copy of base_path trimmed to trim_len seconds (Rule 0).
    If trim_len is None, >= the source duration, or invalid, returns base_path
    unchanged. Stream-copies when possible (fast, lossless); the container is
    the same mp4 the pipeline already base64-encodes downstream."""
    import subprocess, tempfile, os
    if not trim_len or trim_len <= 0:
        return base_path
    try:
        src_dur = float(subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", base_path],
            capture_output=True, text=True).stdout.strip())
    except Exception:
        src_dur = None
    if src_dur is not None and trim_len >= src_dur - 0.1:
        # base already at or under the schedule — nothing to trim
        return base_path
    out = tempfile.mktemp(suffix=".mp4")
    # re-encode (not stream-copy) so the cut lands on an exact frame, not the
    # nearest keyframe — a keyframe-rounded base can still carry extra audio.
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", base_path, "-t", f"{trim_len:.2f}",
         "-c:v", "libx264", "-preset", "fast", "-crf", "18",
         "-c:a", "aac", "-b:a", "192k", out],
        check=True)
    print(f"  base trim: {os.path.basename(base_path)} -> {trim_len:.2f}s "
          f"(src {src_dur:.1f}s)" if src_dur else
          f"  base trim: {os.path.basename(base_path)} -> {trim_len:.2f}s")
    return out


def _run(cmd):
    import subprocess
    return subprocess.run(cmd, stdout=subprocess.DEVNULL,
                          stderr=subprocess.DEVNULL).returncode == 0


def compress_under_cap(path):
    """Return a path to a version of the clip whose raw bytes are under RAW_TARGET
    (so its base64 body stays under Vercel's 4.5MB cap). If the clip is already
    small enough, returns it unchanged. Re-encodes with H.264 at progressively
    lower quality until it fits; keeps audio intact for the voice reference.
    Uses ffmpeg (already required by the pipeline); no token, no upload host."""
    import subprocess, tempfile
    size = os.path.getsize(path)
    if size <= RAW_TARGET:
        return path  # already fits — submit as-is, no quality loss

    # Probe duration so we can target a bitrate that lands under RAW_TARGET.
    try:
        dur = float(subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", path],
            capture_output=True, text=True).stdout.strip() or 0)
    except Exception:
        dur = 0

    tmp = tempfile.NamedTemporaryFile(suffix=".mp4", delete=False).name
    # Try a few CRF/scale steps, each smaller, until one lands under the target.
    attempts = [
        ["-vf", "scale='min(720,iw)':-2", "-c:v", "libx264", "-crf", "26", "-preset", "veryfast", "-c:a", "aac", "-b:a", "96k"],
        ["-vf", "scale='min(640,iw)':-2", "-c:v", "libx264", "-crf", "28", "-preset", "veryfast", "-c:a", "aac", "-b:a", "80k"],
        ["-vf", "scale='min(540,iw)':-2", "-c:v", "libx264", "-crf", "30", "-preset", "veryfast", "-c:a", "aac", "-b:a", "64k"],
    ]
    # If we know duration, also try an explicit total-size cap as a last resort.
    for a in attempts:
        ok = _run(["ffmpeg", "-y", "-i", path, *a, "-movflags", "+faststart", tmp])
        if ok and os.path.getsize(tmp) <= RAW_TARGET:
            return tmp
    if dur > 0:
        # Bitrate math: target bits / duration, minus a little for audio.
        vbit = max(200_000, int((RAW_TARGET * 8 / dur) - 90_000))
        ok = _run(["ffmpeg", "-y", "-i", path, "-vf", "scale='min(540,iw)':-2",
                   "-c:v", "libx264", "-b:v", str(vbit), "-maxrate", str(int(vbit*1.2)),
                   "-bufsize", str(vbit), "-preset", "veryfast",
                   "-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart", tmp])
        if ok and os.path.getsize(tmp) <= RAW_TARGET:
            return tmp
    # Couldn't get under the cap — return whatever we produced (smallest) or original.
    if os.path.exists(tmp) and 0 < os.path.getsize(tmp) < size:
        return tmp
    return path



def submit_clip(path, prompt=None, duration=None):
    """POST action=generate with the clip's base64 bytes. Returns taskId.
    prompt=None -> baked-clip mode (backend submits its default 'Read').
    prompt=str  -> instruction-box mode: the text IS the Omni instruction,
    sent alongside the clean base video.
    duration    -> requested output length in seconds (3-10, backend clamps;
    omitted = 10). Size clips to speech+~1s so there are no blank seconds
    for Omni to fill with bleed or babble."""
    send_path = compress_under_cap(path)
    if send_path != path:
        print(f"  compressed {os.path.basename(path)}: "
              f"{os.path.getsize(path)/1e6:.2f}MB -> {os.path.getsize(send_path)/1e6:.2f}MB",
              file=sys.stderr)
    with open(send_path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode()
    if len(b64) > MAX_B64_BODY:
        raise RuntimeError(
            f"{os.path.basename(path)} is still {len(b64)/1e6:.1f}MB after compression "
            f"(> {MAX_B64_BODY/1e6:.1f}MB cap) — clip is unusually long, split it further.")
    payload = {"action": "generate", "baseVideo": b64}
    if prompt is not None:
        payload["prompt"] = prompt
    if duration is not None:
        payload["duration"] = int(duration)
    last_err = None
    for attempt in range(1, SUBMIT_RETRIES + 1):
        try:
            resp = _post(payload)
            if resp.get("taskId"):
                return resp["taskId"]
            last_err = resp.get("error", "no taskId in response")
        except urllib.error.HTTPError as e:
            body = e.read().decode(errors="replace")
            last_err = f"HTTP {e.code}: {body}"
        except Exception as e:
            last_err = str(e)
        if attempt < SUBMIT_RETRIES:
            print(f"  submit attempt {attempt} failed ({last_err}), retrying...", file=sys.stderr)
            time.sleep(2)
    raise RuntimeError(f"submit failed after {SUBMIT_RETRIES} attempts: {last_err}")


def poll_clip(task_id):
    """Poll action=status until success/fail. Returns (status, videoUrl_or_None, failMsg_or_None)."""
    start = time.time()
    while time.time() - start < POLL_TIMEOUT:
        try:
            resp = _get_status(task_id)
        except Exception as e:
            print(f"  poll error ({e}), retrying...", file=sys.stderr)
            time.sleep(POLL_INTERVAL)
            continue
        status = resp.get("status")
        if status == "success":
            return "success", resp.get("videoUrl"), None
        if status == "fail":
            return "fail", None, resp.get("failMsg", "unknown failure")
        time.sleep(POLL_INTERVAL)
    return "fail", None, f"timed out after {POLL_TIMEOUT}s"


# ---------- script QA (optional, enabled by --scripts) ----------

_FILLERS = {"um", "uh", "uhm", "hmm", "mhm"}
QA_SIM_THRESHOLD = 0.85    # below this = mismatch
_whisper_model = None


def _normalize_words(text):
    import re as _re
    words = _re.sub(r"[^a-z0-9' ]+", " ", text.lower()).split()
    return [w for w in words if w not in _FILLERS]


def transcribe_video(path):
    """Extract audio and transcribe with faster-whisper small.en.
    Returns (text, words) where words = [(start, end), ...]."""
    global _whisper_model
    import subprocess, tempfile, os
    from faster_whisper import WhisperModel
    if _whisper_model is None:
        _whisper_model = WhisperModel("small.en", device="cpu", compute_type="int8")
    wav = tempfile.mktemp(suffix=".wav")
    try:
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-i", path, "-ac", "1", "-ar", "16000", wav],
            check=True,
        )
        segments, _ = _whisper_model.transcribe(wav, word_timestamps=True)
        text_parts, words = [], []
        for s in segments:
            text_parts.append(s.text.strip())
            for w in (s.words or []):
                words.append((w.start, w.end))
        return " ".join(text_parts), words
    finally:
        if os.path.exists(wav):
            os.remove(wav)


OVERLAY_FRAME_FRACTION = 0.15   # >15% of sampled frames with real text = flag
MUSIC_RMS_RATIO = 0.25          # non-speech energy > 25% of speech energy = flag
MUSIC_MIN_SECONDS = 1.0         # ...sustained over at least this long


def overlay_check(video_path):
    """OCR 1fps frames; flag burned-in text (Omni sometimes reproduces the baked
    prompt overlay into the output). Returns (ok, sample_text_or_None).
    Skips gracefully (returns (True, None)) if tesseract/pytesseract missing."""
    import subprocess, tempfile, os, glob, shutil
    try:
        import pytesseract
        from PIL import Image
        if not shutil.which("tesseract"):
            raise ImportError("tesseract binary not found")
    except ImportError as e:
        print(f"  overlay check skipped ({e})", file=sys.stderr)
        return True, None
    d = tempfile.mkdtemp()
    try:
        subprocess.run(
            ["ffmpeg", "-v", "error", "-i", video_path, "-vf", "fps=1", f"{d}/f_%03d.png"],
            check=True,
        )
        frames = sorted(glob.glob(f"{d}/f_*.png"))
        if not frames:
            return True, None
        texty, sample = 0, None
        for f in frames:
            txt = pytesseract.image_to_string(Image.open(f)).strip()
            words = [w for w in txt.split() if len(w) >= 3 and any(c.isalpha() for c in w)]
            if len(words) >= 3:
                texty += 1
                if sample is None:
                    sample = " ".join(words)[:80]
        ok = (texty / len(frames)) <= OVERLAY_FRAME_FRACTION
        return ok, (None if ok else sample)
    finally:
        shutil.rmtree(d, ignore_errors=True)


def music_check(video_path, words):
    """Detect background audio (music) via energy in non-speech gaps.
    Returns (ok, worst_ratio). Uses the word timestamps from transcription."""
    import subprocess, tempfile, os
    import numpy as np
    wav = tempfile.mktemp(suffix=".wav")
    try:
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-i", video_path, "-ac", "1", "-ar", "16000", wav],
            check=True,
        )
        import wave as wavmod
        w = wavmod.open(wav)
        sr = w.getframerate()
        audio = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768
        w.close()
        mask = np.zeros(len(audio), dtype=bool)
        for s, e in words:
            mask[int(s * sr):int(e * sr)] = True
        speech = audio[mask]
        if len(speech) < sr * 0.5:      # nothing spoken — can't baseline; skip
            return True, 0.0
        speech_rms = float(np.sqrt(np.mean(speech ** 2)))
        if speech_rms == 0:
            return True, 0.0
        worst, run = 0.0, 0
        n_sec = int(len(audio) / sr)
        for sec in range(n_sec):
            seg = audio[sec * sr:(sec + 1) * sr]
            m = mask[sec * sr:(sec + 1) * sr]
            gap = seg[~m]
            if len(gap) < sr * 0.5:     # mostly speech this second
                run = 0
                continue
            ratio = float(np.sqrt(np.mean(gap ** 2))) / speech_rms
            if ratio > MUSIC_RMS_RATIO:
                run += 1
                worst = max(worst, ratio)
                if run >= MUSIC_MIN_SECONDS:
                    return False, worst
            else:
                run = 0
        return True, worst
    finally:
        if os.path.exists(wav):
            os.remove(wav)


def qa_clip(video_url, intended, tmp_path):
    """Download + all checks. Returns dict with per-check results, fail count,
    the word timestamps, and the kept local file (tmp_path) for later trim+stitch."""
    download(video_url, tmp_path)
    got, words = transcribe_video(tmp_path)
    script_ok, sim, diff = script_check(intended, got)
    ovl_ok, ovl_sample = overlay_check(tmp_path)
    mus_ok, mus_ratio = music_check(tmp_path, words)
    fails = []
    if not script_ok:
        fails.append("script")
    if not ovl_ok:
        fails.append("overlay")
    if not mus_ok:
        fails.append("music")
    return {
        "fails": fails, "sim": sim, "diff": diff,
        "overlay_sample": ovl_sample, "music_ratio": mus_ratio,
        "words": words, "local": tmp_path,
    }


TRIM_TAIL_PAD = 0.5  # seconds kept after the last spoken word


def trim_and_stitch(local_paths, words_per_clip, output_path):
    """Trim each clip to last-spoken-word + TRIM_TAIL_PAD, then stitch locally
    with ffmpeg. Kills silent/babble tails and base-audio bleed — a sparse clip
    is simply SHORT, not half-empty. Clips are re-encoded uniformly so concat
    is safe."""
    import subprocess, tempfile, os
    parts = []
    for p, words in zip(local_paths, words_per_clip):
        dur = float(subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", p],
            capture_output=True, text=True).stdout.strip())
        end = (max(e for _, e in words) + TRIM_TAIL_PAD) if words else None
        out = tempfile.mktemp(suffix=".mp4")
        cmd = ["ffmpeg", "-v", "error", "-y", "-i", p]
        if end is not None and end < dur - 0.1:
            cmd += ["-t", f"{end:.2f}"]
            print(f"  trim: {os.path.basename(p)} {dur:.1f}s -> {end:.1f}s")
        cmd += ["-c:v", "libx264", "-preset", "fast", "-crf", "18",
                "-c:a", "aac", "-b:a", "192k", out]
        subprocess.run(cmd, check=True)
        parts.append(out)
    if len(parts) == 1:
        os.replace(parts[0], output_path)
        return
    lst = tempfile.mktemp(suffix=".txt")
    with open(lst, "w") as f:
        for pp in parts:
            f.write(f"file '{pp}'\n")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0",
                    "-i", lst, "-c", "copy", output_path], check=True)


def _suffix_equal(w1, w2):
    """Tolerate transcription quirks only: plural/possessive suffix differences
    (sibling/siblings, kid/kids, katie/katie's). NOT general edit distance —
    piblings/siblings differ by one letter too, but at the START, and that's a
    real content error that must be flagged."""
    if w1 == w2:
        return True
    for suf in ("'s", "es", "s"):
        if w1.endswith(suf) and w1[: -len(suf)] == w2:
            return True
        if w2.endswith(suf) and w2[: -len(suf)] == w1:
            return True
    return False


def script_check(intended, got_text):
    """Compare normalized word sequences. ANY content-word insert/delete/replace
    is a failure (short scripts make one wrong word ~10% of the content while
    barely denting similarity — 4 of 5 real errors passed a 0.85 threshold).
    Similarity is returned as a reporting metric only, not the pass criterion.
    Returns (ok, similarity, diff_lines)."""
    import difflib
    a, b = _normalize_words(intended), _normalize_words(got_text)
    sm = difflib.SequenceMatcher(a=a, b=b)
    sim = sm.ratio()
    diff_lines = []
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        if op == "equal":
            continue
        if op == "replace" and (i2 - i1) == (j2 - j1):
            if all(_suffix_equal(x, y) for x, y in zip(a[i1:i2], b[j1:j2])):
                continue  # transcription quirk, not a content error
        diff_lines.append(f"    {op}: intended {a[i1:i2]!r} / got {b[j1:j2]!r}")
    return not diff_lines, sim, diff_lines


def stitch(clip_urls, output_path):
    body = _post_binary({"action": "stitch", "clips": clip_urls})
    with open(output_path, "wb") as f:
        f.write(body)


def download(url, output_path):
    req = urllib.request.Request(url, method="GET")
    with urllib.request.urlopen(req, timeout=120) as r:
        with open(output_path, "wb") as f:
            f.write(r.read())


def _script_from_prompt(block):
    """Best-effort extraction of the spoken script from an omni-skill-20 prompt
    block: the quoted dialogue lines. Returns the concatenated quoted text, or
    "" if no quotes found. Used only for the completeness check, which is
    word-presence based and tolerant of extraction noise."""
    import re as _re
    quotes = _re.findall(r'"([^"]*)"', block)
    return " ".join(q.strip() for q in quotes if q.strip())


COMPLETENESS_MIN_COVERAGE = 0.5   # a scene whose intended content-words appear
                                  # in the final at < this fraction = "missing"


def completeness_check(output_path, intended_per_scene):
    """Problem 1 (missing scenes): transcribe the FINAL stitched video and verify
    each scene's script actually landed in it. A whole clip can silently fail to
    generate/QA and the stitch ships without it — this catches that.

    intended_per_scene: list of intended script strings, one per scene (order
    matches the submitted scenes). Scenes with empty intended text are skipped.
    Returns (ok, report_lines). Word-presence based (not positional) so it's
    robust to stitch order and minor transcription noise."""
    scenes = [(i, s) for i, s in enumerate(intended_per_scene) if s and s.strip()]
    if not scenes:
        return True, []
    try:
        got_text, _ = transcribe_video(output_path)
    except Exception as e:
        return True, [f"  completeness check skipped (transcription error: {e})"]
    got = set(_normalize_words(got_text))
    report, missing = [], []
    for idx, intended in scenes:
        want = _normalize_words(intended)
        # content words only: drop the tiny function words that appear everywhere
        content = [w for w in want if len(w) > 2]
        if not content:
            content = want
        if not content:
            continue
        present = sum(1 for w in content if w in got)
        cov = present / len(content)
        if cov < COMPLETENESS_MIN_COVERAGE:
            missing.append(idx + 1)
            report.append(
                f"  scene {idx+1}: only {present}/{len(content)} script words present "
                f"({cov:.0%}) — likely DROPPED from the stitch")
    if missing:
        header = [f"⚠ COMPLETENESS: {len(missing)} scene(s) appear missing from the final "
                  f"video: {missing}"]
        return False, header + report
    return True, [f"  completeness OK — all {len(scenes)} scene(s) present in the final video"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clips", nargs="+", default=None,
                    help="BAKED mode: ordered list of baked base-video clip paths (prompt burned into frame)")
    ap.add_argument("--base", default=None,
                    help="INSTRUCTION-BOX mode: the single clean base video (e.g. from sarah-overlay's return_base.py)")
    ap.add_argument("--prompts-file", default=None,
                    help="INSTRUCTION-BOX mode: the ---separated Omni prompts .txt from omni-skill-20; one generation per prompt, each submitted as the instruction text alongside --base")
    ap.add_argument("--durations", nargs="+", type=int, default=None,
                    help="optional requested output length (seconds, 3-10) per clip/prompt, same order; overrides #duration lines in --prompts-file")
    ap.add_argument("--base-trims", nargs="+", type=float, default=None,
                    help="INSTRUCTION-BOX mode (Rule 0): per-scene base-video trim length in seconds "
                         "(= each scene's last beat end, from omni-skill-20's scene map), same order as prompts. "
                         "Each scene's base is trimmed to this length before submit to prevent base-audio leakage. "
                         "If omitted, the base is trimmed to (#duration - 0.5s) as an approximation.")
    ap.add_argument("--no-base-trim", action="store_true",
                    help="disable Rule 0 base trimming entirely (submit the full base for every scene). "
                         "Not recommended — full-length bases are the main babble cause.")
    ap.add_argument("--output", required=True, help="path to write the final video")
    ap.add_argument("--scripts", nargs="+", default=None,
                    help="optional: intended spoken script per clip (same order/count as --clips). "
                         "Enables transcript QA: mismatched clips are regenerated ONCE; "
                         "still-failing clips are delivered but flagged with a word diff.")
    args = ap.parse_args()

    prompts = None
    if args.base or args.prompts_file:
        if not (args.base and args.prompts_file):
            ap.error("instruction-box mode needs BOTH --base and --prompts-file")
        if args.clips:
            ap.error("use either --clips (baked mode) or --base/--prompts-file (instruction-box mode), not both")
        raw = open(args.prompts_file).read()
        blocks = [c.strip() for c in raw.split("\n---\n") if c.strip()]
        if not blocks:
            ap.error(f"no prompts found in {args.prompts_file} (expected ---separated blocks)")
        prompts, file_durations = [], []
        import re as _re
        for b in blocks:
            m = _re.match(r"^#\s*duration:\s*(\d+)\s*\n", b)
            if m:
                file_durations.append(int(m.group(1)))
                prompts.append(b[m.end():].strip())
            else:
                file_durations.append(None)
                prompts.append(b)
        if args.durations is None and any(d is not None for d in file_durations):
            args.durations = file_durations
        args.clips = [args.base] * len(prompts)
        print(f"Instruction-box mode: {len(prompts)} prompt(s) x base video {args.base}"
              + (f" | durations {args.durations}" if args.durations else ""))
    elif not args.clips:
        ap.error("provide --clips (baked mode) or --base + --prompts-file (instruction-box mode)")

    if args.scripts and len(args.scripts) != len(args.clips):
        ap.error(f"--scripts count ({len(args.scripts)}) must match clip/prompt count ({len(args.clips)})")
    if args.durations and len(args.durations) != len(args.clips):
        ap.error(f"--durations count ({len(args.durations)}) must match clip/prompt count ({len(args.clips)})")
    if args.base_trims:
        if not prompts:
            ap.error("--base-trims only applies in instruction-box mode (--base + --prompts-file)")
        if len(args.base_trims) != len(args.clips):
            ap.error(f"--base-trims count ({len(args.base_trims)}) must match prompt count ({len(args.clips)})")

    # ---- Rule 0: compute the per-scene base trim length ----
    # explicit --base-trims wins; else approximate from the requested duration.
    # baked --clips mode has per-clip files already, so trimming is a no-op there.
    base_trims = [None] * len(args.clips)
    if prompts and not args.no_base_trim:
        for i in range(len(args.clips)):
            if args.base_trims:
                base_trims[i] = args.base_trims[i]
            elif args.durations and args.durations[i]:
                base_trims[i] = max(1.0, args.durations[i] - BASE_TRIM_FALLBACK_PAD)
            # else: leave None -> submit full base (no duration to key off)
        if any(t is None for t in base_trims):
            print("  note: some scenes have no duration/trim length — those bases submitted full "
                  "(babble risk; pass --durations or --base-trims).", file=sys.stderr)

    clips = args.clips
    n = len(clips)

    # ---- Rule 0: trim each scene's base to its schedule end before submit ----
    # submit_paths[i] is what actually gets uploaded for scene i (trimmed copy in
    # instruction-box mode; the original clip in baked mode). Kept for the QA
    # retry so the resubmit uses the same trimmed base, not the full one.
    submit_paths = list(clips)
    if prompts and not args.no_base_trim and any(base_trims):
        print("Applying Rule 0 base trims...")
        for i in range(n):
            try:
                submit_paths[i] = trim_base_to_schedule(clips[i], base_trims[i])
            except Exception as e:
                print(f"  [{i+1}/{n}] base trim failed ({e}) — submitting full base", file=sys.stderr)
                submit_paths[i] = clips[i]

    print(f"Submitting {n} clip(s)...")

    task_ids = [None] * n
    submit_errors = [None] * n
    for i, path in enumerate(submit_paths):
        try:
            task_ids[i] = submit_clip(path, prompts[i] if prompts else None, args.durations[i] if args.durations else None)
            print(f"  [{i+1}/{n}] {path} -> taskId {task_ids[i]}")
        except Exception as e:
            submit_errors[i] = str(e)
            print(f"  [{i+1}/{n}] {path} -> SUBMIT FAILED: {e}")

    print("Polling for completion...")
    results = [None] * n  # (status, videoUrl, failMsg)
    for i, tid in enumerate(task_ids):
        if tid is None:
            results[i] = ("fail", None, submit_errors[i])
            continue
        status, video_url, fail_msg = poll_clip(tid)
        results[i] = (status, video_url, fail_msg)
        label = clips[i]
        if status == "success":
            print(f"  [{i+1}/{n}] {label} -> success ({video_url})")
        else:
            print(f"  [{i+1}/{n}] {label} -> FAILED: {fail_msg}")

    # ---- QA pass: script + overlay + music (only when --scripts given) ----
    qa_flags = [None] * n   # None = not checked / ok; str = flag report
    qa_locals = [None] * n  # downloaded clip files (kept for local trim+stitch)
    qa_words = [None] * n   # word timestamps per clip (for tail trim)
    if args.scripts:
        import tempfile
        print("\nQA (script / overlay / music) on generated clips...")

        def _describe(q):
            parts = []
            if "script" in q["fails"]:
                parts.append(f"script mismatch (similarity {q['sim']:.2f})")
            if "overlay" in q["fails"]:
                parts.append(f"burned text overlay (e.g. {q['overlay_sample']!r})")
            if "music" in q["fails"]:
                parts.append(f"background audio in gaps ({q['music_ratio']:.2f}x speech level)")
            return "; ".join(parts)

        for i, r in enumerate(results):
            if r[0] != "success":
                continue
            intended = args.scripts[i]
            tmp = tempfile.mktemp(suffix=".mp4")
            try:
                q = qa_clip(r[1], intended, tmp)
            except Exception as e:
                print(f"  [{i+1}/{n}] QA skipped (error: {e})", file=sys.stderr)
                continue
            qa_locals[i], qa_words[i] = q["local"], q["words"]
            if not q["fails"]:
                print(f"  [{i+1}/{n}] all checks OK (similarity {q['sim']:.2f})")
                continue
            # any failed check -> regenerate this clip ONCE
            print(f"  [{i+1}/{n}] FAILED: {_describe(q)} — retrying once...")
            for line in q["diff"]:
                print(line)
            try:
                tid2 = submit_clip(submit_paths[i], prompts[i] if prompts else None, args.durations[i] if args.durations else None)
                status2, url2, fail2 = poll_clip(tid2)
            except Exception as e:
                status2, url2, fail2 = "fail", None, str(e)
            if status2 == "success":
                try:
                    q2 = qa_clip(url2, intended, tmp)
                except Exception:
                    q2 = None
                if q2 is not None and len(q2["fails"]) < len(q["fails"]) or (
                    q2 is not None and len(q2["fails"]) == len(q["fails"]) and q2["sim"] > q["sim"]
                ):
                    results[i] = ("success", url2, None)
                    q = q2
                    qa_locals[i], qa_words[i] = q["local"], q["words"]
                    print(f"  [{i+1}/{n}] retry {'PASSED' if not q['fails'] else 'better: ' + _describe(q)}")
            else:
                print(f"  [{i+1}/{n}] retry generation failed ({fail2}) — keeping first result")
            if q["fails"]:
                # never retry twice: two failures = prompt/pipeline problem, not dice. Deliver + flag.
                qa_flags[i] = "\n".join(
                    [f"clip {i+1} ({clips[i]}): {_describe(q)} — after 1 retry"] + q["diff"]
                )

    succeeded = [(i, r) for i, r in enumerate(results) if r[0] == "success"]
    failed = [(i, r) for i, r in enumerate(results) if r[0] != "success"]

    if failed:
        print(f"\n{len(failed)} of {n} clip(s) failed:")
        for i, r in failed:
            print(f"  - {clips[i]}: {r[2]}")

    if not succeeded:
        print("\nNo clips succeeded. Nothing to output.", file=sys.stderr)
        sys.exit(1)

    have_locals = bool(args.scripts) and all(qa_locals[i] is not None for i, _ in succeeded)
    if have_locals:
        ordered = [i for i, _ in succeeded]
        print(f"\nTrimming tails + stitching {len(ordered)} clip(s) locally -> {args.output}")
        trim_and_stitch([qa_locals[i] for i in ordered],
                        [qa_words[i] for i in ordered], args.output)
    elif len(succeeded) == 1:
        idx, (status, video_url, _) = succeeded[0]
        print(f"\nSingle successful clip — downloading directly to {args.output}")
        download(video_url, args.output)
    else:
        urls_in_order = [r[1] for r in results if r[0] == "success"]
        print(f"\nStitching {len(urls_in_order)} clip(s) remotely -> {args.output}")
        stitch(urls_in_order, args.output)

    print(f"\nDone. Output: {args.output}")
    if failed:
        print(f"({len(failed)} clip(s) were excluded due to failure — see above)")
    flags = [f for f in qa_flags if f]
    if flags:
        print(f"\n⚠ SCRIPT QA FLAGS ({len(flags)}) — delivered anyway; fix the prompt if not acceptable:")
        for f in flags:
            print("  " + f.replace("\n", "\n  "))

    # ---- Problem 1: verify every scene actually made it into the stitch ----
    # Prefer explicit --scripts; else fall back to the quoted dialogue in each
    # prompt block. Skip silently if neither is available.
    intended_per_scene = None
    if args.scripts:
        intended_per_scene = list(args.scripts)
    elif prompts:
        intended_per_scene = [_script_from_prompt(p) for p in prompts]
    if intended_per_scene and any(s and s.strip() for s in intended_per_scene):
        ok, report = completeness_check(args.output, intended_per_scene)
        print()
        for line in report:
            print(line)
        if not ok:
            print("  → a dropped scene usually means that clip failed to generate or was "
                  "QA-rejected without a successful retry; check the per-clip logs above "
                  "and regenerate the missing scene(s) before publishing.")
            # non-zero exit so batch callers/Cowork can detect the incomplete render
            sys.exit(2)


if __name__ == "__main__":
    main()
