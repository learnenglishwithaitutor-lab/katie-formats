const HEYGEN_KEY = process.env.HEYGEN_API_KEY;
const AVATAR_ID = process.env.HEYGEN_AVATAR_ID;
const VOICE_ID = process.env.HEYGEN_VOICE_ID;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action, video_id } = req.query;

  try {
    // ── Generate video ──────────────────────────────────────────
    if (action === 'generate' && req.method === 'POST') {
      const { script, avatar_id_override } = req.body;
      if (!script) return res.status(400).json({ error: 'No script provided' });
      const avatarId = avatar_id_override || AVATAR_ID;

      const response = await fetch('https://api.heygen.com/v2/video/generate', {
        method: 'POST',
        headers: {
          'X-Api-Key': HEYGEN_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          video_inputs: [{
            character: {
              type: 'avatar',
              avatar_id: avatarId,
              avatar_style: 'normal'
            },
            voice: {
              type: 'text',
              input_text: script,
              voice_id: VOICE_ID,
              speed: 1.0
            },
            background: {
              type: 'color',
              value: '#ffffff'
            }
          }],
          dimension: { width: 1080, height: 1920 }, // Portrait for TikTok
          aspect_ratio: null,
          test: false
        })
      });

      const data = await response.json();
      if (data.error) return res.status(400).json({ error: data.error, raw: data });
      return res.status(200).json({ video_id: data.data?.video_id });
    }

    // ── Check status ────────────────────────────────────────────
    if (action === 'status' && video_id) {
      const response = await fetch(
        `https://api.heygen.com/v1/video_status.get?video_id=${video_id}`,
        { headers: { 'X-Api-Key': HEYGEN_KEY } }
      );
      const data = await response.json();
      return res.status(200).json({
        status: data.data?.status,
        video_url: data.data?.video_url,
        thumbnail_url: data.data?.thumbnail_url,
        error: data.data?.error
      });
    }

    return res.status(400).json({ error: 'Invalid action' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
