// v2
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, asset_id, name, avatar_group_id } = req.body;

  try {
    if (action === 'create_photo_avatar') {
      const body = {
        image_asset_id: asset_id,
        name: name || 'Sarah v2'
      };
      if (avatar_group_id) body.avatar_group_id = avatar_group_id;

      const response = await fetch('https://api.heygen.com/v2/photo_avatar/avatar/create', {
        method: 'POST',
        headers: {
          'X-Api-Key': process.env.HEYGEN_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });
      const data = await response.json();
      return res.status(200).json(data);
    }

    if (action === 'get_avatar') {
      const { avatar_id } = req.body;
      const response = await fetch(`https://api.heygen.com/v2/photo_avatar/${avatar_id}`, {
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
