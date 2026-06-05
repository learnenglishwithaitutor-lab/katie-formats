const ACTOR_ID = 'GdWCkxBtKWOsKjdch';
const APIFY_TOKEN = process.env.APIFY_TOKEN;

const DEFAULT_PROFILES = [
  'https://www.tiktok.com/@starvicks51',
  'https://www.tiktok.com/@fluently.kate',
  'https://www.tiktok.com/@lola_englishspeak',
  'https://www.tiktok.com/@keisha.learns'
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action, runId, datasetId } = req.query;

  try {
    if (action === 'start') {
      let profiles = DEFAULT_PROFILES;
      if (req.method === 'POST' && req.body?.profiles?.length > 0) {
        profiles = req.body.profiles;
      }
      const response = await fetch(
        `https://api.apify.com/v2/acts/${ACTOR_ID}/runs?token=${APIFY_TOKEN}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            profiles,
            resultsPerPage: 30,
            shouldDownloadVideos: false,
            shouldDownloadCovers: false
          })
        }
      );
      const data = await response.json();
      if (!data.data?.id) return res.status(200).json({ debug: data }); return res.status(200).json({ runId: data.data?.id, status: data.data?.status });
    }

    if (action === 'status' && runId) {
      const response = await fetch(
        `https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`
      );
      const data = await response.json();
      return res.status(200).json({
        status: data.data?.status,
        datasetId: data.data?.defaultDatasetId
      });
    }

    if (action === 'results' && datasetId) {
      const fiveDaysAgo = Math.floor(Date.now() / 1000) - (5 * 24 * 60 * 60);
      const response = await fetch(
        `https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}&limit=200`
      );
      const items = await response.json();

      const filtered = items.filter(item =>
        item.createTimeISO && new Date(item.createTimeISO).getTime() / 1000 > fiveDaysAgo
      );

      const videos = filtered.map(item => ({
        title:     item.text || item.desc || 'No caption',
        views:     item.playCount || 0,
        comments:  item.commentCount || 0,
        url:       item.webVideoUrl || `https://www.tiktok.com/@${item.authorMeta?.name}/video/${item.id}`,
        thumbnail: item.videoMeta?.coverUrl || item.covers?.default || '',
        author:    item.authorMeta?.name || '',
        created:   item.createTimeISO
      }));

      return res.status(200).json({ videos });
    }

    // ── Debug endpoint ──────────────────────────────────────────
    if (action === 'debug' && datasetId) {
      const fiveDaysAgo = Math.floor(Date.now() / 1000) - (5 * 24 * 60 * 60);
      const response = await fetch(
        `https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}&limit=200`
      );
      const items = await response.json();

      // Group by author, show all dates
      const byAuthor = {};
      for (const item of items) {
        const author = item.authorMeta?.name || 'unknown';
        if (!byAuthor[author]) byAuthor[author] = [];
        byAuthor[author].push({
          date: item.createTimeISO || null,
          withinWindow: item.createTimeISO
            ? new Date(item.createTimeISO).getTime() / 1000 > fiveDaysAgo
            : false
        });
      }

      const summary = Object.entries(byAuthor).map(([author, posts]) => ({
        author,
        totalReturned: posts.length,
        withinLast5Days: posts.filter(p => p.withinWindow).length,
        dates: posts.map(p => p.date)
      }));

      return res.status(200).json({
        totalRawItems: items.length,
        totalAfterFilter: items.filter(item =>
          item.createTimeISO && new Date(item.createTimeISO).getTime() / 1000 > fiveDaysAgo
        ).length,
        fiveDaysAgoCutoff: new Date(fiveDaysAgo * 1000).toISOString(),
        byAuthor: summary
      });
    }

    res.status(400).json({ error: 'Invalid action' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
