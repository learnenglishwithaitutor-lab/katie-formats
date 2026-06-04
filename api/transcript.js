const APIFY_TOKEN = process.env.APIFY_TOKEN;
const ACTOR_ID = 'lofomachines~tiktok-transcription-ai';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { urls } = req.body;
  if (!urls || !urls.length) return res.status(400).json({ error: 'No URLs provided' });

  try {
    const response = await fetch(
      `https://api.apify.com/v2/acts/${ACTOR_ID}/run-sync-get-dataset-items?token=${APIFY_TOKEN}&timeout=300`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoUrls: urls,
          sourceLanguage: 'auto'
        })
      }
    );

    const items = await response.json();

    // Map transcript back by URL
    const transcripts = {};
    for (const item of items) {
      const url = item.video_url;
      const text = item.plain_text || item.transcription?.plain_text_without_timestamps || '';
      if (url) transcripts[url] = text;
    }

    return res.status(200).json({ transcripts });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
