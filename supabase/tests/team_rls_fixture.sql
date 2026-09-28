-- Synthetic Supabase roles and identities for a disposable local PostgreSQL cluster.
create role anon nologin;
create role authenticated nologin;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid
  language sql stable set search_path = ''
  as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
create publication supabase_realtime;

\ir ../migrations/001_team_dashboard.sql

grant usage on schema public to anon, authenticated;
grant select on public.teams, public.team_members, public.ledger_events to anon, authenticated;
grant insert on public.ledger_events to anon, authenticated;
grant usage on sequence public.ledger_events_seq_seq to anon, authenticated;

insert into auth.users (id) values
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222'),
  ('33333333-3333-4333-8333-333333333333');
insert into public.teams (id, name, slug) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Alpha', 'alpha'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Beta', 'beta'),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'Gamma', 'gamma');
insert into public.team_members (team_id, user_id, display_name) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111', 'alice'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '11111111-1111-4111-8111-111111111111', 'alice'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '22222222-2222-4222-8222-222222222222', 'bob'),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '33333333-3333-4333-8333-333333333333', 'carol');

-- A pre-migration username-prefixed row remains readable after migration.
insert into public.ledger_events (team_id, node_id, user_id, type, client_timestamp) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'alice:legacy', '11111111-1111-4111-8111-111111111111', 'node.join', now()),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'bob:legacy', '22222222-2222-4222-8222-222222222222', 'node.join', now()),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'carol:legacy', '33333333-3333-4333-8333-333333333333', 'node.join', now());
