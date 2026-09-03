-- openGym on Supabase — run this once in the Supabase SQL editor.
--
-- One table. openGym's data model is a handful of JSON documents (one `db` holding users,
-- passkey credentials, push subscriptions, invites and teams; one per profile holding that
-- profile's training), so the schema that fits it is a key/value store, not a relational
-- decomposition of a model the application never queries relationally.
--
-- `version` is what makes concurrent writes safe. Every save of the `db` document is a
-- compare-and-set against the version it was read at; a serverless instance whose copy has
-- gone stale is refused and replays the request instead of overwriting someone else's change.

create table if not exists public.kv (
  key        text primary key,
  value      jsonb       not null,
  version    bigint      not null default 1,
  updated_at timestamptz not null default now()
);

-- Row-level security is on with no policies, which denies everything by default. That is
-- deliberate: the only client is the API, which uses the service-role key and bypasses RLS.
-- Should the anon key ever leak into the frontend bundle, it still reads nothing here.
alter table public.kv enable row level security;

-- Keys in use:
--   db                the single application document (users, creds, subs, invites, teams)
--   state:<uid>       one profile's training: routines, week, workouts, weigh-ins, settings
--   secret            session-cookie signing secret, generated once on first boot
--   vapid             Web Push keypair, generated once on first boot
