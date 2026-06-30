// Streams an Apify-hosted video through our own domain so the browser
// can load it same-origin and read frames off a canvas (defeats both the
// 403 token wall and the missing-CORS-header wall).
//
// Honors HTTP Range requests OURSELVES (slicing the buffer) because <video>
// elements require a 206 + Content-Range handshake to begin decoding. Apify
// returns a full 200 even to ranged requests, so we must do the slicing here
// or the element stalls at networkState=LOADING and never gets metadata.
const APIFY_TOKEN = process.env.APIFY_TOKEN;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');
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
    // Fetch the FULL file from Apify (it ignores Range anyway), then do our
    // own range slicing for the browser.
    const upstream = await fetch(parsed.toString());
    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: `upstream ${upstream.status}` });
    }
    const full = Buffer.from(await upstream.arrayBuffer());
    const contentType = upstream.headers.get('content-type') || 'video/mp4';
    const total = full.length;

    res.setHeader('Content-Type', contentType);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-store');

    const range = req.headers['range'];
    if (range) {
      // Parse "bytes=start-end"
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : total - 1;
      if (isNaN(start) || start < 0) start = 0;
      if (isNaN(end) || end >= total) end = total - 1;
      if (start > end) { start = 0; end = total - 1; }

      const chunk = full.subarray(start, end + 1);
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
      res.setHeader('Content-Length', chunk.length);
      return res.end(chunk);
    }

    // No range — return full file
    res.statusCode = 200;
    res.setHeader('Content-Length', total);
    return res.end(full);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
