import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
	GIT_BASE_REFS,
	buildDependentMap,
	collectChangedFiles,
	collectTransitiveDependents,
	isSkippableFile,
	isTestFile,
	isWideFile,
	planRelatedUnitTests,
	shouldRunTestRunner,
	workspaceForFile,
} from "../test-related.mjs";

const workspaces = [
	{
		name: "desktop",
		cwd: "apps/desktop",
		status: "required",
		tiers: { unit: { status: "required" } },
	},
	{
		name: "@cindy/maker-core",
		cwd: "packages/maker-core",
		status: "required",
		tiers: { unit: { status: "required" } },
	},
	{
		name: "@cindy/maker-shared",
		cwd: "packages/maker-shared",
		status: "required",
		tiers: { unit: { status: "required" } },
	},
	{
		name: "project-context",
		cwd: "packages/project-context",
		status: "notApplicable",
		reason: "No tests",
		tiers: {},
	},
];

const packageJsonByCwd = {
	"apps/desktop": {
		name: "desktop",
		dependencies: {
			"@cindy/maker-core": "workspace:*",
		},
	},
	"packages/maker-core": {
		name: "@cindy/maker-core",
		dependencies: {
			"@cindy/maker-shared": "workspace:*",
		},
	},
	"packages/maker-shared": {
		name: "@cindy/maker-shared",
		dependencies: {},
	},
	"packages/project-context": {
		name: "project-context",
		dependencies: {},
	},
};

test("isWideFile covers repository-wide dependency, runner and test-CI inputs", () => {
	assert.equal(isWideFile("package.json"), true);
	// 上游本轮把包级清单从 wide 摘出，改由 fullWorkspaces 让该包整包全跑。
	assert.equal(isWideFile("apps/desktop/package.json"), false);
	assert.equal(isWideFile("pnpm-lock.yaml"), true);
	assert.equal(isWideFile("scripts/test-related.mjs"), true);
	assert.equal(isWideFile("scripts/test-workspaces.config.mjs"), true);
	// 刻意保留的 Meka 门禁口径（偏离上游）：`.github/workflows/**` 就是单测 CI 本体。
	// meka/main 是直推集成分支，唯一自动化门禁是 ci.yml 的 push 触发，没有 PR CI
	// 兜底，所以「改 CI 配置 ⇒ 退回全量 pnpm test:unit」不能像上游那样反转成 false。
	// 依据：根 AGENTS.md「提交前测试门禁（硬性要求）」的保留 Meka 口径注记 +
	// docs/migrations/2026-09-25-origin-main-to-meka-main.md（本期同步报告）。
	assert.equal(isWideFile(".github/workflows/ci.yml"), true);
	assert.equal(isWideFile(".github/workflows/nested/release.yml"), true);
	assert.equal(isWideFile("apps/desktop/src/main/foo.ts"), false);
});

test("isSkippableFile and isTestFile classify docs versus tests", () => {
	assert.equal(isSkippableFile("docs/dev-rules/development-workflow.md"), true);
	assert.equal(isSkippableFile("LICENSE"), true);
	assert.equal(isSkippableFile("apps/desktop/src/main/foo.ts"), false);
	assert.equal(isTestFile("apps/desktop/src/main/foo.test.ts"), true);
	assert.equal(isTestFile("apps/desktop/src/main/foo.ts"), false);
});

test("shouldRunTestRunner excludes documentation and workspace-only changes", () => {
	assert.equal(
		shouldRunTestRunner(["apps/desktop/src/main/foo.ts"]),
		false,
	);
	assert.equal(
		shouldRunTestRunner(["docs/dev-rules/desktop-development.md"]),
		false,
	);
	assert.equal(shouldRunTestRunner(["scripts/check-i18n.mjs"]), true);
});

test("workspaceForFile picks the longest matching workspace prefix", () => {
	assert.equal(
		workspaceForFile("apps/desktop/src/main/foo.ts", [
			"apps",
			"apps/desktop",
		]),
		"apps/desktop",
	);
	assert.equal(
		workspaceForFile("README.md", ["apps/desktop", "packages/maker-core"]),
		undefined,
	);
});

test("GIT_BASE_REFS prefers the Meka product branch over upstream main", () => {
	const indexOf = (ref) => GIT_BASE_REFS.indexOf(ref);
	// Meka 不变量：产品集成分支必须先于上游 Cindy 的 main 被解析，否则 related
	// 门禁会把整个 Meka 产品增量算成本次改动并静默退回全量。
	assert.equal(GIT_BASE_REFS[0], "origin/meka/main");
	assert.ok(indexOf("meka/main") < indexOf("origin/main"));
	assert.ok(indexOf("meka/main") < indexOf("main"));
	// 上游新增的 upstream / origin HEAD 候选保留，但都不允许插到 meka 之前。
	for (const ref of [
		"refs/remotes/upstream/HEAD",
		"upstream/main",
		"upstream/master",
		"refs/remotes/origin/HEAD",
	]) {
		assert.equal(GIT_BASE_REFS.includes(ref), true, ref);
		assert.ok(indexOf("origin/meka/main") < indexOf(ref), ref);
	}
	// 上游的本地兜底仍在末尾，供没有 meka ref 的上游 Cindy checkout 使用。
	assert.deepEqual(GIT_BASE_REFS.slice(-2), ["main", "master"]);
});

function collectChangedFilesFixture(baseRef) {
	const calls = [];
	const runGit = (args) => {
		calls.push(args);
		const key = args.join(" ");
		if (key === `rev-parse --verify ${baseRef}`) return "abc\n";
		if (key === `merge-base HEAD ${baseRef}`) return "base123\n";
		if (key === "diff --name-only base123 HEAD")
			return "apps/desktop/src/a.ts\n";
		if (key === "diff --name-only --cached")
			return "apps/desktop/src/b.ts\n";
		if (key === "diff --name-only") return "apps/desktop/src/c.ts\n";
		if (key === "ls-files --others --exclude-standard")
			return "apps/desktop/src/d.ts\n";
		throw new Error(`missing ${key}`);
	};
	return { calls, runGit };
}

test("collectChangedFiles unions committed, staged, unstaged, and untracked files", () => {
	const { calls, runGit } = collectChangedFilesFixture("origin/main");
	assert.deepEqual(collectChangedFiles(runGit), {
		files: [
			"apps/desktop/src/a.ts",
			"apps/desktop/src/b.ts",
			"apps/desktop/src/c.ts",
			"apps/desktop/src/d.ts",
		],
		base: "base123",
		baseRef: "origin/main",
	});
	// Meka 口径：产品集成分支先试，origin/main 仍然作为兜底被试过。
	assert.deepEqual(calls[0], ["rev-parse", "--verify", "origin/meka/main"]);
	assert.ok(
		calls.some((args) => args.join(" ") === "rev-parse --verify origin/main"),
	);
	// 上游口径：fork 的 origin 可能落后，upstream 默认分支也要先于 origin/main 试。
	assert.ok(calls.some((args) => args.join(" ") === "rev-parse --verify upstream/main"));
});

test("collectChangedFiles prefers origin/meka/main over origin/main", () => {
	const { calls, runGit } = collectChangedFilesFixture("origin/meka/main");
	const collected = collectChangedFiles(runGit);
	assert.equal(collected.baseRef, "origin/meka/main");
	assert.equal(collected.base, "base123");
	assert.deepEqual(calls[0], ["rev-parse", "--verify", "origin/meka/main"]);
	assert.equal(
		calls.some((args) => args.join(" ") === "rev-parse --verify origin/main"),
		false,
	);
});

test("collectChangedFiles falls back when git base cannot be resolved", () => {
	const runGit = () => {
		throw new Error("not a git repo");
	};
	assert.deepEqual(collectChangedFiles(runGit), {
		files: [],
		base: null,
		baseRef: null,
		error: "cannot resolve git base against meka/main or main",
	});
});

test("planRelatedUnitTests runs only related tests for a leaf workspace file", () => {
	const plan = planRelatedUnitTests({
		changedFiles: ["apps/desktop/src/main/foo.ts"],
		workspaces,
		packageJsonByCwd,
	});
	assert.equal(plan.mode, "related");
	assert.equal(plan.runTestRunner, false);
	assert.deepEqual(plan.runs, [
		{
			cwd: "apps/desktop",
			name: "desktop",
			relatedFiles: ["apps/desktop/src/main/foo.ts"],
		},
	]);
});

test("planRelatedUnitTests runs dependents fully when a shared package source changes", () => {
	const plan = planRelatedUnitTests({
		changedFiles: ["packages/maker-shared/src/index.ts"],
		workspaces,
		packageJsonByCwd,
	});
	assert.equal(plan.mode, "related");
	assert.deepEqual(
		plan.runs.map((run) => [run.cwd, run.relatedFiles]),
		[
			["apps/desktop", null],
			["packages/maker-core", null],
			["packages/maker-shared", ["packages/maker-shared/src/index.ts"]],
		],
	);
});

test("planRelatedUnitTests does not fan out dependents for a test-only change", () => {
	const plan = planRelatedUnitTests({
		changedFiles: ["packages/maker-core/src/foo.test.ts"],
		workspaces,
		packageJsonByCwd,
	});
	assert.deepEqual(plan.runs, [
		{
			cwd: "packages/maker-core",
			name: "@cindy/maker-core",
			relatedFiles: ["packages/maker-core/src/foo.test.ts"],
		},
	]);
});

test("planRelatedUnitTests falls back to the full suite for wide files", () => {
	const plan = planRelatedUnitTests({
		changedFiles: ["package.json", "apps/desktop/src/main/foo.ts"],
		workspaces,
		packageJsonByCwd,
	});
	assert.equal(plan.mode, "full");
	assert.match(plan.reason, /wide files changed: package\.json/);
	assert.equal(plan.runTestRunner, true);
	assert.deepEqual(plan.runs, []);
});

test("planRelatedUnitTests skips markdown-only changes", () => {
	const plan = planRelatedUnitTests({
		changedFiles: ["README.md", "docs/dev-rules/development-workflow.md"],
		workspaces,
		packageJsonByCwd,
	});
	assert.equal(plan.mode, "skip");
	assert.equal(plan.runTestRunner, false);
	assert.deepEqual(plan.runs, []);
});

test("planRelatedUnitTests skips when there are no changes", () => {
	const plan = planRelatedUnitTests({
		changedFiles: [],
		workspaces,
		packageJsonByCwd,
	});
	assert.deepEqual(plan, {
		mode: "skip",
		reason: "no changes vs integration branch",
		runTestRunner: false,
		runs: [],
	});
	assert.equal(
		planRelatedUnitTests({
			changedFiles: [],
			workspaces,
			packageJsonByCwd,
			baseRef: "origin/meka/main",
		}).reason,
		"no changes vs origin/meka/main",
	);
});

test("generated glossary and legal text retain their runner checks without business suites", () => {
	for (const file of ["i18n/GLOSSARY.md", "docs/legal/notices/desktop-win.txt"]) {
		const plan = planRelatedUnitTests({ changedFiles: [file], workspaces, packageJsonByCwd });
		assert.equal(plan.mode, "related", file);
		assert.equal(plan.runTestRunner, true, file);
		assert.deepEqual(plan.runs, [], file);
	}
});

test("planRelatedUnitTests runs the owner suite when a file is deleted", () => {
	const plan = planRelatedUnitTests({
		changedFiles: ["apps/desktop/src/main/gone.ts"],
		workspaces,
		packageJsonByCwd,
		fileExists: () => false,
	});
	assert.equal(plan.mode, "related");
	assert.deepEqual(plan.runs, [{ cwd: "apps/desktop", name: "desktop", relatedFiles: null }]);
});

test("buildDependentMap and collectTransitiveDependents follow workspace:* edges", () => {
	const dependents = buildDependentMap(workspaces, packageJsonByCwd);
	assert.deepEqual(
		[...collectTransitiveDependents(["packages/maker-shared"], dependents)].sort(),
		["apps/desktop", "packages/maker-core"],
	);
	assert.deepEqual(
		[...collectTransitiveDependents(["apps/desktop"], dependents)],
		[],
	);
});

test("workspace manifest and Vitest configuration changes stay in the affected dependency graph", () => {
	for (const file of ["packages/maker-core/package.json", "packages/maker-core/vitest.config.ts"]) {
		const plan = planRelatedUnitTests({ changedFiles: [file], workspaces, packageJsonByCwd });
		assert.equal(plan.mode, "related");
		assert.deepEqual(plan.runs.map(({ cwd, relatedFiles }) => [cwd, relatedFiles]), [
			["apps/desktop", null], ["packages/maker-core", null],
		]);
	}
});

test("workflow edits fall back to the full unit suite (Meka 门禁口径)", () => {
	// 上游本轮把这条改成 related + 只跑 runner：那是「CI 有 PR 阶段兜底」的口径。
	// Meka 的 meka/main 是直推分支，推送前的本地门禁就是唯一闸门，所以改到单测 CI
	// 必须退回全量；这里钉住的是**调度结果**（mode=full），不只是 isWideFile 谓词。
	const plan = planRelatedUnitTests({
		changedFiles: [".github/workflows/pr-design-basis.yml"], workspaces, packageJsonByCwd,
	});
	assert.equal(plan.mode, "full");
	assert.match(plan.reason, /wide files changed: \.github\/workflows\/pr-design-basis\.yml/);
	assert.equal(plan.runTestRunner, true);
	assert.deepEqual(plan.runs, []);
});

test("a stale fork does not count upstream commits as local work, including from a worktree", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "related-git-base-"));
	const repo = path.join(root, "repo");
	fs.mkdirSync(repo);
	// Git for Windows cannot open Node's \\.\nul device path as a config file.
	const globalConfig = path.join(root, "empty.gitconfig");
	fs.writeFileSync(globalConfig, "");
	const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: globalConfig };
	const git = (cwd, args) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	try {
		git(repo, ["init", "-b", "main"]);
		git(repo, ["config", "user.name", "Test"]);
		git(repo, ["config", "user.email", "test@example.invalid"]);
		git(repo, ["commit", "--allow-empty", "-m", "base"]);
		git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
		fs.writeFileSync(path.join(repo, "upstream.ts"), "export const upstream = true;\n");
		git(repo, ["add", "upstream.ts"]);
		git(repo, ["commit", "-m", "upstream change"]);
		git(repo, ["update-ref", "refs/remotes/upstream/trunk", "HEAD"]);
		git(repo, ["symbolic-ref", "refs/remotes/upstream/HEAD", "refs/remotes/upstream/trunk"]);
		assert.deepEqual(collectChangedFiles((args) => git(repo, args)).files, []);
		const worktree = path.join(root, "task");
		git(repo, ["worktree", "add", "-b", "task", worktree]);
		fs.writeFileSync(path.join(worktree, "local.ts"), "export const local = true;\n");
		const result = collectChangedFiles((args) => git(worktree, args));
		assert.equal(result.baseRef, "refs/remotes/upstream/HEAD");
		assert.deepEqual(result.files, ["local.ts"]);
		git(repo, ["symbolic-ref", "--delete", "refs/remotes/upstream/HEAD"]);
		git(repo, ["update-ref", "refs/remotes/upstream/main", "HEAD"]);
		assert.deepEqual(collectChangedFiles((args) => git(worktree, args)).files, ["local.ts"]);
		git(repo, ["update-ref", "-d", "refs/remotes/upstream/main"]);
		assert.equal(collectChangedFiles((args) => git(worktree, args)).baseRef, "origin/main");
		git(repo, ["update-ref", "-d", "refs/remotes/origin/main"]);
		assert.equal(collectChangedFiles((args) => git(worktree, args)).baseRef, "main");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
