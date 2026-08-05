PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text DEFAULT 'New Maker' NOT NULL,
	`working_dir` text,
	`workspace_kind` text DEFAULT 'project' NOT NULL,
	`meka_role` text,
	`meka_target_json` text,
	`meka_project_id` text,
	`meka_role_id` text,
	`is_formal` integer DEFAULT 0 NOT NULL,
	`formal_type` text,
	`formal_link` text,
	`formal_ref` text,
	`formal_content_json` text,
	`model` text DEFAULT 'claude-sonnet-4-6' NOT NULL,
	`effort` text DEFAULT 'high' NOT NULL,
	`permission_mode` text DEFAULT 'ask' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`sdk_session_id` text,
	`total_token_usage` integer DEFAULT 0 NOT NULL,
	`total_cost_usd` real DEFAULT 0 NOT NULL,
	`total_cost_amount` real DEFAULT 0 NOT NULL,
	`total_cost_currency` text,
	`total_cost_is_approximate` integer DEFAULT false NOT NULL,
	`context_tokens` integer DEFAULT 0 NOT NULL,
	`context_window` integer DEFAULT 0 NOT NULL,
	`fast_mode` integer DEFAULT false NOT NULL,
	`plan_mode_enabled` integer DEFAULT false NOT NULL,
	`cleared_at` integer,
	`pinned_at` integer,
	`summary` text,
	`provider_id` text,
	`user_send_at` integer,
	`agent_kind` text DEFAULT 'cc' NOT NULL,
	`orca_role` text,
	`parent_session_id` text,
	`forked_at_message_id` text,
	`worktree_path` text,
	`source` text DEFAULT 'desktop' NOT NULL,
	`feishu_open_id` text,
	`feishu_bot_app_id` text,
	`im_bot_context_id` text,
	`im_user_id` text,
	`used_project_context` integer DEFAULT false NOT NULL,
	`codex_history_has_product_prompt` integer,
	`extra_dirs` text DEFAULT '[]' NOT NULL,
	`remote_host_id` text,
	`capability_snapshot_json` text,
	`active_turn_started_at` integer,
	`active_turn_pid` integer,
	`last_turn_ended_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`meka_role_id`) REFERENCES `meka_roles`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`parent_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_sessions`("id", "title", "working_dir", "workspace_kind", "meka_role", "meka_target_json", "meka_project_id", "meka_role_id", "is_formal", "formal_type", "formal_link", "formal_ref", "formal_content_json", "model", "effort", "permission_mode", "status", "sdk_session_id", "total_token_usage", "total_cost_usd", "total_cost_amount", "total_cost_currency", "total_cost_is_approximate", "context_tokens", "context_window", "fast_mode", "plan_mode_enabled", "cleared_at", "pinned_at", "summary", "provider_id", "user_send_at", "agent_kind", "orca_role", "parent_session_id", "forked_at_message_id", "worktree_path", "source", "feishu_open_id", "feishu_bot_app_id", "im_bot_context_id", "im_user_id", "used_project_context", "codex_history_has_product_prompt", "extra_dirs", "remote_host_id", "capability_snapshot_json", "active_turn_started_at", "active_turn_pid", "last_turn_ended_at", "created_at", "updated_at") SELECT "id", "title", "working_dir", "workspace_kind", "meka_role", "meka_target_json", "meka_project_id", "meka_role_id", "is_formal", "formal_type", "formal_link", "formal_ref", "formal_content_json", "model", "effort", "permission_mode", "status", "sdk_session_id", "total_token_usage", "total_cost_usd", "total_cost_amount", "total_cost_currency", "total_cost_is_approximate", "context_tokens", "context_window", "fast_mode", "plan_mode_enabled", "cleared_at", "pinned_at", "summary", "provider_id", "user_send_at", "agent_kind", "orca_role", "parent_session_id", "forked_at_message_id", "worktree_path", "source", "feishu_open_id", "feishu_bot_app_id", "im_bot_context_id", "im_user_id", "used_project_context", "codex_history_has_product_prompt", "extra_dirs", "remote_host_id", "capability_snapshot_json", "active_turn_started_at", "active_turn_pid", "last_turn_ended_at", "created_at", "updated_at" FROM `sessions`;--> statement-breakpoint
DROP TABLE `sessions`;--> statement-breakpoint
ALTER TABLE `__new_sessions` RENAME TO `sessions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_sessions_updated_at` ON `sessions` (`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_sessions_user_send_at` ON `sessions` (`user_send_at`);--> statement-breakpoint
CREATE INDEX `idx_sessions_sdk_session_id` ON `sessions` (`sdk_session_id`);--> statement-breakpoint
CREATE INDEX `idx_sessions_workdir_created` ON `sessions` (`working_dir`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_sessions_created_at` ON `sessions` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_sessions_workspace_kind` ON `sessions` (`workspace_kind`);--> statement-breakpoint
CREATE INDEX `idx_sessions_meka_project_id` ON `sessions` (`meka_project_id`);--> statement-breakpoint
CREATE INDEX `idx_sessions_meka_role_id` ON `sessions` (`meka_role_id`);--> statement-breakpoint
CREATE INDEX `idx_sessions_parent_session_id` ON `sessions` (`parent_session_id`);--> statement-breakpoint
CREATE INDEX `idx_sessions_orca_role` ON `sessions` (`orca_role`);--> statement-breakpoint
CREATE INDEX `idx_sessions_worktree_path` ON `sessions` (`worktree_path`);--> statement-breakpoint
CREATE INDEX `idx_sessions_feishu_lookup` ON `sessions` (`source`,`feishu_bot_app_id`,`feishu_open_id`);--> statement-breakpoint
CREATE INDEX `idx_sessions_im_lookup` ON `sessions` (`source`,`im_bot_context_id`,`im_user_id`);