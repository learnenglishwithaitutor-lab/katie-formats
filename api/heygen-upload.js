export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { imageBase64, mimeType = 'image/png', uploadUrl, assetId } = req.body;
  if (!imageBase64 || !uploadUrl || !assetId) {
    return res.status(400).json({ error: 'Missing imageBase64, uploadUrl, or assetId' });
  }

  try {
    const buffer = Buffer.from(imageBase64, 'base64');

    // Step 1: PUT to S3 presigned URL
    const s3Resp = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': mimeType,
        'Content-Length': buffer.length,
        'x-amz-server-side-encryption': 'AES256'
      },
      body: buffer
    });

    if (!s3Resp.ok) {
      const text = await s3Resp.text();
      return res.status(500).json({ error: 'S3 upload failed', status: s3Resp.status, body: text.slice(0, 300) });
    }

    // Step 2: Complete the upload
    const completeResp = await fetch(`https://api.heygen.com/v3/assets/${assetId}/complete`, {
      method: 'POST',
      headers: {
        'X-Api-Key': process.env.HEYGEN_API_KEY,
        'Content-Type': 'application/json'
      }
    });
    const completeData = await completeResp.json();
    return res.status(200).json({ s3Status: s3Resp.status, complete: completeData });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
