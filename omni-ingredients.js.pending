// api/omni-ingredients.js
//
// The INGREDIENTS route into Gemini Omni — Miko's image-prompt method.
//
// A SEPARATE endpoint from api/omni.js on purpose (Ashitha, 2026-08-06: "can you
// make a new endpoint without touching existing one"). The existing pipeline runs
// every overnight batch and must keep working byte-for-byte; nothing here touches
// it, and nothing here is imported by it.
//
//   api/omni.js              base video + prompt text          (current, untouched)
//   api/omni-ingredients.js  images + optional voice video      (this file)
//
// Why this route exists: it is driven by a STILL IMAGE rather than a base video, so
// it can animate a generated Sarah variant, and it can pin the voice using a
// black-screen audio-only clip.
//
// kie.ai's gemini-omni-video accepts (docs.kie.ai/market/gemini-omni-video):
//   prompt       string, required, max 20k chars
//   duration     '4' | '6' | '8' | '10' — IGNORED when a video is supplied
//   image_urls   up to 7 public URLs
//   video_list   max 1 video, <=30s, trim range <=10s
//   aspect_ratio '16:9' | '9:16'
//   resolution   '720p' | '1080p' | '4k'
// Quota: images + (videos x 2) + character_ids <= 7.

const KIE_TOKEN = process.env.KIE_API_TOKEN;

const KIE_UPLOAD_URL = 'https://kieai.redpandaai.co/api/file-stream-upload';
const KIE_CREATE_URL = 'https://api.kie.ai/api/v1/jobs/createTask';
const KIE_POLL_URL   = 'https://api.kie.ai/api/v1/jobs/recordInfo';

const MAX_IMAGES = 7;
const QUOTA = 7; // images + videos*2

async function uploadToKie(buffer, mimeType, filename) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType }), filename);
  form.append('uploadPath', `katie/${filename}`);
  const res = await fetch(KIE_UPLOAD_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KIE_TOKEN}` },
    body: form
  });
  if (!res.ok) throw new Error(`kie.ai upload failed (${res.status}) for ${filename}: ${await res.text()}`);
  const data = await res.json();
  const url = data?.data?.downloadUrl;
  if (!url) throw new Error(`kie.ai upload: no downloadUrl for ${filename}`);
  return url;
}

// Accept either a base64 blob (which we upload) or an already-public URL.
async function resolveAsset(asset, kind, i) {
  if (typeof asset === 'string' && /^https?:\/\//.test(asset)) return asset;
  if (typeof asset !== 'string' || !asset.length) {
    throw new Error(`${kind}[${i}]: expected a public URL or base64 string`);
  }
  const isVideo = kind === 'video';
  const buf = Buffer.from(asset, 'base64');
  return uploadToKie(
    buf,
    isVideo ? 'video/mp4' : 'image/png',
    `${kind}_${Date.now()}_${i}.${isVideo ? 'mp4' : 'png'}`
  );
}

async function submitTask(input) {
  const res = await fetch(KIE_CREATE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KIE_TOKEN}` },
    body: JSON.stringify({ model: 'gemini-omni-video', input })
  });
  if (!res.ok) throw new Error(`kie.ai createTask failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  if (data.code && data.code !== 200) {
    throw new Error(`kie.ai: ${data.msg || 'createTask error'} (code ${data.code})`);
  }
  const taskId = data?.data?.taskId;
  if (!taskId) throw new Error(`kie.ai: no taskId. Response: ${JSON.stringify(data)}`);
  return taskId;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!KIE_TOKEN) return res.status(500).json({ error: 'KIE_API_TOKEN not set' });

  try {
    // ── status ────────────────────────────────────────────────
    if (req.method === 'GET' || req.query?.action === 'status') {
      const taskId = req.query?.taskId;
      if (!taskId) return res.status(400).json({ error: 'taskId required' });
      const r = await fetch(`${KIE_POLL_URL}?taskId=${taskId}`, {
        headers: { Authorization: `Bearer ${KIE_TOKEN}` }
      });
      if (!r.ok) return res.status(502).json({ error: `poll failed: ${r.status}` });
      const rec = (await r.json())?.data;
      if (!rec) return res.status(502).json({ error: 'empty poll response' });

      const state = String(rec.state || rec.status || '').toLowerCase();
      let resultUrl = null;
      try {
        const rj = typeof rec.resultJson === 'string' ? JSON.parse(rec.resultJson) : rec.resultJson;
        resultUrl = rj?.resultUrls?.[0] || rj?.resultUrl || null;
      } catch { /* leave null */ }

      if (['success', 'succeeded', 'completed'].includes(state)) {
        return res.status(200).json({ status: 'success', videoUrl: resultUrl });
      }
      if (['fail', 'failed', 'error'].includes(state)) {
        return res.status(200).json({ status: 'fail', failMsg: rec.failMsg || rec.errorMessage || 'unknown' });
      }
      return res.status(200).json({ status: 'processing' });
    }

    // ── generate ──────────────────────────────────────────────
    const {
      prompt,
      images = [],          // base64 or public URLs. Order matters — see below.
      voiceVideo = null,    // base64 or URL. Black-screen audio-only clip.
      duration = '10',
      aspectRatio = '9:16',
      resolution = '720p',
      trim = null           // { start, ends } into voiceVideo; ends-start must be <=10
    } = req.body || {};

    if (!prompt || !String(prompt).trim()) {
      return res.status(400).json({ error: 'prompt is required' });
    }
    if (!Array.isArray(images) || images.length === 0) {
      return res.status(400).json({
        error: 'images[] is required — this route is image-driven. Use /api/omni for the base-video route.'
      });
    }
    if (images.length > MAX_IMAGES) {
      return res.status(400).json({ error: `at most ${MAX_IMAGES} images` });
    }
    // Reject over-quota here rather than letting kie.ai fail after the uploads.
    const cost = images.length + (voiceVideo ? 2 : 0);
    if (cost > QUOTA) {
      return res.status(400).json({
        error: `quota exceeded: ${images.length} image(s) + ${voiceVideo ? 1 : 0} video = ${cost} units, max ${QUOTA}`
      });
    }

    const image_urls = [];
    for (let i = 0; i < images.length; i++) {
      image_urls.push(await resolveAsset(images[i], 'image', i));
    }

    const input = { prompt, image_urls, aspect_ratio: aspectRatio, resolution };

    if (voiceVideo) {
      const url = await resolveAsset(voiceVideo, 'video', 0);
      const start = Number(trim?.start ?? 0);
      const ends = Number(trim?.ends ?? 10);
      if (!(ends > start) || ends - start > 10) {
        return res.status(400).json({ error: 'trim range must satisfy 0 < ends-start <= 10' });
      }
      input.video_list = [{ url, start, ends }];
      // duration is ignored by the model whenever a video is supplied — the video's
      // length wins. Sending it anyway would imply a control we do not have.
    } else {
      input.duration = String(duration);
    }

    const taskId = await submitTask(input);
    return res.status(200).json({
      taskId,
      sent: {
        images: image_urls.length,
        voiceVideo: Boolean(voiceVideo),
        durationControlledBy: voiceVideo ? 'voiceVideo length (duration ignored)' : `duration=${duration}`
      }
    });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
}
