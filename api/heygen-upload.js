export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, imageUrl, name } = req.body;

  try {
    if (action === 'create_talking_photo') {
      const resp = await fetch('https://api.heygen.com/v1/talking_photo', {
        method: 'POST',
        headers: { 'X-Api-Key': process.env.HEYGEN_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_url: imageUrl, name: name || 'Sarah v2' })
      });
      const text = await resp.text();
      return res.status(resp.status).send(text);
    }
    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
