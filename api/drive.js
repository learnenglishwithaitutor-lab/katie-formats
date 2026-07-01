// Uploads generated video clips to a Google Drive folder on the user's
// behalf. No server-side token storage: the browser sends its stored
// refresh_token on each call; this function exchanges it for a short-lived
// access_token (never persisted) and uploads with that.

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  if (!CLIENT_ID || !CLIENT_SECRET) {
    return res.status(500).json({ error: 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set in Vercel env vars.' });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  const { refreshToken, folderId, videos } = body;
  if (!refreshToken) return res.status(400).json({ error: 'not connected to Google — refreshToken missing' });
  if (!Array.isArray(videos) || !videos.length) return res.status(400).json({ error: 'videos array required' });

  try {
    // 1. Exchange the refresh token for a fresh access token (short-lived, never stored)
    const tokRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: 'refresh_token'
      })
    });
    const tokData = await tokRes.json();
    if (!tokRes.ok || !tokData.access_token) {
      return res.status(401).json({ error: 'Google auth expired or revoked — reconnect. (' + (tokData.error || tokRes.status) + ')' });
    }
    const accessToken = tokData.access_token;

    // 2. Upload each video (sequential — keeps memory bounded on serverless)
    const results = [];
    for (const v of videos) {
      try {
        const vr = await fetch(v.url);
        if (!vr.ok) throw new Error('download failed: ' + vr.status);
        const buf = Buffer.from(await vr.arrayBuffer());
        const filename = (v.filename || 'katie_video.mp4').replace(/[^a-zA-Z0-9_.-]/g, '_');

        const metadata = { name: filename };
        if (folderId) metadata.parents = [folderId];

        const boundary = 'katieboundary' + Date.now();
        const multipartBody = Buffer.concat([
          Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: video/mp4\r\n\r\n`, 'utf8'),
          buf,
          Buffer.from(`\r\n--${boundary}--`, 'utf8')
        ]);

        const upRes = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + accessToken,
            'Content-Type': `multipart/related; boundary=${boundary}`
          },
          body: multipartBody
        });
        const upData = await upRes.json();
        if (!upRes.ok) throw new Error(upData.error?.message || ('upload failed: ' + upRes.status));

        results.push({ filename, ok: true, fileId: upData.id, link: upData.webViewLink });
      } catch (e) {
        results.push({ filename: v.filename || 'unknown', ok: false, error: e.message });
      }
    }

    return res.status(200).json({ ok: true, results });
  } catch (e) {
    return res.status(500).json({ error: 'drive upload failed: ' + e.message });
  }
}
