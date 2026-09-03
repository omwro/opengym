/* Serverless entry point (Vercel).
 *
 * The long-lived server owns one copy of `db` in memory and is the only writer, so a request
 * can read it, mutate it and save it without anyone else moving underneath. A serverless host
 * runs many short-lived instances of this file at once, and that assumption stops holding:
 * two people accepting the same join code, on two instances, would each save a `db` that never
 * saw the other's change, and one of them would silently not be in the team.
 *
 * So every request here does the whole cycle explicitly:
 *
 *   1. reload `db` from the store, with the version it was read at
 *   2. run the request, capturing the response instead of sending it
 *   3. commit — the store refuses the write if `db` moved since step 1
 *   4. on refusal, throw the captured response away and replay from step 1
 *
 * The response is buffered for exactly that reason: a replayed request must not be the second
 * half of a reply the client has already started reading.
 *
 * Requests that never call saveDb() skip step 3 entirely and cost one read.
 *
 * That handles two *instances* racing. Two requests inside ONE instance are a separate problem
 * with the same consequence: `db` is module state, so concurrent requests would interleave —
 * each reloading over the other's view, then each saving from a version the other had already
 * moved past. Both would be told they succeeded and one change would be gone, which is exactly
 * what happened the first time three profiles published a plan simultaneously.
 *
 * So the cycle below is serialized per instance. It is a real throughput ceiling and a
 * deliberate one: the work is a JSON read and write, the app is used by a gym's worth of
 * people rather than a stadium's, and the platform's answer to load is more instances — which
 * the compare-and-set already covers.
 */
import { dispatch, reloadDb, flushDb } from './server.js';

const MAX_ATTEMPTS = 5;

// One at a time, per instance. Each request waits for the previous cycle to finish before
// reloading, so no two ever hold overlapping views of `db`.
let queue = Promise.resolve();
function exclusive(fn) {
  const run = queue.then(fn, fn);
  // The lock must be released whether the request succeeded or threw, and a rejection here
  // must not poison the chain for every request behind it.
  queue = run.then(() => {}, () => {});
  return run;
}

/** A minimal ServerResponse stand-in — the surface `json()` in server.js actually uses. */
function capture() {
  const out = { status: 200, headers: {}, body: '', sent: false };
  return {
    out,
    res: {
      get headersSent() { return out.sent; },
      writeHead(code, headers) { out.status = code; Object.assign(out.headers, headers || {}); out.sent = true; },
      end(body) { out.body = body ?? ''; }
    }
  };
}

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

  const done = await exclusive(async () => {
    for (let attempt = 1; ; attempt++) {
      await reloadDb();
      const cap = capture();
      await dispatch(req, cap.res);

      try {
        await flushDb();
      } catch (e) {
        if (e.name === 'ConflictError' && attempt < MAX_ATTEMPTS) continue;   // replay on fresh data
        console.error('commit failed', req.method, req.url, e);
        return { status: 503, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
                 body: '{"error":"busy — please try again"}' };
      }
      return cap.out;
    }
  });

  res.writeHead(done.status, done.headers);
  res.end(done.body);
}
