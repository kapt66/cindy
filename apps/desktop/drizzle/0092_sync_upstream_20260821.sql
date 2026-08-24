CREATE TABLE IF NOT EXISTS `hook_group_context_cursors` (
	`provider` text NOT NULL,
	`cursor_key` text NOT NULL,
	`cursor_id` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`provider`, `cursor_key`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `hook_group_context_cursors_updated_at_idx` ON `hook_group_context_cursors` (`updated_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `hook_group_message_stats` (
	`provider` text PRIMARY KEY NOT NULL,
	`row_count` integer NOT NULL,
	`text_bytes` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `media_invocations` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`model_id` text NOT NULL,
	`capability` text NOT NULL,
	`guide_revision` text NOT NULL,
	`guide_json` text NOT NULL,
	`state` text NOT NULL,
	`task_id` text,
	`response_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `media_invocations_owner_created_at_idx` ON `media_invocations` (`owner`,`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `media_invocations_owner_state_idx` ON `media_invocations` (`owner`,`state`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `subagent_run_aliases` (
	`session_id` text NOT NULL,
	`provider` text NOT NULL,
	`alias` text NOT NULL,
	`run_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`run_id`, `alias`),
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `subagent_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `subagent_run_aliases_lookup_idx` ON `subagent_run_aliases` (`session_id`,`provider`,`alias`,`created_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `subagent_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`provider` text NOT NULL,
	`logical_agent_id` text NOT NULL,
	`parent_tool_use_id` text,
	`aliases` text DEFAULT '[]' NOT NULL,
	`provider_run_ids` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`title` text,
	`description` text,
	`summary` text,
	`model` text,
	`reasoning_effort` text,
	`total_tokens` integer,
	`tool_uses` integer,
	`duration_ms` integer,
	`capabilities` text DEFAULT '{}' NOT NULL,
	`activity` text DEFAULT '[]' NOT NULL,
	`started_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ended_at` integer,
	`rewind_at` integer,
	`deleted_at` integer,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `subagent_runs_logical_idx` ON `subagent_runs` (`session_id`,`provider`,`logical_agent_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `subagent_runs_session_idx` ON `subagent_runs` (`session_id`,`rewind_at`,`deleted_at`,`started_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `subagent_runs_parent_tool_use_idx` ON `subagent_runs` (`session_id`,`parent_tool_use_id`);
