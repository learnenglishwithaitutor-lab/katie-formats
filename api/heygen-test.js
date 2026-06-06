const HEYGEN_KEY = process.env.HEYGEN_API_KEY;
const VOICE_ID = 'bfa319fcf29646678baa4716c7f72f86';
const AVATAR_ID = '30cc2bb61cd44adb90ce84b4f1ef2fce';
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
      video_inputs: [{
        character: {
          type: 'talking_photo',
          talking_photo_id: AVATAR_ID
        },
        voice: {
          type: 'text',
          input_text: script,
          voice_id: VOICE_ID,
          speed: 0.95,
          emotion: 'Friendly'
        },
        background: {
          type: 'color',
          value: '#f5f0eb'
        }
      }],
      dimension: { width: 1080, height: 1920 },
      aspect_ratio: null,
      test: false
    };

    const r = await fetch('https://api.heygen.com/v2/video/generate', {
      method: 'POST',
      headers: { 'X-Api-Key': HEYGEN_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const d = await r.json();
    if (d.error) return res.status(400).json({ error: d.error, raw: d });
    return res.status(200).json({ video_id: d.data?.video_id });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
