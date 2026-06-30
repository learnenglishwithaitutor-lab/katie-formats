// Streams an Apify-hosted video through our own domain so the browser
// can load it same-origin and read frames off a canvas (defeats both the
// 403 token wall and the missing-CORS-header wall).
//
// Supports HTTP Range requests — <video> elements require this to start
// playback; without it the element stalls and never fires loadeddata.
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
    // Forward the browser's Range header upstream so we can return 206 partials
    const range = req.headers['range'];
    const upstreamHeaders = {};
    if (range) upstreamHeaders['Range'] = range;

    const upstream = await fetch(parsed.toString(), { headers: upstreamHeaders });
    if (!upstream.ok && upstream.status !== 206) {
      return res.status(upstream.status).json({ error: `upstream ${upstream.status}` });
    }

    const buf = Buffer.from(await upstream.arrayBuffer());
    const contentType = upstream.headers.get('content-type') || 'video/mp4';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-store');

    // Mirror upstream's range response if present
    const contentRange = upstream.headers.get('content-range');
    if (contentRange) res.setHeader('Content-Range', contentRange);
    res.setHeader('Content-Length', buf.length);

    // 206 if upstream gave a partial (or we asked for a range), else 200
    const status = upstream.status === 206 ? 206 : 200;
    return res.status(status).send(buf);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
