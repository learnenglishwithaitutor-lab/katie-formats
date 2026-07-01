// Step 1: redirect the browser to Google's OAuth consent screen.
// GET /api/auth  →  302 to accounts.google.com

const CLIENT_ID    = process.env.GOOGLE_CLIENT_ID;
const REDIRECT_URI = 'https://katie-formats-app.vercel.app/api/auth/callback';
const SCOPE        = 'https://www.googleapis.com/auth/drive.file';

export default async function handler(req, res) {
  if (!CLIENT_ID) {
    return res.status(500).send('GOOGLE_CLIENT_ID not set in Vercel env vars.');
  }
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', SCOPE);
  authUrl.searchParams.set('access_type', 'offline'); // needed to get a refresh_token
  authUrl.searchParams.set('prompt', 'consent');       // force refresh_token every time (testing-mode app)
  res.writeHead(302, { Location: authUrl.toString() });
  res.end();
}
