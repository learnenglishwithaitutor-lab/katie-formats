// Google Drive I/O for the Cowork hand-off.
// Reuses the same service account as sheets.js, with the Drive scope added.
//
// Folder layout (shared with the service account as Editor):
//   KatiePipeline/        <- KATIE_DRIVE_FOLDER_ID
//     inbox/              <- app writes work orders here
//     ready/              <- Mac (Dispatch) writes prompt PNGs here

const CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
const ROOT_FOLDER_ID = process.env.KATIE_DRIVE_FOLDER_ID || '1mYDcBby1uBxDDoH0t3TwyCXYCbIn02jU';

// ── Service-account JWT → access token (Drive + Sheets scopes) ──
async function getAccessToken() {
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: CLIENT_EMAIL,
    scope: 'https://www.googleapis.com/auth/drive',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  };
  const encode = obj => btoa(JSON.stringify(obj))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const header64 = encode(header);
  const claim64 = encode(claim);
  const sigInput = `${header64}.${claim64}`;

  const pemContents = PRIVATE_KEY
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s/g, '');
  const keyBuffer = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', keyBuffer.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );
  const sigBuffer = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(sigInput)
  );
  const sig64 = btoa(String.fromCharCode(...new Uint8Array(sigBuffer)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const jwt = `${sigInput}.${sig64}`;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error('Auth failed: ' + JSON.stringify(tokenData));
  return tokenData.access_token;
}

// ── Find a subfolder by name under a parent ───────────────────
async function findFolder(token, parentId, name) {
  const q = encodeURIComponent(
    `name='${name}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`
  );
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&supportsAllDrives=true&includeItemsFromAllDrives=true`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  return data.files?.[0]?.id || null;
}

// ── List files in a folder ────────────────────────────────────
async function listFolder(token, folderId) {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,mimeType,modifiedTime)&supportsAllDrives=true&includeItemsFromAllDrives=true&orderBy=modifiedTime desc`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return res.json();
}

// ── Write a text file into a folder (multipart upload) ────────
async function writeFile(token, folderId, name, content, mimeType = 'application/json') {
  const boundary = '-------katie' + Date.now();
  const metadata = { name, parents: [folderId] };
  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n` +
    `${content}\r\n` +
    `--${boundary}--`;

  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`
      },
      body
    }
  );
  const data = await res.json();
  if (!data.id) throw new Error('Write failed: ' + JSON.stringify(data));
  return data;
}

// ── Read a file's content by ID ───────────────────────────────
async function readFile(token, fileId) {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return res.text();
}

// ── Handler ───────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.method === 'GET' ? req.query.action : req.body?.action;

  try {
    const token = await getAccessToken();

    // test: write a file to inbox, read it back, confirm round-trip
    if (action === 'test') {
      const inboxId = await findFolder(token, ROOT_FOLDER_ID, 'inbox');
      const readyId = await findFolder(token, ROOT_FOLDER_ID, 'ready');
      if (!inboxId) return res.status(500).json({ error: 'inbox folder not found — check sharing/folder ID' });

      const stamp = new Date().toISOString();
      const written = await writeFile(token, inboxId, `roundtrip-test-${Date.now()}.json`,
        JSON.stringify({ hello: 'katie', stamp }));
      const readBack = await readFile(token, written.id);

      return res.status(200).json({
        ok: true,
        inboxFound: !!inboxId,
        readyFound: !!readyId,
        wroteFileId: written.id,
        wroteName: written.name,
        readBackMatches: JSON.parse(readBack).stamp === stamp,
        readBack: JSON.parse(readBack)
      });
    }

    // list: see what's in inbox or ready
    if (action === 'list') {
      const which = (req.query.folder || req.body?.folder) === 'ready' ? 'ready' : 'inbox';
      const folderId = await findFolder(token, ROOT_FOLDER_ID, which);
      if (!folderId) return res.status(500).json({ error: `${which} folder not found` });
      const listing = await listFolder(token, folderId);
      return res.status(200).json({ folder: which, files: listing.files || [] });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
