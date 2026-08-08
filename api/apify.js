import { DISCOVER_ACTIONS, handleDiscover } from '../lib/discover.js';
import { CLASSIFY_ACTIONS, handleClassify } from '../lib/classify.js';
import { SCREEN_ACTIONS, handleScreen } from '../lib/screen.js';

const ACTOR_ID = 'GdWCkxBtKWOsKjdch';
const APIFY_TOKEN = process.env.APIFY_TOKEN;

// How far back a candidate can have been posted. Older than this and the
// format has usually already been copied to death.
const RECENCY_MONTHS = 6;

// A post counts as a breakout when it beat its own creator's median by this
// much. Same number lib/discover.js uses, so a creator's badge and its videos
// can't disagree.
const OUTLIER_X = 3;

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const postedAt = item =>
  item.createTimeISO
    ? new Date(item.createTimeISO).getTime()
    : (item.createTime || 0) * 1000;

// Turn a raw Apify dump into candidates: recent posts only, each scored
// against its own creator's normal rather than against other creators. A
// 20k-view post is a hit on a small account and a flop on a big one, so an
// absolute view count would just rank the biggest creator first every time.
function rankVideos(items, monthsBack = RECENCY_MONTHS) {
  const cutoff = Date.now() - monthsBack * 30 * 24 * 60 * 60 * 1000;

  const byAuthor = {};
  for (const item of items) {
    const author = item.authorMeta?.name || 'unknown';
    (byAuthor[author] = byAuthor[author] || []).push(item);
  }

  const videos = [];
  for (const author of Object.keys(byAuthor)) {
    // The median comes from everything scraped, not just the recent slice —
    // a creator's normal is better measured over the longer run, and a burst
    // of recent hits shouldn't quietly raise the bar it's being judged by.
    const med = median(byAuthor[author].map(i => i.playCount || 0).filter(Boolean));

    for (const item of byAuthor[author]) {
      if (postedAt(item) < cutoff) continue;
      const views = item.playCount || 0;
      videos.push({
        title:      item.text || item.desc || 'No caption',
        views,
        comments:   item.commentCount || 0,
        url:        item.webVideoUrl || `https://www.tiktok.com/@${author}/video/${item.id}`,
        videoFile:  (Array.isArray(item.mediaUrls) && item.mediaUrls[0]) || '',
        thumbnail:  item.videoMeta?.coverUrl || item.covers?.default || '',
        author,
        created:    item.createTimeISO,
        duration:   item.videoMeta?.duration || 0,
        hashtags:   (item.hashtags || []).map(h => h.name).filter(Boolean),
        // TikTok's own speech-to-text, handed over with the scrape. Free, and
        // far better evidence than a caption for what a video actually taught.
        subtitleUrl: item.videoMeta?.subtitleLinks?.find(s => /^eng/i.test(s.language))?.downloadLink || '',
        isSlideshow: !!item.isSlideshow,
        medianViews: med,
        outlierRatio: med > 0 ? +(views / med).toFixed(1) : 0,
        isOutlier:   med > 0 && views >= med * OUTLIER_X
      });
    }
  }

  // Best-performing relative to its own creator first.
  return videos.sort((a, b) => b.outlierRatio - a.outlierRatio);
}

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

  // Creator discovery and cover classification share this endpoint so they
  // don't spend the remaining serverless-function slots (the plan caps at 12).
  // See lib/discover.js and lib/classify.js.
  if (DISCOVER_ACTIONS.includes(action)) return handleDiscover(req, res);
  if (CLASSIFY_ACTIONS.includes(action)) return handleClassify(req, res);
  if (SCREEN_ACTIONS.includes(action)) return handleScreen(req, res);

  try {
    if (action === 'start') {
      let profiles = DEFAULT_PROFILES;
      if (req.method === 'POST' && req.body?.profiles?.length > 0) {
        profiles = req.body.profiles;
      }
      // Allow a one-off test run that downloads videos (for CORS/frame-extraction testing)
      const downloadVideos = req.query.downloadVideos === '1';
      // Six months of an active creator runs to 100+ posts, and the outlier
      // maths needs a real sample to take a median from — twelve posts gave a
      // median that moved every scrape. Callers can override for a cheap probe.
      const perPage = Math.min(Number(req.body?.resultsPerPage) || 60, 200);
      const response = await fetch(
        `https://api.apify.com/v2/acts/${ACTOR_ID}/runs?token=${APIFY_TOKEN}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            profiles,
            resultsPerPage: perPage,
            shouldDownloadVideos: true,
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
        datasetId: data.data?.defaultDatasetId,
        // Lets the discovery screens show "N videos so far" while polling.
        itemCount: data.data?.stats?.outputItemCount ?? null
      });
    }

    if (action === 'results' && datasetId) {
      const response = await fetch(
        `https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}&limit=1000`
      );
      const items = await response.json();
      const monthsBack = Number(req.query.months) || RECENCY_MONTHS;
      return res.status(200).json({ videos: rankVideos(items, monthsBack) });
    }

    // ── Raw item dump: see ALL fields Apify returns for one video ──
    if (action === 'rawitem' && datasetId) {
      const response = await fetch(
        `https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}&limit=5`
      );
      const items = await response.json();
      if (!items.length) return res.status(200).json({ error: 'no items' });
      // Return the full first item + a list of all top-level keys
      return res.status(200).json({
        topLevelKeys: Object.keys(items[0]),
        videoMetaKeys: items[0].videoMeta ? Object.keys(items[0].videoMeta) : null,
        videoMeta: items[0].videoMeta || null,
        mediaUrls: items[0].mediaUrls || null,
        webVideoUrl: items[0].webVideoUrl || null,
        fullItem: items[0]
      });
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
