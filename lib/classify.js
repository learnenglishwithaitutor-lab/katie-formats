// Talking-head vs faceless classification, from the video covers.
//
// Caption keywords can tell a lesson from a feeling, but they cannot tell a
// real person on camera from a faceless slideshow — both write "stop saying
// this". So we actually look at the pictures: Claude reads each creator's top
// cover frames and says whether a human is on camera delivering to lens.
//
// Lives in lib/ for the same reason as discover.js: Vercel counts files under
// api/ as serverless functions and this plan caps at 12.

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-opus-5';

// TikTok's CDN refuses requests without a browser-shaped User-Agent.
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    format: {
      type: 'string',
      enum: ['talking_head', 'faceless', 'mixed', 'unclear'],
      description:
        'talking_head = a real person filmed to camera in most frames. ' +
        'faceless = text cards, screen recordings, stock footage, b-roll, ' +
        'animation, or a person shown only incidentally. ' +
        'mixed = roughly half and half. unclear = covers too poor to judge.'
    },
    onCameraCount: {
      type: 'integer',
      description: 'How many of the supplied frames show a person to camera.'
    },
    note: {
      type: 'string',
      description: 'One short sentence on what the frames actually look like.'
    }
  },
  required: ['format', 'onCameraCount', 'note'],
  additionalProperties: false
};

const PROMPT =
  'These are cover frames from one TikTok creator who posts English-teaching ' +
  'videos. Decide whether this creator films themselves talking to camera, or ' +
  'makes faceless content.\n\n' +
  'Count a frame as on-camera only when a real human face is present and the ' +
  'person appears to be the one speaking — a selfie-style shot, a piece to ' +
  'camera, a street interview. Do NOT count: text-on-plain-background cards, ' +
  'screen or app recordings, slideshows, stock or b-roll footage, cartoons or ' +
  'avatars, or a face that is only a small inset on top of other footage.\n\n' +
  'Text overlaid on a genuine selfie shot is still on-camera — most creators ' +
  'caption their talking-head videos.';

// Covers are fetched server-side and inlined as base64: the Anthropic URL image
// source can't send TikTok's required User-Agent, so a plain URL 403s.
async function fetchImageBlock(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': BROWSER_UA, Referer: 'https://www.tiktok.com/' }
  });
  if (!res.ok) return null;

  const type = (res.headers.get('content-type') || '').split(';')[0].trim();
  if (!/^image\/(jpeg|png|webp|gif)$/.test(type)) return null;

  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length || buf.length > 4_000_000) return null;

  return {
    type: 'image',
    source: { type: 'base64', media_type: type, data: buf.toString('base64') }
  };
}

async function classifyOne(creator, framesPerCreator) {
  const urls = (creator.topVideos || [])
    .map(v => v.thumbnail)
    .filter(Boolean)
    .slice(0, framesPerCreator);

  if (!urls.length) {
    return { handle: creator.handle, format: 'unclear', onCameraCount: 0, note: 'No cover images.' };
  }

  const images = (await Promise.all(urls.map(fetchImageBlock))).filter(Boolean);
  if (!images.length) {
    return { handle: creator.handle, format: 'unclear', onCameraCount: 0, note: 'Covers could not be loaded.' };
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2048,
      // Classification doesn't need deep reasoning; low effort keeps the
      // per-creator cost down across a 20-creator scan.
      output_config: {
        effort: 'low',
        format: { type: 'json_schema', schema: CLASSIFY_SCHEMA }
      },
      messages: [{ role: 'user', content: [...images, { type: 'text', text: PROMPT }] }]
    })
  });

  const data = await res.json();
  if (data.type === 'error') {
    return { handle: creator.handle, format: 'unclear', onCameraCount: 0, note: data.error?.message || 'API error' };
  }
  // A safety decline returns HTTP 200 with stop_reason "refusal" and no usable
  // content — check before reading content[0].
  if (data.stop_reason === 'refusal') {
    return { handle: creator.handle, format: 'unclear', onCameraCount: 0, note: 'Classification declined.' };
  }

  const text = (data.content || []).find(b => b.type === 'text')?.text;
  if (!text) {
    return { handle: creator.handle, format: 'unclear', onCameraCount: 0, note: 'Empty response.' };
  }

  try {
    const parsed = JSON.parse(text);
    return {
      handle: creator.handle,
      format: parsed.format,
      onCameraCount: parsed.onCameraCount,
      framesSeen: images.length,
      note: parsed.note
    };
  } catch {
    return { handle: creator.handle, format: 'unclear', onCameraCount: 0, note: 'Unparseable response.' };
  }
}

export const CLASSIFY_ACTIONS = ['classify'];

// Classifies a small batch per request. The front end walks the creator list in
// chunks so no single invocation runs past Vercel's 60s function ceiling.
export async function handleClassify(req, res) {
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  const creators = req.body?.creators || [];
  if (!creators.length) return res.status(400).json({ error: 'No creators given' });
  if (creators.length > 6) return res.status(400).json({ error: 'Send at most 6 creators per call' });

  const framesPerCreator = Math.min(Number(req.body?.frames) || 3, 4);

  try {
    const results = await Promise.all(creators.map(c => classifyOne(c, framesPerCreator)));
    return res.status(200).json({ results });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
