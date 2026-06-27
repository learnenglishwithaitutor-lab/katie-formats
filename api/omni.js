// ── Norah hardcoded assets ─────────────────────────────────────
// After uploading via Cowork, replace these two URLs:
const NORAH_START_FRAME_URL = process.env.NORAH_START_FRAME_URL || 'REPLACE_WITH_NORAH_START_FRAME_URL';
const NORAH_VOICE_REF_URL   = process.env.NORAH_VOICE_REF_URL   || 'REPLACE_WITH_NORAH_VOICE_REF_URL';

const KIE_TOKEN     = process.env.KIE_API_TOKEN || '4ec49d0af165d739d7c263825614c142';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

// ── Generate Omni prompt text via Claude ───────────────────────
async function generateOmniPrompt(script) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: `You write video generation prompts for Gemini Omni (Google Flow). You are given a Katie AI TikTok script and you output a complete Omni prompt following this exact block structure:

Block 1 — Action & Script:
Generate a video of this girl saying the following, clearly and naturally:
"[script goes here word by word with delivery notes in parentheses, e.g. (enthusiastically), (slower), (smiling)]"

Block 2 — Voice:
Use the video attached as reference for her voice. Make sure she is naturally expressive when she is speaking.

Block 3 — Movement Breakdown:
Describe realistic movement beats timed 0:00–0:10, using 2–4 second segments. Account for every second. Specify which hand (left/right) for gestures. Keep it natural for a talking-head TikTok. Format each line as:
0:00-0:03 | [Beat description]

Block 4 — Setting:
One sentence. Home/bedroom background, casual and warm. Naturally expressive.

Block 5 — Format:
Vertical 9:16, phone-camera UGC aesthetic, no captions.

Rules:
- Output ONLY the prompt text — no labels, no block headings, no preamble, no explanation
- Keep script under 28 words for 10 seconds
- If the script is longer than 28 words, truncate naturally at a sentence boundary
- Delivery notes like (enthusiastically), (warmly), (slower and clearer) go inline after each phrase
- Movement should match a warm, engaging English tutor talking to camera — hands gesturing naturally, leaning slightly in on key points
- Do NOT use detachable props — no lids, caps, or loose objects
- CAPS for emphasis words only, sparingly`,
      messages: [{
        role: 'user',
        content: `Write the Omni prompt for this Katie AI script:\n\n${script}`
      }]
    })
  });
  const data = await response.json();
  return data.content?.[0]?.text || '';
}

// ── Upload file to kie.ai ──────────────────────────────────────
async function uploadToKie(url, mimeType, filename) {
  // Fetch the asset from its hosted URL
  const assetRes = await fetch(url);
  if (!assetRes.ok) throw new Error(`Failed to fetch asset: ${url}`);
  const blob = await assetRes.arrayBuffer();

  const form = new FormData();
  form.append('file', new Blob([blob], { type: mimeType }), filename);

  const uploadRes = await fetch('https://kieai.redpandaai.co/api/file-stream-upload', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${KIE_TOKEN}` },
    body: form
  });
  if (!uploadRes.ok) throw new Error(`kie.ai upload failed: ${uploadRes.status}`);
  const uploadData = await uploadRes.json();
  const kieUrl = uploadData?.data?.downloadUrl;
  if (!kieUrl) throw new Error('kie.ai upload: no downloadUrl returned');
  return kieUrl;
}

// ── Submit generation task to kie.ai ──────────────────────────
async function submitKieTask(promptText, imageUrl, voiceUrl) {
  const body = {
    model: 'gemini-omni-video',
    input: {
      prompt: promptText,
      image_urls: [imageUrl],
      video_list: [{ url: voiceUrl, start: 0, ends: 12 }],
      duration: '8',
      aspect_ratio: '9:16'
    }
  };
  const res = await fetch('https://api.kie.ai/api/v1/jobs/createTask', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${KIE_TOKEN}`
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`kie.ai createTask failed: ${res.status}`);
  const data = await res.json();
  const taskId = data?.data?.taskId;
  if (!taskId) throw new Error('kie.ai: no taskId returned');
  return taskId;
}

// ── Poll kie.ai task status ────────────────────────────────────
async function pollKieTask(taskId) {
  const res = await fetch(`https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${taskId}`, {
    headers: { 'Authorization': `Bearer ${KIE_TOKEN}` }
  });
  if (!res.ok) throw new Error(`kie.ai poll failed: ${res.status}`);
  const data = await res.json();
  const record = data?.data;
  if (!record) throw new Error('kie.ai: empty poll response');

  const status = record.status; // waiting | queuing | generating | processing | success | fail
  let videoUrl = null;
  if (status === 'success' && record.resultJson) {
    try {
      const parsed = JSON.parse(record.resultJson);
      videoUrl = parsed?.resultUrls?.[0] || null;
    } catch(e) {}
  }
  return { status, videoUrl };
}

// ── Main handler ───────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.method === 'GET' ? req.query.action : req.body?.action;

  // ── action=status: poll a running task ──
  if (action === 'status') {
    const taskId = req.query.taskId || req.body?.taskId;
    if (!taskId) return res.status(400).json({ error: 'taskId required' });
    try {
      const { status, videoUrl } = await pollKieTask(taskId);
      return res.status(200).json({ status, videoUrl });
    } catch(err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── action=generate: full pipeline ──
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { script } = req.body || {};
  if (!script) return res.status(400).json({ error: 'script required' });

  try {
    // Step 1: Generate Omni prompt via Claude
    const promptText = await generateOmniPrompt(script);
    if (!promptText) throw new Error('Claude returned empty prompt');

    // Step 2: Upload Norah assets to kie.ai (they need to be hosted on kie's servers)
    const [kieImageUrl, kieVoiceUrl] = await Promise.all([
      uploadToKie(NORAH_START_FRAME_URL, 'image/png', 'luna_start_frame.png'),
      uploadToKie(NORAH_VOICE_REF_URL,   'video/mp4',  'norah_voice.mp4')
    ]);

    // Step 3: Submit task
    const taskId = await submitKieTask(promptText, kieImageUrl, kieVoiceUrl);

    return res.status(200).json({ taskId, promptText });
  } catch(err) {
    return res.status(500).json({ error: err.message });
  }
}
