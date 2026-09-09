# Deploying openGym to Vercel + Supabase

openGym is built to run as a long-lived Docker process with a data directory it owns. This
document covers the other shape: a serverless deployment where there is no disk, and the data
lives in Supabase.

**Nothing here changes the Docker deployment.** With no `SUPABASE_URL` set, the API reads and
writes exactly the files it always did, in exactly the same layout.

## What you give up

- **The AI Coach.** It spawns long-running provider CLIs under a separate user, keeps job
  payloads on disk and runs reviews on a schedule. A serverless function has none of that, so
  on this deployment the Coach is not merely off — it is never imported, and its provider SDKs
  are excluded from the bundle.
- **The daily workout reminder.** It is an interval in a process that is always running.
  Web Push itself still works (rest-timer alerts included); only the unattended daily sweep
  is gone. It can come back as a Vercel Cron job if you want it.

Teams, passkeys, sync, the admin dashboard, invite-only signup and everything else are
unaffected.

## 1. Create the Supabase project

Run [`supabase/schema.sql`](../supabase/schema.sql) in the SQL editor. It creates one `kv`
table and enables row-level security with no policies, so the anon key can read nothing.

From **Project Settings → API**, take the project URL and the **`service_role`** key.

> The service-role key bypasses row-level security. It belongs only in Vercel's environment
> variables — never in the frontend, never in the repository.

## 2. Create the Vercel project

Import the fork. [`vercel.json`](../vercel.json) already describes the build: the frontend as a
static site, `api/index.js` as the single function every `/api/*` request is rewritten onto.

The ~140 MB of exercise images and GIFs are not deployed — there is nowhere to put them. The
`vercel-build` script points them at the same pinned jsDelivr copy the mobile build uses.

## 3. Environment variables

| Variable | Required | Notes |
|---|---|---|
| `SUPABASE_URL` | yes | Project URL. Its presence is what selects the Supabase backend. `NEXT_PUBLIC_SUPABASE_URL` is accepted too, so Vercel's Supabase integration works with nothing added by hand. |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Service-role key. Server-side only. `SUPABASE_SECRET_KEY` is accepted as an alias. The anon and publishable keys will **not** work — every table here is policy-less, so they can read nothing. |
| `APP_PASSWORD` | yes | The one password everyone on this instance types. Defaults to `shoarmasate` — change it. |
| `ORIGIN` | no | Full origin, e.g. `https://opengym.vercel.app`. Only used as the fallback when a request arrives without a proxy scheme header, and for the push contact address. |
| `ADMIN_UIDS` | no | Comma-separated user ids that get the admin dashboard. |
| `SESSION_DAYS` | no | Cookie lifetime, default 90. |
| `VAPID_SUBJECT` | no | Contact URL for push. Defaults to `ORIGIN`. |

There is nothing here that has to match the domain. Sign-in is a password, so a new deployment
URL, a preview branch and a custom domain all work the same and none of them needs a variable
updated to keep working.

The session secret and the Web Push keypair are generated on first boot and stored in `kv`, so
every instance agrees on them. Nothing to configure.

### About the password

One password for the whole instance, and profiles behind it. Anyone who has it can open any
profile here — it says whose log you are looking at, not who you are. That is the intended
trade for a group of friends sharing a server, and it is worth knowing rather than assuming
otherwise. Wrong guesses are rate-limited per instance, but the real protection is that the
password is only given to people you train with.

## 4. Bringing existing data with you

Already running openGym somewhere? Copy the data directory across before the first sign-in:

```bash
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/migrate-to-supabase.mjs ./data
```

It copies every profile, the teams, the passkey credentials, and — importantly — the session
signing secret and the Web Push keypair, so nobody is signed out and no push subscription
breaks. It refuses to run against a deployment that already has profiles unless you pass
`--force`, because running it twice would roll everyone back to the state of the dump.

## 5. Installing on phones

There is no app to sideload for this deployment. Open the site in Safari (iOS) or Chrome
(Android) and add it to the home screen; it installs as a PWA with offline support and push.
Push requires HTTPS, which Vercel gives you.

The standalone Android APK is a different build with no backend at all — it cannot join a team,
because there is no server for it to share anything with.

## Concurrency

All of `db` — every profile, credential and team — is one document, and two things can go
wrong with that once more than one person is using the app at the same moment.

**Across instances.** Two functions each read the document, each add a member, each save. Every
save is a compare-and-set against the version it read at, so the second is refused and the
request is replayed against fresh data rather than overwriting the first.

**Within one instance.** A single function serves several requests at once, and `db` is module
state, so concurrent requests would otherwise interleave — both told they succeeded, one
change gone. The reload/run/commit cycle is therefore serialized per instance.

Both are covered by [`api/test/concurrency.test.js`](../api/test/concurrency.test.js), which
runs against a store with real latency; against a synchronous one the failure cannot reproduce
and the test would prove nothing.

Per-profile training data is keyed per profile and needs none of this — a profile only ever
writes its own.

## Running a long-lived server against Supabase

Nothing forces Supabase and serverless to go together. `npm start` in `api/` with the two
Supabase variables set runs the ordinary server against the hosted database — useful for
trying the backend locally, and a legitimate way to self-host. The AI Coach stays unavailable
either way; it needs a filesystem it owns.

## Why the routes point at `/frontend`

`@vercel/static-build` publishes a build's output under the directory its `src` lives in. The
frontend's `package.json` is in `frontend/`, so `frontend/dist/index.html` is deployed as
`/frontend/index.html` — not `/index.html`. Routes that assume the root produce a `NOT_FOUND`
for every page while the build log reports complete success, which is a confusing pair of
symptoms to be handed.

Hence the two rewrites: `/` serves `frontend/index.html`, and everything else is looked up
under `frontend/`. There is no SPA fallback and none is needed — the app uses a hash router, so
`/#/team` is the single path `/` as far as the server is concerned, and a request for a file
that genuinely is not there should still 404.
