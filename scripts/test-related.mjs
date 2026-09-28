import fs from "node:fs";
import path from "node:path";

const WIDE_ROOT_FILES = new Set([
	"package.json",
	"pnpm-lock.yaml",
	"pnpm-workspace.yaml",
	"scripts/test-workspaces.mjs",
	"scripts/test-workspaces.config.mjs",
	"scripts/test-related.mjs",
	"scripts/test-gate-lock.mjs",
]);
const SKIP_EXTENSIONS = new Set([
	".md",
	".markdown",
	".txt",
	".rst",
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
	".svg",
	".ico",
	".bmp",
	".mp4",
	".webm",
	".mov",
	".mp3",
	".wav",
	".ogg",
	".woff",
	".woff2",
	".ttf",
	".otf",
	".eot",
	".pdf",
]);
const SKIP_BASENAMES = new Set([
	"LICENSE",
	"LICENSE.txt",
	"DCO",
	"NOTICE",
	"NOTICE.txt",
	".gitignore",
	".gitattributes",
	".editorconfig",
	".npmrc",
	".prettierignore",
	".eslintignore",
]);
// Meka 侧口径（不可丢）：related 测试的基线是**产品集成分支**，不是 GitHub 上
// 叫 "main" 的那个。在本私有 fork 里 origin/main 是上游 Cindy 的同步目标，用它当
// 基线会把整个 Meka 产品增量（lockfile、package.json、vitest 配置、CI）当成「本次
// 改动」并静默退回全量门禁。所以 meka/main 派生的 ref 排在最前：先远端产品分支
// （未推送的本地提交也算进来），再本地 meka/main。
//
// 上游口径（保留）：fork 的 origin 可能落后于贡献目标，所以 upstream 远端默认分支
// 和 origin 自己的 HEAD 先于 origin/main 试；本地 main/master 只作为最后兜底，供
// 没有 meka ref 的上游 Cindy checkout 使用。
export const GIT_BASE_REFS = [
	"origin/meka/main",
	"meka/main",
	"refs/remotes/upstream/HEAD", "upstream/main", "upstream/master",
	"refs/remotes/origin/HEAD", "origin/main", "origin/master", "main", "master",
];

export function normalizeRelPath(value) {
	return String(value).replace(/\\/g, "/");
}

export function isTestFile(file) {
	return /\.(test|spec)\.[cm]?[jt]sx?$/.test(normalizeRelPath(file));
}

export function isSkippableFile(file) {
	const normalized = normalizeRelPath(file);
	const basename = normalized.split("/").pop() ?? normalized;
	if (SKIP_BASENAMES.has(basename)) return true;
	const extension = path.posix.extname(basename).toLowerCase();
	return SKIP_EXTENSIONS.has(extension);
}

// Meka 侧口径（不可丢，刻意偏离上游）：`.github/workflows/**` 是**单测 CI 本身**。
// meka/main 是直推集成分支，唯一自动化门禁是 ci.yml 的 push 触发，没有 PR 阶段的
// CI 兜底，所以「改到单测 CI ⇒ 退回全量 pnpm test:unit」必须由调度器自己兜住
// （见根 AGENTS.md「提交前测试门禁（硬性要求）」的保留 Meka 口径注记）。
// 上游本轮把该行删掉、只留 WIDE_ROOT_FILES + 根 vitest.config.*，那是 PR-first +
// PR CI 兜底的口径；同时上游新增的「包级 package.json / 包级 vitest.config ⇒ 该包
// 整包全跑」由 planRelatedUnitTests 的 fullWorkspaces 承担，与本案并存互不冲突
// （包级清单不再 wide，但仍不会漏跑）。
export function isWideFile(file) {
	const normalized = normalizeRelPath(file);
	if (WIDE_ROOT_FILES.has(normalized)) return true;
	if (normalized.startsWith(".github/workflows/")) return true;
	return /^vitest\.config\.[cm]?[jt]s$/.test(normalized);
}

export function shouldRunTestRunner(files) {
	return files.some((file) => {
		const normalized = normalizeRelPath(file);
		// These text artifacts are executable test inputs, not explanatory docs:
		// glossary-rules and third-party-notices validate their generated content.
		if (
			normalized === "i18n/GLOSSARY.md" ||
			normalized.startsWith("docs/legal/notices/")
		) return true;
		return (
			!isSkippableFile(normalized) &&
			!normalized.startsWith("apps/") && !normalized.startsWith("packages/")
		);
	});
}

export function workspaceForFile(file, workspaceCwds) {
	const normalized = normalizeRelPath(file);
	return workspaceCwds
		.map(normalizeRelPath)
		.filter(
			(cwd) => normalized === cwd || normalized.startsWith(`${cwd}/`),
		)
		.sort((left, right) => right.length - left.length)[0];
}

function isPackagePublicSource(file) {
	const normalized = normalizeRelPath(file);
	if (isTestFile(normalized)) return false;
	return !(
		normalized.includes("/__tests__/") || normalized.includes("/__mocks__/")
	);
}

function isWorkspaceDependency(version) {
	return typeof version === "string" && version.startsWith("workspace:");
}

export function buildDependentMap(workspaces, packageJsonByCwd) {
	const nameToCwd = new Map();
	for (const workspace of workspaces) {
		nameToCwd.set(workspace.name, normalizeRelPath(workspace.cwd));
	}
	for (const [cwd, pkg] of Object.entries(packageJsonByCwd)) {
		if (pkg?.name) nameToCwd.set(pkg.name, normalizeRelPath(cwd));
	}

	const dependents = new Map();
	for (const workspace of workspaces) {
		dependents.set(normalizeRelPath(workspace.cwd), new Set());
	}

	for (const workspace of workspaces) {
		const cwd = normalizeRelPath(workspace.cwd);
		const pkg =
			packageJsonByCwd[cwd] ?? packageJsonByCwd[workspace.cwd] ?? null;
		if (!pkg) continue;
		const entries = [
			...Object.entries(pkg.dependencies ?? {}),
			...Object.entries(pkg.devDependencies ?? {}),
			...Object.entries(pkg.peerDependencies ?? {}),
		];
		for (const [depName, version] of entries) {
			if (!isWorkspaceDependency(version)) continue;
			const producer = nameToCwd.get(depName);
			if (!producer || producer === cwd) continue;
			if (!dependents.has(producer)) dependents.set(producer, new Set());
			dependents.get(producer).add(cwd);
		}
	}
	return dependents;
}

export function collectTransitiveDependents(startCwds, dependentMap) {
	const result = new Set();
	const queue = startCwds.map(normalizeRelPath);
	while (queue.length > 0) {
		const cwd = queue.pop();
		for (const dependent of dependentMap.get(cwd) ?? []) {
			if (result.has(dependent)) continue;
			result.add(dependent);
			queue.push(dependent);
		}
	}
	return result;
}

export function resolveGitBaseRef(runGit) {
	for (const ref of GIT_BASE_REFS) {
		try {
			runGit(["rev-parse", "--verify", ref]);
			return ref;
		} catch {
			// try the next conventional main-branch name
		}
	}
	return null;
}

function addGitNames(files, output) {
	for (const line of String(output).split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed) files.add(normalizeRelPath(trimmed));
	}
}

export function collectChangedFiles(runGit) {
	try {
		const baseRef = resolveGitBaseRef(runGit);
		if (!baseRef) {
			return {
				files: [],
				base: null,
				baseRef: null,
				error: "cannot resolve git base against meka/main or main",
			};
		}
		const mergeBase = String(runGit(["merge-base", "HEAD", baseRef])).trim();
		if (!mergeBase) {
			return {
				files: [],
				base: null,
				baseRef,
				error: `cannot compute merge-base with ${baseRef}`,
			};
		}
		const files = new Set();
		addGitNames(files, runGit(["diff", "--name-only", mergeBase, "HEAD"]));
		addGitNames(files, runGit(["diff", "--name-only", "--cached"]));
		addGitNames(files, runGit(["diff", "--name-only"]));
		addGitNames(files, runGit(["ls-files", "--others", "--exclude-standard"]));
		return {
			files: [...files].sort(),
			base: mergeBase,
			baseRef,
		};
	} catch (error) {
		return {
			files: [],
			base: null,
			baseRef: null,
			error: error?.message ?? "git changed-file collection failed",
		};
	}
}

function hasRequiredUnitTier(workspace) {
	const unit = workspace.tiers?.unit;
	return unit?.status === "required";
}

function describeRelatedRuns(runs) {
	if (runs.length === 0) return "no workspace unit tests";
	return runs
		.map((run) =>
			Array.isArray(run.relatedFiles)
				? `${run.cwd} (related ${run.relatedFiles.length})`
				: `${run.cwd} (full)`,
		)
		.join(", ");
}

export function planRelatedUnitTests({
	changedFiles,
	workspaces,
	packageJsonByCwd,
	fileExists = () => true,
	baseRef,
}) {
	const files = (changedFiles ?? []).map(normalizeRelPath);
	const vsLabel = baseRef ?? "integration branch";
	if (files.length === 0) {
		return {
			mode: "skip",
			reason: `no changes vs ${vsLabel}`,
			runTestRunner: false,
			runs: [],
		};
	}

	const wide = files.filter(isWideFile);
	if (wide.length > 0) {
		const preview = wide.slice(0, 5).join(", ");
		const extra = wide.length > 5 ? "…" : "";
		return {
			mode: "full",
			reason: `wide files changed: ${preview}${extra}`,
			runTestRunner: true,
			runs: [],
		};
	}

	const runTestRunner = shouldRunTestRunner(files);
	const testable = files.filter((file) => !isSkippableFile(file));
	if (testable.length === 0) {
		return {
			mode: runTestRunner ? "related" : "skip",
			reason: runTestRunner
				? "only non-code files changed; run root test:runner"
				: "only non-code files changed",
			runTestRunner,
			runs: [],
		};
	}

	const workspaceCwds = workspaces.map((workspace) =>
		normalizeRelPath(workspace.cwd),
	);
	const byCwd = new Map(
		workspaces.map((workspace) => [
			normalizeRelPath(workspace.cwd),
			workspace,
		]),
	);
	const ownerRelated = new Map();
	const sourceChangedCwds = new Set();
	const fullWorkspaces = new Set();

	for (const file of testable) {
		const cwd = workspaceForFile(file, workspaceCwds);
		if (!cwd) continue;
		const workspace = byCwd.get(cwd);
		if (!workspace || !hasRequiredUnitTier(workspace)) continue;
		if (!ownerRelated.has(cwd)) ownerRelated.set(cwd, new Set());
		if (fileExists(file)) ownerRelated.get(cwd).add(file);
		if (
			file === `${cwd}/package.json` ||
			/(^|\/)vitest\.config\.[cm]?[jt]s$/.test(file.slice(cwd.length + 1)) ||
			!fileExists(file)
		) fullWorkspaces.add(cwd);
		if (isPackagePublicSource(file)) sourceChangedCwds.add(cwd);
	}

	const dependents = collectTransitiveDependents(
		[...sourceChangedCwds],
		buildDependentMap(workspaces, packageJsonByCwd),
	);
	const runCwds = new Set([...ownerRelated.keys(), ...dependents]);
	const runs = [...runCwds]
		.sort()
		.flatMap((cwd) => {
			const workspace = byCwd.get(cwd);
			if (!workspace || !hasRequiredUnitTier(workspace)) return [];
			const ownFiles = [...(ownerRelated.get(cwd) ?? [])].sort();
			const relatedFiles = dependents.has(cwd) || fullWorkspaces.has(cwd)
				? null : ownFiles;
			if (Array.isArray(relatedFiles) && relatedFiles.length === 0) return [];
			return [
				{
					cwd,
					name: workspace.name,
					relatedFiles,
				},
			];
		});

	if (runs.length === 0 && !runTestRunner) {
		return {
			mode: "skip",
			reason: "no related unit tests",
			runTestRunner: false,
			runs: [],
		};
	}

	return {
		mode: "related",
		reason: describeRelatedRuns(runs),
		runTestRunner,
		runs,
	};
}

export function readWorkspacePackages(
	root,
	workspaces,
	readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8")),
) {
	const result = {};
	for (const workspace of workspaces) {
		const cwd = normalizeRelPath(workspace.cwd);
		try {
			result[cwd] = readJson(path.join(root, ...cwd.split("/"), "package.json"));
		} catch {
			result[cwd] = null;
		}
	}
	return result;
}

export function createRelatedUnitPlan({
	root,
	manifest,
	runGit,
	readJson,
	fileExists,
}) {
	const collected = collectChangedFiles(runGit);
	if (collected.error) {
		return {
			mode: "full",
			reason: collected.error,
			runTestRunner: true,
			runs: [],
			baseRef: collected.baseRef ?? null,
			base: collected.base ?? null,
		};
	}
	return {
		...planRelatedUnitTests({
			changedFiles: collected.files,
			workspaces: manifest.workspaces,
			packageJsonByCwd: readWorkspacePackages(
				root,
				manifest.workspaces,
				readJson,
			),
			fileExists:
				fileExists ??
				((file) =>
					fs.existsSync(
						path.join(root, ...normalizeRelPath(file).split("/")),
					)),
			baseRef: collected.baseRef,
		}),
		baseRef: collected.baseRef,
		base: collected.base,
	};
}
