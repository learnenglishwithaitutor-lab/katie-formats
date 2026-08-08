#!/usr/bin/env python3
"""Katie Formats — the whole pull, on this Mac.

Scrapes the tracked creators, screens every video, drops what Sarah has
already covered, and posts the survivors to the sheet for the phone app to
show. The app is a window onto the result; it triggers nothing.

Two reasons this lives here rather than in the app:

  * Claude runs through the local `claude` CLI, on Ashitha's subscription,
    so screening costs nothing per run. The old version called the Anthropic
    API from Vercel and drained a paid balance in a single test.

  * Screening one video per call meant 117 calls. Twenty videos fit in one
    call comfortably, so a full pull is about six.

Everything talks to the deployed app over HTTP, so no Apify or Google
credentials are needed here. Only the `claude` CLI.

    python3 scripts/screen_run.py                 # normal pull
    python3 scripts/screen_run.py --dry           # screen, but don't publish
    python3 scripts/screen_run.py --replay RUN    # re-screen a saved run
"""

import argparse
import json
import re
import subprocess
import sys
import time
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

APP = "https://katie-formats-app.vercel.app"

CREATORS = [
    "https://www.tiktok.com/@wordy.adri",
    "https://www.tiktok.com/@learnwithmeera",
]

SARAH = "https://www.tiktok.com/@sarah.englishwithkatie"

# Posts pulled per creator. Both of these post daily, so sixty only reached
# back about three months — a real six-month window needs roughly double.
PER_CREATOR = 120

# Her back catalogue barely moves week to week; re-scraping 175 posts on every
# run would add minutes for nothing.
SARAH_CACHE_DAYS = 7

# Videos per Claude call. Twenty transcripts is a comfortable prompt and keeps
# a full pull to a handful of calls.
BATCH = 20

RUNS_DIR = Path(__file__).resolve().parent.parent / ".runs"

BROWSER_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
)


def log(msg):
    print(f"  {msg}", flush=True)


# ── HTTP ──────────────────────────────────────────────────────────────

def api(path, payload=None, timeout=120):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        APP + path, data=data,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def fetch_text(url, timeout=30):
    # Plenty of videos carry no subtitle link at all — TikTok only generates
    # captions where there is speech to caption.
    if not url:
        return ""
    req = urllib.request.Request(
        url, headers={"User-Agent": BROWSER_UA, "Referer": "https://www.tiktok.com/"}
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read().decode("utf-8", "replace")
    except Exception:
        return ""


# ── Scrape ────────────────────────────────────────────────────────────

def scrape(profiles, per_page, label):
    log(f"scraping {label} ({len(profiles)} account(s), {per_page} posts each)")
    started = api("/api/apify?action=start",
                  {"profiles": profiles, "resultsPerPage": per_page})
    run_id = started.get("runId")
    if not run_id:
        raise SystemExit(f"apify refused to start: {started}")

    for attempt in range(1, 121):
        time.sleep(5)
        st = api(f"/api/apify?action=status&runId={run_id}")
        if st.get("status") == "SUCCEEDED":
            return st["datasetId"]
        if st.get("status") in ("FAILED", "ABORTED"):
            raise SystemExit(f"apify run {st.get('status')}")
        if attempt % 12 == 0:
            log(f"  still scraping ({attempt * 5}s)")
    raise SystemExit("apify run timed out")


def results(dataset_id, months=None):
    q = f"/api/apify?action=results&datasetId={dataset_id}"
    if months:
        q += f"&months={months}"
    return api(q).get("videos", [])


# ── Transcripts ───────────────────────────────────────────────────────

def vtt_to_text(vtt):
    out = []
    for line in vtt.splitlines():
        line = line.strip()
        if not line or line.startswith("WEBVTT") or "-->" in line or line.isdigit():
            continue
        out.append(line)
    return re.sub(r"\s+", " ", " ".join(out)).strip()


def add_transcripts(videos):
    """Fetch every transcript now and keep the text.

    TikTok's subtitle links are signed and expire after about two days. A run
    that stores only the link cannot be re-screened later, which is exactly
    when you most want to — after fixing a rule that was dropping good videos.
    """
    def one(v):
        # Already stored from an earlier run — never re-fetch. That is the
        # whole point of keeping them, and by now the link may well be dead.
        if v.get("transcript"):
            return v
        raw = fetch_text(v.get("subtitleUrl") or "")
        v["transcript"] = vtt_to_text(raw)[:4000] if "-->" in raw else ""
        return v

    todo = sum(1 for v in videos if not v.get("transcript"))
    with ThreadPoolExecutor(max_workers=12) as ex:
        list(ex.map(one, videos))

    have = sum(1 for v in videos if v["transcript"])
    log(f"transcripts: {have} of {len(videos)} ({todo} fetched, rest already stored)")
    return videos


# ── Claude ────────────────────────────────────────────────────────────

def claude_json(prompt, expect_key, tries=2):
    """Run a prompt through the local CLI and get JSON back.

    The Anthropic API can force a reply into a schema. The CLI cannot, so the
    checking happens here: parse it, and if it comes back malformed, say so
    and ask again rather than letting a bad batch through as silence.
    """
    for attempt in range(tries):
        text = subprocess.run(
            ["claude", "-p", "--output-format", "text"],
            input=prompt if attempt == 0 else prompt + (
                "\n\nYour previous reply could not be parsed. Reply with the "
                "raw JSON object only — no prose, no markdown fences."
            ),
            capture_output=True, text=True, timeout=900,
        ).stdout.strip()

        # Tolerate a fenced block; insist on nothing else.
        fence = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
        if fence:
            text = fence.group(1).strip()
        start = text.find("{")
        if start > 0:
            text = text[start:]

        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            continue
        if expect_key in parsed:
            return parsed
    return None


SCREEN_RULES = """You are screening TikTok videos from English-teaching creators, to
decide which are worth remaking for a different channel.

For EACH video, judge:

contentType — the one thing it teaches. One of:
  vocabulary  individual words and their meanings
  grammar     rules, tenses, prepositions, sentence structure
  phrases     set expressions, idioms, phrasal verbs, sentence upgrades, and
              how words run together in natural speech (gonna, wanna, gotta)
  pronunciation  how to physically produce a sound, word stress, syllables,
              silent letters, accent training
  listening   the viewer is asked to hear or catch something — a listening
              test, dictation, "what did I say", "can you hear the difference"
  slang       informal street language
  culture     customs and etiquette
  exam        IELTS/TOEFL test technique
  motivation  encouragement rather than a lesson
  other       none of the above

Two traps. A video about how words blend in fast speech ("gonna", "wanna") is
phrases, not pronunciation — it teaches an expression, not a sound. And "stop
saying X, say Y" is vocabulary or phrases unless the point is genuinely sound.

isSkit — true when the creator is acting rather than explaining: playing
characters, roleplay, costumes, appearing twice in one frame, a staged scene
between people. A plain piece to camera is not a skit, however lively.

needsPhysicalDemo — true ONLY when the lesson depends on something physically
present with the creator: a real object held to camera, mouth or tongue
position, a gesture carrying the meaning. Pictures, graphics, text or emoji
added on screen do NOT count — they are edited in afterwards. Ask whether a
different person, reading the same script in a plain room, could make this
video. If yes, false.

mentionsBritish — true if the video is about British English in any way:
British vs American, British slang, British phrases or accents. Judge the
content, not whether the creator sounds British.

isSelfPromo — true ONLY when the video teaches nothing at all and exists purely
to sell. Almost every creator plugs something at the end, many in every single
video. That is a habit, not an advert. If a viewer who skipped the last few
seconds would still have learnt something, answer false.

isWhiteboard — true when the teaching happens on a whiteboard, blackboard or
paper pad the creator writes on.

whiteboardConvertible — only meaningful when isWhiteboard is true, else false.
True when the board holds standalone items — words, phrases, rules — that would
read just as well as text on screen. False when the teaching depends on the
board itself: arrows, diagrams, circling, spatial layout.

topic — the lesson in under eight words, as a person would say it: "formal
alternatives to very", "through vs across", "berry names". No hashtags, no
hook wording.

examples — two or three actual items taught, copied VERBATIM from the
transcript. For a berry video: ["gooseberry", "mulberry", "elderberry"]. For a
grammar one: ["I have been", "I had been"]. Never invent an example, and never
paraphrase one. If the transcript is empty or teaches no listable items, return
an empty array.

The transcript is the strongest evidence — it is what was actually said. The
caption is often just a hook and can mislead.

Reply with a JSON object and nothing else:
{"results":[{"id":"<the id given>","contentType":"...","isSkit":false,
"needsPhysicalDemo":false,"mentionsBritish":false,"isSelfPromo":false,
"isWhiteboard":false,"whiteboardConvertible":false,"topic":"...",
"examples":["...","..."]}]}

One entry per video, in the order given."""

BLOCKED_TYPES = {
    "pronunciation": "pronunciation video",
    "listening": "listening test or practice",
}


def apply_rules(v):
    """The drop rules, kept out of the prompt on purpose.

    Claude describes the video; this decides what to do about it. Changing
    what gets rejected is then a line here, not a re-prompt — and the same
    description can be re-judged later without asking Claude anything again.
    """
    reasons = []
    if v.get("mentionsBritish"):
        reasons.append("British English")
    if v.get("contentType") in BLOCKED_TYPES:
        reasons.append(BLOCKED_TYPES[v["contentType"]])
    if v.get("isSelfPromo") and v.get("contentType") in ("other", "motivation"):
        reasons.append("an advert, not a lesson")
    if v.get("isSkit"):
        reasons.append("skit")
    if v.get("needsPhysicalDemo"):
        reasons.append("needs a physical demo")
    if v.get("isWhiteboard") and not v.get("whiteboardConvertible"):
        reasons.append("whiteboard, needs the drawing")
    return reasons


def screen(videos):
    batches = [videos[i:i + BATCH] for i in range(0, len(videos), BATCH)]
    verdicts = {}

    for n, batch in enumerate(batches, 1):
        log(f"screening batch {n}/{len(batches)} ({len(batch)} videos)")
        facts = []
        for v in batch:
            facts.append(
                f'--- id: {v["url"]}\n'
                f'CAPTION: {v.get("title", "")}\n'
                f'HASHTAGS: {", ".join(v.get("hashtags") or []) or "(none)"}\n'
                f'TRANSCRIPT: {v.get("transcript") or "(none available)"}'
            )
        got = claude_json(SCREEN_RULES + "\n\nVIDEOS:\n" + "\n".join(facts), "results")
        if not got:
            log(f"  batch {n} came back unreadable twice — keeping all of it")
            continue
        for r in got["results"]:
            if r.get("id"):
                verdicts[r["id"]] = r

    out = []
    for v in videos:
        r = verdicts.get(v["url"])
        if not r:
            # Never seen by the screener. Keep it: a filter failing is not
            # evidence against a video, and a wrong keep costs one swipe.
            out.append({**v, "verdict": "unclear", "reasons": [], "topic": "",
                        "contentType": "", "examples": []})
            continue
        reasons = apply_rules(r)
        out.append({
            **v,
            "contentType": r.get("contentType", ""),
            "topic": r.get("topic", ""),
            "examples": r.get("examples") or [],
            "makeListicle": bool(r.get("isWhiteboard") and r.get("whiteboardConvertible")),
            "reasons": reasons,
            "verdict": "drop" if reasons else "keep",
        })
    return out


DEDUPE_RULES = """Sarah teaches English on TikTok. Below is every video she has already
posted, then videos we are considering remaking. Say which candidates would
repeat a lesson she has already done.

Match on the lesson, not the wording — she never writes the same caption twice.
"Stop Saying Big — Say This Instead" and "formal alternatives to very" are the
same lesson. But do not match on subject area alone: two videos both being
about phrasal verbs is not a repeat unless they teach the same phrasal verbs.

When unsure, answer not covered. A repeat that slips through costs one video;
a good idea wrongly dropped is never seen again.

Reply with a JSON object and nothing else:
{"results":[{"id":"<the id given>","covered":true,"match":"<her caption, or empty>"}]}"""


def dedupe(candidates, posted):
    if not candidates or not posted:
        return {}
    covered = {}
    batches = [candidates[i:i + 25] for i in range(0, len(candidates), 25)]
    for n, batch in enumerate(batches, 1):
        log(f"checking against Sarah, batch {n}/{len(batches)}")
        prompt = (
            DEDUPE_RULES
            + "\n\nALREADY POSTED BY SARAH:\n"
            + "\n".join(f"- {c}" for c in posted)
            + "\n\nCANDIDATES:\n"
            + "\n".join(f'- id: {v["url"]}\n  topic: {v.get("topic") or v.get("title", "")}'
                        for v in batch)
        )
        got = claude_json(prompt, "results")
        if not got:
            log(f"  batch {n} unreadable — treating all as new")
            continue
        for r in got["results"]:
            if r.get("covered") and r.get("id"):
                covered[r["id"]] = r.get("match", "")
    return covered


# ── Sarah's history ───────────────────────────────────────────────────

def sarah_history():
    cache = RUNS_DIR / "sarah.json"
    if cache.exists():
        saved = json.loads(cache.read_text())
        age = time.time() - saved.get("at", 0)
        if age < SARAH_CACHE_DAYS * 86400 and saved.get("captions"):
            log(f"Sarah's history from cache ({len(saved['captions'])} posts)")
            return saved["captions"]

    # Her whole catalogue, not a recent window — a lesson she did last year is
    # still a repeat, so the six-month cut is pushed out of the way.
    ds = scrape([SARAH], 200, "Sarah's back catalogue")
    captions = [v["title"] for v in results(ds, months=999)
                if v.get("title") and v["title"] != "No caption"]
    RUNS_DIR.mkdir(exist_ok=True)
    cache.write_text(json.dumps({"at": time.time(), "captions": captions}))
    log(f"Sarah has posted {len(captions)} videos")
    return captions


# ── Main ──────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true", help="screen but don't publish")
    ap.add_argument("--replay", metavar="FILE", help="re-screen a saved run")
    args = ap.parse_args()

    RUNS_DIR.mkdir(exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")

    if args.replay:
        saved = json.loads(Path(args.replay).read_text())
        videos = saved["videos"]
        log(f"replaying {len(videos)} videos from {args.replay}")
        # A run saved before transcripts were stored still has only the links,
        # and those may already have expired. Fill what we can, carry on
        # without the rest.
        videos = add_transcripts(videos)
    else:
        posted = sarah_history()
        ds = scrape(CREATORS, PER_CREATOR, "creators")
        videos = results(ds)
        log(f"{len(videos)} videos in the last six months")
        videos = add_transcripts(videos)
        # Save the raw pull before screening: the transcripts inside it are the
        # part that cannot be fetched again.
        (RUNS_DIR / f"raw-{stamp}.json").write_text(
            json.dumps({"at": stamp, "videos": videos}))

    if args.replay:
        posted = sarah_history()

    screened = screen(videos)
    survivors = [v for v in screened if v["verdict"] != "drop"]
    log(f"{len(survivors)} survived the rules, {len(screened) - len(survivors)} dropped")

    covered = dedupe(survivors, posted)
    final = [v for v in survivors if v["url"] not in covered]
    for v in survivors:
        if v["url"] in covered:
            v["reasons"] = ["Sarah already posted this"]
            v["verdict"] = "drop"
    log(f"{len(final)} left after Sarah's back catalogue")

    doc = {
        "at": datetime.now(timezone.utc).isoformat(),
        "counts": {
            "pulled": len(screened),
            "dropped": len(screened) - len(final),
            "survivors": len(final),
        },
        # Survivors are what the app shows. The dropped ones ride along so the
        # app can surface a few each run — the filter can only ever learn from
        # bad keeps otherwise, and quietly narrows forever.
        "videos": final,
        "dropped": [v for v in screened if v["verdict"] == "drop"],
    }

    out = RUNS_DIR / f"run-{stamp}.json"
    out.write_text(json.dumps(doc, indent=1))
    log(f"saved {out}")

    if args.dry:
        log("dry run — not published")
        return

    res = api("/api/sheets", {"action": "putrun", "data": doc})
    if res.get("ok"):
        log(f"published {res['bytes']} bytes to the sheet — the app will show it")
    else:
        log(f"publish failed: {res}")
        sys.exit(1)


if __name__ == "__main__":
    main()
