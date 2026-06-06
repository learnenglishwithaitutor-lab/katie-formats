const HEYGEN_KEY = process.env.HEYGEN_API_KEY;
const VOICE_ID = 'bfa319fcf29646678baa4716c7f72f86';
const IMAGE_URL = 'https://raw.githubusercontent.com/learnenglishwithaitutor-lab/katie-formats/main/sarah_new_realistic.png';
const DEFAULT_SCRIPT = `I used to freeze every time I had to speak English at work. My heart would race and my mind would go blank. I knew the words, but they just wouldn't come out. If that sounds familiar, I made this for you.`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { video_id } = req.query;

  try {
    if (video_id) {
      const r = await fetch(`https://api.heygen.com/v1/video_status.get?video_id=${video_id}`, {
        headers: { 'X-Api-Key': HEYGEN_KEY }
      });
      const d = await r.json();
      return res.status(200).json({
        status: d.data?.status,
        video_url: d.data?.video_url,
        error: d.data?.error
      });
    }

    const script = req.body?.script || DEFAULT_SCRIPT;

    const body = {
      image: { type: 'url', url: IMAGE_URL },
      script,
      voice_id: VOICE_ID,
      voice_settings: { speed: 0.95 },
      expressiveness: 'high',
      motion_prompt: 'speak naturally with warm expressive facial movements, subtle head nods, natural blinking',
      aspect_ratio: '9:16',
      background: { type: 'color', value: '#f5f0eb' },
      title: 'Sarah test - create_video_from_image'
    };

    const r = await fetch('https://api.heygen.com/v3/video/from-image', {
      method: 'POST',
      headers: { 'X-Api-Key': HEYGEN_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const d = await r.json();
    if (d.error) return res.status(400).json({ error: d.error, raw: d });
    return res.status(200).json({ video_id: d.data?.video_id, notes: 'create_video_from_image, expressiveness high' });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
