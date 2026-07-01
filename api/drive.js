// Uploads generated videos to Google Drive.
//
// Request shape:
//   { refreshToken, folderId, groups: [ { author, clips: [{url, filename}, ...] }, ... ] }
//
// Rule (per user spec):
//   - group with 1 clip  -> upload that single file directly into folderId, no subfolder
//   - group with 2+ clips -> create a subfolder inside folderId, upload every clip into it,
//                            AND stitch them (server-side, via the decode service) and upload
//                            the stitched result into the same subfolder
//
// The stitched video is produced HERE (Vercel -> Railway decode service) rather than being
// sent up from the browser, so its bytes never have to cross the browser's request-body
// limit -- they go decode-service -> this function -> Google Drive directly.

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const DECODE_URL    = process.env.DECODE_SERVICE_URL || 'https://katie-decode-production.up.railway.app';
const DECODE_SECRET = process.env.DECODE_SECRET;

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
  const { refreshToken, folderId, groups } = body;
  if (!refreshToken) return res.status(400).json({ error: 'not connected to Google - refreshToken missing' });
  if (!Array.isArray(groups) || !groups.length) return res.status(400).json({ error: 'groups array required' });

  try {
    const accessToken = await refreshAccessToken(refreshToken);

    const groupResults = [];
    for (const group of groups) {
      const author = (group.author || 'video').replace(/[^a-zA-Z0-9_.-]/g, '_');
      const clips = Array.isArray(group.clips) ? group.clips : [];
      if (!clips.length) { groupResults.push({ author, results: [] }); continue; }

      const results = [];

      if (clips.length === 1) {
        // Single clip -> upload directly into the top-level folder, no subfolder
        const r = await uploadClipToDrive(accessToken, clips[0], folderId || null);
        results.push(r);
      } else {
        // Multiple clips -> subfolder containing all clips + the stitched video
        let subfolderId = null;
        try {
          subfolderId = await driveCreateFolder(accessToken, `katie_${author}_${stamp()}`, folderId || null);
        } catch (e) {
          groupResults.push({ author, results: [{ filename: author, ok: false, error: 'folder creation failed: ' + e.message }] });
          continue;
        }

        // Upload each individual clip into the subfolder
        for (const clip of clips) {
          const r = await uploadClipToDrive(accessToken, clip, subfolderId);
          results.push(r);
        }

        // Stitch server-side (decode service) and upload the result into the same subfolder
        try {
          const stitchedBuf = await stitchClips(clips.map(c => c.url));
          const stitchedName = `katie_${author}_STITCHED.mp4`;
          const up = await driveUploadBuffer(accessToken, stitchedBuf, stitchedName, subfolderId);
          results.push({ filename: stitchedName, ok: true, fileId: up.id, link: up.webViewLink });
        } catch (e) {
          results.push({ filename: `katie_${author}_STITCHED.mp4`, ok: false, error: 'stitch failed: ' + e.message });
        }
      }

      groupResults.push({ author, results });
    }

    return res.status(200).json({ ok: true, groups: groupResults });
  } catch (e) {
    if (/invalid_grant|unauthorized/i.test(e.message)) {
      return res.status(401).json({ error: 'Google auth expired or revoked - reconnect. (' + e.message + ')' });
    }
    return res.status(500).json({ error: 'drive upload failed: ' + e.message });
  }
}

// -- Helpers --------------------------------------------------------

async function refreshAccessToken(refreshToken) {
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
    throw new Error(tokData.error || ('token refresh failed: ' + tokRes.status));
  }
  return tokData.access_token;
}

async function uploadClipToDrive(accessToken, clip, parentId) {
  const filename = (clip.filename || 'katie_video.mp4').replace(/[^a-zA-Z0-9_.-]/g, '_');
  try {
    const vr = await fetch(clip.url);
    if (!vr.ok) throw new Error('download failed: ' + vr.status);
    const buf = Buffer.from(await vr.arrayBuffer());
    const up = await driveUploadBuffer(accessToken, buf, filename, parentId);
    return { filename, ok: true, fileId: up.id, link: up.webViewLink };
  } catch (e) {
    return { filename, ok: false, error: e.message };
  }
}

async function driveUploadBuffer(accessToken, buffer, filename, parentId) {
  const metadata = { name: filename };
  if (parentId) metadata.parents = [parentId];

  const boundary = 'katieboundary' + Date.now() + Math.random().toString(36).slice(2);
  const multipartBody = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: video/mp4\r\n\r\n`, 'utf8'),
    buffer,
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
  return upData;
}

async function driveCreateFolder(accessToken, name, parentId) {
  const metadata = { name, mimeType: 'application/vnd.google-apps.folder' };
  if (parentId) metadata.parents = [parentId];
  const fRes = await fetch('https://www.googleapis.com/drive/v3/files?fields=id', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(metadata)
  });
  const fData = await fRes.json();
  if (!fRes.ok) throw new Error(fData.error?.message || ('folder create failed: ' + fRes.status));
  return fData.id;
}

// Calls the decode service's /stitch endpoint and returns the MP4 as a Buffer
// (kept entirely server-side -- never sent to the browser in this flow).
async function stitchClips(clipUrls) {
  const dres = await fetch(`${DECODE_URL}/stitch`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(DECODE_SECRET ? { 'x-decode-secret': DECODE_SECRET } : {})
    },
    body: JSON.stringify({ clips: clipUrls })
  });
  if (!dres.ok) {
    let msg = dres.status;
    try { const j = await dres.json(); msg = j.error || msg; } catch {}
    throw new Error(String(msg));
  }
  const arrayBuf = await dres.arrayBuffer();
  return Buffer.from(arrayBuf);
}

function stamp() {
  return new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
}
