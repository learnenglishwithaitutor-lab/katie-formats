const ACTOR_ID = 'GdWCkxBtKWOsKjdch';
const APIFY_TOKEN = process.env.APIFY_TOKEN;
const PROFILES = [
  'https://www.tiktok.com/@starvicks51',
  'https://www.tiktok.com/@fluently.kate',
  'https://www.tiktok.com/@lola_englishspeak',
  'https://www.tiktok.com/@keisha.learns'
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { action, runId, datasetId } = req.query;

  try {
    // Start a new run
    if (action === 'start') {
      const response = await fetch(
        `https://api.apify.com/v2/acts/${ACTOR_ID}/runs?token=${APIFY_TOKEN}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            profiles: PROFILES,
            resultsPerPage: 30,
            shouldDownloadVideos: false,
            shouldDownloadCovers: false
          })
        }
      );
      const data = await response.json();
      return res.status(200).json({ runId: data.data?.id, status: data.data?.status });
    }

    // Check run status
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

    // Fetch dataset results
    if (action === 'results' && datasetId) {
      const fiveDaysAgo = Math.floor(Date.now() / 1000) - (5 * 24 * 60 * 60);
      const response = await fetch(
        `https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}&limit=200`
      );
      const items = await response.json();

      // Filter to last 5 days and map to our format
      const videos = items
        .filter(item => item.createTimeISO && new Date(item.createTimeISO).getTime() / 1000 > fiveDaysAgo)
        .map(item => ({
          title: item.text || item.desc || 'No caption',
          views: item.playCount || 0,
          url: item.webVideoUrl || `https://www.tiktok.com/@${item.authorMeta?.name}/video/${item.id}`,
          thumbnail: item.videoMeta?.coverUrl || item.covers?.default || '',
          author: item.authorMeta?.name || '',
          created: item.createTimeISO
        }));

      return res.status(200).json({ videos });
    }

    res.status(400).json({ error: 'Invalid action' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
