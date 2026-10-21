# 0001 — Turso team ledger

Date: 2026-10-21
Status: Accepted

## Scope

Replace the optional Supabase team ledger and its authentication dependency with
Turso. Local agents, the issue scheduler and LangGraph continue to use their
existing ports. Team users need to publish their own node events and read their
team's ordered ledger from multiple machines.

## Storage and schema ownership

Use `@libsql/client` for local SQLite and remote Turso connections. Drizzle defines
the schema in `packages/core/src/relay/turso-schema.ts`; Drizzle Kit generates
reviewable SQL, snapshots and a migration journal under `turso/migrations/`.
`av team migrate` explicitly applies pending migrations. Request handlers never
initialize a schema. Database policies stay in application code; SQL constraints
enforce storage integrity.

The external view is an authenticated session and cursor-based event API. The
conceptual model has teams, memberships, expiring access tokens and ledger events.
The physical schema uses text UUIDs and timestamps, integer sequence numbers,
typed JSON payloads and token hashes. Memberships have a composite team/user key;
tokens reference that key. Historical events reference their team and retain the
original author UUID even after membership removal.

Entities and memberships are normalized. Event payloads deliberately preserve
historical display names and execution details as immutable facts. No mutable
membership data is copied into tokens. Indexes support token hash lookup, member
revocation and ordered `(team_id, seq)` reads. A unique `(team_id, event_id)` key
makes exact publication retries idempotent; different content using the same key
fails with a conflict.

## Authentication boundary

A Turso database token is a server capability. It stays in the central server's
environment and explicitly invoked administration commands. Workers receive a
random AV token bound to one user, team, gateway URL and expiration. Only its
SHA-256 hash is stored in the database. Every API operation checks expiration,
revocation and current membership. Publishing also checks that the node ID begins
with the authenticated user's UUID. Browser polling uses the existing
same-origin dashboard authorization; the server calls the team gateway.

The gateway allows HTTPS, or HTTP on loopback for development. It validates
untrusted requests, bounds body size and event page size, and never returns SDK
errors or credentials. The existing dashboard polls every five seconds. Relaying
events remains behind the `LedgerEventPublisher` port.

## Transactions and concurrency

Publishing checks the token and membership within the same write transaction as
the event insertion. Concurrent retries converge on the unique event key. Read
queries check identity and fetch an ordered team page in one statement. SQLite
serializes writes; a failed transaction commits no partial import. Schema
migrations run explicitly before serving requests and record their applied
versions through Drizzle.

An offline Supabase export contains only teams, memberships and events. Import
preserves UUIDs, sequence gaps, legacy node IDs, timestamps and payloads. It creates
no authentication credentials or missing memberships. Matching imports can be
repeated, while conflicting rows roll back the entire import. Null timestamps or
invalid typed payloads require source repair; the importer does not invent values.
Legacy node IDs are accepted only by this administrator import path. New events
always use UUID-based ownership checks.

## Capacity and recovery

Assume small teams with tens of active nodes. Reads return at most 1,000 events
per page, and dashboard reconstruction is bounded to 20,000 events. The initial
import also supports at most 20,000 events and a 32 MB JSON file. Larger histories
need a separately designed checkpoint and batched migration; silently truncating
an import is forbidden. Event storage grows with event count and JSON payload
size; retaining execution errors can dominate the payload budget.

No automatic history deletion ships with this change. Operators choose retention
and preserve the event sequence and replay requirements when archiving. Keep a
verified backup before applying schema migrations or importing existing data.
For local SQLite, use an SQLite-aware consistent backup while writers are stopped
or coordinated. For hosted Turso, configure its supported backup/recovery policy
for the chosen service plan and verify restoration into a separate target.
Suggested initial recovery objectives are a daily recovery point and restoration
within one working day; operators must adjust these to the actual workload.

## Consequences

Turso does not replace Supabase Auth or row-level security. AV owns authentication
and team isolation through its gateway, with tests against real offline SQLite
for cross-team access, revocation, spoofed node ownership and migration rollback.
Administration requires database access on the central machine. Existing
Supabase sessions cannot be reused: administrators issue fresh AV tokens while
retaining imported user UUIDs. Remote database provisioning and production data
copying are separate operational steps; repository validation uses isolated local
databases.
