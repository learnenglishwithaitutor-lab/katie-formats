// ── Norah assets — bundled in the repo, uploaded fresh per generation ──
// kie.ai's tempfile URLs expire, so we re-upload every time to avoid
// stale-URL "image fetch failed" errors.
import { readFile } from 'fs/promises';
import path from 'path';

const KIE_TOKEN     = process.env.KIE_API_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const KIE_UPLOAD_URL = 'https://kieai.redpandaai.co/api/file-stream-upload';
const KIE_CREATE_URL = 'https://api.kie.ai/api/v1/jobs/createTask';
const KIE_POLL_URL   = 'https://api.kie.ai/api/v1/jobs/recordInfo';

// ── Generate Omni prompt TEXT via Claude (goes inside the PNG) ──
async function generateOmniPrompt(script) {
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
      system: `You write video generation prompts for Gemini Omni (Google Flow). You are given a Katie AI TikTok script and you output a complete Omni prompt following this exact block structure:

Generate a video of this girl saying the following, clearly and naturally:
"[script goes here word by word with delivery notes in parentheses, e.g. (enthusiastically), (slower), (smiling)]"

Use the video attached as reference for her voice (norah_new_voice.mp4). Make sure she is naturally expressive when she is speaking.

Movement:
0:00-0:03 | [body action tied to script — specify left/right hand]
0:03-0:06 | [next beat]
0:06-0:10 | [closing beat]

Setting: Home bedroom background, casual and warm, naturally expressive.
Format: Vertical 9:16, phone-camera UGC aesthetic, no captions.

Rules:
- Output ONLY the prompt text — no labels like "Block 1", no preamble, no explanation
- Keep script under 28 words for 10 seconds; if longer, truncate at a sentence boundary
- Delivery notes like (enthusiastically), (warmly), (slower) go inline after each phrase
- Movement: warm, engaging English tutor talking to camera — hands gesturing naturally, leaning slightly in on key points
- Always name the voice file as norah_new_voice.mp4 in the voice line
- Do NOT use detachable props
- CAPS for emphasis words only, sparingly`,
      messages: [{
        role: 'user',
        content: `Write the Omni prompt for this Katie AI script:\n\n${script}`
      }]
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

  // ── action=prompt: Claude generates the prompt text (for the PNG) ──
  if (action === 'prompt') {
    const script = body.script;
    if (!script) return res.status(400).json({ error: 'script required' });
    if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });
    try {
      const promptText = await generateOmniPrompt(script);
      if (!promptText) throw new Error('Claude returned empty prompt');
      return res.status(200).json({ promptText });
    } catch(err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── action=generate: upload prompt PNG + Norah assets fresh, submit ──
  if (action === 'generate') {
    const promptPng = body.promptPng; // base64 (no data: prefix)
    const noVoice = body.noVoice === true;
    if (!promptPng) return res.status(400).json({ error: 'promptPng required' });
    if (!KIE_TOKEN) return res.status(500).json({ error: 'KIE_API_TOKEN not set' });
    try {
      // Upload all assets fresh so no kie.ai tempfile URL is ever stale
      const promptBuffer = Buffer.from(promptPng, 'base64');
      const [startBuffer, voiceBuffer] = await Promise.all([
        readAsset('luna_start_frame.png'),
        noVoice ? Promise.resolve(null) : readAsset('norah_new_voice.mp4')
      ]);

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
