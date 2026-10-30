# Team ledger: Turso and the AV gateway

The central AV dashboard server stores team events in Turso. Workers authenticate
to its HTTP gateway with opaque AV user tokens. The browser polls its own
`/api/team/ledger` every five seconds and receives replayed state.

The database token belongs on the central server or a machine performing an
explicit administrator command. Workers and browsers do not receive it.

## Central server

Provision a Turso database separately, choose a team UUID, and configure the
server's `av.yaml` or `~/.config/agent-valley/settings.yaml`:

```yaml
team:
  relay_url: https://av.example.com
  id: 11111111-1111-4111-8111-111111111111
  display_name: central-server
  turso_url: libsql://your-team-region.turso.io
  turso_auth_token_env: TURSO_AUTH_TOKEN
```

Set the database token in the server environment variable named by
`turso_auth_token_env`; its default is `TURSO_AUTH_TOKEN`. Keep the secret value
out of YAML, invitations, command arguments and logs. A local `file:` database
can be used without a remote database token for development or offline tests.

For a new team, initialize the managed schema and save the owner's AV login:

```bash
av team init --name "Example team" --slug example-team
```

`init` creates an owner UUID unless `--user-id UUID` is supplied. It also accepts
`--display-name NAME` and `--days N`; token validity defaults to 30 days, with a
supported range of 1–365 days. It saves the owner token locally without printing
it. For an existing ledger migration, follow the import sequence below before
initializing a new team over the target.

Run the dashboard server and expose the gateway through HTTPS. Remote database
access requires its configured token environment variable; request handlers do
not initialize an empty database. Dashboard status/intervention authentication
remains separate from team bearer authentication. See
[dashboard access setup](./environment-setup.md).

## Workers and user tokens

Workers configure only the gateway, team UUID and optional display name:

```yaml
team:
  relay_url: https://av.example.com
  id: 11111111-1111-4111-8111-111111111111
  display_name: alice-desktop
```

An administrator issues a private token file on the central/admin machine:

```bash
av team add-member --name Alice \
  --token-file "$HOME/.agent-valley/invitations/alice.token"
```

The file is created with private permissions and must not already exist.
`--user-id UUID` retains an imported identity; `--role owner|admin|member`
defaults to `member`, and `--days N` defaults to 30. Transfer the AV token through
a secure channel. On the worker, run:

```bash
av login
```

Enter the AV user token at the password prompt. AV verifies it with the gateway
and saves a private `~/.agent-valley/credentials.json`. A saved session is bound
to the normalized full gateway URL, including its path, and the team UUID.
Changing either requires another login. HTTPS is required; HTTP is accepted only
for loopback gateways such as `http://127.0.0.1:9741`.

The server stores SHA-256 token hashes, expiry and revocation records. Every
request checks current membership. New published node IDs must be
`<authenticated-user-uuid>:<nonempty-machine-name>`; a display name does not
grant node ownership. The API rejects user identity supplied in an event body.

Revoke a member's active tokens on the central/admin machine with:

```bash
av team revoke --user-id 22222222-2222-4222-8222-222222222222
```

This preserves event history. Issue a replacement token to a new private file
and log in again when rotating access. `av logout` deletes only the local login;
it does not revoke the server token. Restart a running dashboard/worker publisher
after changing its login.

## Drizzle schema and migrations

Drizzle manages the TypeScript schema and generated migration history. From an
AV source checkout:

```bash
bun run db:generate
bun run db:check
bun run db:migrate
```

`db:generate` derives migrations from
`packages/core/src/relay/turso-schema.ts` using `drizzle.config.ts` and writes
them under `turso/migrations`; generating files does not require database
credentials. `db:check` checks the migration metadata. `db:migrate` runs
`av team migrate`, which applies pending migrations to the explicitly configured
database using the admin environment. Review generated migrations before
applying them. `av team init` and the legacy import also apply pending migrations
explicitly. Gateway requests never generate or apply migrations.

Published CLI packages include the migration SQL and journal. Installing the CLI
through its package manager also installs `@libsql/client` and its platform
driver dependencies; copying the CLI JavaScript file alone is insufficient.

## Import an existing Supabase ledger

The legacy `team.supabase_url` and `team.supabase_anon_key` configuration keys and
Supabase login files cannot be reused. Migrate data explicitly and issue new AV
tokens. Remote database provisioning and production data import are separate
operator actions; local tests do not establish that either has occurred.

Use a fresh Turso target, keep the original database/export available, and pause
legacy publishers while capturing the final snapshot. Use the existing
PostgreSQL administrator connection to run this read-only export from the AV
checkout:

```bash
psql -X -qAt -v ON_ERROR_STOP=1 \
  -f turso/import/export-supabase.sql > team-export.json
```

The export includes `teams`, `team_members` and `ledger_events`, with no
`auth.users` records, passwords, access tokens or signing keys. Treat it as
private team data and keep it out of version control.

Configure the central/admin machine for the target Turso database and original
team UUID, then import:

```bash
av team import-supabase --file ./team-export.json
```

The file must be a regular JSON file no larger than 32,000,000 bytes, containing
at most 20,000 ledger events. The importer validates UUIDs, timestamps, event
types and payloads before writing. Null timestamps must be corrected explicitly
in the source/export; missing dates are not invented. Team and user UUIDs,
sequence numbers, timestamps and historical node IDs are preserved, including
events whose users no longer have a current membership. Those historical node
IDs remain readable; new events still require UUID-based ownership.

Import inserts matching records without overwriting existing data. Reapplying
an unchanged snapshot is idempotent while the corresponding target records still
match. Conflicting target records or a failed data batch roll back the entire
data import transaction. Schema migrations are an earlier, separate explicit
step. Reconcile conflicts or choose a fresh target; do not reset identities or
sequence numbers to bypass them.

After import, issue owner/member AV tokens using each retained `--user-id`.
`av team init --name NAME --slug SLUG --user-id UUID` can save an owner's local
login; use the original team name and slug. Subsequent role/member changes can
make an old snapshot conflict on reimport. Check the gateway session, replayed
node/event counts and the next sequence after import before moving workers to
the new gateway. Stop legacy publishers, give workers the new gateway config and
AV token, log in, and restart their publishers.

## HTTP and dashboard behavior

| Endpoint                                              | Authentication                                 | Result                                                     |
| ----------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------- |
| `GET /api/team/session?team_id=UUID`                  | AV team bearer token                           | Authenticated identity and expiry                          |
| `GET /api/team/relay?team_id=UUID&after=0&limit=1000` | AV team bearer token                           | Ordered events after the sequence cursor                   |
| `POST /api/team/relay`                                | AV team bearer token                           | Publish `{teamId,eventId,event}` with idempotent event IDs |
| `GET /api/team/ledger`                                | Local dashboard status token/HMAC cookie rules | Replayed state for its browser                             |

Browser writes must present the dashboard's own Origin. Originless CLI writes
still require a valid AV bearer token. Query parameters and JSON bodies are
validated; publish bodies are limited to 64,000 bytes. No request accepts a
database connection URL or user ID as a substitute for authentication.

The browser receives neither the user token nor the database credential. Reads
are uncached, paged at up to 1,000 events, and the dashboard caps its replay at
20,000 events. Missing/expired/revoked credentials, denied membership or an
unavailable gateway leave the local orchestrator view visible with an error.
Local orchestrator updates continue using `/api/events` SSE.
