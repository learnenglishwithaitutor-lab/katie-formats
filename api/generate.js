export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { transcript, caption, author } = req.body;
  if (!caption && !transcript) return res.status(400).json({ error: 'No content provided' });

  const content = transcript
    ? `Video transcript:\n${transcript}`
    : `Video caption:\n${caption}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: `You are a script writer for Katie AI, an English speaking practice app that helps non-native English speakers become confident in real-life conversations.

Your job is to recreate TikTok video scripts in the same style and format as the original video. Keep it light, fun and simple — exactly like the original. Use the same examples and content from the transcript. If the original mentions another app or brand, replace it with "Katie AI". Keep the CTA style consistent with the original. Output only the script text, nothing else — no labels, no explanation, no preamble.`,
        messages: [
          {
            role: 'user',
            content: `Recreate this TikTok video as a Katie AI script.\n\nOriginal creator: @${author || 'unknown'}\n\n${content}`
          }
        ]
      })
    });

    const data = await response.json();
    const script = data.content?.[0]?.text || '';
    return res.status(200).json({ script });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
