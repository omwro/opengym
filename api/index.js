/* Serverless entry point (Vercel).
 *
 * A serverless host runs many short-lived instances of this file at once, all writing one
 * `db` document. Two of them publishing a plan at the same moment would each save a copy that
 * never saw the other's change, and one plan would quietly not exist — while its author was
 * told it was published.
 *
 * The reload/run/commit cycle that makes that safe lives in server.js as `serve`, because the
 * long-lived server needs exactly the same thing the moment its store is remote — a laptop
 * pointed at the deployment's database is a second writer just like another instance is.
 *
 * What is left here is the part that is genuinely Vercel's: undoing the rewrite that folds
 * every /api/* path onto this one function, and reading a body the platform may already have
 * consumed.
 */
import { serve } from './server.js';

export default async function handler(req, res) {
  // Vercel rewrites /api/* onto this one function, and how much of the original path survives
  // that depends on the rewrite. `__p` is set by the rewrite in vercel.json precisely so the
  // route key does not depend on it; req.url is the fallback when it already looks right.
  const url = new URL(req.url, 'http://x');
  const passed = url.searchParams.get('__p');
  if (passed != null) {
    url.searchParams.delete('__p');
    const qs = url.searchParams.toString();
    req.url = '/api/' + passed.replace(/^\/+/, '') + (qs ? '?' + qs : '');
  }

  // The body is read once and pinned to the request: a replay must see the same payload, and
  // the underlying stream can only be consumed once.
  if (req.body === undefined && req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    try { req.body = raw ? JSON.parse(raw) : {}; }
    catch { res.statusCode = 400; res.setHeader('Content-Type', 'application/json'); return res.end('{"error":"bad json"}'); }
  }

  return serve(req, res);
}
