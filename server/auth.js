// API-key auth for the engine. Once deployed publicly on Railway, only callers
// holding SYNC_API_KEY (i.e. n8n) may trigger syncs.
//
// Mounted on /api. Exemptions:
//   • /health           — Railway healthcheck must stay open
//   • /hooks/*           — inbound webhooks (Monday) have their own trust model
//                          (challenge handshake / hard-to-guess path); route them
//                          through n8n if you want them behind the key too.
//
// If SYNC_API_KEY is unset (local dev), auth is disabled with a warning.

let warned = false;

export function apiKeyAuth(req, res, next) {
  const required = process.env.SYNC_API_KEY;
  if (!required) {
    if (!warned) {
      console.warn('[auth] SYNC_API_KEY not set — API is OPEN (fine for local dev, NOT for Railway).');
      warned = true;
    }
    return next();
  }
  // req.path is relative to the /api mount point.
  if (req.path === '/health' || req.path.startsWith('/hooks/')) return next();

  const header = req.get('authorization') || '';
  const provided = req.get('x-api-key') || header.replace(/^Bearer\s+/i, '').trim();
  if (provided && provided === required) return next();

  return res.status(401).json({ error: 'unauthorized — missing or invalid API key' });
}
