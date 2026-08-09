// Step 2: Google redirects back here with ?code=... after consent.
// Exchanges the code for tokens, then hands the refresh_token to the PWA
// via a tiny inline script (localStorage) before bouncing back to the app.
// No server-side DB — this is a single-user tool, so the refresh token
// lives in the browser, same trust model as the rest of the app's data.

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI  = 'https://katie-formats-app.vercel.app/api/auth/callback';

export default async function handler(req, res) {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    return res.status(500).send('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set in Vercel env vars.');
  }

  const url = new URL(req.url, 'https://x.internal');
  const code = url.searchParams.get('code');
  const err = url.searchParams.get('error');

  if (err) return res.status(200).send(htmlMessage('Google sign-in was cancelled or denied.', err));
  if (!code) return res.status(400).send(htmlMessage('Missing authorization code.', ''));

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code'
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.refresh_token) {
      return res.status(200).send(htmlMessage(
        'Sign-in succeeded but no refresh token was returned.',
        (tokenData.error_description || tokenData.error || 'unknown') +
        ' — try again; if it repeats, revoke access at https://myaccount.google.com/permissions and retry.'
      ));
    }

    // The token is SHOWN as well as stored. The PWA only ever needed it in
    // localStorage, but the overnight video pipeline runs on a Mac with no
    // browser, so the same token has to be copyable out by hand exactly once.
    // The redirect is now a link rather than automatic — an auto-redirect would
    // flash the token past before it could be copied. localStorage is still set
    // the moment this page loads, so the app behaves as before once you click.
    return res.status(200).send(`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:24px;max-width:760px;">
      <script>
        localStorage.setItem('kf_google_refresh_token', ${JSON.stringify(tokenData.refresh_token)});
        localStorage.setItem('kf_google_connected_at', new Date().toISOString());
      </script>
      <h3>Connected.</h3>
      <p>Copy this refresh token — it is shown once and is what lets the video
         pipeline upload to Drive without a browser:</p>
      <textarea readonly rows="3" style="width:100%;font-family:monospace;font-size:13px;padding:8px;"
        onclick="this.select()">${tokenData.refresh_token}</textarea>
      <p style="color:#666;font-size:13px;">Treat it like a password — it grants
         access to files this app creates in your Drive.</p>
      <p><a href="/?gdrive_connected=1">← Continue to the app</a></p>
    </body></html>`);
  } catch (e) {
    return res.status(500).send(htmlMessage('Token exchange failed.', e.message));
  }
}

function htmlMessage(title, detail) {
  return `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:24px;">
    <h3>${title}</h3><p style="color:#666;">${detail}</p>
    <a href="/">← Back to app</a>
  </body></html>`;
}
