// Creator discovery + outlier ranking.
//
// Two phases, because a keyword/hashtag scrape returns only 1-2 videos per
// creator — not enough to know what "normal" looks like for that account:
//
//   phase 1  discover   keywords/hashtags -> candidate creator handles
//   phase 2  profiles   those handles     -> ~24 videos each -> real stats
//
// Neither phase downloads video files (that is slow and costs Apify credits);
// the shortlist only needs numbers, captions and cover images.
//
// This lives in lib/ rather than api/ on purpose: Vercel counts every file
// under api/ as a serverless function and this plan caps at 12. api/apify.js
// delegates the actions below to us, so discovery costs no extra function.

const ACTOR_ID = 'GdWCkxBtKWOsKjdch'; // clockworks/tiktok-scraper
const APIFY_TOKEN = process.env.APIFY_TOKEN;

const DEFAULT_KEYWORDS = [
  'english tips',
  'learn english',
  'english grammar',
  'english pronunciation',
  'speak english fluently',
  'english mistakes',
  'phrasal verbs',
  'english vocabulary'
];

// Captions that read like a lesson. Used to tell tutorial talking-head content
// apart from the emotional/story UGC that needs a human eye instead.
const TUTORIAL_MARKERS = [
  'stop saying', "don't say", 'dont say', 'say this instead', 'instead of',
  ' vs ', 'vs.', 'difference between', 'how to say', 'how to pronounce',
  'pronounce', 'pronunciation', 'grammar', 'phrasal verb', 'preposition',
  'vocabulary', 'meaning', 'means', 'idiom', 'collocation', 'tense',
  'english tip', 'english lesson', 'learn english', 'common mistake',
  'mistake', 'correct', 'native speakers say', 'sound more natural',
  'improve your english', 'word of the day', 'synonym'
];

// Captions that read like a feeling, not a lesson.
const EMOTIONAL_MARKERS = [
  'why is english so hard', 'crying', 'cried', 'pov', 'storytime',
  'story time', 'my journey', 'i failed', 'embarrassing', 'i was so',
  'nobody talks about', 'this broke me', 'day in my life'
];

function scoreCaption(text, markers) {
  const t = (text || '').toLowerCase();
  return markers.reduce((n, m) => (t.includes(m) ? n + 1 : n), 0);
}

// What counts as a breakout: a post that beat its own creator's median by this
// much. One number, used for the creator's outlier count here and for the
// shortlist in index.html — if the two disagree, a creator badged "0 breakouts"
// can still feed the queue.
const OUTLIER_X = 3;

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

async function startRun(input) {
  const res = await fetch(
    `https://api.apify.com/v2/acts/${ACTOR_ID}/runs?token=${APIFY_TOKEN}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input)
    }
  );
  const data = await res.json();
  if (!data.data?.id) return { error: 'Failed to start Apify run', debug: data };
  return { runId: data.data.id, status: data.data.status };
}

async function fetchItems(datasetId, limit = 1000) {
  const res = await fetch(
    `https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}&limit=${limit}`
  );
  const items = await res.json();
  return Array.isArray(items) ? items : [];
}

function videoOf(item) {
  return {
    id:        item.id || '',
    caption:   item.text || item.desc || '',
    views:     item.playCount || 0,
    likes:     item.diggCount || 0,
    comments:  item.commentCount || 0,
    shares:    item.shareCount || 0,
    duration:  item.videoMeta?.duration || 0,
    url:       item.webVideoUrl || (item.authorMeta?.name && item.id
                 ? `https://www.tiktok.com/@${item.authorMeta.name}/video/${item.id}` : ''),
    thumbnail: item.videoMeta?.coverUrl || item.covers?.default || '',
    created:   item.createTimeISO || null
  };
}

// The actions api/apify.js hands over to us. Anything not listed here stays
// with the original handler, so the existing pull is untouched.
export const DISCOVER_ACTIONS = ['discover', 'candidates', 'profiles', 'creators', 'rawdiscover'];

export async function handleDiscover(req, res) {
  if (!APIFY_TOKEN) return res.status(500).json({ error: 'APIFY_TOKEN not set' });

  const { action, datasetId } = req.query;

  try {
    // ── Phase 1: keyword/hashtag sweep to find candidate creators ──────
    if (action === 'discover') {
      const keywords = (req.method === 'POST' && req.body?.keywords?.length)
        ? req.body.keywords
        : DEFAULT_KEYWORDS;
      const perKeyword = Math.min(Number(req.body?.perKeyword) || 40, 100);

      // searchQueries covers keyword search; hashtags covers the tag feeds.
      // Both are sent so one sweep pulls from either surface.
      const started = await startRun({
        searchQueries: keywords,
        hashtags: keywords.map(k => k.replace(/[^a-z0-9]/gi, '')),
        searchSection: '/video',
        resultsPerPage: perKeyword,
        shouldDownloadVideos: false,
        shouldDownloadCovers: false,
        shouldDownloadSubtitles: false
      });
      if (started.error) return res.status(200).json(started);
      return res.status(200).json({ ...started, keywords });
    }

    // ── Phase 1 results: candidate handles seen in the sweep ───────────
    if (action === 'candidates' && datasetId) {
      const items = await fetchItems(datasetId);
      const byAuthor = {};
      for (const item of items) {
        const handle = item.authorMeta?.name;
        if (!handle) continue;
        const v = videoOf(item);
        const a = byAuthor[handle] || (byAuthor[handle] = {
          handle,
          nickname: item.authorMeta?.nickName || '',
          followers: item.authorMeta?.fans || 0,
          verified: !!item.authorMeta?.verified,
          hits: 0, bestViews: 0, tutorialHits: 0, emotionalHits: 0
        });
        a.hits++;
        a.bestViews = Math.max(a.bestViews, v.views);
        if (scoreCaption(v.caption, TUTORIAL_MARKERS)) a.tutorialHits++;
        if (scoreCaption(v.caption, EMOTIONAL_MARKERS)) a.emotionalHits++;
      }

      // Rank candidates by how often they surfaced on these keywords and how
      // well their best video did — the sweep is too thin for a real median.
      const candidates = Object.values(byAuthor)
        .map(a => ({
          ...a,
          style: a.tutorialHits >= a.emotionalHits && a.tutorialHits > 0
            ? 'tutorial'
            : (a.emotionalHits > 0 ? 'emotional' : 'unknown')
        }))
        .sort((a, b) => (b.hits - a.hits) || (b.bestViews - a.bestViews));

      return res.status(200).json({ totalVideos: items.length, candidates });
    }

    // ── Phase 2: deep-scrape specific handles for real per-creator stats ──
    if (action === 'profiles') {
      const handles = req.body?.handles || [];
      if (!handles.length) return res.status(400).json({ error: 'No handles given' });
      const perProfile = Math.min(Number(req.body?.perProfile) || 24, 50);

      const started = await startRun({
        profiles: handles.map(h =>
          h.startsWith('http') ? h : `https://www.tiktok.com/@${h.replace(/^@/, '')}`
        ),
        resultsPerPage: perProfile,
        profileScrapeSections: ['videos'],
        profileSorting: 'latest',
        shouldDownloadVideos: false,
        shouldDownloadCovers: false,
        shouldDownloadSubtitles: false
      });
      if (started.error) return res.status(200).json(started);
      return res.status(200).json({ ...started, handles });
    }

    // ── Phase 2 results: ranked creators with outlier maths ────────────
    if (action === 'creators' && datasetId) {
      const items = await fetchItems(datasetId);
      const byAuthor = {};
      for (const item of items) {
        const handle = item.authorMeta?.name;
        if (!handle) continue;
        const a = byAuthor[handle] || (byAuthor[handle] = {
          handle,
          nickname:  item.authorMeta?.nickName || '',
          followers: item.authorMeta?.fans || 0,
          totalLikes: item.authorMeta?.heart || 0,
          postCount: item.authorMeta?.video || 0,
          verified:  !!item.authorMeta?.verified,
          bio:       item.authorMeta?.signature || '',
          videos: []
        });
        a.videos.push(videoOf(item));
      }

      const creators = Object.values(byAuthor).map(a => {
        const views = a.videos.map(v => v.views);
        const med = median(views);
        const sorted = [...a.videos].sort((x, y) => y.views - x.views);
        const top = sorted[0] || null;

        // How far the best post beat this creator's own normal. A high ratio
        // means the *format* did the work, not the follower count — that is
        // the video worth copying.
        const outlierRatio = med > 0 ? +(top?.views / med).toFixed(1) : 0;

        const outliers = sorted.filter(v => med > 0 && v.views >= med * OUTLIER_X);

        // How often they break out, not just whether they ever did. One lucky
        // viral is noise; four breakouts in 24 posts is a format that repeats,
        // and repeatable is the whole point of copying someone.
        const outlierRate = a.videos.length
          ? +(outliers.length / a.videos.length).toFixed(3) : 0;

        // Reach per follower: small accounts pulling big views are the
        // strongest signal that the content, not the audience, is winning.
        const reachRatio = a.followers > 0 ? +(med / a.followers).toFixed(2) : 0;

        const tutorialHits  = a.videos.filter(v => scoreCaption(v.caption, TUTORIAL_MARKERS)).length;
        const emotionalHits = a.videos.filter(v => scoreCaption(v.caption, EMOTIONAL_MARKERS)).length;
        const tutorialShare = a.videos.length ? +(tutorialHits / a.videos.length).toFixed(2) : 0;

        return {
          handle: a.handle,
          nickname: a.nickname,
          bio: a.bio,
          verified: a.verified,
          followers: a.followers,
          postCount: a.postCount,
          sampled: a.videos.length,
          medianViews: med,
          topViews: top?.views || 0,
          outlierRatio,
          outlierCount: outliers.length,
          outlierRate,
          outlierX: OUTLIER_X,
          reachRatio,
          tutorialShare,
          style: tutorialShare >= 0.3 ? 'tutorial'
               : (emotionalHits > tutorialHits ? 'emotional' : 'mixed'),
          // Every sampled post as a multiple of the median, oldest first — the
          // shape the row's spark bars are drawn from. 24 small numbers, so it
          // costs almost nothing to carry and saves re-scraping to draw it.
          multiples: [...a.videos]
            .sort((x, y) => new Date(x.created || 0) - new Date(y.created || 0))
            .map(v => (med > 0 ? +(v.views / med).toFixed(1) : 0)),
          // 8 is enough to cover every real outlier in a 24-video sample
          // without bloating localStorage across many creators.
          topVideos: sorted.slice(0, 8).map(v => ({
            ...v,
            multiple: med > 0 ? +(v.views / med).toFixed(1) : 0
          }))
        };
      });

      // Rank: tutorial-style first, then how often they break out, then how big
      // the best breakout was, then reach. Breakout rate leads because a
      // creator with four repeatable wins is worth more than a big healthy
      // account that has never had one — the aim is finding a format that
      // works twice, not an account that is merely doing well.
      creators.sort((a, b) => {
        const styleRank = s => (s === 'tutorial' ? 0 : s === 'mixed' ? 1 : 2);
        return (styleRank(a.style) - styleRank(b.style))
            || (b.outlierRate - a.outlierRate)
            || (b.outlierRatio - a.outlierRatio)
            || (b.reachRatio - a.reachRatio);
      });

      return res.status(200).json({ totalVideos: items.length, creators });
    }

    // ── Field-name smoke test: confirms the actor accepted our input ───
    // (Run status is handled by api/apify.js — both phases share it.)
    if (action === 'rawdiscover' && datasetId) {
      const items = await fetchItems(datasetId, 3);
      if (!items.length) return res.status(200).json({ error: 'no items', datasetId });
      return res.status(200).json({
        count: items.length,
        topLevelKeys: Object.keys(items[0]),
        authorMeta: items[0].authorMeta || null,
        sample: videoOf(items[0])
      });
    }

    return res.status(400).json({ error: 'Invalid action' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
