-- Run only against the disposable cluster created by run-team-rls-local.sh.
-- The fixture and both migrations have already been applied.
do $$
begin
  -- PostgreSQL may serialize an empty search_path as either search_path=
  -- or search_path="" in pg_proc.proconfig; both represent the same setting.
  if (select not p.prosecdef or (
        p.proconfig is distinct from array['search_path=']
        and p.proconfig is distinct from array['search_path=""']
      )
      from pg_proc p where p.oid = 'public.team_rls_is_member(uuid)'::regprocedure) then
    raise exception 'membership helper must be SECURITY DEFINER with empty search_path';
  end if;
  if has_function_privilege('anon', 'public.team_rls_is_member(uuid)', 'EXECUTE') then
    raise exception 'anonymous role must not execute membership helper';
  end if;
  if not has_function_privilege('authenticated', 'public.team_rls_is_member(uuid)', 'EXECUTE') then
    raise exception 'authenticated role needs membership helper';
  end if;
end $$;

set role authenticated;
set request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
do $$
begin
  if (select count(*) from public.teams) <> 2 then raise exception 'Alice team reads'; end if;
  if (select count(*) from public.team_members) <> 3 then raise exception 'Alice membership reads or recursion'; end if;
  if (select count(*) from public.ledger_events) <> 2 then raise exception 'Alice ledger reads'; end if;
  if (select count(*) from public.ledger_events where node_id = 'alice:legacy') <> 1 then
    raise exception 'legacy row should remain readable';
  end if;
  if (select count(*) from public.team_members where team_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc') <> 0 then
    raise exception 'Alice can read another team';
  end if;

  insert into public.ledger_events (team_id, node_id, user_id, type, client_timestamp) values
    ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111:laptop', '11111111-1111-4111-8111-111111111111', 'node.join', now()),
    ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '11111111-1111-4111-8111-111111111111:laptop', '11111111-1111-4111-8111-111111111111', 'node.join', now());

  begin
    insert into public.ledger_events (team_id, node_id, user_id, type, client_timestamp) values
      ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '11111111-1111-4111-8111-111111111111:laptop', '11111111-1111-4111-8111-111111111111', 'node.join', now());
    raise exception 'other-team write unexpectedly allowed';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.ledger_events (team_id, node_id, user_id, type, client_timestamp) values
      ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '11111111-1111-4111-8111-111111111111:laptop', '22222222-2222-4222-8222-222222222222', 'node.join', now());
    raise exception 'other-user write unexpectedly allowed';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.ledger_events (team_id, node_id, user_id, type, client_timestamp) values
      ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '22222222-2222-4222-8222-222222222222:laptop', '11111111-1111-4111-8111-111111111111', 'node.join', now());
    raise exception 'other-user node ID unexpectedly allowed';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.ledger_events (team_id, node_id, user_id, type, client_timestamp) values
      ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'alice:legacy', '11111111-1111-4111-8111-111111111111', 'node.join', now());
    raise exception 'legacy display-name node ID unexpectedly allowed for new write';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.ledger_events (team_id, node_id, user_id, type, client_timestamp) values
      ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111:', '11111111-1111-4111-8111-111111111111', 'node.join', now());
    raise exception 'empty node suffix unexpectedly allowed';
  exception when insufficient_privilege then null;
  end;
end $$;

set request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222';
do $$
begin
  if (select count(*) from public.teams) <> 1 then raise exception 'Bob team reads'; end if;
  if (select count(*) from public.team_members) <> 2 then raise exception 'Bob membership reads'; end if;
  if (select count(*) from public.ledger_events where team_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') <> 0 then
    raise exception 'Bob can read Alpha events';
  end if;
  insert into public.ledger_events (team_id, node_id, user_id, type, client_timestamp) values
    ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '22222222-2222-4222-8222-222222222222:desktop', '22222222-2222-4222-8222-222222222222', 'node.join', now());
end $$;

set request.jwt.claim.sub = '33333333-3333-4333-8333-333333333333';
do $$
begin
  if (select count(*) from public.teams) <> 1 then raise exception 'Carol team reads'; end if;
  if (select count(*) from public.team_members) <> 1 then raise exception 'Carol membership reads'; end if;
  if (select count(*) from public.ledger_events where team_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb') <> 0 then
    raise exception 'Carol can read Beta events';
  end if;
end $$;

reset role;
set role anon;
set request.jwt.claim.sub = '';
do $$
begin
  if (select count(*) from public.teams) <> 0 then raise exception 'anonymous team read'; end if;
  if (select count(*) from public.team_members) <> 0 then raise exception 'anonymous membership read'; end if;
  if (select count(*) from public.ledger_events) <> 0 then raise exception 'anonymous ledger read'; end if;
  begin
    insert into public.ledger_events (team_id, node_id, user_id, type, client_timestamp) values
      ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111:laptop', '11111111-1111-4111-8111-111111111111', 'node.join', now());
    raise exception 'anonymous write unexpectedly allowed';
  exception when insufficient_privilege then null;
  end;
end $$;
-- Role scoping must still deny an anonymous session with a forged claim value.
set request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
do $$
begin
  if (select count(*) from public.teams) <> 0 then raise exception 'anonymous forged-claim team read'; end if;
  if (select count(*) from public.team_members) <> 0 then raise exception 'anonymous forged-claim membership read'; end if;
  if (select count(*) from public.ledger_events) <> 0 then raise exception 'anonymous forged-claim ledger read'; end if;
end $$;
reset role;

select 'team RLS regression passed' as result;
