// Streams an Apify-hosted video through our own domain so the browser
// can load it same-origin and read frames off a canvas (defeats both the
// 403 token wall and the missing-CORS-header wall).
const APIFY_TOKEN = process.env.APIFY_TOKEN;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });

  // SSRF guard — only allow Apify hosts
  let parsed;
  try { parsed = new URL(url); } catch { return res.status(400).json({ error: 'bad url' }); }
  if (!/(^|\.)apify\.com$/.test(parsed.host)) {
    return res.status(403).json({ error: 'only apify hosts allowed' });
  }

  // Attach token if the URL doesn't already carry one
  if (!parsed.searchParams.get('token') && APIFY_TOKEN) {
    parsed.searchParams.set('token', APIFY_TOKEN);
  }

  try {
    const upstream = await fetch(parsed.toString());
    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: `upstream ${upstream.status}` });
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'video/mp4');
    res.setHeader('Content-Length', buf.length);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(buf);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
