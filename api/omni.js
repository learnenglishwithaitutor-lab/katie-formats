// ── Norah assets — bundled in the repo, uploaded fresh per generation ──
// kie.ai's tempfile URLs expire, so we re-upload every time to avoid
// stale-URL "image fetch failed" errors.
import { readFile } from 'fs/promises';
import path from 'path';

const KIE_TOKEN     = process.env.KIE_API_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

// Decode service (Railway) — downloads video, extracts frames, returns motion breakdown
const DECODE_URL    = process.env.DECODE_SERVICE_URL || 'https://katie-decode-production.up.railway.app';
const DECODE_SECRET = process.env.DECODE_SECRET;

const KIE_UPLOAD_URL = 'https://kieai.redpandaai.co/api/file-stream-upload';
const KIE_CREATE_URL = 'https://api.kie.ai/api/v1/jobs/createTask';
const KIE_POLL_URL   = 'https://api.kie.ai/api/v1/jobs/recordInfo';

// ── Generate Omni prompt TEXT via Claude (goes inside the PNG) ──
async function generateOmniPrompt(script, thumbnailUrl, motionBreakdown, clipInfo) {
  const clipNote = clipInfo
    ? `\n\nNOTE: This is clip ${clipInfo.index} of ${clipInfo.total} of a longer video that will be stitched together. The clips MUST look continuous: identical room, identical framing/camera distance, identical lighting, and the SAME warm upbeat baseline energy as the other clips. Use the exact Setting line provided. Generate ONLY this segment's words at a natural, unhurried pace, using the matching part of the movement breakdown.`
    : '';
  // If we have a real motion breakdown from the decode service (derived from
  // watching the actual video frames), use it directly. Otherwise fall back to
  // thumbnail-grounded guessing.
  if (motionBreakdown && motionBreakdown.trim()) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: `You assemble a Gemini Omni (Google Flow) video prompt. You are given a Katie AI script AND a real movement breakdown derived from watching the original video frame-by-frame. Output the complete Omni prompt in this exact block structure:

Generate a video of this girl saying the following, clearly and naturally:
"[script word-by-word with delivery notes in parentheses, e.g. (enthusiastically), (slower), (smiling)]"

Use the video attached as reference for her voice (norah_new_voice.mp4). Make sure she is naturally expressive when she is speaking.

Movement:
[USE THE PROVIDED MOVEMENT BREAKDOWN — these are the real gestures from the source video, adapted to Norah talking to camera. Do not invent different gestures. Write each gesture ANCHORED TO THE WORD it lands on, e.g. At "Absolutely," right index finger points up. At "Certainly," open palm sweeps inward. NEVER use timestamps like 0:00-0:03 — anchor to words only.]

Setting: Same cozy home bedroom — plain warm-white wall behind her, soft natural daylight from the side, a couple of small framed pictures, waist-up framing with the camera at eye level. Warm, upbeat, friendly UGC energy throughout.
Format: Vertical 9:16, phone-camera UGC aesthetic, no captions.

Rules:
- Output ONLY the prompt text — no labels, no preamble
- Keep script under 28 words for 10 seconds; truncate at a sentence boundary if longer
- The Movement section MUST use the provided breakdown — that's the whole point
- Movement MUST be word-anchored (At "word," gesture). NEVER emit timestamps (no 0:00-0:03). Timestamps are forbidden because each clip is a fresh ~10s generation and fabricated times cause rushing.
- COPY THE SETTING LINE EXACTLY AS GIVEN ABOVE, word for word, every time — do not paraphrase or vary it. Identical setting + framing + energy across clips is what lets them stitch seamlessly.
- Keep the SAME baseline energy (warm, upbeat, expressive) in every clip; only the per-word delivery notes should vary with the words' meaning (e.g. confident vs skeptical). Do not let the overall mood drop between clips.
- Always name the voice file as norah_new_voice.mp4
- Do NOT use detachable props
- CAPS for emphasis words only, sparingly`,
        messages: [{
          role: 'user',
          content: `Script:\n${script}\n\nReal movement breakdown (from watching the original video):\n${motionBreakdown}\n\nAssemble the full Omni prompt using this exact movement.${clipNote}`
        }]
      })
    });
    const data = await response.json();
    if (data.error) throw new Error(`Claude: ${data.error.message || JSON.stringify(data.error)}`);
    return data.content?.[0]?.text || '';
  }

  // Try to fetch the original's thumbnail so Claude can ground the
  // movement breakdown in what the creator is actually doing.
  // Falls back to text-only if the fetch fails (never breaks the pipeline).
  let imageBlock = null;
  if (thumbnailUrl) {
    try {
      const imgRes = await fetch(thumbnailUrl);
      if (imgRes.ok) {
        const ct = imgRes.headers.get('content-type') || 'image/jpeg';
        if (ct.startsWith('image/')) {
          const buf = Buffer.from(await imgRes.arrayBuffer());
          // Keep within sane size limits for the vision API
          if (buf.length > 0 && buf.length < 4_500_000) {
            imageBlock = {
              type: 'image',
              source: { type: 'base64', media_type: ct.split(';')[0], data: buf.toString('base64') }
            };
          }
        }
      }
    } catch (e) { /* fall back to text-only */ }
  }

  const userContent = imageBlock
    ? [
        imageBlock,
        { type: 'text', text: `The image above is the opening frame of the ORIGINAL TikTok we are recreating. Study what the creator is physically doing — their gestures, hand positions, posture, framing (close-up vs waist-up), and energy. Then write the Omni prompt for this Katie AI script, with a movement breakdown that echoes that same gesture style and energy, adapted to Norah talking to camera.\n\nScript:\n${script}` }
      ]
    : `Write the Omni prompt for this Katie AI script:\n\n${script}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: `You write video generation prompts for Gemini Omni (Google Flow). You are given a Katie AI TikTok script — and usually the opening frame of the original video — and you output a complete Omni prompt following this exact block structure:

Generate a video of this girl saying the following, clearly and naturally:
"[script goes here word by word with delivery notes in parentheses, e.g. (enthusiastically), (slower), (smiling)]"

Use the video attached as reference for her voice (norah_new_voice.mp4). Make sure she is naturally expressive when she is speaking.

Movement:
0:00-0:03 | [body action tied to script — specify left/right hand]
0:03-0:06 | [next beat]
0:06-0:10 | [closing beat]

Setting: Home bedroom background, casual and warm, naturally expressive.
Format: Vertical 9:16, phone-camera UGC aesthetic, no captions.

How to use the original frame (if provided):
- Study what the creator is physically DOING — pointing, counting on fingers, holding up a hand, leaning in, reacting, framing (close-up vs waist-up), overall energy.
- Write the movement breakdown to ECHO that gesture style and energy, adapted to Norah talking to camera. If they point at two options, Norah points. If they count on fingers, Norah counts. If it's a punchy close-up reaction, make the beats punchy.
- Do NOT transplant the original's location — Norah is always in her own home/bedroom (her start frame is fixed). Only the GESTURE STYLE, ENERGY, and FRAMING carry over, never the background.
- If no image is provided, infer natural, engaging tutor gestures from the script.

Rules:
- Output ONLY the prompt text — no labels like "Block 1", no preamble, no explanation
- Keep script under 28 words for 10 seconds; if longer, truncate at a sentence boundary
- Delivery notes like (enthusiastically), (warmly), (slower) go inline after each phrase
- Make the movement breakdown specific and assertive — name the hand, the gesture, and the word it lands on. Vague filler makes the avatar just stand and talk.
- Always name the voice file as norah_new_voice.mp4 in the voice line
- Do NOT use detachable props (Norah's start frame has none — never add a prop she'd have to hold)
- CAPS for emphasis words only, sparingly`,
      messages: [{ role: 'user', content: userContent }]
    })
  });
  const data = await response.json();
  if (data.error) throw new Error(`Claude: ${data.error.message || JSON.stringify(data.error)}`);
  return data.content?.[0]?.text || '';
}

// ── Upload a buffer to kie.ai, return hosted URL ──────────────
// filename is preserved in the upload path so the image-prompt hack
// can reference files by name (prompt.png, luna_start_frame.png, etc).
async function uploadToKie(buffer, mimeType, filename) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType }), filename);
  form.append('uploadPath', `katie/${filename}`);

  const res = await fetch(KIE_UPLOAD_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${KIE_TOKEN}` },
    body: form
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`kie.ai upload failed (${res.status}) for ${filename}: ${t}`);
  }
  const data = await res.json();
  const url = data?.data?.downloadUrl;
  if (!url) throw new Error(`kie.ai upload: no downloadUrl for ${filename}. Response: ${JSON.stringify(data)}`);
  return url;
}

// ── Read a bundled Norah asset from the repo ──────────────────
async function readAsset(filename) {
  const p = path.join(process.cwd(), filename);
  return readFile(p);
}

// ── Submit a nano-banana-edit image task (avatar first-frame swap) ──
// Keeps the reference frame's background/pose/framing, swaps the person to Norah.
async function submitKieImageTask(refFrameUrl, norahUrl, outfit) {
  const wearing = outfit && outfit.trim() ? outfit.trim() : 'a plain casual top';
  const prompt =
    'Composite one clean, photorealistic frame of a single person. ' +
    'Use the SECOND image ONLY as the reference for the woman\'s face, facial features, and hairstyle — her identity. ' +
    'Place her into the scene from the FIRST image: keep the FIRST image\'s background, room, furniture, wall decor, ' +
    'lighting, camera framing and distance, her body pose, head angle, and hand positions. ' +
    'Dress her in: ' + wearing + '. Render this outfit naturally and completely on her body. ' +
    'Do NOT copy or keep the clothing from the first image, and do NOT copy the clothing from the second image — ' +
    'her clothing must be exactly the outfit described above, cleanly and fully replacing whatever either image shows ' +
    'her wearing (no layering or blending of garments). ' +
    'REMOVE any caption text, subtitle bars, on-screen text, watermarks, stickers, or graphic overlays that were laid ' +
    'on top of the first image (TikTok-style captions). The final frame must contain NO overlaid text or captions — ' +
    'just the person in the room. A single person only, natural lighting consistent with the scene.';
  const body = {
    model: 'google/nano-banana-edit',
    input: {
      prompt,
      image_urls: [refFrameUrl, norahUrl],
      output_format: 'png',
      image_size: '9:16'
    }
  };
  const res = await fetch(KIE_CREATE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${KIE_TOKEN}` },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`kie.ai image createTask failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  if (data.code && data.code !== 200) throw new Error(`kie.ai image: ${data.msg || 'createTask error'} (code ${data.code})`);
  const taskId = data?.data?.taskId;
  if (!taskId) throw new Error(`kie.ai image: no taskId. Response: ${JSON.stringify(data)}`);
  return taskId;
}

// ── Submit generation task (image-prompt hack) ────────────────
async function submitKieTask(promptPngUrl, startFrameUrl, voiceUrl, noVoice) {
  const input = {
    // The real prompt lives in the PNG. This text just points Omni to it.
    prompt: 'Read prompt.png. Use luna_start_frame.png as the starting image for norah_new_voice.mp4',
    // Prompt PNG first, Norah start frame second
    image_urls: [promptPngUrl, startFrameUrl],
    duration: '8',
    aspect_ratio: '9:16'
  };
  if (!noVoice && voiceUrl) {
    input.video_list = [{ url: voiceUrl, start: 0, ends: 10 }];
  }
  const body = { model: 'gemini-omni-video', input };
  const res = await fetch(KIE_CREATE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${KIE_TOKEN}`
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`kie.ai createTask failed (${res.status}): ${errText}`);
  }
  const data = await res.json();
  if (data.code && data.code !== 200) {
    throw new Error(`kie.ai: ${data.msg || 'createTask error'} (code ${data.code})`);
  }
  const taskId = data?.data?.taskId;
  if (!taskId) throw new Error(`kie.ai: no taskId returned. Response: ${JSON.stringify(data)}`);
  return taskId;
}

// ── Poll kie.ai task status ────────────────────────────────────
async function pollKieTask(taskId) {
  const res = await fetch(`${KIE_POLL_URL}?taskId=${taskId}`, {
    headers: { 'Authorization': `Bearer ${KIE_TOKEN}` }
  });
  if (!res.ok) throw new Error(`kie.ai poll failed: ${res.status}`);
  const data = await res.json();
  const record = data?.data;
  if (!record) throw new Error('kie.ai: empty poll response');

  // kie.ai uses `state`: waiting | queuing | generating | success | fail
  const rawState = record.state;
  let status = 'processing';
  if (rawState === 'success') status = 'success';
  else if (rawState === 'fail') status = 'fail';

  let videoUrl = null;
  let failMsg = null;
  if (status === 'success' && record.resultJson) {
    try {
      const parsed = JSON.parse(record.resultJson);
      videoUrl = parsed?.resultUrls?.[0] || null;
    } catch(e) {}
  }
  if (status === 'fail') failMsg = record.failMsg || 'Generation failed';
  return { status, videoUrl, failMsg };
}

// ── Main handler ───────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // GET ?action=status&taskId=xxx
  if (req.method === 'GET') {
    const { action, taskId } = req.query;
    if (action !== 'status') return res.status(400).json({ error: 'Unknown action' });
    if (!taskId) return res.status(400).json({ error: 'taskId required' });
    try {
      const result = await pollKieTask(taskId);
      return res.status(200).json(result);
    } catch(err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const body = req.body || {};
  const action = body.action;

  // ── action=analyze: call decode service for the real motion breakdown ──
  if (action === 'analyze') {
    const videoFile = body.videoFile;
    const script = body.script || '';
    if (!videoFile) return res.status(400).json({ error: 'videoFile required' });
    try {
      const dres = await fetch(`${DECODE_URL}/analyze`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(DECODE_SECRET ? { 'x-decode-secret': DECODE_SECRET } : {})
        },
        body: JSON.stringify({ videoUrl: videoFile, script })
      });
      const ddata = await dres.json();
      if (!dres.ok || !ddata.ok) {
        return res.status(502).json({ error: 'decode service: ' + (ddata.error || dres.status) });
      }
      return res.status(200).json({ motionBreakdown: ddata.movementBreakdown, frameCount: ddata.frameCount, duration: ddata.duration || 0, firstFrame: ddata.firstFrame || null });
    } catch (err) {
      return res.status(500).json({ error: 'decode call failed: ' + err.message });
    }
  }

  // ── action=stitch: proxy to decode /stitch, stream the MP4 back ──
  if (action === 'stitch') {
    const clips = body.clips;
    if (!Array.isArray(clips) || clips.length < 2) {
      return res.status(400).json({ error: 'need at least 2 clip URLs' });
    }
    try {
      const dres = await fetch(`${DECODE_URL}/stitch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(DECODE_SECRET ? { 'x-decode-secret': DECODE_SECRET } : {})
        },
        body: JSON.stringify({ clips })
      });
      if (!dres.ok) {
        let msg = dres.status;
        try { const j = await dres.json(); msg = j.error || msg; } catch {}
        return res.status(502).json({ error: 'stitch failed: ' + msg });
      }
      const arrayBuf = await dres.arrayBuffer();
      const buf = Buffer.from(arrayBuf);
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', 'attachment; filename="stitched.mp4"');
      res.setHeader('Content-Length', buf.length);
      return res.status(200).send(buf);
    } catch (err) {
      return res.status(500).json({ error: 'stitch call failed: ' + err.message });
    }
  }

  // ── action=prompt: Claude generates the prompt text (for the PNG) ──
  if (action === 'prompt') {
    const script = body.script;
    const thumbnail = body.thumbnail || null;
    const motionBreakdown = body.motionBreakdown || null;
    const clipInfo = body.clipInfo || null;
    if (!script) return res.status(400).json({ error: 'script required' });
    if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });
    try {
      const promptText = await generateOmniPrompt(script, thumbnail, motionBreakdown, clipInfo);
      if (!promptText) throw new Error('Claude returned empty prompt');
      return res.status(200).json({ promptText });
    } catch(err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── action=firstframe: submit the Norah swap, return taskId (poll separately) ──
  // Body: { firstFrame: <base64 jpg of the reference video's frame 0> }
  // Returns { taskId }. The app polls action=status until the image is ready.
  // (No inline poll — keeps us well under the function time limit.)
  if (action === 'firstframe') {
    const firstFrame = body.firstFrame; // base64, no data: prefix
    const outfit = body.outfit || null;
    if (!firstFrame) return res.status(400).json({ error: 'firstFrame required' });
    if (!KIE_TOKEN) return res.status(500).json({ error: 'KIE_API_TOKEN not set' });
    try {
      const refBuffer = Buffer.from(firstFrame, 'base64');
      const norahBuffer = await readAsset('luna_start_frame.png');
      const [refUrl, norahUrl] = await Promise.all([
        uploadToKie(refBuffer, 'image/jpeg', 'ref_first_frame.jpg'),
        uploadToKie(norahBuffer, 'image/png', 'norah_identity.png')
      ]);
      const taskId = await submitKieImageTask(refUrl, norahUrl, outfit);
      return res.status(200).json({ taskId });
    } catch(err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── action=generate: upload prompt PNG + Norah assets fresh, submit ──
  if (action === 'generate') {
    const promptPng = body.promptPng; // base64 (no data: prefix)
    const noVoice = body.noVoice === true;
    const startFrameUrl_in = body.startFrameUrl || null; // per-video Norah frame (optional)
    if (!promptPng) return res.status(400).json({ error: 'promptPng required' });
    if (!KIE_TOKEN) return res.status(500).json({ error: 'KIE_API_TOKEN not set' });
    try {
      const promptBuffer = Buffer.from(promptPng, 'base64');

      // Start frame: prefer the per-video Norah frame; re-fetch and re-upload it
      // fresh under the luna filename so the prompt hint still resolves and no
      // kie tempfile URL is stale. Any failure falls back to the bundled avatar.
      let startBuffer = null;
      if (startFrameUrl_in) {
        try {
          const fr = await fetch(startFrameUrl_in);
          if (fr.ok) startBuffer = Buffer.from(await fr.arrayBuffer());
        } catch (e) { /* fall back below */ }
      }
      if (!startBuffer) startBuffer = await readAsset('luna_start_frame.png');

      const voiceBuffer = noVoice ? null : await readAsset('norah_new_voice.mp4');

      const uploads = [
        uploadToKie(promptBuffer, 'image/png', 'prompt.png'),
        uploadToKie(startBuffer, 'image/png', 'luna_start_frame.png')
      ];
      if (!noVoice) uploads.push(uploadToKie(voiceBuffer, 'video/mp4', 'norah_new_voice.mp4'));

      const urls = await Promise.all(uploads);
      const promptPngUrl  = urls[0];
      const startFrameUrl = urls[1];
      const voiceUrl      = noVoice ? null : urls[2];

      const taskId = await submitKieTask(promptPngUrl, startFrameUrl, voiceUrl, noVoice);
      return res.status(200).json({ taskId });
    } catch(err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(400).json({ error: 'Unknown action' });
}
