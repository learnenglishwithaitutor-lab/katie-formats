// Serves the omni-generate pipeline script (scripts/run_pipeline.py) as text so
// the skill can fetch-and-run the latest version at runtime. Updates ship via
// git push + Vercel deploy — no skill re-upload. Served from the allowlisted
// katie-formats-app.vercel.app domain the skill can already reach.
import { readFileSync } from 'fs';
import { join } from 'path';

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const candidates = [
    join(process.cwd(), 'scripts', 'run_pipeline.py'),
    join(process.cwd(), 'scripts/run_pipeline.py'),
    join(__dirname, '..', 'scripts', 'run_pipeline.py'),
  ];
  for (const p of candidates) {
    try {
      const body = readFileSync(p, 'utf8');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).send(body);
    } catch (e) { /* try next */ }
  }
  return res.status(500).send('# pipeline script not found on server');
}
