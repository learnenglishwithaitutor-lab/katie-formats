// Per-video screening: decide whether one candidate video is worth remaking.
//
// The creator filter in lib/classify.js answers "is this person worth
// watching". This answers the different question "is this particular video
// worth copying" — a vetted talking-head creator still posts the odd skit, and
// still posts plenty of lessons Sarah has already covered.
//
// Evidence, best first: TikTok's own speech-to-text (shipped free with the
// scrape, so we read what the video actually taught rather than guessing from
// a caption), then hashtags, then the caption, then the cover frame.
//
// Lives in lib/ because Vercel counts files under api/ as serverless functions
// and this plan caps at 12.

import { fetchImageBlock } from './classify.js';

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-opus-5';

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// Content types we don't want to remake, and why. Kept as data so adding a
// rule later is a line here rather than a change to the prompt.
const BLOCKED_TYPES = {
  pronunciation: 'pronunciation video',
  listening:     'listening test or practice'
};

const SCREEN_SCHEMA = {
  type: 'object',
  properties: {
    contentType: {
      type: 'string',
      enum: ['vocabulary', 'grammar', 'phrases', 'pronunciation', 'listening',
             'slang', 'culture', 'exam', 'motivation', 'other'],
      description:
        'The single thing this video teaches. ' +
        'vocabulary = individual words and their meanings. ' +
        'grammar = rules, tenses, prepositions, sentence structure. ' +
        'phrases = set expressions, idioms, phrasal verbs, sentence upgrades, ' +
        'and how words run together in natural speech (gonna, wanna, gotta). ' +
        'pronunciation = how to physically produce a sound, word stress, ' +
        'syllables, silent letters, accent training. ' +
        'listening = the viewer is asked to hear or catch something — a ' +
        'listening test, dictation, "what did I say", "can you hear the ' +
        'difference". ' +
        'slang = informal street language. culture = customs and etiquette. ' +
        'exam = IELTS/TOEFL test technique. motivation = encouragement rather ' +
        'than a lesson.'
    },
    isSkit: {
      type: 'boolean',
      description:
        'True when the creator is acting rather than explaining — playing ' +
        'characters, roleplay, wigs or costumes, appearing twice in one ' +
        'frame, or a staged scene between people. A plain piece to camera is ' +
        'not a skit, even if lively.'
    },
    needsPhysicalDemo: {
      type: 'boolean',
      description:
        'True when the lesson depends on showing something physical — props, ' +
        'objects held to camera, mouth or tongue position, gestures that ' +
        'carry the meaning. False when the same lesson would survive being ' +
        'read aloud by a different person.'
    },
    mentionsBritish: {
      type: 'boolean',
      description:
        'True if the video is about British English in any way — British vs ' +
        'American, British slang, British phrases or accents. Judge on the ' +
        'content, not on the creator happening to sound British.'
    },
    isWhiteboard: {
      type: 'boolean',
      description:
        'True when the teaching happens on a whiteboard, blackboard, paper ' +
        'pad or similar written surface that the creator writes on.'
    },
    whiteboardConvertible: {
      type: 'boolean',
      description:
        'Only meaningful when isWhiteboard is true; use false otherwise. ' +
        'True when the board holds a set of standalone items — words, ' +
        'phrases, rules, examples — that would read just as well as a list of ' +
        'text on screen. False when the teaching depends on the board itself: ' +
        'arrows, diagrams, circling and crossing out, spatial layout, or the ' +
        'act of writing being what carries the point.'
    },
    topic: {
      type: 'string',
      description:
        'The lesson in under eight words, as a person would describe it — ' +
        '"formal alternatives to very", "through vs across", "berry names". ' +
        'No hashtags, no hook wording, no punctuation at the end.'
    },
    note: {
      type: 'string',
      description: 'One short sentence on what the video actually does.'
    }
  },
  required: ['contentType', 'isSkit', 'needsPhysicalDemo', 'mentionsBritish',
             'isWhiteboard', 'whiteboardConvertible', 'topic', 'note'],
  additionalProperties: false
};

const PROMPT_HEAD =
  'This is one TikTok video from a creator who teaches English. Work out what ' +
  'it teaches and how it is filmed, so we can decide whether to remake it.\n\n' +
  'The transcript is the strongest evidence — it is what was actually said. ' +
  'Hashtags are the next best, because creators tag their own videos ' +
  'honestly. The caption is often just a hook and can mislead. The cover is ' +
  'one frame and shows only how it is filmed, not what it teaches.\n\n' +
  'On content type, pick the single best fit. Two traps worth naming: a video ' +
  'about how words blend in fast speech ("gonna", "wanna", "I\'m gonna head ' +
  'out") is phrases, not pronunciation — it is teaching an expression, not a ' +
  'sound. And "stop saying X, say Y" is vocabulary or phrases unless the ' +
  'point is genuinely the sound.\n\n' +
  'If it is taught on a whiteboard, judge from the transcript whether the ' +
  'lesson would survive being shown as a list of text instead. A board that ' +
  'is really just a list of phrases would; one built on arrows and diagrams ' +
  'would not.\n';

// TikTok's ASR subtitles arrive as WebVTT. Strip the timing and the cue
// numbering, keep the words.
function vttToText(vtt) {
  return vtt
    .split(/\r?\n/)
    .filter(line =>
      line.trim() &&
      !/^WEBVTT/i.test(line) &&
      !/^\d+$/.test(line.trim()) &&
      !line.includes('-->'))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchTranscript(url) {
  if (!url) return '';
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': BROWSER_UA, Referer: 'https://www.tiktok.com/' }
    });
    if (!res.ok) return '';
    const text = await res.text();
    if (!/-->/.test(text)) return '';       // not a VTT — an error page
    return vttToText(text).slice(0, 4000);
  } catch {
    return '';
  }
}

// The drop rules themselves, applied to a verdict. Separate from the model so
// changing what we reject never means re-prompting.
function applyRules(v) {
  const reasons = [];
  if (v.mentionsBritish)   reasons.push('British English');
  if (BLOCKED_TYPES[v.contentType]) reasons.push(BLOCKED_TYPES[v.contentType]);
  if (v.isSkit)            reasons.push('skit');
  if (v.needsPhysicalDemo) reasons.push('needs a physical demo');
  return reasons;
}

async function screenOne(video) {
  const [transcript, cover] = await Promise.all([
    fetchTranscript(video.subtitleUrl),
    video.thumbnail ? fetchImageBlock(video.thumbnail) : null
  ]);

  const facts =
    `CAPTION: ${video.title || '(none)'}\n` +
    `HASHTAGS: ${(video.hashtags || []).join(', ') || '(none)'}\n` +
    `TRANSCRIPT: ${transcript || '(none available)'}`;

  const content = [];
  if (cover) content.push(cover);
  content.push({ type: 'text', text: `${PROMPT_HEAD}\n${facts}` });

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
      output_config: {
        effort: 'low',
        format: { type: 'json_schema', schema: SCREEN_SCHEMA }
      },
      messages: [{ role: 'user', content }]
    })
  });

  const data = await res.json();
  const fail = note => ({ url: video.url, verdict: 'unclear', reasons: [], note });
  if (data.type === 'error')          return fail(data.error?.message || 'API error');
  if (data.stop_reason === 'refusal') return fail('Screening declined.');

  const text = (data.content || []).find(b => b.type === 'text')?.text;
  if (!text) return fail('Empty response.');

  let parsed;
  try { parsed = JSON.parse(text); } catch { return fail('Unparseable response.'); }

  const reasons = applyRules(parsed);
  // A whiteboard lesson that is really just a list survives — it becomes a
  // digital listicle. One built on the drawing itself cannot.
  if (parsed.isWhiteboard && !parsed.whiteboardConvertible) {
    reasons.push('whiteboard, needs the drawing');
  }

  return {
    url: video.url,
    ...parsed,
    hadTranscript: !!transcript,
    sawCover: !!cover,
    reasons,
    verdict: reasons.length ? 'drop' : 'keep',
    makeListicle: !!(parsed.isWhiteboard && parsed.whiteboardConvertible)
  };
}

// ── Already-posted check ──────────────────────────────────────────────
//
// Sarah's own captions are already topic-shaped ("through vs across",
// "compound words"), so her back catalogue needs no labelling pass of its own
// — we hand the captions over as-is and ask which candidates they cover.
//
// This is deliberately a judgement, not a string match: nobody writes the same
// caption twice, and "Stop Saying Big" and "formal alternatives to very" are
// the same lesson. The verdict shows on the row so a wrong call is visible.

const DEDUPE_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The candidate url, copied back exactly.' },
          covered: {
            type: 'boolean',
            description:
              'True only when Sarah has already taught this same lesson. The ' +
              'same broad area is not enough — both being about prepositions ' +
              'is not a match, but both teaching "through vs across" is.'
          },
          match: {
            type: 'string',
            description:
              'When covered, the caption of her post that covers it, copied ' +
              'exactly. Empty string when not covered.'
          }
        },
        required: ['url', 'covered', 'match'],
        additionalProperties: false
      }
    }
  },
  required: ['results'],
  additionalProperties: false
};

async function dedupeChunk(candidates, postedCaptions) {
  const prompt =
    'Sarah teaches English on TikTok. Below is every video she has already ' +
    'posted, then a list of videos we are considering remaking. Say which of ' +
    'the candidates would repeat a lesson she has already done.\n\n' +
    'Match on the lesson, not the wording — she never writes the same caption ' +
    'twice. "Stop Saying Big — Say This Instead" and "formal alternatives to ' +
    'very" are the same lesson. But do not match on subject area alone: two ' +
    'videos both being about phrasal verbs is not a repeat unless they teach ' +
    'the same phrasal verbs.\n\n' +
    'When unsure, answer not covered. A repeat that slips through costs one ' +
    'video; a good idea wrongly dropped is never seen again.\n\n' +
    'ALREADY POSTED BY SARAH:\n' +
    postedCaptions.map(c => `- ${c}`).join('\n') +
    '\n\nCANDIDATES:\n' +
    candidates.map(c => `- url: ${c.url}\n  topic: ${c.topic || c.title || ''}`).join('\n');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      output_config: {
        effort: 'low',
        format: { type: 'json_schema', schema: DEDUPE_SCHEMA }
      },
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
    })
  });

  const data = await res.json();
  if (data.type === 'error' || data.stop_reason === 'refusal') return [];
  const text = (data.content || []).find(b => b.type === 'text')?.text;
  if (!text) return [];
  try { return JSON.parse(text).results || []; } catch { return []; }
}

export const SCREEN_ACTIONS = ['screen', 'dedupe'];

// Screens a small batch per request. The front end walks the candidate list in
// chunks so no single invocation runs past Vercel's 60s function ceiling.
export async function handleScreen(req, res) {
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  if (req.query.action === 'dedupe') {
    const candidates = req.body?.candidates || [];
    const posted = (req.body?.posted || []).filter(Boolean);
    if (!candidates.length) return res.status(400).json({ error: 'No candidates given' });
    // Nothing posted yet means nothing to repeat — don't spend a call to be
    // told so, and don't let an empty list read as "all clear" by accident.
    if (!posted.length) return res.status(200).json({ results: [], skipped: 'no posted history' });
    if (candidates.length > 25) return res.status(400).json({ error: 'Send at most 25 candidates per call' });
    try {
      return res.status(200).json({ results: await dedupeChunk(candidates, posted) });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  const videos = req.body?.videos || [];
  if (!videos.length) return res.status(400).json({ error: 'No videos given' });
  if (videos.length > 8) return res.status(400).json({ error: 'Send at most 8 videos per call' });

  try {
    const results = await Promise.all(videos.map(screenOne));
    return res.status(200).json({ results });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
