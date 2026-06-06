export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, assetId } = req.body;

  try {
    // Complete a v3 asset upload after S3 PUT
    if (action === 'complete') {
      const resp = await fetch(`https://api.heygen.com/v3/assets/${assetId}/complete`, {
        method: 'POST',
        headers: { 'X-Api-Key': process.env.HEYGEN_API_KEY, 'Content-Type': 'application/json' }
      });
      const data = await resp.json();
      return res.status(200).json(data);
    }

    // Create photo avatar from v3 asset
    if (action === 'create_photo_avatar') {
      const { name } = req.body;
      const resp = await fetch('https://api.heygen.com/v2/photo_avatar', {
        method: 'POST',
        headers: { 'X-Api-Key': process.env.HEYGEN_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_asset_id: assetId, name: name || 'Sarah v2' })
      });
      const data = await resp.json();
      return res.status(200).json(data);
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
