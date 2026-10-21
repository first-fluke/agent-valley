CREATE TABLE `ledger_events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`team_id` text NOT NULL,
	`event_id` text NOT NULL,
	`node_id` text NOT NULL,
	`user_id` text NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`client_timestamp` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`source` text DEFAULT 'native' NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ledger_event_id_length" CHECK(length("ledger_events"."event_id") between 1 and 200),
	CONSTRAINT "ledger_event_type" CHECK("ledger_events"."type" in ('node.join','node.reconnect','node.leave','agent.start','agent.done','agent.failed','agent.cancelled')),
	CONSTRAINT "ledger_payload_object" CHECK(json_valid("ledger_events"."payload") and json_type("ledger_events"."payload") = 'object'),
	CONSTRAINT "ledger_source" CHECK("ledger_events"."source" in ('native','supabase-import')),
	CONSTRAINT "ledger_native_node_owner" CHECK("ledger_events"."source" = 'supabase-import' or (lower(substr("ledger_events"."node_id", 1, length("ledger_events"."user_id") + 1)) = lower("ledger_events"."user_id") || ':' and length("ledger_events"."node_id") > length("ledger_events"."user_id") + 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ledger_events_team_event_unique` ON `ledger_events` (`team_id`,`event_id`);--> statement-breakpoint
CREATE INDEX `idx_ledger_team_seq` ON `ledger_events` (`team_id`,`seq`);--> statement-breakpoint
CREATE TABLE `team_members` (
	`team_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`display_name` text NOT NULL,
	`joined_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`team_id`, `user_id`),
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "team_members_role" CHECK("team_members"."role" in ('owner', 'admin', 'member')),
	CONSTRAINT "team_members_display_name_length" CHECK(length(trim("team_members"."display_name")) between 1 and 200)
);
--> statement-breakpoint
CREATE INDEX `idx_team_members_user` ON `team_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `team_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`team_id`,`user_id`) REFERENCES `team_members`(`team_id`,`user_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "team_tokens_hash_length" CHECK(length("team_tokens"."token_hash") = 64),
	CONSTRAINT "team_tokens_expiry" CHECK("team_tokens"."expires_at" > 0)
);
--> statement-breakpoint
CREATE INDEX `idx_team_tokens_member` ON `team_tokens` (`team_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `teams` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "teams_name_length" CHECK(length(trim("teams"."name")) between 1 and 200),
	CONSTRAINT "teams_slug_length" CHECK(length(trim("teams"."slug")) between 1 and 200)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `teams_slug_unique` ON `teams` (`slug`);