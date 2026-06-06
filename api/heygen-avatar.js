// v3
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action } = req.body;

  try {
    // Register uploaded asset as a talking photo (returns talking_photo_id)
    if (action === 'create_talking_photo') {
      const { asset_id, name } = req.body;
      const response = await fetch('https://api.heygen.com/v1/talking_photo', {
        method: 'POST',
        headers: {
          'X-Api-Key': process.env.HEYGEN_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ image_asset_id: asset_id, name: name || 'Sarah v2' })
      });
      const data = await response.json();
      return res.status(200).json(data);
    }

    // List existing talking photos to find IDs
    if (action === 'list_talking_photos') {
      const response = await fetch('https://api.heygen.com/v1/talking_photo.list', {
        headers: { 'X-Api-Key': process.env.HEYGEN_API_KEY }
      });
      const data = await response.json();
      return res.status(200).json(data);
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
