// Katie Project Index — persistence endpoint.
//
// Stores the project-index JSON (cards/streams/entries for katie-project-index.html)
// in a dedicated tab ("claude_index") of the existing KatiePipeline Google Sheet,
// chunked across column A cells (Sheets caps a cell at 50k chars).
//
//   GET  /api/index-data?secret=...          -> { ok, data }   (data = parsed JSON, or null if never saved)
//   POST /api/index-data?secret=...          -> { ok }         (body = the full JSON document to save)
//
// Reuses the same service-account env vars as sheets.js:
//   GOOGLE_SHEET_ID, GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY
//
// The secret is a light tamper-deterrent, not real security (this repo is public);
// the data it guards is a bookmarks/notes list.

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

const TAB = 'claude_index';
const CHUNK = 40000; // chars per cell, safely under the 50k cell cap
const MAX_ROWS = 200;
const SECRET = 'kti-9f4e2ab7c1';

async function getAccessToken() {
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: CLIENT_EMAIL,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
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
  return tokenData.access_token;
}

async function ensureTab(token) {
  const meta = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}?fields=sheets.properties.title`,
    { headers: { Authorization: `Bearer ${token}` } }
  ).then(r => r.json());
  const exists = (meta.sheets || []).some(s => s.properties?.title === TAB);
  if (exists) return;
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}:batchUpdate`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: TAB } } }] })
    }
  );
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const secret = req.query?.secret || req.headers['x-index-secret'];
  if (secret !== SECRET) return res.status(401).json({ error: 'bad secret' });

  if (!SHEET_ID || !CLIENT_EMAIL || !PRIVATE_KEY) {
    return res.status(500).json({ error: 'sheet service-account env vars not set' });
  }

  try {
    const token = await getAccessToken();
    await ensureTab(token);

    if (req.method === 'GET') {
      const r = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${TAB}!A1:A${MAX_ROWS}`,
        { headers: { Authorization: `Bearer ${token}` } }
      ).then(x => x.json());
      const chunks = (r.values || []).map(row => row[0] || '');
      const raw = chunks.join('');
      if (!raw.trim()) return res.status(200).json({ ok: true, data: null });
      let data;
      try { data = JSON.parse(raw); }
      catch (e) { return res.status(500).json({ error: 'stored data is not valid JSON', raw: raw.slice(0, 200) }); }
      return res.status(200).json({ ok: true, data });
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const doc = body.data !== undefined ? body.data : body;
      const raw = JSON.stringify(doc);
      if (raw.length > CHUNK * MAX_ROWS) {
        return res.status(413).json({ error: 'index too large' });
      }
      const rows = [];
      for (let i = 0; i < raw.length; i += CHUNK) rows.push([raw.slice(i, i + CHUNK)]);

      // Clear the column first so stale trailing chunks never survive a shrink
      await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${TAB}!A1:A${MAX_ROWS}:clear`,
        { method: 'POST', headers: { Authorization: `Bearer ${token}` } }
      );
      const w = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${TAB}!A1?valueInputOption=RAW`,
        {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ values: rows })
        }
      ).then(x => x.json());
      if (w.error) return res.status(500).json({ error: 'write failed', detail: w.error });
      return res.status(200).json({ ok: true, chunks: rows.length, bytes: raw.length });
    }

    return res.status(405).json({ error: 'GET or POST only' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
