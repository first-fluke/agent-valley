-- Repair recursive membership reads and bind new ledger node IDs to auth.uid().
-- Run after 001_team_dashboard.sql. Existing ledger rows remain readable; only
-- new inserts require the authenticated UUID prefix.

create or replace function public.team_rls_is_member(target_team_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null
    and exists (
      select 1
      from public.team_members as member
      where member.team_id = target_team_id
        and member.user_id = auth.uid()
    );
$$;

-- The function returns only the caller's own membership, never member data.
-- Anonymous requests have no policy that calls it and receive no execute grant.
revoke all on function public.team_rls_is_member(uuid) from public;
grant execute on function public.team_rls_is_member(uuid) to authenticated;

drop policy if exists "team_member_read" on public.teams;
create policy "team_member_read" on public.teams
  for select to authenticated
  using (public.team_rls_is_member(id));

drop policy if exists "team_members_read" on public.team_members;
create policy "team_members_read" on public.team_members
  for select to authenticated
  using (public.team_rls_is_member(team_id));

drop policy if exists "team_read" on public.ledger_events;
create policy "team_read" on public.ledger_events
  for select to authenticated
  using (public.team_rls_is_member(team_id));

drop policy if exists "own_write" on public.ledger_events;
create policy "own_write" on public.ledger_events
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and public.team_rls_is_member(team_id)
    and starts_with(node_id, auth.uid()::text || ':')
    and length(node_id) > length(auth.uid()::text) + 1
  );
