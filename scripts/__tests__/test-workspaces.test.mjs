import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";
import manifest, {
  desktopUnitWorkerCount,
  desktopUnitPool,
  unitTestShardArgs,
} from "../test-workspaces.config.mjs";
import { nodeWebstorageEnabled } from "../shared/node-webstorage.mjs";
import {
	acquireTestGateLock,
	classifyTestGateLockProbeError,
	decideTestGateLock,
	resolveTestGateCommonDir,
	shouldUseTestGateLock,
	TEST_GATE_LOCK_TIMEOUT_EXIT_CODE,
	testGateLockIdentity,
} from "../test-gate-lock.mjs";
import {
	buildPnpmArgs,
	checkIncludeCoverage,
	checkTestFiles,
	classifyFailure,
	commandLineLength,
	createBoundedOutputBuffer,
	createOutputForwarder,
	createWorkspaceRunReporter,
	defaultWorkspaceConcurrency,
	discoverTestFiles,
	expandWorkspacePatterns,
	filterRunsByWorkspace,
	isIgnoredFile,
	mapWithConcurrency,
	maxInlineCommandLength,
	normalizeRelPath,
	parseWorkspacePatterns,
	parseCliOptions,
	parseWorkspaceConcurrency,
	parseWorkspaceSelectorValue,
	planPnpmArgBatches,
	planRuns,
	printSummary,
	readAllFiles,
	resolveOutputStream,
	runCommand,
	runPlannedTests,
	runWithExclusiveBarriers,
	selectFilesForTier,
	validateManifest,
	validateManifestCoverage,
} from "../test-workspaces.mjs";
import {
	resolvePnpmInvocation,
	usablePnpmExecPath,
} from "../shared/pnpm-invocation.mjs";
import { findSymlinkPlatformSkips } from "../shared/symlink-test-guard.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

function readRootScripts() {
	return JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"))
		.scripts;
}

function readWorkspacePackageJson(cwd) {
	return JSON.parse(fs.readFileSync(path.join(ROOT, cwd, "package.json"), "utf8"));
}

async function waitFor(predicate, message = "condition was not reached") {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return;
		await new Promise((resolve) => setImmediate(resolve));
	}
	throw new Error(message);
}

test("parseWorkspacePatterns reads pnpm-workspace.yaml package globs", () => {
	assert.deepEqual(
		parseWorkspacePatterns('packages:\n  - "apps/*"\n  - "packages/*"\n'),
		["apps/*", "packages/*"],
	);
});

test("root unit and all scripts run runner self-tests before workspace sweep", () => {
	const scripts = readRootScripts();
	// CI uses the package lifecycle to propagate npm_execpath without duplicating self-tests.
	assert.equal(scripts["test:workspaces"], "node scripts/test-workspaces.mjs");
	assert.match(
		scripts["test:unit"],
		/^pnpm test:runner && node scripts\/test-workspaces\.mjs --tier unit$/,
	);
	assert.equal(
		scripts["test:unit:related"],
		"node scripts/test-workspaces.mjs --tier unit --related",
	);
	assert.match(
		scripts["test:all"],
		/^pnpm test:runner && node scripts\/test-workspaces\.mjs --all$/,
	);
});

test("root db and guard delegate to the workspace runner", () => {
	const scripts = readRootScripts();
	for (const tier of ["integration", "e2e"]) {
		assert.equal(
			scripts[`test:${tier}`],
			`pnpm test:runner && node scripts/test-workspaces.mjs --tier ${tier}`,
		);
	}
	assert.equal(
		scripts["test:git-integration"],
		"pnpm test:runner && node scripts/test-workspaces.mjs --tier git-integration",
	);
	assert.equal(
		scripts["test:db"],
		"pnpm test:runner && node scripts/test-workspaces.mjs --tier db",
	);
	assert.equal(scripts["test:guard"], "node scripts/test-workspaces.mjs --tier guard");
});

test("client CI owns the complete Desktop Git integration tier", () => {
	const workflow = fs.readFileSync(
		path.join(ROOT, ".github", "workflows", "ci.yml"),
		"utf8",
	).replace(/\r\n/g, "\n");
	const job = workflow.match(/\n  git-integration:\n([\s\S]*)$/);
	assert.ok(job, "client CI must define an independent git-integration job");
	assert.match(
		job[1],
		/^\s{6}- name: Run Desktop Git integration tests\n\s{8}run: pnpm test:git-integration$/m,
	);
});

test("client CI no longer builds model-access protocol for consumers", () => {
	const workflow = fs.readFileSync(
		path.join(ROOT, ".github", "workflows", "ci.yml"),
		"utf8",
	).replace(/\r\n/g, "\n");
	assert.doesNotMatch(workflow, /pnpm --filter @cindy\/model-access-protocol build/);
});

test("help groups copyable desktop, binary, and Mobile workflows", async () => {
	const { printHelp } = await import("../help.mjs");
	const lines = [];
	printHelp((line = "") => lines.push(line));
	const output = lines.join("\n");
	const rootScripts = Object.keys(readRootScripts());
	const documentedWorkflowScripts = rootScripts.filter((name) =>
		/^(mobile:xcode|mobile:sim:|mobile:build:(ios|android))/.test(name) ||
		/^(install:(agent-binaries|claude|codex|ripgrep|pi)|update:(vendors|claude|codex|ripgrep|pi))$/.test(name) ||
		/^release:(claude-code|codex|ripgrep)(:arm64|:x64|:win)?$/.test(name),
	);
	assert.deepEqual(
		documentedWorkflowScripts.filter((name) => !output.includes(`pnpm ${name}`)),
		[],
		"pnpm h must include every user-facing Mobile and binary workflow",
	);

	for (const command of [
		"pnpm dev:desktop:remote",
		"pnpm dev:desktop:remote --region=cn",
		"pnpm install:agent-binaries",
		"pnpm mobile:build:ios -- --region cn --execute",
		"pnpm mobile:build:android -- --region cn --execute",
	]) {
		assert.match(output, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	}
	assert.match(output, /pnpm test:guard/);
});

test("orca workflow unit tier uses its own declared test runner", () => {
	const orcaPackage = readWorkspacePackageJson("packages/orca-workflow");
	const orcaWorkspace = manifest.workspaces.find(
		(workspace) => workspace.cwd === "packages/orca-workflow",
	);
	assert.equal(orcaPackage.scripts.test, "vitest run");
	assert.equal(orcaPackage.devDependencies.vitest, "^3.2.4");
	assert.deepEqual(orcaWorkspace.tiers.unit.command, {
		type: "packageBin",
		bin: "vitest",
		args: ["run", "--pool=threads", "--maxWorkers=1", ...unitTestShardArgs()],
	});
});

test("unit workspace concurrency reserves the full worker budget for heavy workspaces", () => {
	const desktop = manifest.workspaces.find(
		(workspace) => workspace.cwd === "apps/desktop",
	);
	const mobile = manifest.workspaces.find(
		(workspace) => workspace.cwd === "apps/mobile",
	);
	const makerCore = manifest.workspaces.find(
		(workspace) => workspace.cwd === "packages/maker-core",
	);
	assert.equal(desktop.tiers.unit.execution, "exclusive");
	assert.deepEqual(desktop.tiers.unit.command.args, [
		"run",
		// win32 pins forks: threads segfaults the desktop suite there, and the
		// LaunchServices churn that threads exists to avoid is macOS-only.
		`--pool=${desktopUnitPool()}`,
		`--maxWorkers=${desktopUnitWorkerCount()}`,
		...unitTestShardArgs(),
	]);
	assert.equal(desktopUnitWorkerCount(1), 1);
	assert.equal(desktopUnitWorkerCount(4), 4);
	assert.equal(desktopUnitWorkerCount(32), 8);
	assert.equal(desktopUnitWorkerCount(Number.NaN), 1);
	assert.equal(mobile.tiers.unit.execution, "exclusive");
	assert.deepEqual(mobile.tiers.unit.command.args, [
		"run",
		"--pool=threads",
		"--maxWorkers=4",
		...unitTestShardArgs(),
	]);
	assert.equal(makerCore.tiers.unit.execution, undefined);
	assert.deepEqual(makerCore.tiers.unit.exclude, [
		"**/*.integration.test.ts",
		"**/*.e2e.test.ts",
		"**/*.git-integration.test.ts",
	]);
	assert.deepEqual(makerCore.tiers.unit.command, {
		type: "packageBin",
		bin: "vitest",
		args: ["run", "--pool=forks", "--maxWorkers=1", ...unitTestShardArgs()],
	});
});

test("real agent integration tests are explicit tiers outside unit", () => {
	const makerCore = manifest.workspaces.find(
		(workspace) => workspace.cwd === "packages/maker-core",
	);
	const piManager = manifest.workspaces.find(
		(workspace) => workspace.cwd === "packages/maker-pi-manager",
	);
	const desktop = manifest.workspaces.find(
		(workspace) => workspace.cwd === "apps/desktop",
	);
	assert.equal(makerCore.tiers.integration.status, "manual");
	assert.equal(makerCore.tiers.integration.execution, "exclusive");
	assert.equal(makerCore.tiers.integration.coverage, "allowlist");
	assert.deepEqual(makerCore.tiers.integration.include, [
		"src/agents/codex/*.integration.test.ts",
		"src/agents/claude-code/__tests__/*.integration.test.ts",
		"src/agents/pi/__tests__/*.integration.test.ts",
	]);
	assert.deepEqual(piManager.tiers.unit.exclude, [
		"src/__tests__/pi-manager.integration.test.ts",
	]);
	assert.deepEqual(piManager.tiers.integration.include, [
		"src/__tests__/pi-manager.integration.test.ts",
	]);
	assert.deepEqual(desktop.tiers.e2e.include, [
		"src/main/maker-host/__tests__/*.e2e.test.ts",
	]);
});

test("Pi RPC lifecycle stays in unit while binary resource discovery stays in integration", () => {
	const makerCore = manifest.workspaces.find(
		(workspace) => workspace.cwd === "packages/maker-core",
	);
	const testDir = "packages/maker-core/src/agents/pi/__tests__";
	const files = fs.readdirSync(path.join(ROOT, testDir))
		.filter((file) => file.startsWith("pi-rpc-"))
		.map((file) => `${testDir}/${file}`);
	assert.deepEqual(selectFilesForTier(makerCore, makerCore.tiers.unit, files), [
		`${testDir}/pi-rpc-harness.test.ts`,
	]);
	assert.deepEqual(selectFilesForTier(makerCore, makerCore.tiers.integration, files), [
		`${testDir}/pi-rpc-resource-discovery.integration.test.ts`,
	]);
});

test("unit tier pins an explicit vitest pool, forks only by documented exception", () => {
	// The default forks pool recycles one child process per test file, which on
	// 2026-07-30 sustained ~21 LaunchServices check-ins/second and took down
	// macOS 27.0 beta's launchservicesd mid-gate (empty running-application
	// registry -> no frontmost app -> dead keyboard, no menu bar, vanishing Dock
	// tiles). A workspace added later must not silently inherit that churn, and
	// opting back into forks must be a deliberate edit to this list.
	// Desktop's entry is conditional: it stays on forks on a Node whose
	// webstorage globals force the execArgv that worker threads cannot take,
	// and on win32, where threads segfaults the suite outright (native addon
	// finalizers crashing in isolate teardown) and no launchservicesd exists
	// for the churn to hurt.
	const forksByException = [
		...(desktopUnitPool() === "forks" ? ["apps/desktop"] : []),
		"packages/maker-core",
	];
	const unpinned = [];
	const onForks = [];
	for (const workspace of manifest.workspaces) {
		const tier = workspace.tiers?.unit;
		if (!tier || (tier.status !== "required" && tier.status !== "manual"))
			continue;
		if (tier.command?.type !== "packageBin" || tier.command.bin !== "vitest")
			continue;
		const args = tier.command.args ?? [];
		if (args.includes("--pool=forks")) onForks.push(workspace.cwd);
		else if (!args.includes("--pool=threads")) unpinned.push(workspace.cwd);
	}
	assert.deepEqual(unpinned, []);
	assert.deepEqual(onForks.sort(), [...forksByException].sort());
});

test("nodeWebstorageEnabled detects the globals that force the webstorage flag", () => {
	assert.equal(nodeWebstorageEnabled({}), false);
	assert.equal(nodeWebstorageEnabled({ localStorage: undefined }), false);
	assert.equal(nodeWebstorageEnabled({ localStorage: {} }), true);
	// Node 25's stub is an object whose methods are all missing; presence is what
	// matters here, because that alone displaces jsdom's implementation.
	assert.equal(
		nodeWebstorageEnabled({ localStorage: Object.create(null) }),
		true,
	);
});

test("desktop unit uses forks on Node 24+ to avoid native finalizer crashes", () => {
	assert.equal(desktopUnitPool("darwin", "24.18.0", false), "forks");
	assert.equal(desktopUnitPool("darwin", "22.23.0", false), "threads");
	assert.equal(desktopUnitPool("win32", "22.23.0", false), "forks");
	assert.equal(desktopUnitPool("darwin", "25.0.0", true), "forks");
});

test("normalizeRelPath makes path matching independent of host path separators", () => {
	assert.equal(
		normalizeRelPath("apps\\desktop\\src\\main\\foo.test.ts"),
		"apps/desktop/src/main/foo.test.ts",
	);
});

test("validateManifestCoverage fails when a pnpm workspace is missing", () => {
	assert.throws(
		() =>
			validateManifestCoverage(
				["apps/desktop", "apps/server"],
				[{ cwd: "apps/desktop" }],
			),
		/Manifest is missing pnpm workspace: apps\/server/,
	);
});

test("discoverTestFiles ignores generated and nested non-workspace directories", () => {
	const files = [
		"packages/orca-workflow/src/__tests__/orca-bridge-mcp.test.ts",
		"packages/orca-workflow/node_modules/@cindy/maker-core/src/session.test.ts",
		"apps/server/release/src/__tests__/ignored.test.ts",
		"apps/desktop/cindy-updater/src/__tests__/ignored.test.ts",
		"apps/server/src/__tests__/services/oss.spec.ts",
		"packages/generated/src/__tests__/ignored.test.ts",
		"apps/desktop/src/renderer/__tests__/automationGeneratedSessions.test.ts",
	];
	assert.deepEqual(discoverTestFiles(files), [
		"packages/orca-workflow/src/__tests__/orca-bridge-mcp.test.ts",
		"apps/server/src/__tests__/services/oss.spec.ts",
		"apps/desktop/src/renderer/__tests__/automationGeneratedSessions.test.ts",
	]);
});

test("isIgnoredFile ignores the git-ignored tmp/ product directory", () => {
	// .gitignore 忽略 tmp/（会话工具临时产物）。readAllFiles 若递归进去，
	// 遇到沙箱/工具遗留的不可读子目录会 EPERM 让整个门禁失败（#3353）。
	assert.equal(isIgnoredFile("tmp/blocked"), true);
	assert.equal(isIgnoredFile("tmp/nested/deep/file.ts"), true);
	assert.equal(isIgnoredFile("packages/orca-workflow/tmp/x.test.ts"), true);
	// 含 "tmp" 的合法包名/文件名不应被误杀（按路径段精确匹配）。
	assert.equal(isIgnoredFile("packages/tmp-adapter/src/index.ts"), false);
});

test("readAllFiles tolerates an unreadable directory instead of crashing the gate", () => {
	// 平台不支持把目录 chmod 成不可读时（Windows）跳过：EPERM 容错分支在
	// POSIX 上由 chmod 0o000 覆盖，逻辑本身是平台无关的 try/catch。
	if (process.platform === "win32") return;
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "read-all-files-"));
	try {
		fs.mkdirSync(path.join(root, "src"), { recursive: true });
		fs.writeFileSync(path.join(root, "src", "a.test.ts"), "// ok\n");
		// 一个当前进程无权 scandir 的目录（模拟沙箱遗留物）。
		const locked = path.join(root, "tmp", "locked");
		fs.mkdirSync(locked, { recursive: true });
		fs.writeFileSync(path.join(locked, "secret.txt"), "x");
		fs.chmodSync(path.join(root, "tmp", "locked"), 0o000);
		try {
			const files = readAllFiles(root);
			assert.deepEqual(files.map(normalizeRelPath).sort(), ["src/a.test.ts"]);
		} finally {
			// 必须先恢复权限才能在 Windows/POSIX 清理临时目录。
			fs.chmodSync(path.join(root, "tmp", "locked"), 0o700);
		}
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("checkTestFiles fails runnable tiers with no selected tests", () => {
	const workspace = { cwd: "packages/orca-workflow", status: "required" };
	const tier = { status: "required", include: ["src/__tests__/**/*.test.ts"] };
	assert.throws(
		() => checkTestFiles(workspace, "unit", tier, []),
		/No tests selected for runnable tier packages\/orca-workflow unit/,
	);
});

test("checkTestFiles skips notApplicable workspace with reason", () => {
	const workspace = {
		cwd: "apps/heartbeat-server",
		status: "notApplicable",
		reason: "No tests yet",
		tiers: {},
	};
	assert.deepEqual(checkTestFiles(workspace, "unit", undefined, []), {
		status: "skipped",
		reason: "No tests yet",
	});
});

test("checkIncludeCoverage catches spec files missed by include patterns", () => {
	const workspace = { cwd: "apps/server", status: "required" };
	const tier = { status: "required", include: ["src/__tests__/**/*.test.ts"] };
	assert.throws(
		() =>
			checkIncludeCoverage(workspace, "unit", tier, [
				"apps/server/src/__tests__/services/oss.spec.ts",
			]),
		/not covered by manifest include\/exclude/,
	);
});

test("checkIncludeCoverage allows explicit allowlist tiers", () => {
	const workspace = { cwd: "apps/desktop", status: "required" };
	const tier = {
		status: "required",
		coverage: "allowlist",
		include: ["src/main/__tests__/directSessionSendGuard.test.ts"],
	};
	assert.doesNotThrow(() =>
		checkIncludeCoverage(workspace, "guard", tier, [
			"apps/desktop/src/main/__tests__/directSessionSendGuard.test.ts",
			"apps/desktop/src/main/__tests__/lifecycle.test.ts",
		]),
	);
});

test("checkIncludeCoverage catches allowlist include patterns that match no tests", () => {
	const workspace = { cwd: "apps/desktop", status: "required" };
	const tier = {
		status: "required",
		coverage: "allowlist",
		include: [
			"src/main/__tests__/directSessionSendGuard.test.ts",
			"src/main/__tests__/makerSendToSessionOrdering.test.ts",
		],
	};
	assert.throws(
		() =>
			checkIncludeCoverage(workspace, "guard", tier, [
				"apps/desktop/src/main/__tests__/directSessionSendGuard.test.ts",
			]),
		/apps\/desktop guard allowlist include matched no tests: src\/main\/__tests__\/makerSendToSessionOrdering\.test\.ts/,
	);
});

test("include patterns match direct and nested test files", () => {
	const workspace = { cwd: "apps/server", status: "required" };
	const tier = {
		status: "required",
		include: ["src/__tests__/**/*.{test,spec}.ts"],
	};
	assert.doesNotThrow(() =>
		checkIncludeCoverage(workspace, "unit", tier, [
			"apps/server/src/__tests__/sessions.test.ts",
			"apps/server/src/__tests__/services/oss.spec.ts",
		]),
	);
});

test("single-level include pattern matches orca workflow test file", () => {
	const workspace = { cwd: "packages/orca-workflow", status: "required" };
	const tier = { status: "required", include: ["src/__tests__/**/*.test.ts"] };
	assert.doesNotThrow(() =>
		checkIncludeCoverage(workspace, "unit", tier, [
			"packages/orca-workflow/src/__tests__/orca-bridge-mcp.test.ts",
		]),
	);
});

test("desktop unit excludes integration, migration, direct db-tier, and source-contract guard tests while keeping normal unit tests", () => {
	const workspace = { cwd: "apps/desktop", status: "required" };
	const tier = {
		status: "required",
		exclude: [
			"**/*.git-integration.test.ts",
			"**/*.integration.test.ts",
			"**/*.e2e.test.ts",
			"src/main/localDb/**",
			"src/main/__tests__/*Migration.test.ts",
			"src/main/__tests__/schemaDriftRepair.test.ts",
			"src/main/__tests__/betterSqliteFactory.test.ts",
			"src/main/__tests__/*LocalSessions.test.ts",
			"src/main/__tests__/codexHistoryPromptInit.test.ts",
			"src/main/__tests__/orcaStaleIndexCleanup.test.ts",
			"src/main/scheduler-host/__tests__/*.db.test.ts",
			"src/main/__tests__/directSessionSendGuard.test.ts",
			"src/main/__tests__/makerSendToSessionOrdering.test.ts",
			"**/*.bench.ts",
		],
	};
	assert.deepEqual(
		selectFilesForTier(workspace, tier, [
			"apps/desktop/src/main/git-review/__tests__/stageOps.git-integration.test.ts",
			"apps/desktop/src/main/localDb/ipc/messages.test.ts",
			"apps/desktop/src/main/__tests__/sessionWorkspaceKindMigration.test.ts",
			"apps/desktop/src/main/__tests__/codexProjectlessMigration.test.ts",
			"apps/desktop/src/main/__tests__/schemaDriftRepair.test.ts",
			"apps/desktop/src/main/__tests__/betterSqliteFactory.test.ts",
			"apps/desktop/src/main/__tests__/codexLocalSessions.test.ts",
			"apps/desktop/src/main/__tests__/claudeLocalSessions.test.ts",
			"apps/desktop/src/main/__tests__/codexHistoryPromptInit.test.ts",
			"apps/desktop/src/main/__tests__/orcaStaleIndexCleanup.test.ts",
			"apps/desktop/src/main/scheduler-host/__tests__/storage.db.test.ts",
			"apps/desktop/src/main/scheduler-host/__tests__/storage.test.ts",
			"apps/desktop/src/main/__tests__/directSessionSendGuard.test.ts",
			"apps/desktop/src/main/__tests__/makerSendToSessionOrdering.test.ts",
			"apps/desktop/src/main/__tests__/lifecycle.test.ts",
		]),
		[
			"apps/desktop/src/main/scheduler-host/__tests__/storage.test.ts",
			"apps/desktop/src/main/__tests__/lifecycle.test.ts",
		],
	);
});

test("desktop real-Git coverage is an explicit coordinated tier outside default unit", () => {
	const desktopPackage = readWorkspacePackageJson("apps/desktop");
	const desktop = manifest.workspaces.find(
		(workspace) => workspace.cwd === "apps/desktop",
	);
	const tier = desktop.tiers["git-integration"];

	assert.equal(tier.status, "manual");
	assert.equal(tier.execution, "exclusive");
	assert.equal(tier.coverage, "allowlist");
	assert.deepEqual(tier.include, ["src/main/**/*.git-integration.test.ts"]);
	assert.deepEqual(tier.command, {
		type: "packageBin",
		bin: "vitest",
		args: ["run", `--maxWorkers=${desktopUnitWorkerCount()}`],
	});
	assert.match(
		desktopPackage.scripts["test:git-integration"],
		/test-workspaces\.mjs --tier git-integration/,
	);

	const files = [
		"apps/desktop/src/main/git-review/__tests__/stageOps.git-integration.test.ts",
		"apps/desktop/src/main/__tests__/gitSnapshotService.git-integration.test.ts",
		"apps/desktop/src/main/git-review/__tests__/gitReviewSmoke.test.ts",
	];
	assert.deepEqual(selectFilesForTier(desktop, desktop.tiers.unit, files), [
		"apps/desktop/src/main/git-review/__tests__/gitReviewSmoke.test.ts",
	]);
	assert.deepEqual(selectFilesForTier(desktop, tier, files), files.slice(0, 2));
});

test("maker-core real-Git worktree matrix is an explicit tier outside default unit", () => {
	const makerCore = manifest.workspaces.find(
		(workspace) => workspace.cwd === "packages/maker-core",
	);
	const tier = makerCore.tiers["git-integration"];

	assert.equal(tier.status, "manual");
	assert.equal(tier.coverage, "allowlist");
	assert.deepEqual(tier.include, ["src/**/*.git-integration.test.ts"]);
	assert.deepEqual(tier.command, {
		type: "packageBin",
		bin: "vitest",
		args: ["run", "--maxWorkers=1"],
	});
	assert.ok(makerCore.tiers.unit.exclude.includes("**/*.git-integration.test.ts"));

	const files = [
		"packages/maker-core/src/memory/scope-resolver.git-integration.test.ts",
		"packages/maker-core/src/memory/scope-resolver.test.ts",
	];
	assert.deepEqual(selectFilesForTier(makerCore, makerCore.tiers.unit, files), [
		"packages/maker-core/src/memory/scope-resolver.test.ts",
	]);
	assert.deepEqual(selectFilesForTier(makerCore, tier, files), files.slice(0, 1));
});

test("default desktop unit keeps real Git subprocess coverage to one smoke", () => {
	const files = discoverTestFiles(readAllFiles(ROOT))
		.filter((file) =>
			file.startsWith("apps/desktop/src/main/") &&
			file.endsWith(".test.ts") &&
			!file.endsWith(".git-integration.test.ts"),
		)
		.filter((file) => /\b(?:runGit|gitExec)\(/.test(
			fs.readFileSync(path.join(ROOT, file), "utf8"),
		));

	assert.deepEqual(files, [
		"apps/desktop/src/main/git-review/__tests__/gitReviewSmoke.test.ts",
		// This file mocks child_process.spawn and tests the adapter itself.
		"apps/desktop/src/main/git-review/__tests__/gitRunner.test.ts",
		// This file mocks child_process.execFile and tests gitExec's timeout
		// process-tree termination itself; no real Git subprocess is spawned.
		"apps/desktop/src/main/worktree/__tests__/gitExec.test.ts",
	]);
});

test("tests never bind a fixed numeric port", () => {
	const violations = [];
	for (const file of discoverTestFiles(readAllFiles(ROOT))) {
		const source = fs.readFileSync(path.join(ROOT, file), "utf8");
		const directPort = /\.listen\s*\(\s*(\d+)/g;
		const objectPort = /\.listen\s*\(\s*\{[\s\S]{0,300}?\bport\s*:\s*(\d+)/g;
		for (const pattern of [directPort, objectPort]) {
			for (const match of source.matchAll(pattern)) {
				if (Number(match[1]) !== 0) violations.push(`${file}:${match[1]}`);
			}
		}
	}
	assert.deepEqual(violations, []);
});

test("symlink platform-skip guard detects hard skips without flagging capability probes", () => {
	assert.deepEqual(
		findSymlinkPlatformSkips(`
			it.skipIf(process.platform === "win32")("rejects escape", async () => {
				await fs.symlink(outside, link);
			});
		`),
		[{ line: 2 }],
	);
	assert.deepEqual(
		findSymlinkPlatformSkips(`
			it.skipIf(!canCreateSymlink)("rejects escape", async () => {
				await fs.symlink(outside, link);
			});
			it.skipIf(process.platform === "win32")("sends SIGTERM", async () => {
				await stopProcess();
			});
		`),
		[],
	);
	assert.deepEqual(
		findSymlinkPlatformSkips(`
			it("rejects escape", async () => {
				if (process.platform === "win32") return;
				await fs.symlink(outside, link);
			});
		`),
		[{ line: 3 }],
	);
});

test("symlink platform-skip guard requires a concrete POSIX-only exception", () => {
	const skippedTest = `
		// symlink-platform-skip: Windows cannot represent non-UTF-8 link target bytes.
		it.skipIf(process.platform === "win32")("hashes raw link bytes", async () => {
			await fs.symlink(Buffer.from([0xff]), link);
		});
	`;
	assert.deepEqual(findSymlinkPlatformSkips(skippedTest), []);
	assert.deepEqual(
		findSymlinkPlatformSkips(skippedTest.replace(
			"Windows cannot represent non-UTF-8 link target bytes.",
			"POSIX only",
		)),
		[{ line: 3 }],
	);
});

test("symlink tests never skip solely because the host is Windows", () => {
	const violations = [];
	for (const file of discoverTestFiles(readAllFiles(ROOT))) {
		const source = fs.readFileSync(path.join(ROOT, file), "utf8");
		for (const violation of findSymlinkPlatformSkips(source)) {
			violations.push(`${file}:${violation.line}`);
		}
	}
	assert.deepEqual(violations, []);
});

test("desktop guard selects source-contract tests only", () => {
	const workspace = manifest.workspaces.find(
		(candidate) => candidate.cwd === "apps/desktop",
	);
	const tier = workspace.tiers.guard;
	assert.equal(tier.status, "required");
	assert.equal(tier.coverage, "allowlist");
	assert.deepEqual(
		selectFilesForTier(workspace, tier, [
			"apps/desktop/src/main/__tests__/directSessionSendGuard.test.ts",
			"apps/desktop/src/main/__tests__/makerSendToSessionOrdering.test.ts",
			"apps/desktop/src/main/__tests__/lifecycle.test.ts",
			"apps/desktop/src/main/localDb/ipc/messages.test.ts",
		]),
		[
			"apps/desktop/src/main/__tests__/directSessionSendGuard.test.ts",
			"apps/desktop/src/main/__tests__/makerSendToSessionOrdering.test.ts",
		],
	);
});

test("manifest reasons use current local-test terminology", () => {
	const manifestText = JSON.stringify(manifest);
	assert.doesNotMatch(manifestText, /Phase 1/);
	assert.doesNotMatch(manifestText, /uses Electron and DB worker setup/);

	const desktop = manifest.workspaces.find(
		(workspace) => workspace.cwd === "apps/desktop",
	);
	assert.match(desktop.tiers.db.reason, /explicit DB tier/);
	assert.match(desktop.tiers.migration.reason, /explicit DB tier/);
});

test("desktop DB tiers are explicit manual tiers outside test:all", () => {
	const desktopPackage = readWorkspacePackageJson("apps/desktop");
	const desktop = manifest.workspaces.find(
		(workspace) => workspace.cwd === "apps/desktop",
	);
	assert.equal(desktop.tiers.db.status, "manual");
	assert.equal(desktop.tiers.db.coverage, "allowlist");
	assert.deepEqual(desktop.tiers.db.command, {
		type: "packageBin",
		bin: "vitest",
		args: ["run"],
	});
	assert.match(
		desktop.tiers.db.include.join("\n"),
		/src\/main\/scheduler-host\/__tests__\/\*\.db\.test\.ts/,
	);
	assert.match(desktopPackage.scripts["test:db"], /test-workspaces\.mjs --tier db/);
	assert.doesNotMatch(desktopPackage.scripts["test:db"], /test:db-proxy-perf/);
	assert.equal(desktop.tiers.migration.status, "manual");
	assert.deepEqual(desktop.tiers.migration.command, {
		type: "packageBin",
		bin: "vitest",
		args: ["run"],
	});
	assert.equal(desktop.tiers["db-perf"].status, "manual");
	assert.deepEqual(desktop.tiers["db-perf"].command, {
		type: "packageScript",
		script: "test:db-proxy-perf",
	});
});

test("validateManifest rejects invalid status and missing reason", () => {
	assert.throws(
		() => validateManifest([{ cwd: "x", status: "invalid", tiers: {} }]),
		/has invalid status/,
	);
	assert.throws(
		() =>
			validateManifest([
				{
					cwd: "x",
					status: "required",
					tiers: { unit: { status: "invalid" } },
				},
			]),
		/unit has invalid status/,
	);
	assert.throws(
		() => validateManifest([{ cwd: "x", status: "notApplicable", tiers: {} }]),
		/requires reason/,
	);
	assert.throws(
		() =>
			validateManifest([
				{
					cwd: "x",
					status: "required",
					tiers: { unit: { status: "required" } },
				},
			]),
		/requires command/,
	);
	assert.throws(
		() =>
			validateManifest([
				{
					cwd: "x",
					status: "required",
					tiers: {
						unit: {
							status: "required",
							command: { type: "packageScript", script: "test" },
							execution: "parallel-ish",
						},
					},
				},
			]),
		/invalid execution mode/,
	);
	assert.throws(
		() =>
			validateManifest([
				{
					cwd: "x",
					status: "required",
					tiers: {
						unit: {
							status: "required",
							coverage: "invalid",
							command: { type: "packageScript", script: "test" },
						},
					},
				},
			]),
		/unit has invalid coverage mode/,
	);
	assert.throws(
		() =>
			validateManifest([
				{
					cwd: "x",
					status: "required",
					tiers: {
						guard: {
							status: "required",
							coverage: "allowlist",
							command: { type: "packageScript", script: "test" },
						},
					},
				},
			]),
		/guard allowlist coverage requires include patterns/,
	);
	assert.throws(
		() =>
			validateManifest([
				{
					cwd: "x",
					status: "required",
					tiers: {
						db: {
							status: "manual",
							reason: "Runs explicitly",
						},
					},
				},
			]),
		/x db requires command/,
	);
});

test("validateManifest rejects runnable tiers on non-required workspaces", () => {
	assert.throws(
		() =>
			validateManifest([
				{
					cwd: "packages/x",
					status: "notApplicable",
					reason: "No tests yet",
					tiers: {
						unit: {
							status: "required",
							command: { type: "packageScript", script: "test" },
						},
					},
				},
			]),
		/packages\/x unit cannot be runnable when workspace status is notApplicable/,
	);
});

test("planRuns rejects desktop unit if it directly uses package test script", () => {
	const workspaces = [
		{
			cwd: "apps/desktop",
			status: "required",
			tiers: {
				unit: {
					status: "required",
					command: { type: "packageScript", script: "test" },
				},
			},
		},
	];
	assert.throws(
		() => planRuns(workspaces, { tier: "unit" }),
		/desktop unit cannot use package test script/,
	);
});

test("planRuns skips deferred tiers and includes required tiers", () => {
	const workspaces = [
		{
			cwd: "apps/desktop",
			status: "required",
			tiers: {
				unit: {
					status: "required",
					command: { type: "packageBin", bin: "vitest", args: ["run"] },
				},
				db: { status: "deferred", reason: "later", existingScript: "test:db" },
			},
		},
	];
	assert.equal(planRuns(workspaces, { tier: "unit" }).length, 1);
	assert.equal(planRuns(workspaces, { tier: "db" }).length, 0);
});

test("planRuns includes manual tiers only for explicit tier runs", () => {
	const workspaces = [
		{
			cwd: "apps/desktop",
			status: "required",
			tiers: {
				unit: {
					status: "required",
					command: { type: "packageBin", bin: "vitest", args: ["run"] },
				},
				db: {
					status: "manual",
					reason: "Runs explicitly",
					command: { type: "packageScript", script: "test:db" },
				},
			},
		},
	];
	assert.equal(planRuns(workspaces, { tier: "db" }).length, 1);
	assert.equal(planRuns(workspaces, { tier: "db", explicit: false }).length, 0);
});

test("planRuns includes the required desktop guard tier", () => {
	const runs = planRuns(manifest.workspaces, { tier: "guard" });
	assert.deepEqual(
		runs.map((run) => [run.workspace.cwd, run.tier]),
		[["apps/desktop", "guard"]],
	);
});

test("filterRunsByWorkspace selects by manifest name or cwd and supports exclude", () => {
	const runs = planRuns(manifest.workspaces, { tier: "unit" });
	assert.deepEqual(
		filterRunsByWorkspace(runs, { workspaces: ["desktop"] }).map(
			(run) => run.workspace.cwd,
		),
		["apps/desktop"],
	);
	assert.deepEqual(
		filterRunsByWorkspace(runs, {
			workspaces: ["apps/desktop", "mobile"],
			excludeWorkspaces: ["desktop"],
		}).map((run) => run.workspace.cwd),
		["apps/mobile"],
	);
});

test("expandWorkspacePatterns supports nested workspace package roots", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-patterns-"));
	try {
		const pkg = path.join(root, "vendor", "protocols", "protocol-a");
		fs.mkdirSync(pkg, { recursive: true });
		fs.writeFileSync(path.join(pkg, "package.json"), '{"name":"protocol-a"}\n');
		assert.deepEqual(expandWorkspacePatterns(root, ["vendor/protocols/*"]), [
			"vendor/protocols/protocol-a",
		]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("parseCliOptions rejects --tier without a value", () => {
	assert.throws(
		() => parseCliOptions(["--tier"]),
		/--tier requires a value/,
	);
	assert.deepEqual(parseCliOptions([]), {
		all: false,
		tier: "unit",
		workspaces: [],
		excludeWorkspaces: [],
		workspaceConcurrency: undefined,
		noLock: false,
		related: false,
	});
});

test("parseCliOptions supports workspace include and exclude selectors", () => {
	assert.deepEqual(
		parseCliOptions([
			"--tier",
			"unit",
			"--workspace",
			"desktop,apps/server",
			"--workspace",
			"@cindy/maker-core",
			"--exclude-workspace",
			"packages/orca-workflow",
		]),
		{
			all: false,
			tier: "unit",
			workspaces: ["desktop", "apps/server", "@cindy/maker-core"],
			excludeWorkspaces: ["packages/orca-workflow"],
			workspaceConcurrency: undefined,
			noLock: false,
			related: false,
		},
	);
	assert.deepEqual(parseWorkspaceSelectorValue(" desktop, apps/server "), [
		"desktop",
		"apps/server",
	]);
	assert.throws(
		() => parseCliOptions(["--workspace", ","]),
		/--workspace requires a value/,
	);
});

test("workspace concurrency defaults to a bounded CPU count and accepts both CLI forms", () => {
	assert.equal(defaultWorkspaceConcurrency(1), 1);
	assert.equal(defaultWorkspaceConcurrency(2), 2);
	assert.equal(defaultWorkspaceConcurrency(32), 4);
	assert.equal(defaultWorkspaceConcurrency(Number.NaN), 1);
	assert.equal(parseWorkspaceConcurrency("8"), 8);
	assert.equal(
		parseCliOptions(["--workspace-concurrency", "3"]).workspaceConcurrency,
		3,
	);
	assert.equal(
		parseCliOptions(["--", "--workspace-concurrency=2"]).workspaceConcurrency,
		2,
	);
	for (const value of ["0", "-1", "1.5", "nope", "999999999999999999999"]) {
		assert.throws(
			() => parseWorkspaceConcurrency(value),
			/requires a positive integer/,
		);
	}
	assert.throws(
		() => parseCliOptions(["--workspace-concurrency"]),
		/requires a positive integer/,
	);
	assert.equal(parseCliOptions(["--no-lock"]).noLock, true);
	assert.equal(parseCliOptions(["--related"]).related, true);
	assert.throws(
		() => parseCliOptions(["--related", "--all"]),
		/--related cannot be combined with --all/,
	);
});

test("unit CI shard arguments cover valid halves and reject malformed input", () => {
	assert.deepEqual(unitTestShardArgs(""), []);
	assert.deepEqual(unitTestShardArgs(" 1/2 "), ["--shard=1/2"]);
	assert.deepEqual(unitTestShardArgs("2/2"), ["--shard=2/2"]);
	for (const value of ["1", "0/2", "3/2", "1/0", "a/b"]) {
		assert.throws(() => unitTestShardArgs(value), /XDT_UNIT_TEST_SHARD/);
	}
});

test("test gate lock covers heavy local tiers but skips guard, CI, and explicit bypass", () => {
	for (const tier of ["unit", "db", "git-integration", "integration", "e2e"]) {
		assert.equal(shouldUseTestGateLock({ tier, env: {} }), true);
	}
	assert.equal(shouldUseTestGateLock({ all: true, env: {} }), true);
	assert.equal(shouldUseTestGateLock({ tier: "guard", env: {} }), false);
	assert.equal(
		shouldUseTestGateLock({ tier: "unit", noLock: true, env: {} }),
		false,
	);
	for (const env of [{ CI: "1" }, { CI: "true" }, { GITHUB_ACTIONS: "true" }]) {
		assert.equal(shouldUseTestGateLock({ tier: "unit", env }), false);
	}
	assert.equal(
		shouldUseTestGateLock({ tier: "unit", env: { CI: "false" } }),
		true,
	);
});

test("test gate lock identity is stable per clone and normalizes Windows case", () => {
	assert.equal(
		testGateLockIdentity("C:\\Repo\\.git", "win32"),
		testGateLockIdentity("c:\\repo\\.git", "win32"),
	);
	assert.notEqual(
		testGateLockIdentity("/repo-a/.git", "linux"),
		testGateLockIdentity("/repo-b/.git", "linux"),
	);
});

test("test gate common-dir resolver joins worktrees from one clone without joining separate roots", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "test-gate-common-dir-"));
	try {
		const commonDir = path.join(root, "common.git");
		const firstGitDir = path.join(commonDir, "worktrees", "first");
		const secondGitDir = path.join(commonDir, "worktrees", "second");
		const firstWorktree = path.join(root, "first");
		const secondWorktree = path.join(root, "second");
		const separateRoot = path.join(root, "separate");
		for (const directory of [
			firstGitDir,
			secondGitDir,
			firstWorktree,
			secondWorktree,
			separateRoot,
		]) {
			fs.mkdirSync(directory, { recursive: true });
		}
		fs.writeFileSync(path.join(firstWorktree, ".git"), `gitdir: ${firstGitDir}\n`);
		fs.writeFileSync(
			path.join(secondWorktree, ".git"),
			`gitdir: ${secondGitDir}\n`,
		);
		for (const gitDir of [firstGitDir, secondGitDir]) {
			fs.writeFileSync(path.join(gitDir, "commondir"), "../..\n");
		}

		const firstResolved = await resolveTestGateCommonDir(firstWorktree);
		const secondResolved = await resolveTestGateCommonDir(secondWorktree);
		const separateResolved = await resolveTestGateCommonDir(separateRoot);
		assert.equal(firstResolved, secondResolved);
		assert.notEqual(firstResolved, separateResolved);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("test gate lock decision prefers an existing owner over an earlier free port", () => {
	const owner = { pid: 42, tier: "unit", cwd: "/repo/worktree-a" };
	assert.deepEqual(
		decideTestGateLock([
			{ port: 50_000, result: "available" },
			{ port: 50_001, result: "owner", owner },
		]),
		{ type: "wait", owner },
	);
	assert.deepEqual(
		decideTestGateLock([
			{ port: 50_000, result: "collision" },
			{ port: 50_001, result: "available" },
		]),
		{ type: "acquire", port: 50_001 },
	);
	assert.deepEqual(
		decideTestGateLock([{ port: 50_000, result: "collision" }]),
		{ type: "unavailable" },
	);
	assert.equal(classifyTestGateLockProbeError("ECONNREFUSED"), "available");
	assert.equal(classifyTestGateLockProbeError("ETIMEDOUT"), "collision");
});

test("test gate lock rejects invalid port counts before deriving candidates", async () => {
	for (const lockPortCount of [0, -1, 1.5, Number.NaN]) {
		await assert.rejects(
			() =>
				acquireTestGateLock({
					repoRoot: "unused",
					owner: { pid: 99, tier: "unit", cwd: "unused" },
					lockPortCount,
				}),
			/lockPortCount must be a positive integer/,
		);
	}
});

test("test gate lock reports the holder, waits, and acquires after release", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "test-gate-lock-"));
	let probeRound = 0;
	let now = 0;
	let listenedPort;
	const output = [];
	try {
		const lock = await acquireTestGateLock({
			repoRoot: root,
			owner: { pid: 99, tier: "db", cwd: root },
			timeoutMs: 1_000,
			retryDelayMs: 100,
			now: () => now,
			sleep: async (durationMs) => {
				now += durationMs;
			},
			probeCandidatesImpl: async (ports) => {
				probeRound += 1;
				if (probeRound === 1) {
					return [
						{ port: ports[0], result: "available" },
						{
							port: ports[1],
							result: "owner",
							owner: {
								pid: 42,
								tier: "unit",
								cwd: "/repo/worktree-a",
							},
						},
					];
				}
				return [{ port: ports[0], result: "available" }];
			},
			listenImpl: async (port) => {
				listenedPort = port;
				return { port, release: async () => {} };
			},
			output: (message) => output.push(message),
		});
		assert.equal(probeRound, 2);
		assert.equal(lock.port, listenedPort);
		assert.match(output.join("\n"), /pid 42, tier unit, cwd \/repo\/worktree-a/);
		await lock.release();
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

// A real probe round connects to every candidate port, and a port that accepts
// the connection without answering only resolves once the probe socket times
// out. So the window that waits for the WAIT report has to be far wider than a
// single probe round, otherwise a slow round loses the race and the assertion
// fails for reasons unrelated to the lock protocol.
const REAL_LOCK_WAIT_WINDOW_MS = 30_000;
const REAL_LOCK_ACQUIRE_TIMEOUT_MS = 60_000;
// Windows assigns 49152+ as its default dynamic client-port range. Keep this
// real socket test outside that range so unrelated CI network traffic cannot
// occupy all deterministic candidates while preserving the production range.
const REAL_LOCK_TEST_PORT_START = 10_000;
const REAL_LOCK_TEST_PORT_COUNT = 30_000;
const REAL_LOCK_TEST_PORT_STRIDE = 997;

function raceWithDeadline(candidates, deadlineMs, deadlineValue) {
	let timer;
	const deadline = new Promise((resolve) => {
		timer = setTimeout(() => resolve(deadlineValue), deadlineMs);
	});
	return Promise.race([...candidates, deadline]).finally(() => {
		clearTimeout(timer);
	});
}

test("two real test gate lock holders serialize on the same identity", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "test-gate-real-lock-"));
	let firstLock;
	let secondLockPromise;
	let reportWaiting;
	const waiting = new Promise((resolve) => {
		reportWaiting = resolve;
	});
	try {
		firstLock = await acquireTestGateLock({
			repoRoot: root,
			owner: { pid: 41, tier: "unit", cwd: path.join(root, "first") },
			lockPortStart: REAL_LOCK_TEST_PORT_START,
			lockPortCount: REAL_LOCK_TEST_PORT_COUNT,
			lockPortStride: REAL_LOCK_TEST_PORT_STRIDE,
			output: () => {},
		});
		secondLockPromise = acquireTestGateLock({
			repoRoot: root,
			owner: { pid: 42, tier: "db", cwd: path.join(root, "second") },
			lockPortStart: REAL_LOCK_TEST_PORT_START,
			lockPortCount: REAL_LOCK_TEST_PORT_COUNT,
			lockPortStride: REAL_LOCK_TEST_PORT_STRIDE,
			timeoutMs: REAL_LOCK_ACQUIRE_TIMEOUT_MS,
			retryDelayMs: 10,
			output: reportWaiting,
		});
		// A failing assertion below jumps straight to `finally` while this
		// acquisition is still running. Attach a no-op handler so an eventual
		// rejection is never unhandled; the real await and release happen in
		// `finally`, otherwise a lock bound after the failure keeps its listener
		// open and `node --test` never exits.
		secondLockPromise.catch(() => {});

		const outcome = await raceWithDeadline(
			[waiting.then(() => "waiting"), secondLockPromise.then(() => "acquired")],
			REAL_LOCK_WAIT_WINDOW_MS,
			"timed-out",
		);
		assert.equal(outcome, "waiting");

		await firstLock.release();
		firstLock = undefined;
		const secondLock = await secondLockPromise;
		assert.ok(secondLock.port >= REAL_LOCK_TEST_PORT_START);
		assert.ok(
			secondLock.port < REAL_LOCK_TEST_PORT_START + REAL_LOCK_TEST_PORT_COUNT,
		);
	} finally {
		// Order matters: releasing the first lock lets the second acquisition
		// settle immediately instead of waiting out its own timeout.
		await firstLock?.release();
		await secondLockPromise?.then(
			(lock) => lock.release(),
			() => {},
		);
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("test gate lock skips ports denied at bind time", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "test-gate-bind-denied-"));
	const attemptedPorts = [];
	try {
		const lock = await acquireTestGateLock({
			repoRoot: root,
			owner: { pid: 99, tier: "unit", cwd: root },
			probeCandidatesImpl: async (ports) =>
				ports.map((port) => ({ port, result: "available" })),
			listenImpl: async (port) => {
				attemptedPorts.push(port);
				if (attemptedPorts.length === 1) {
					throw Object.assign(new Error("bind denied"), { code: "EACCES" });
				}
				return { port, release: async () => {} };
			},
			output: () => {},
		});

		assert.equal(attemptedPorts.length, 2);
		assert.notEqual(attemptedPorts[0], attemptedPorts[1]);
		assert.equal(lock.port, attemptedPorts[1]);
		await lock.release();
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("test gate lock timeout uses a distinct temporary-failure exit code", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "test-gate-timeout-"));
	let now = 0;
	try {
		await assert.rejects(
			() =>
				acquireTestGateLock({
					repoRoot: root,
					owner: { pid: 99, tier: "unit", cwd: root },
					timeoutMs: 100,
					retryDelayMs: 100,
					now: () => now,
					sleep: async (durationMs) => {
						now += durationMs;
					},
					probeCandidatesImpl: async (ports) => [
						{
							port: ports[0],
							result: "owner",
							owner: {
								pid: 42,
								tier: "unit",
								cwd: "/repo/worktree-a",
							},
						},
					],
					output: () => {},
				}),
			(error) => {
				assert.equal(error.exitCode, TEST_GATE_LOCK_TIMEOUT_EXIT_CODE);
				assert.match(error.message, /tests did not run/);
				return true;
			},
		);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("resolvePnpmInvocation uses current pnpm through node when npm_execpath points at a JS entry on any platform", () => {
	assert.deepEqual(
		resolvePnpmInvocation(["--dir", "apps/server", "run", "test"], {
			execPath: "C:/node/node.exe",
			npmExecPath: "C:/pnpm/pnpm.cjs",
			platform: "win32",
		}),
		{
			command: "C:/node/node.exe",
			args: ["C:/pnpm/pnpm.cjs", "--dir", "apps/server", "run", "test"],
			shell: false,
		},
	);
	assert.deepEqual(
		resolvePnpmInvocation(["--dir", "/repo/apps/server", "run", "test"], {
			execPath: "/usr/local/bin/node",
			npmExecPath: "/usr/local/lib/node_modules/pnpm/bin/pnpm.cjs",
			platform: "darwin",
		}),
		{
			command: "/usr/local/bin/node",
			args: [
				"/usr/local/lib/node_modules/pnpm/bin/pnpm.cjs",
				"--dir",
				"/repo/apps/server",
				"run",
				"test",
			],
			shell: false,
		},
	);
});

test("resolvePnpmInvocation runs a native pnpm binary directly instead of feeding it to node", () => {
	// pnpm 的原生二进制发行版（standalone 安装）把 npm_execpath 指向可执行文件本身；
	// 交给 node 会抛 SyntaxError: Invalid or unexpected token，把整轮测试变成假失败。
	assert.deepEqual(
		resolvePnpmInvocation(["--dir", "/repo/apps/server", "run", "test"], {
			execPath: "/usr/local/bin/node",
			npmExecPath:
				"/Users/dev/Library/pnpm/.tools/@pnpm+macos-arm64/10.33.2/node_modules/@pnpm/macos-arm64/pnpm",
			platform: "darwin",
		}),
		{
			command:
				"/Users/dev/Library/pnpm/.tools/@pnpm+macos-arm64/10.33.2/node_modules/@pnpm/macos-arm64/pnpm",
			args: ["--dir", "/repo/apps/server", "run", "test"],
			shell: false,
		},
	);
	assert.deepEqual(
		resolvePnpmInvocation(["--version"], {
			execPath: "/usr/bin/node",
			npmExecPath: "/home/dev/.local/share/pnpm/pnpm",
			platform: "linux",
		}),
		{
			command: "/home/dev/.local/share/pnpm/pnpm",
			args: ["--version"],
			shell: false,
		},
	);
	assert.deepEqual(
		resolvePnpmInvocation(["--version"], {
			execPath: "C:/node/node.exe",
			npmExecPath: "C:/Users/dev/AppData/Local/pnpm/pnpm.exe",
			platform: "win32",
		}),
		{
			command: "C:/Users/dev/AppData/Local/pnpm/pnpm.exe",
			args: ["--version"],
			shell: false,
		},
	);
});

test("resolvePnpmInvocation invokes Windows command wrappers through cmd.exe", () => {
	// .cmd／.bat 通过 cmd.exe 执行，同时逐字传递 /c 命令串。
	for (const npmExecPath of [
		"C:/Program Files/nodejs/pnpm.cmd",
		"C:/Program Files/nodejs/pnpm.bat",
	]) {
		assert.deepEqual(
			resolvePnpmInvocation(["--version"], {
				execPath: "C:/node/node.exe",
				npmExecPath,
				platform: "win32",
				comSpec: "C:/Windows/System32/cmd.exe",
			}),
			{
				command: "C:/Windows/System32/cmd.exe",
				args: [
					"/d",
					"/s",
					"/v:off",
					"/c",
					'""%CINDY_PNPM_CMD_ARG_0%" "%CINDY_PNPM_CMD_ARG_1%""',
				],
				env: {
					CINDY_PNPM_CMD_ARG_0: npmExecPath,
					CINDY_PNPM_CMD_ARG_1: "--version",
				},
				shell: false,
				windowsVerbatimArguments: true,
			},
		);
	}
});

test("resolvePnpmInvocation resolves Corepack relative JS entries from Node install", () => {
	const execPath = path.win32.normalize("C:/node/node.exe");
	assert.deepEqual(
		resolvePnpmInvocation(["--version"], {
			execPath,
			npmExecPath: "corepack/dist/pnpm.js",
			platform: "win32",
		}),
		{
			command: execPath,
			args: [
				path.win32.join(
					path.win32.dirname(execPath),
					"node_modules",
					"corepack/dist/pnpm.js",
				),
				"--version",
			],
			shell: false,
		},
	);
});

test("resolvePnpmInvocation quotes Windows command wrapper arguments", () => {
	assert.deepEqual(
		resolvePnpmInvocation(
			[
				"--dir",
				'C:/Users/First Last/repo & "tools"!/%literal%/apps/server',
				"run",
				"test",
			],
			{
				npmExecPath: "C:/Program Files/nodejs/pnpm.cmd",
				platform: "win32",
				comSpec: "C:/Windows/System32/cmd.exe",
			},
		),
		{
			command: "C:/Windows/System32/cmd.exe",
			args: [
				"/d",
				"/s",
				"/v:off",
				"/c",
				'""%CINDY_PNPM_CMD_ARG_0%" "%CINDY_PNPM_CMD_ARG_1%" "%CINDY_PNPM_CMD_ARG_2%" "%CINDY_PNPM_CMD_ARG_3%" "%CINDY_PNPM_CMD_ARG_4%""',
			],
			env: {
				CINDY_PNPM_CMD_ARG_0: "C:/Program Files/nodejs/pnpm.cmd",
				CINDY_PNPM_CMD_ARG_1: "--dir",
				CINDY_PNPM_CMD_ARG_2: 'C:/Users/First Last/repo & ""tools""!/%literal%/apps/server',
				CINDY_PNPM_CMD_ARG_3: "run",
				CINDY_PNPM_CMD_ARG_4: "test",
			},
			shell: false,
			windowsVerbatimArguments: true,
		},
	);
});

test("usablePnpmExecPath rejects paths that are not a present pnpm entry", () => {
	const present = () => true;
	assert.equal(usablePnpmExecPath(undefined, present), undefined);
	assert.equal(usablePnpmExecPath("", present), undefined);
	// 名字不是 pnpm：npm_execpath 可能残留自 npm／yarn 的生命周期脚本。
	assert.equal(usablePnpmExecPath("/usr/local/bin/npm-cli.js", present), undefined);
	// 路径不存在：Windows 的 restart 管线新开 cmd.exe 时见过残留的旧路径。
	assert.equal(usablePnpmExecPath("/gone/pnpm.cjs", () => false), undefined);
	assert.equal(
		usablePnpmExecPath("/home/dev/.local/share/pnpm/pnpm", present),
		"/home/dev/.local/share/pnpm/pnpm",
	);
});

test("resolvePnpmInvocation fallback shell behavior is explicit per platform", () => {
	assert.deepEqual(
		resolvePnpmInvocation(["--version"], {
			execPath: "C:/node/node.exe",
			npmExecPath: undefined,
			platform: "win32",
			comSpec: "C:/Windows/System32/cmd.exe",
		}),
		{
			command: "C:/Windows/System32/cmd.exe",
			args: [
				"/d",
				"/s",
				"/v:off",
				"/c",
				'""%CINDY_PNPM_CMD_ARG_0%" "%CINDY_PNPM_CMD_ARG_1%""',
			],
			env: {
				CINDY_PNPM_CMD_ARG_0: path.win32.join("C:/node", "pnpm.cmd"),
				CINDY_PNPM_CMD_ARG_1: "--version",
			},
			shell: false,
			windowsVerbatimArguments: true,
		},
	);
	assert.deepEqual(
		resolvePnpmInvocation(["--version"], {
			execPath: "node",
			npmExecPath: undefined,
			platform: "darwin",
		}),
		{ command: "pnpm", args: ["--version"], shell: false },
	);
	assert.deepEqual(
		resolvePnpmInvocation(["--version"], {
			execPath: "node",
			npmExecPath: undefined,
			platform: "linux",
		}),
		{ command: "pnpm", args: ["--version"], shell: false },
	);
});

test("classifyFailure distinguishes no tests and collect failures conservatively", () => {
	assert.equal(
		classifyFailure({
			stage: "test",
			exitCode: 1,
			output: "No test files found",
		}),
		"NO_TESTS_REQUIRED",
	);
	assert.equal(
		classifyFailure({
			stage: "test",
			exitCode: 1,
			output: "Failed Suites 3\nCannot find module",
		}),
		"TEST_COLLECT_FAILED",
	);
	assert.equal(
		classifyFailure({
			stage: "test",
			exitCode: 1,
			output: "FAIL expected value\nTest timed out in 5000ms",
		}),
		"TEST_ASSERTION_FAILED",
	);
});

test("runCommand resolves spawn errors as failed command results", async () => {
	const result = await runCommand("__xdmaker_missing_command__", [], {
		shell: false,
	});
	assert.equal(result.exitCode, 1);
	assert.match(result.output, /ENOENT|not found|找不到|无法|spawn/i);
});

test("createOutputForwarder stops writing after EPIPE without treating it as a command failure", () => {
	class FakeStream extends EventEmitter {
		writes = [];
		write(chunk) {
			this.writes.push(chunk.toString());
		}
	}
	const stream = new FakeStream();
	const forwarder = createOutputForwarder(stream);
	forwarder.write(Buffer.from("before"));
	stream.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
	assert.doesNotThrow(() => forwarder.write(Buffer.from("after")));
	assert.deepEqual(stream.writes, ["before"]);
	assert.equal(forwarder.finish(), null);
});

test("resolveOutputStream preserves explicit null while defaulting undefined", () => {
	const fallback = new EventEmitter();
	assert.equal(resolveOutputStream(undefined, fallback), fallback);
	assert.equal(resolveOutputStream(null, fallback), null);
});

test("createBoundedOutputBuffer keeps bounded head and tail diagnostics", () => {
	const output = createBoundedOutputBuffer(20);
	output.append("0123456789");
	output.append("abcdefghij");
	output.append("KLMNOPQRST");
	assert.equal(
		output.toString(),
		"01234\n... 10 output characters omitted ...\nfghijKLMNOPQRST",
	);
});

test("runCommand bounds captured output while retaining head and tail", async () => {
	const result = await runCommand(
		process.execPath,
		["-e", "process.stdout.write(`HEAD${'x'.repeat(100)}TAIL`)"],
		{
			shell: false,
			stdout: null,
			stderr: null,
			maxOutputChars: 20,
		},
	);
	assert.equal(result.exitCode, 0);
	assert.match(result.output, /^HEAD/);
	assert.match(result.output, /output characters omitted/);
	assert.match(result.output, /TAIL$/);
	assert.ok(result.output.length < 100);
});

test("runCommand completes successfully when its output consumer closes with EPIPE", async () => {
	class ClosedStream extends EventEmitter {
		write() {}
	}
	const stream = new ClosedStream();
	const pending = runCommand(
		process.execPath,
		["-e", "setTimeout(() => process.stdout.write('child-finished'), 20)"],
		{ shell: false, stdout: stream, stderr: stream },
	);
	stream.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
	const result = await pending;
	assert.equal(result.exitCode, 0);
	assert.match(result.output, /child-finished/);
});

test("mapWithConcurrency stays within the bound, remains work-conserving, and preserves result order", async () => {
	const releases = [];
	const started = [];
	let active = 0;
	let maxActive = 0;
	const pending = mapWithConcurrency(["a", "b", "c"], 2, async (item) => {
		started.push(item);
		active += 1;
		maxActive = Math.max(maxActive, active);
		await new Promise((resolve) => releases.push(resolve));
		active -= 1;
		return item.toUpperCase();
	});

	await waitFor(() => started.length === 2);
	assert.deepEqual(started, ["a", "b"]);
	assert.equal(active, 2);
	releases.shift()();
	await waitFor(() => started.length === 3);
	assert.deepEqual(started, ["a", "b", "c"]);
	assert.equal(active, 2, "the freed slot should be reused immediately");
	for (const release of releases.splice(0)) release();

	assert.deepEqual(await pending, ["A", "B", "C"]);
	assert.equal(maxActive, 2);
});

test("runWithExclusiveBarriers never overlaps exclusive and normal work", async () => {
	const runs = [
		{ id: "a", tierConfig: {} },
		{ id: "b", tierConfig: {} },
		{ id: "desktop", tierConfig: { execution: "exclusive" } },
		{ id: "c", tierConfig: {} },
	];
	let normalActive = 0;
	let exclusiveActive = false;
	let maxNormalActive = 0;
	const started = [];
	const results = await runWithExclusiveBarriers(runs, 2, async (run) => {
		started.push(run.id);
		if (run.tierConfig.execution === "exclusive") {
			assert.equal(normalActive, 0);
			assert.equal(exclusiveActive, false);
			exclusiveActive = true;
		} else {
			assert.equal(exclusiveActive, false);
			normalActive += 1;
			maxNormalActive = Math.max(maxNormalActive, normalActive);
		}
		await new Promise((resolve) => setImmediate(resolve));
		if (run.tierConfig.execution === "exclusive") exclusiveActive = false;
		else normalActive -= 1;
		return run.id;
	});

	assert.deepEqual(started, ["a", "b", "desktop", "c"]);
	assert.deepEqual(results, ["a", "b", "desktop", "c"]);
	assert.equal(maxNormalActive, 2);
});

test("createWorkspaceRunReporter keeps passing output concise and flushes failed output as one block", () => {
	let timestamp = 1_000;
	const writes = [];
	const reporter = createWorkspaceRunReporter({
		stdout: { write: (chunk) => writes.push(String(chunk)) },
		now: () => timestamp,
	});
	const run = {
		workspace: { cwd: "packages/a" },
		tier: "unit",
	};
	reporter.onRunStart(run);
	reporter.onCommandComplete({
		run,
		stage: "test",
		commandResult: { output: "passing output", exitCode: 0 },
	});
	reporter.onCommandComplete({
		run,
		stage: "test",
		commandResult: { output: "failed output", exitCode: 1 },
	});
	timestamp = 2_250;
	reporter.onRunComplete(run, {
		exitCode: 1,
		failure: "COMMAND_FAILED",
		durationMs: 1_500,
	});
	assert.equal(
		writes.join(""),
		"START packages/a unit\n" +
			"\n[packages/a unit test]\nfailed output\n" +
			"FAIL COMMAND_FAILED packages/a unit (1.5s)\n",
	);
});

test("runPlannedTests skips test command when preflight fails", async () => {
	const calls = [];
	const manifest = {
		workspaces: [
			{
				name: "server",
				cwd: "apps/server",
				status: "required",
				tiers: {
					unit: {
						status: "required",
						preflight: [{ type: "packageScript", script: "db:generate" }],
						command: { type: "packageScript", script: "test" },
					},
				},
			},
		],
	};
	const result = await runPlannedTests({
		root: "F:/repo",
		workspaceCwds: ["apps/server"],
		allFiles: ["apps/server/src/__tests__/sessions.test.ts"],
		manifest,
		tier: "unit",
		runCommandImpl: async (command, args, options) => {
			calls.push({ command, args, cwd: options.cwd });
			return { exitCode: 1, output: "generate failed" };
		},
	});
	assert.equal(calls.length, 1);
	assert.equal(normalizeRelPath(calls[0].cwd), "F:/repo/apps/server");
	assert.equal(result[0].stage, "preflight");
	assert.equal(result[0].failure, "PREFLIGHT_FAILED");
});

test("runPlannedTests filters workspaces after full manifest coverage validation", async () => {
	const fakeManifest = {
		workspaces: [
			{
				name: "desktop",
				cwd: "apps/desktop",
				status: "required",
				tiers: {
					unit: {
						status: "required",
						command: { type: "packageBin", bin: "vitest", args: ["run"] },
					},
				},
			},
			{
				name: "server",
				cwd: "apps/server",
				status: "required",
				tiers: {
					unit: {
						status: "required",
						command: { type: "packageScript", script: "test" },
					},
				},
			},
		],
	};
	const common = {
		root: "/repo",
		manifest: fakeManifest,
		workspaceCwds: ["apps/desktop", "apps/server"],
		allFiles: [
			"apps/desktop/src/main/__tests__/lifecycle.test.ts",
			"apps/server/src/__tests__/sessions.test.ts",
		],
		runCommandImpl: async () => ({ exitCode: 0, output: "ok" }),
	};

	const desktopOnly = await runPlannedTests({
		...common,
		tier: "unit",
		workspaces: ["desktop"],
	});
	assert.deepEqual(
		desktopOnly.map((result) => result.workspace),
		["apps/desktop"],
	);

	const restOnly = await runPlannedTests({
		...common,
		tier: "unit",
		excludeWorkspaces: ["apps/desktop"],
	});
	assert.deepEqual(
		restOnly.map((result) => result.workspace),
		["apps/server"],
	);

	await assert.rejects(
		() =>
			runPlannedTests({
				...common,
				workspaceCwds: ["apps/desktop"],
				tier: "unit",
				workspaces: ["desktop"],
			}),
		/Manifest declares non-pnpm workspace: apps\/server/,
	);
	await assert.rejects(
		() =>
			runPlannedTests({
				...common,
				tier: "unit",
				workspaces: ["missing"],
			}),
		/--workspace matched no workspace: missing/,
	);
});

test("runPlannedTests continues after one workspace test fails", async () => {
	const manifest = {
		workspaces: [
			{
				name: "a",
				cwd: "packages/a",
				status: "required",
				tiers: {
					unit: {
						status: "required",
						command: { type: "packageBin", bin: "vitest", args: ["run"] },
					},
				},
			},
			{
				name: "b",
				cwd: "packages/b",
				status: "required",
				tiers: {
					unit: {
						status: "required",
						command: { type: "packageBin", bin: "vitest", args: ["run"] },
					},
				},
			},
		],
	};
	let index = 0;
	const result = await runPlannedTests({
		root: "F:/repo",
		workspaceCwds: ["packages/a", "packages/b"],
		allFiles: ["packages/a/a.test.ts", "packages/b/b.test.ts"],
		manifest,
		tier: "unit",
		runCommandImpl: async () =>
			index++ === 0
				? { exitCode: 1, output: "FAIL expected" }
				: { exitCode: 0, output: "PASS" },
	});
	assert.equal(result.length, 2);
	assert.equal(result[0].failure, "TEST_ASSERTION_FAILED");
	assert.equal(result[1].exitCode, 0);
});

test("runPlannedTests applies bounded concurrency while keeping results in manifest order", async () => {
	const workspaces = ["a", "b", "c"].map((name) => ({
		name,
		cwd: `packages/${name}`,
		status: "required",
		tiers: {
			unit: {
				status: "required",
				command: { type: "packageBin", bin: "vitest", args: ["run"] },
			},
		},
	}));
	const delays = new Map([
		["packages/a", 20],
		["packages/b", 1],
		["packages/c", 5],
	]);
	let active = 0;
	let maxActive = 0;
	const result = await runPlannedTests({
		root: "F:/repo",
		workspaceCwds: workspaces.map((workspace) => workspace.cwd),
		allFiles: workspaces.map(
			(workspace) => `${workspace.cwd}/src/example.test.ts`,
		),
		manifest: { workspaces },
		tier: "unit",
		workspaceConcurrency: 2,
		runCommandImpl: async (_command, _args, options) => {
			active += 1;
			maxActive = Math.max(maxActive, active);
			const workspace = normalizeRelPath(options.cwd).replace("F:/repo/", "");
			await new Promise((resolve) => setTimeout(resolve, delays.get(workspace)));
			active -= 1;
			return { exitCode: 0, output: workspace };
		},
	});

	assert.equal(maxActive, 2);
	assert.deepEqual(
		result.map((entry) => entry.workspace),
		["packages/a", "packages/b", "packages/c"],
	);
});

test("runPlannedTests treats an exclusive workspace as a concurrency barrier", async () => {
	const workspaces = [
		{ name: "a", cwd: "packages/a", execution: undefined },
		{ name: "desktop", cwd: "apps/desktop", execution: "exclusive" },
		{ name: "b", cwd: "packages/b", execution: undefined },
	].map(({ name, cwd, execution }) => ({
		name,
		cwd,
		status: "required",
		tiers: {
			unit: {
				status: "required",
				command: { type: "packageBin", bin: "vitest", args: ["run"] },
				...(execution ? { execution } : {}),
			},
		},
	}));
	let normalActive = 0;
	let desktopActive = false;
	await runPlannedTests({
		root: "F:/repo",
		workspaceCwds: workspaces.map((workspace) => workspace.cwd),
		allFiles: workspaces.map(
			(workspace) => `${workspace.cwd}/src/example.test.ts`,
		),
		manifest: { workspaces },
		tier: "unit",
		workspaceConcurrency: 2,
		runCommandImpl: async (_command, _args, options) => {
			const workspace = normalizeRelPath(options.cwd).replace("F:/repo/", "");
			if (workspace === "apps/desktop") {
				assert.equal(normalActive, 0);
				desktopActive = true;
			} else {
				assert.equal(desktopActive, false);
				normalActive += 1;
			}
			await new Promise((resolve) => setImmediate(resolve));
			if (workspace === "apps/desktop") desktopActive = false;
			else normalActive -= 1;
			return { exitCode: 0, output: workspace };
		},
	});
});

test("runPlannedTests passes selected include files to packageBin commands", async () => {
	const calls = [];
	const manifest = {
		workspaces: [
			{
				name: "orca",
				cwd: "packages/orca-workflow",
				status: "required",
				tiers: {
					unit: {
						status: "required",
						command: { type: "packageBin", bin: "vitest", args: ["run"] },
						include: ["src/__tests__/**/*.test.ts"],
					},
				},
			},
		],
	};
	await runPlannedTests({
		root: "F:/repo",
		workspaceCwds: ["packages/orca-workflow"],
		allFiles: ["packages/orca-workflow/src/__tests__/orca-bridge-mcp.test.ts"],
		manifest,
		tier: "unit",
		runCommandImpl: async (command, args, options) => {
			calls.push({ command, args, options });
			return { exitCode: 0, output: "PASS" };
		},
	});
	const invocation = calls[0];
	const forwardedEntries = Object.entries(invocation.options?.env ?? {})
		.filter(([name]) => /^CINDY_PNPM_CMD_ARG_\d+$/.test(name))
		.sort(
			([left], [right]) =>
				Number(left.slice("CINDY_PNPM_CMD_ARG_".length)) -
				Number(right.slice("CINDY_PNPM_CMD_ARG_".length)),
		);
	if (forwardedEntries.length > 0) {
		// Windows .cmd/.bat pnpm entries are invoked through cmd.exe. The
		// resolver passes each argument through a dedicated environment variable
		// so paths and shell metacharacters remain intact.
		const forwardedArgs = forwardedEntries.map(([, value]) => value);
		assert.deepEqual(forwardedArgs.slice(-1), [
			"src/__tests__/orca-bridge-mcp.test.ts",
		]);
		assert.equal(
			forwardedArgs.includes("src/__tests__/**/*.test.ts"),
			false,
		);
	} else {
		assert.deepEqual(invocation.args.slice(-1), [
			"src/__tests__/orca-bridge-mcp.test.ts",
		]);
		assert.equal(invocation.args.includes("src/__tests__/**/*.test.ts"), false);
	}
});

test("buildPnpmArgs rejects selected files outside the workspace", () => {
	assert.throws(
		() =>
			buildPnpmArgs(
				"F:/repo",
				{ cwd: "packages/orca-workflow" },
				{ type: "packageBin", bin: "vitest", args: ["run"] },
				{ include: ["src/__tests__/**/*.test.ts"] },
				["packages/other/src/foo.test.ts"],
			),
		/Selected test file is outside workspace packages\/orca-workflow: packages\/other\/src\/foo\.test\.ts/,
	);
});

test("buildPnpmArgs switches vitest to related mode when related files are provided", () => {
	const args = buildPnpmArgs(
		"F:/repo",
		{ cwd: "apps/desktop" },
		{
			type: "packageBin",
			bin: "vitest",
			args: ["run", "--pool=threads", "--maxWorkers=1"],
		},
		{ exclude: ["**/*.bench.ts"] },
		["apps/desktop/src/main/foo.test.ts"],
		["apps/desktop/src/main/foo.ts"],
	);
	assert.equal(args[3], "vitest");
	assert.deepEqual(args.slice(4, 9), [
		"related",
		"--run",
		"--pool=threads",
		"--maxWorkers=1",
		"--passWithNoTests",
	]);
	assert.equal(args.includes("src/main/foo.ts"), true);
	assert.equal(args.includes("src/main/foo.test.ts"), false);
	assert.deepEqual(args.slice(-2), ["--exclude", "**/*.bench.ts"]);
});

test("buildPnpmArgs only loosens Vitest sharding for undersized workspaces", () => {
	const root = "F:/repo";
	const workspace = { cwd: "packages/example" };
	const oneSelectedFile = ["packages/example/src/only.test.ts"];
	const buildShard = (shard, selectedFiles = oneSelectedFile) =>
		buildPnpmArgs(
			root,
			workspace,
			{ type: "packageBin", bin: "vitest", args: ["run", `--shard=${shard}`] },
			{},
			selectedFiles,
		);

	assert.equal(buildShard("1/2").includes("--passWithNoTests"), true);
	assert.equal(buildShard("2/2").includes("--passWithNoTests"), true);
	assert.equal(
		buildShard("2/2", [
			"packages/example/src/first.test.ts",
			"packages/example/src/second.test.ts",
		]).includes("--passWithNoTests"),
		false,
	);
});

test("runPlannedTests all mode runs required configured tiers and skips manual tiers", async () => {
	const manifest = {
		workspaces: [
			{
				name: "a",
				cwd: "packages/a",
				status: "required",
				tiers: {
					smoke: {
						status: "required",
						command: { type: "packageBin", bin: "vitest", args: ["run"] },
					},
					heavy: {
						status: "manual",
						reason: "Run explicitly",
						command: { type: "packageBin", bin: "vitest", args: ["run"] },
					},
				},
			},
		],
	};
	const result = await runPlannedTests({
		root: "F:/repo",
		workspaceCwds: ["packages/a"],
		allFiles: ["packages/a/a.test.ts"],
		manifest,
		all: true,
		runCommandImpl: async () => ({ exitCode: 0, output: "PASS" }),
	});
	assert.equal(result.length, 1);
	assert.equal(result[0].tier, "smoke");
});

test("runPlannedTests rejects explicit tiers with no runnable runs", async () => {
	const manifest = {
		workspaces: [
			{
				name: "desktop",
				cwd: "apps/desktop",
				status: "required",
				tiers: {
					db: {
						status: "deferred",
						reason: "Uses existing desktop script",
						existingScript: "test:db",
					},
				},
			},
		],
	};
	await assert.rejects(
		() =>
			runPlannedTests({
				root: "F:/repo",
				workspaceCwds: ["apps/desktop"],
				allFiles: [],
				manifest,
				tier: "db",
			}),
		/No runnable test runs configured for tier db/,
	);
});

test("printSummary includes complete command line and skipped workspaces", () => {
	const logs = [];
	const originalLog = console.log;
	console.log = (message) => {
		logs.push(message);
	};
	try {
		printSummary(
			[
				{
					workspace: "apps/server",
					tier: "unit",
					exitCode: 1,
					failure: "TEST_ASSERTION_FAILED",
					command: "pnpm",
					args: ["--dir", "F:/repo/apps/server", "run", "test"],
				},
			],
			{
				workspaces: [
					{
						cwd: "apps/heartbeat-server",
						status: "notApplicable",
						reason: "No tests yet",
						tiers: {},
					},
				],
			},
		);
	} finally {
		console.log = originalLog;
	}
	const output = logs.join("\n");
	assert.match(output, /FAIL TEST_ASSERTION_FAILED apps\/server unit/);
	assert.match(output, /command: pnpm --dir F:\/repo\/apps\/server run test/);
	assert.match(
		output,
		/SKIP apps\/heartbeat-server notApplicable: No tests yet/,
	);
});

// ---------------------------------------------------------------------------
// Windows command-line budget: tier batching (scripts/test-workspaces.mjs).
// 事实、机制与不变量见 docs/dev-rules/desktop-unit-test-performance.md
// 的「Windows 命令行长度预算与 tier 分块」一节。
// ---------------------------------------------------------------------------

// cmd.exe 拒绝超过 8191 字符的命令行；runner 的 win32 预算是 6000，留出的差额
// 要覆盖 node + pnpm.cjs 前缀与 .cmd shim 的引号开销。
const CMD_EXE_COMMAND_LINE_LIMIT = 8_191;

let repoTestFilesCache;
function repoTestFiles() {
	if (!repoTestFilesCache) repoTestFilesCache = discoverTestFiles(readAllFiles(ROOT));
	return repoTestFilesCache;
}

function manifestWorkspace(cwd) {
	const workspace = manifest.workspaces.find((candidate) => candidate.cwd === cwd);
	assert.ok(workspace, `${cwd} must be declared in test-workspaces.config.mjs`);
	return workspace;
}

function planRealTier(cwd, tier, options) {
	const workspace = manifestWorkspace(cwd);
	const tierConfig = workspace.tiers[tier];
	assert.ok(tierConfig, `${cwd} must declare a ${tier} tier`);
	const selected = selectFilesForTier(workspace, tierConfig, repoTestFiles());
	return {
		workspace,
		tierConfig,
		selected,
		args: buildPnpmArgs(ROOT, workspace, tierConfig.command, tierConfig, selected),
		batches: planPnpmArgBatches(
			ROOT,
			workspace,
			tierConfig.command,
			tierConfig,
			selected,
			undefined,
			options,
		),
	};
}

/**
 * 把一批 args 拆回 buildPnpmArgParts 组装的三段：共享前缀、显式文件列表
 * （`fileCount` 项）与 `--exclude` 后缀（每个 pattern 固定两个参数）。
 */
function batchArgParts(batch, tierConfig = {}) {
	const suffixStart = batch.args.length - (tierConfig.exclude?.length ?? 0) * 2;
	return {
		prefix: batch.args.slice(0, suffixStart - batch.fileCount),
		fileArgs: batch.args.slice(suffixStart - batch.fileCount, suffixStart),
		suffix: batch.args.slice(suffixStart),
	};
}

const BATCH_ROOT = "F:/repo";
const BATCH_CWD = "packages/batch";
const BATCH_COMMAND = {
	type: "packageBin",
	bin: "vitest",
	args: ["run", "--pool=forks", "--maxWorkers=1"],
};
const BATCH_TIER = {
	status: "required",
	command: BATCH_COMMAND,
	include: ["src/__tests__/**/*.test.ts"],
	exclude: ["**/*.integration.test.ts", "**/*.bench.ts"],
};
const BATCH_WORKSPACE = {
	name: "batch",
	cwd: BATCH_CWD,
	status: "required",
	tiers: { unit: BATCH_TIER },
};

function batchFixtureFiles(count) {
	return Array.from(
		{ length: count },
		(_, index) =>
			`${BATCH_CWD}/src/__tests__/batch-${String(index).padStart(4, "0")}.test.ts`,
	);
}

function batchFixtureRelativeFiles(count) {
	return batchFixtureFiles(count).map((file) => file.slice(`${BATCH_CWD}/`.length));
}

test("commandLineLength measures the joined argument vector and the budget is per platform", () => {
	assert.equal(commandLineLength([]), 0);
	// 每个参数各占一个分隔符：`pnpm a bb` 就是 OS 看到的长度。
	assert.equal(commandLineLength(["a"]), 2);
	assert.equal(commandLineLength(["aa", "bbb"]), 3 + 4);
	assert.equal(commandLineLength(["--exclude", "**/*.bench.ts"]), 10 + 14);
	assert.equal(maxInlineCommandLength("win32"), 6_000);
	assert.equal(maxInlineCommandLength("darwin"), 120_000);
	assert.equal(maxInlineCommandLength("linux"), 120_000);
	assert.equal(
		maxInlineCommandLength(process.platform),
		process.platform === "win32" ? 6_000 : 120_000,
	);
	assert.ok(maxInlineCommandLength("win32") < CMD_EXE_COMMAND_LINE_LIMIT);
	assert.ok(CMD_EXE_COMMAND_LINE_LIMIT - maxInlineCommandLength("win32") >= 1_000);
});

test("planPnpmArgBatches keeps single-invocation behaviour byte for byte on real tiers", () => {
	// POSIX 预算（120k）下清单里每个 tier 今天都装得下，因此都必须恰好 1 批，
	// 且 args 与 buildPnpmArgs 的输出逐字节相同 —— 零行为变化。
	const realTiers = [
		// 125 个显式文件的 tier：本修复的触发点。
		["apps/desktop", "db"],
		["apps/desktop", "guard"],
		// 无显式 include 的 tier：不带任何文件列表。
		["apps/desktop", "unit"],
		["packages/maker-core", "unit"],
		["apps/mobile", "unit"],
		// packageScript tier：连文件列表口径都不存在。
		["apps/desktop", "db-perf"],
	];
	for (const [cwd, tier] of realTiers) {
		const planned = planRealTier(cwd, tier, { platform: "linux" });
		assert.equal(
			planned.batches.length,
			1,
			`${cwd} ${tier} must stay a single invocation on POSIX`,
		);
		assert.equal(
			JSON.stringify(planned.batches[0].args),
			JSON.stringify(planned.args),
			`${cwd} ${tier} batched args must be byte-identical to buildPnpmArgs`,
		);
		// 只有 packageBin + 显式 include 的 tier 才把逐文件列表追加到命令上。
		assert.equal(
			planned.batches[0].fileCount,
			planned.tierConfig.command.type === "packageBin" &&
				planned.tierConfig.include?.length
				? planned.selected.length
				: 0,
			`${cwd} ${tier} must forward exactly the files the tier selects`,
		);
		assert.equal(planned.batches[0].commandLength, commandLineLength(planned.args));
	}

	// 无显式 include 的 tier 传的是裸命令：一个文件参数都不追加。
	const noInclude = planRealTier("packages/maker-core", "unit", {
		platform: "linux",
	});
	assert.equal(noInclude.tierConfig.include, undefined);
	assert.ok(noInclude.selected.length > 0);
	assert.equal(noInclude.batches[0].fileCount, 0);
	assert.deepEqual(noInclude.batches[0].args, noInclude.args);

	// packageScript tier 同理：args 只有 `--dir <abs> run <script>`。
	const scripted = planRealTier("apps/desktop", "db-perf", { platform: "linux" });
	assert.equal(scripted.tierConfig.command.type, "packageScript");
	assert.equal(scripted.batches[0].fileCount, 0);
	assert.deepEqual(scripted.batches[0].args, scripted.args);
});

test("planPnpmArgBatches splits the real desktop db tier only past the win32 budget", () => {
	const win32 = planRealTier("apps/desktop", "db", { platform: "win32" });
	const posix = planRealTier("apps/desktop", "db", { platform: "linux" });

	// 2026-09-24 第三轮上游同步实测：apps/desktop db 有 125 个显式文件、整串约
	// 7.4k 字符。先钉住「确实越过 win32 预算」，否则文件数缩水会让本测试静默失效。
	assert.ok(
		win32.selected.length >= 100,
		"desktop db is the tier with one explicit path per selected file",
	);
	assert.ok(
		commandLineLength(win32.args) > maxInlineCommandLength("win32"),
		"desktop db must exceed the win32 budget for this regression to matter",
	);
	assert.ok(win32.batches.length > 1, "an oversized tier must be split");
	assert.equal(
		posix.batches.length,
		1,
		"the same tier stays on one invocation under the POSIX budget",
	);
	assert.equal(
		JSON.stringify(posix.batches[0].args),
		JSON.stringify(posix.args),
	);

	const expected = win32.selected.map((file) =>
		file.slice("apps/desktop/".length),
	);
	const parts = win32.batches.map((batch) =>
		batchArgParts(batch, win32.tierConfig),
	);
	// (a) 各批文件列表的并集与顺序等于原始选择：不重、不漏、顺序不变。
	assert.deepEqual(parts.flatMap((part) => part.fileArgs), expected);
	assert.equal(new Set(expected).size, expected.length);
	assert.equal(new Set(parts.flatMap((part) => part.fileArgs)).size, expected.length);
	assert.equal(
		win32.batches.reduce((total, batch) => total + batch.fileCount, 0),
		expected.length,
	);

	// (b) 每批都带全部 --exclude；(d) 共享前缀逐字节相同。
	assert.ok(win32.tierConfig.exclude.length >= 1);
	const suffix = win32.tierConfig.exclude.flatMap((pattern) => [
		"--exclude",
		pattern,
	]);
	const prefix = parts[0].prefix;
	for (const [index, batch] of win32.batches.entries()) {
		// (c) 每批都在 win32 预算内（本 tier 每个文件都远小于预算，不存在退化批）。
		assert.ok(
			batch.commandLength <= maxInlineCommandLength("win32"),
			`batch ${index + 1} must fit the win32 budget`,
		);
		assert.equal(batch.commandLength, commandLineLength(batch.args));
		assert.deepEqual(parts[index].prefix, prefix);
		assert.deepEqual(parts[index].suffix, suffix);
	}
	// 贪心装填的紧致性：下一批的首个文件塞不进上一批。
	for (let index = 1; index < win32.batches.length; index += 1) {
		const nextFile = parts[index].fileArgs[0];
		assert.ok(
			win32.batches[index - 1].commandLength + nextFile.length + 1 >
				maxInlineCommandLength("win32"),
			"a batch must be full before the next one starts",
		);
	}

	// 6000 是「pnpm 参数口径」：resolvePnpmInvocation 追加的 node + pnpm.cjs
	// 前缀仍要落在 cmd.exe 的 8191 字符硬上限内。
	const invocation = resolvePnpmInvocation(win32.batches[0].args, {
		execPath: "C:/Program Files/nodejs/node.exe",
		npmExecPath: "C:/Users/dev/AppData/Local/pnpm/pnpm.cjs",
		platform: "win32",
	});
	assert.ok(
		commandLineLength([invocation.command, ...invocation.args]) <
			CMD_EXE_COMMAND_LINE_LIMIT,
	);
});

test("planPnpmArgBatches packs an oversized file list into budget-sized batches", () => {
	const selected = batchFixtureFiles(24);
	const limit = 500;
	const batches = planPnpmArgBatches(
		BATCH_ROOT,
		{ cwd: BATCH_CWD },
		BATCH_COMMAND,
		BATCH_TIER,
		selected,
		undefined,
		{ maxCommandLength: limit },
	);
	const whole = buildPnpmArgs(
		BATCH_ROOT,
		{ cwd: BATCH_CWD },
		BATCH_COMMAND,
		BATCH_TIER,
		selected,
	);
	assert.ok(
		commandLineLength(whole) > limit,
		"the unbudgeted line must exceed the injected budget",
	);
	assert.ok(batches.length > 1, "an over-budget line must be split");
	assert.ok(
		batches.length < selected.length,
		"batches must pack several files each, not one file per batch",
	);

	const expected = batchFixtureRelativeFiles(24);
	const parts = batches.map((batch) => batchArgParts(batch, BATCH_TIER));
	// (a) 并集与顺序等于原始选择：不重、不漏、顺序不变。
	assert.deepEqual(parts.flatMap((part) => part.fileArgs), expected);
	assert.equal(new Set(parts.flatMap((part) => part.fileArgs)).size, expected.length);
	assert.equal(
		batches.reduce((total, batch) => total + batch.fileCount, 0),
		selected.length,
	);
	// (d) 每批的共享前缀逐字节相同。
	for (const part of parts) assert.deepEqual(part.prefix, parts[0].prefix);
	// (b) 每批都带全部 --exclude，且位置不变。
	assert.deepEqual(parts[0].suffix, [
		"--exclude",
		"**/*.integration.test.ts",
		"--exclude",
		"**/*.bench.ts",
	]);
	for (const part of parts) assert.deepEqual(part.suffix, parts[0].suffix);
	for (const [index, batch] of batches.entries()) {
		// (c) 每批的 commandLength ≤ 注入阈值（本用例每批至少装得下一个文件）。
		assert.ok(batch.commandLength <= limit, `batch ${index + 1} must fit ${limit}`);
		assert.equal(batch.commandLength, commandLineLength(batch.args));
		assert.ok(batch.fileCount > 0);
		assert.equal(batch.fileCount, parts[index].fileArgs.length);
	}
	// 贪心装填的紧致性：下一批的首个文件塞不进上一批。
	for (let index = 1; index < batches.length; index += 1) {
		const nextFile = parts[index].fileArgs[0];
		assert.ok(
			batches[index - 1].commandLength + nextFile.length + 1 > limit,
			"a batch must be full before the next one starts",
		);
	}
});

test("planPnpmArgBatches runs a file that cannot fit alone instead of dropping it", () => {
	const selected = batchFixtureFiles(3);
	// 空文件列表的长度就是共享前缀 + 全部 --exclude 的成本；把阈值设成它，
	// 任何一个文件单独都超限（退化情形）。
	const emptyLength = commandLineLength(
		buildPnpmArgs(BATCH_ROOT, { cwd: BATCH_CWD }, BATCH_COMMAND, BATCH_TIER, []),
	);
	const batches = planPnpmArgBatches(
		BATCH_ROOT,
		{ cwd: BATCH_CWD },
		BATCH_COMMAND,
		BATCH_TIER,
		selected,
		undefined,
		{ maxCommandLength: emptyLength },
	);

	// 显式断言退化行为：每个文件各占一批、都超预算、都仍然被跑（宁可大声失败
	// 也不静默丢文件）。
	assert.equal(batches.length, 3);
	assert.deepEqual(
		batches.map((batch) => batch.fileCount),
		[1, 1, 1],
	);
	for (const batch of batches) assert.ok(batch.commandLength > emptyLength);
	assert.deepEqual(
		batches.flatMap((batch) => batchArgParts(batch, BATCH_TIER).fileArgs),
		batchFixtureRelativeFiles(3),
	);
});

test("planPnpmArgBatches never splits a sharded or scripted tier", () => {
	const selected = batchFixtureFiles(24);
	const partial = { cwd: BATCH_CWD };

	// `--shard=i/n` 自己就切分文件列表：逐批重复会跑到与请求不同的子集，
	// 因此带 --shard 的 tier 即使超限也必须恰好 1 批。
	const sharded = {
		type: "packageBin",
		bin: "vitest",
		args: ["run", "--shard=1/2"],
	};
	const batches = planPnpmArgBatches(
		BATCH_ROOT,
		partial,
		sharded,
		BATCH_TIER,
		selected,
		undefined,
		{ maxCommandLength: 200 },
	);
	assert.equal(batches.length, 1, "a sharded tier must stay on one invocation");
	assert.deepEqual(
		batches[0].args,
		buildPnpmArgs(BATCH_ROOT, partial, sharded, BATCH_TIER, selected),
	);
	assert.equal(batches[0].fileCount, selected.length);
	assert.ok(batches[0].commandLength > 200);
	assert.equal(
		batches[0].args.filter((arg) => arg.startsWith("--shard")).length,
		1,
	);
	assert.equal(batches[0].args.includes("--shard=1/2"), true);

	// undersized shard 的 `--passWithNoTests` 兼容标志不改变「不分块」。
	const undersized = planPnpmArgBatches(
		BATCH_ROOT,
		partial,
		sharded,
		BATCH_TIER,
		selected.slice(0, 1),
		undefined,
		{ maxCommandLength: 1 },
	);
	assert.equal(undersized.length, 1);
	assert.equal(undersized[0].args.includes("--passWithNoTests"), true);

	// packageScript tier 没有逐文件列表，永远 1 批。
	const scripted = { type: "packageScript", script: "test" };
	const scriptedBatches = planPnpmArgBatches(
		BATCH_ROOT,
		partial,
		scripted,
		BATCH_TIER,
		selected,
		undefined,
		{ maxCommandLength: 1 },
	);
	assert.equal(scriptedBatches.length, 1);
	assert.deepEqual(
		scriptedBatches[0].args,
		buildPnpmArgs(BATCH_ROOT, partial, scripted, BATCH_TIER, selected),
	);
	assert.deepEqual(scriptedBatches[0].args.slice(-2), ["run", "test"]);
});

test("planPnpmArgBatches batches the related-mode source list the same way", () => {
	const selected = batchFixtureFiles(24);
	const relatedFiles = Array.from(
		{ length: 30 },
		(_, index) => `${BATCH_CWD}/src/mod-${String(index).padStart(3, "0")}.ts`,
	);
	const partial = { cwd: BATCH_CWD };
	const limit = 500;
	const whole = buildPnpmArgs(
		BATCH_ROOT,
		partial,
		BATCH_COMMAND,
		BATCH_TIER,
		selected,
		relatedFiles,
	);
	assert.ok(commandLineLength(whole) > limit);
	const batches = planPnpmArgBatches(
		BATCH_ROOT,
		partial,
		BATCH_COMMAND,
		BATCH_TIER,
		selected,
		relatedFiles,
		{ maxCommandLength: limit },
	);
	assert.ok(batches.length > 1);

	const parts = batches.map((batch) => batchArgParts(batch, BATCH_TIER));
	// related 模式切分的是相关源码列表，而不是逐文件 include 的测试文件列表。
	const relatedRelative = relatedFiles.map((file) =>
		file.slice(`${BATCH_CWD}/`.length),
	);
	assert.deepEqual(parts.flatMap((part) => part.fileArgs), relatedRelative);
	assert.equal(new Set(parts.flatMap((part) => part.fileArgs)).size, relatedFiles.length);
	for (const [index, batch] of batches.entries()) {
		assert.ok(batch.commandLength <= limit);
		assert.deepEqual(parts[index].prefix, parts[0].prefix);
		assert.deepEqual(parts[index].suffix, parts[0].suffix);
	}
	// `related --run` 与 `--passWithNoTests` 属于共享前缀，每批各出现一次。
	assert.equal(parts[0].prefix.filter((arg) => arg === "related").length, 1);
	assert.equal(parts[0].prefix.includes("--run"), true);
	assert.equal(
		parts[0].prefix.filter((arg) => arg === "--passWithNoTests").length,
		1,
	);
	assert.equal(
		parts
			.flatMap((part) => part.fileArgs)
			.some((arg) => arg.startsWith("src/__tests__/")),
		false,
	);
});

// 足够多的显式路径，连 POSIX 预算（120k）都能越过：每个相对路径
// `src/__tests__/batch-0000.test.ts` 加分隔符只花 33 字符。
function oversizedBatchFixtureFiles() {
	const count = Math.ceil((maxInlineCommandLength() * 2) / 32) + 4;
	return batchFixtureFiles(count);
}

test("runPlannedTests keeps running batches after one fails and aggregates the tier verdict", async () => {
	const allFiles = oversizedBatchFixtureFiles();
	const selected = selectFilesForTier(BATCH_WORKSPACE, BATCH_TIER, allFiles);
	const planned = planPnpmArgBatches(
		BATCH_ROOT,
		BATCH_WORKSPACE,
		BATCH_COMMAND,
		BATCH_TIER,
		selected,
	);
	assert.ok(planned.length > 1, "fixture must force more than one batch");

	const calls = [];
	const writes = [];
	const result = await runPlannedTests({
		root: BATCH_ROOT,
		workspaceCwds: [BATCH_CWD],
		allFiles,
		manifest: { workspaces: [BATCH_WORKSPACE] },
		tier: "unit",
		reporter: createWorkspaceRunReporter({
			stdout: { write: (chunk) => writes.push(String(chunk)) },
			now: () => 0,
		}),
		runCommandImpl: async (command, args) => {
			const ordinal = calls.length + 1;
			calls.push({ command, args, ordinal });
			// 第 2 批失败、第 1 批成功：失败批不能中断后面的批次。
			return ordinal === 2
				? { exitCode: 2, output: "FAIL expected 2 != 1\n" }
				: { exitCode: 0, output: `PASS batch ${ordinal}\n` };
		},
	});

	assert.ok(calls.length > 1);
	assert.equal(calls.length, planned.length, "every batch must be invoked");
	assert.equal(calls.at(-1).ordinal, planned.length);
	assert.equal(
		new Set(calls.map((call) => call.args.join("\u0000"))).size,
		planned.length,
		"each batch must carry its own file list",
	);
	assert.equal(result.length, 1);
	assert.equal(result[0].chunks, planned.length);
	// 任一失败 ⇒ tier 失败，分类沿用单批时的同一套规则。
	assert.equal(result[0].exitCode, 2);
	assert.equal(result[0].failure, "TEST_ASSERTION_FAILED");

	// 聚合输出的每块都带 chunk i/n 表头与块长度，失败块可定位。
	for (const [index, batch] of planned.entries()) {
		const exit = index === 1 ? 2 : 0;
		assert.ok(
			result[0].output.includes(
				`[chunk ${index + 1}/${planned.length}] ${BATCH_CWD} unit ` +
					`${batch.fileCount} files, ${batch.commandLength} chars, exit ${exit}`,
			),
			`aggregated output must label chunk ${index + 1}`,
		);
	}

	// reporter 在多批时逐块打印 CHUNK i/n（块间分隔 + 块长度）。
	const log = writes.join("");
	for (const [index, batch] of planned.entries()) {
		assert.ok(
			log.includes(
				`CHUNK ${index + 1}/${planned.length} ${BATCH_CWD} unit test ` +
					`(${batch.fileCount} files, ${batch.commandLength} chars)`,
			),
			`reporter must announce chunk ${index + 1}`,
		);
	}
	assert.match(log, /FAIL TEST_ASSERTION_FAILED packages\/batch unit \(/);

	// printSummary 在多批时打印 chunks: N。
	const logs = [];
	const originalLog = console.log;
	console.log = (message) => logs.push(message);
	try {
		printSummary(result, { workspaces: [BATCH_WORKSPACE] });
	} finally {
		console.log = originalLog;
	}
	assert.match(
		logs.join("\n"),
		new RegExp(`chunks: ${planned.length} sequential invocations`),
	);
});

test("runPlannedTests leaves a single batch output byte for byte", async () => {
	const allFiles = batchFixtureFiles(3);
	const rawOutput = "PASS  3 files, spacing kept\ttab and no extra newline";
	const writes = [];
	const result = await runPlannedTests({
		root: BATCH_ROOT,
		workspaceCwds: [BATCH_CWD],
		allFiles,
		manifest: { workspaces: [BATCH_WORKSPACE] },
		tier: "unit",
		reporter: createWorkspaceRunReporter({
			stdout: { write: (chunk) => writes.push(String(chunk)) },
			now: () => 0,
		}),
		runCommandImpl: async () => ({ exitCode: 0, output: rawOutput }),
	});

	assert.equal(result.length, 1);
	assert.equal(result[0].chunks, 1);
	// 单批时聚合 output 与命令原始 output 逐字节相同（含空白、制表符与行尾）。
	assert.equal(result[0].output, rawOutput);
	assert.equal(writes.join("").includes("CHUNK "), false);

	const logs = [];
	const originalLog = console.log;
	console.log = (message) => logs.push(message);
	try {
		printSummary(result, { workspaces: [BATCH_WORKSPACE] });
	} finally {
		console.log = originalLog;
	}
	assert.doesNotMatch(logs.join("\n"), /chunks:/);
});
