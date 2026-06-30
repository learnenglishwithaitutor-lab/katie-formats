const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

// Create JWT for Google API auth
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

  // Import private key
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
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(sigInput)
  );

  const sig64 = btoa(String.fromCharCode(...new Uint8Array(sigBuffer)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  const jwt = `${sigInput}.${sig64}`;

  // Exchange JWT for access token
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  });
  const tokenData = await tokenRes.json();
  return tokenData.access_token;
}

// ── Ensure a tab (sheet) exists, return true if present/created ──
async function ensureTab(token, title) {
  const meta = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}?fields=sheets.properties.title`,
    { headers: { Authorization: `Bearer ${token}` } }
  ).then(r => r.json());
  const exists = (meta.sheets || []).some(s => s.properties?.title === title);
  if (exists) return true;
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}:batchUpdate`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title } } }] })
    }
  );
  return true;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.method === 'GET' ? req.query.action : (req.body?.action);

  // ── action=queue: write the work order (approved batch) to the Queue tab ──
  // Columns: ID | VideoURL | Author | Script | Status | PromptPngLink | OutputUrl
  if (action === 'queue') {
    try {
      const items = req.body?.items || [];
      if (!items.length) return res.status(400).json({ error: 'no items' });
      const token = await getAccessToken();
      await ensureTab(token, 'Queue');

      // Add header row if Queue is empty
      const head = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/Queue!A1:G1`,
        { headers: { Authorization: `Bearer ${token}` } }
      ).then(r => r.json());
      const values = [];
      if (!head.values || !head.values.length) {
        values.push(['ID', 'VideoURL', 'Author', 'Script', 'Status', 'PromptPngLink', 'OutputUrl']);
      }
      for (const it of items) {
        const id = it.id || (Date.now() + '-' + Math.random().toString(36).slice(2, 7));
        values.push([ id, it.videoUrl || '', it.author || '', it.script || '', 'pending', '', '' ]);
      }
      const appendRes = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/Queue!A1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ values })
        }
      ).then(r => r.json());
      return res.status(200).json({ ok: true, queued: items.length, updatedRange: appendRes.updates?.updatedRange });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── action=updaterow: update a Queue row by ID (Cowork calls this) ──
  // Body: { action:'updaterow', id, status?, promptPngLink?, outputUrl? }
  if (action === 'updaterow') {
    try {
      const { id, status, promptPngLink, outputUrl } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id required' });
      const token = await getAccessToken();

      // Read the Queue to find which row this ID is on
      const data = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/Queue!A2:G10000`,
        { headers: { Authorization: `Bearer ${token}` } }
      ).then(r => r.json());
      const rows = data.values || [];
      const idx = rows.findIndex(r => r[0] === id);
      if (idx === -1) return res.status(404).json({ error: 'id not found in Queue' });

      const sheetRow = idx + 2; // +2: header is row 1, data starts row 2
      const current = rows[idx];
      // Columns: A=ID B=VideoURL C=Author D=Script E=Status F=PromptPngLink G=OutputUrl
      const newStatus  = status        !== undefined ? status        : (current[4] || '');
      const newPng     = promptPngLink !== undefined ? promptPngLink : (current[5] || '');
      const newOutput  = outputUrl     !== undefined ? outputUrl     : (current[6] || '');

      const updateRes = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/Queue!E${sheetRow}:G${sheetRow}?valueInputOption=USER_ENTERED`,
        {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ values: [[ newStatus, newPng, newOutput ]] })
        }
      ).then(r => r.json());

      return res.status(200).json({ ok: true, id, row: sheetRow, updated: updateRes.updatedCells || 0 });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── action=clearqueue: wipe all Queue rows below the header ──
  if (action === 'clearqueue') {
    try {
      const token = await getAccessToken();
      await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/Queue!A2:G10000:clear`,
        { method: 'POST', headers: { Authorization: `Bearer ${token}` } }
      );
      return res.status(200).json({ ok: true, cleared: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── action=readqueue: read Queue rows (optionally filter by status) ──
  if (action === 'readqueue') {
    try {
      const token = await getAccessToken();
      const data = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/Queue!A2:G1000`,
        { headers: { Authorization: `Bearer ${token}` } }
      ).then(r => r.json());
      const wantStatus = req.query.status;
      const rows = (data.values || []).map(r => ({
        id: r[0], videoUrl: r[1], author: r[2], script: r[3],
        status: r[4], promptPngLink: r[5], outputUrl: r[6]
      })).filter(r => r.id && (!wantStatus || r.status === wantStatus));
      return res.status(200).json({ rows });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { rows } = req.body; // array of approved scripts
    if (!rows || !rows.length) return res.status(400).json({ error: 'No rows provided' });

    const token = await getAccessToken();

    // First check if sheet has headers, if not add them
    const sheetRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/A1:G1`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const sheetData = await sheetRes.json();
    const hasHeaders = sheetData.values && sheetData.values.length > 0;

    const values = [];
    if (!hasHeaders) {
      values.push(['Date', 'Thumbnail', 'Source Account', 'Source Video URL', 'Original Caption', 'Generated Script', 'Video URL']);
    }

    for (const row of rows) {
      values.push([
        new Date().toLocaleDateString('en-GB'),
        row.thumbnail ? `=IMAGE("${row.thumbnail}")` : '',
        row.author ? `@${row.author}` : '',
        row.url || '',
        row.originalCaption || '',
        row.script || '',
        row.video_url || ''
      ]);
    }

    const appendRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/A1:G1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ values })
      }
    );

    const appendData = await appendRes.json();
    return res.status(200).json({ success: true, updatedRows: appendData.updates?.updatedRows });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
