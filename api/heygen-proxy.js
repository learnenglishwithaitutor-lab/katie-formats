const HEYGEN_KEY = process.env.HEYGEN_API_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { endpoint } = req.query;
  if (!endpoint) return res.status(400).json({ error: 'No endpoint' });

  try {
    const r = await fetch(`https://api.heygen.com/${endpoint}`, {
      headers: { 'X-Api-Key': HEYGEN_KEY, 'Content-Type': 'application/json' }
    });
    const data = await r.json();
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
