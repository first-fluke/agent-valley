-- Run with the existing PostgreSQL administrator connection, never a browser credential.
-- psql -X -qAt -v ON_ERROR_STOP=1 -f turso/import/export-supabase.sql > team-export.json
-- This read-only export includes no auth.users records, passwords, tokens or signing keys.
begin transaction isolation level repeatable read read only;
select jsonb_build_object(
  'version', 1,
  'teams', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.teams t), '[]'::jsonb),
  'team_members', coalesce((select jsonb_agg(to_jsonb(m) order by m.team_id,m.user_id) from public.team_members m), '[]'::jsonb),
  'ledger_events', coalesce((select jsonb_agg(to_jsonb(e) order by e.seq) from public.ledger_events e), '[]'::jsonb)
);
commit;
