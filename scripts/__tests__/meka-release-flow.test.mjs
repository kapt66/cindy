import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertPublishVersionOrder,
  buildCanaryManifest,
  buildPublishedEndpointManifest,
  canaryBackupKey,
  compareReleaseVersions,
  putImmutableArtifact,
  sha256File,
  validateBuildInfo,
  validateManifestForPlatform,
} from "../../apps/desktop/scripts/ci/release-lib.mjs";
import {
  contentTypeForReleaseFile,
  MekaReleaseStorage,
  normalizeReleaseObjectKey,
} from "../../apps/desktop/scripts/ci/release-storage.mjs";
import {
  assertMekaReleaseTargetIsolation,
  validateMekaReleaseCdnBaseUrl,
  validateMekaS3Endpoint,
  validateReleaseRegions,
} from "../../apps/desktop/scripts/ci/release-regions.mjs";
import {
  packageArgsForShortcut,
  parsePromoteShortcutArgs,
  parseReleaseShortcutArgs,
  parseResetCanaryShortcutArgs,
  promoteArgsForShortcut,
  publishArgsForShortcut,
  resetCanaryArgsForShortcut,
  targetArchs,
} from "../../apps/desktop/scripts/ci/release-shortcut-lib.mjs";
import {
  assertArtifactsUnreferenced,
  resetCanaryArtifactCandidates,
  resetCanaryArtifactKeys,
} from "../../apps/desktop/scripts/ci/reset-canary-lib.mjs";
import {
  assertRuntimeManifestAssets,
  collectLocalRuntimeAssets,
  publishRuntimeAssets,
} from "../../apps/desktop/scripts/ci/runtime-release.mjs";

function makeRegions() {
  return Object.fromEntries(
    ["cn", "global", "dev"].map((region) => [
      region,
      {
        oss: {
          cdnBaseUrl: `https://cdn.example.com/${region}/cindy-meka`,
          bucket: `cindy-meka-${region}`,
          prefix: "cindy-meka",
          ossRegion: "us-east-1",
        },
        s3: {
          endpoint: "https://rustfs.example.com",
          forcePathStyle: true,
          accessKeyIdEnv: "CINDY_MEKA_RUSTFS_ACCESS_KEY_ID",
          secretAccessKeyEnv: "CINDY_MEKA_RUSTFS_SECRET_ACCESS_KEY",
          sessionTokenEnv: "",
        },
      },
    ]),
  );
}

function makeBuildInfo(root, overrides = {}) {
  const installer = path.join(root, "cindy-meka-1.2.3-Setup.exe");
  const hotfix = path.join(root, "cindy-meka-1.2.3.zip");
  fs.writeFileSync(installer, "signed-installer");
  fs.writeFileSync(hotfix, "signed-hotfix");
  const entry = (role, filePath) => ({
    role,
    name: path.basename(filePath),
    sha256: sha256File(filePath),
    size: fs.statSync(filePath).size,
  });
  const buildInfo = {
    schemaVersion: 2,
    product: "cindy-meka-desktop",
    version: "1.2.3",
    versionless: false,
    region: "cn",
    platform: "win32",
    arch: "x64",
    platformKey: "win32-x64",
    files: [entry("installer", installer), entry("hotfix", hotfix)],
    signing: { installerSigned: true, internalExesSigned: true },
    ...overrides,
  };
  const buildInfoPath = path.join(root, "build-info.json");
  fs.writeFileSync(buildInfoPath, `${JSON.stringify(buildInfo, null, 2)}\n`);
  return buildInfoPath;
}

test("fixed CN release shortcuts cover Windows and both macOS architectures", () => {
  const win = parseReleaseShortcutArgs([
    "--platform",
    "win32",
    "--arch",
    "x64",
    "patch",
  ]);
  assert.deepEqual(packageArgsForShortcut(win), [
    "--platform",
    "win32",
    "--region",
    "cn",
    "--version",
    "patch",
    "--arch",
    "x64",
  ]);
  assert.deepEqual(targetArchs("darwin"), ["arm64", "x64"]);
  assert.deepEqual(targetArchs("darwin", "x64"), ["x64"]);

  const mac = parseReleaseShortcutArgs([
    "--platform",
    "darwin",
    "1.2.3",
    "--release-notes-file",
    "notes.txt",
    "--require-relogin",
  ]);
  assert.equal(mac.versionSpec, "1.2.3");
  assert.equal(mac.requireRelogin, true);
  assert.deepEqual(
    publishArgsForShortcut("build-info.json", mac, { execute: true }).slice(-2),
    ["--require-relogin", "--execute"],
  );
  assert.throws(
    () => parseReleaseShortcutArgs(["--platform", "win32", "--arch", "x64"]),
    /必须提供版本号/,
  );
});

test("fixed promotion shortcuts preview by default and require --yes for writes", () => {
  const preview = parsePromoteShortcutArgs([
    "--platform",
    "darwin",
    "--arch",
    "arm64",
  ]);
  assert.equal(preview.yes, false);
  assert.deepEqual(promoteArgsForShortcut("darwin", "arm64"), [
    "--region",
    "cn",
    "--platform",
    "darwin",
    "--arch",
    "arm64",
  ]);

  const execute = parsePromoteShortcutArgs([
    "--platform",
    "win32",
    "--arch",
    "x64",
    "--",
    "--yes",
  ]);
  assert.equal(execute.yes, true);
  assert.equal(
    promoteArgsForShortcut("win32", "x64", { yes: true }).at(-1),
    "--yes",
  );
});

test("canary reset shortcuts preview by default and require only --yes for writes", () => {
  const preview = parseResetCanaryShortcutArgs([
    "--platform",
    "win32",
    "--arch",
    "x64",
  ]);
  assert.equal(preview.yes, false);
  assert.deepEqual(
    resetCanaryArgsForShortcut("win32", "x64", {
      yes: true,
    }),
    ["--region", "cn", "--platform", "win32", "--arch", "x64", "--yes"],
  );
  assert.throws(
    () =>
      parseResetCanaryShortcutArgs([
        "--platform",
        "win32",
        "--arch",
        "x64",
        "--unknown",
      ]),
    /未知参数/,
  );
});

test("canary reset discovers only standard app and hotfix objects newer than stable", () => {
  const windows = resetCanaryArtifactKeys("win32", "x64", "0.0.4");
  assert.deepEqual(windows, [
    "app/win32-x64/cindy-meka-0.0.4-Setup.exe",
    "hotfix/win32-x64/cindy-meka-0.0.4.zip",
  ]);
  assert.deepEqual(resetCanaryArtifactKeys("darwin", "arm64", "1.2.3"), [
    "app/darwin-arm64/cindy-meka-1.2.3-arm64.dmg",
    "hotfix/darwin-arm64/cindy-meka-1.2.3-arm64.zip",
  ]);

  assert.deepEqual(
    resetCanaryArtifactCandidates("win32", "x64", "0.0.3", [
      "app/win32-x64/cindy-meka-0.0.3-Setup.exe",
      ...windows,
      "app/win32-x64/cindy-meka-0.0.5-Setup.exe.bak",
      "claude-code/2.1.219/win32-x64/claude.exe",
      "hotfix/darwin-arm64/cindy-meka-0.0.5-arm64.zip",
    ]),
    windows,
  );
  assert.throws(
    () =>
      assertArtifactsUnreferenced(windows, [
        {
          app: {
            installer: { file: windows[0] },
            hotfix: { file: windows[1] },
          },
        },
      ]),
    /仍被 reset 后的 manifest 引用/,
  );
  assert.doesNotThrow(() =>
    assertArtifactsUnreferenced(windows, [
      {
        app: {
          installer: {
            file: "app/win32-x64/cindy-meka-0.0.3-Setup.exe",
          },
          hotfix: { file: "hotfix/win32-x64/cindy-meka-0.0.3.zip" },
        },
      },
    ]),
  );
});

test("release storage deletes within its configured prefix", async () => {
  const commands = [];
  const storage = new MekaReleaseStorage(
    { bucket: "releases", prefix: "cindy-meka" },
    {
      async send(command) {
        commands.push(command);
      },
    },
  );

  await storage.deleteObject("app/win32-x64/cindy-meka-0.0.4-Setup.exe");
  assert.deepEqual(commands[0].input, {
    Bucket: "releases",
    Key: "cindy-meka/app/win32-x64/cindy-meka-0.0.4-Setup.exe",
  });
});

test("release storage lists paginated keys within its configured prefix", async () => {
  const commands = [];
  const responses = [
    {
      Contents: [{ Key: "cindy-meka/app/win32-x64/first.exe" }],
      IsTruncated: true,
      NextContinuationToken: "next-page",
    },
    {
      Contents: [{ Key: "cindy-meka/app/win32-x64/second.exe" }],
      IsTruncated: false,
    },
  ];
  const storage = new MekaReleaseStorage(
    { bucket: "releases", prefix: "cindy-meka" },
    {
      async send(command) {
        commands.push(command);
        return responses.shift();
      },
    },
  );

  assert.deepEqual(await storage.listKeys("app/win32-x64"), [
    "app/win32-x64/first.exe",
    "app/win32-x64/second.exe",
  ]);
  assert.equal(commands[0].input.Prefix, "cindy-meka/app/win32-x64");
  assert.equal(commands[1].input.ContinuationToken, "next-page");

  const malformedStorage = new MekaReleaseStorage(
    { bucket: "releases", prefix: "cindy-meka" },
    {
      async send() {
        return { IsTruncated: true };
      },
    },
  );
  await assert.rejects(
    () => malformedStorage.listKeys("app/win32-x64"),
    /缺少 continuation token/,
  );
});

test("root and desktop package scripts expose the restored release shortcuts", () => {
  const rootPackage = JSON.parse(
    fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  );
  const desktopPackage = JSON.parse(
    fs.readFileSync(
      new URL("../../apps/desktop/package.json", import.meta.url),
      "utf8",
    ),
  );
  for (const name of [
    "release:win",
    "release:mac",
    "release:mac:arm64",
    "release:mac:x64",
    "release:promote:win",
    "release:promote:mac",
    "release:promote:mac:arm64",
    "release:promote:mac:x64",
    "release:reset-canary:win",
    "release:reset-canary:mac",
    "release:reset-canary:mac:arm64",
    "release:reset-canary:mac:x64",
  ]) {
    assert.equal(typeof rootPackage.scripts[name], "string", name);
    assert.equal(typeof desktopPackage.scripts[name], "string", name);
  }
});

test("canary reset backups are immutable and content-addressed", () => {
  const first = canaryBackupKey(
    "win32-x64",
    "1.2.3",
    '{"app":{"version":"1.2.3"}}\n',
  );
  const second = canaryBackupKey(
    "win32-x64",
    "1.2.3",
    '{"app":{"version":"1.2.3","releaseNotes":"changed"}}\n',
  );
  assert.match(
    first,
    /^back-up\/canary\/1\.2\.3\/[a-f0-9]{64}\/manifest-win32-x64\.json$/,
  );
  assert.notEqual(first, second);
  assert.throws(
    () => canaryBackupKey("linux-x64", "1.2.3", "{}"),
    /非法 platformKey/,
  );
});

test("first release publishes every runtime asset into the manifest", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cindy-meka-runtimes-"));
  try {
    for (const [dir, binary] of [
      ["claude-code-bin", "claude.exe"],
      ["codex-bin", "codex.exe"],
      ["ripgrep-bin", "rg.exe"],
    ]) {
      const target = path.join(root, "apps", dir, "win32-x64");
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, ".version"), "1.2.3\n");
      fs.writeFileSync(path.join(target, binary), Buffer.alloc(2048, dir));
    }
    const local = collectLocalRuntimeAssets("win32-x64", { projectRoot: root });
    const objects = new Map();
    const storage = {
      async head(key) {
        return objects.get(key) ?? null;
      },
      async putFile(key, filePath, options) {
        objects.set(key, {
          size: fs.statSync(filePath).size,
          metadata: options.metadata,
        });
      },
    };
    const published = await publishRuntimeAssets(
      storage,
      local,
      null,
      path.join(root, "out"),
    );
    const manifest = {
      app: {
        version: "0.0.1",
        hotfix: {
          file: "hotfix/win32-x64/cindy-meka-0.0.1.zip",
          sha256: "a".repeat(64),
          size: 1,
        },
        installer: {
          file: "app/win32-x64/cindy-meka-0.0.1-Setup.exe",
          sha256: "b".repeat(64),
          size: 1,
        },
      },
      ...published.manifestAssets,
    };
    assertRuntimeManifestAssets(manifest, "win32-x64");
    assert.equal(published.results.claudeCode, "uploaded");
    assert.equal(published.results.codex, "uploaded");
    assert.equal(published.results.ripgrep, "uploaded");
    assert.match(manifest.claudeCode.file, /claude-code\/1\.2\.3\/win32-x64/);
    assert.match(manifest.codex.file, /codex\/1\.2\.3\/win32-x64/);
    assert.match(manifest.ripgrep.file, /ripgrep\/1\.2\.3\/win32-x64/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runtime manifest guard rejects a first release without agent assets", () => {
  assert.throws(
    () => assertRuntimeManifestAssets({ app: {} }, "win32-x64"),
    /claudeCode/,
  );
});

test("runtime manifest guard can read legacy manifests without ripgrep", () => {
  assert.doesNotThrow(() =>
    assertRuntimeManifestAssets(
      {
        app: {},
        claudeCode: {
          version: "1.2.3",
          file: "claude-code/1.2.3/win32-x64/claude.exe.gz",
          sha256: "a".repeat(64),
          size: 1,
        },
        codex: {
          version: "1.2.3",
          file: "codex/1.2.3/win32-x64/codex.exe.gz",
          sha256: "b".repeat(64),
          size: 1,
        },
      },
      "win32-x64",
      { allowMissing: ["ripgrep"] },
    ),
  );
});

test("canary manifest records every published runtime asset", () => {
  const runtimeAsset = (root, binary) => ({
    version: "1.2.3",
    file: `${root}/1.2.3/win32-x64/${binary}.gz`,
    sha256: "a".repeat(64),
    size: 123,
    binarySha256: "b".repeat(64),
  });
  const runtimeAssets = {
    claudeCode: runtimeAsset("claude-code", "claude.exe"),
    codex: runtimeAsset("codex", "codex.exe"),
    ripgrep: runtimeAsset("ripgrep", "rg.exe"),
  };
  const manifest = buildCanaryManifest(
    {
      app: { version: "1.2.2" },
    },
    {
      version: "1.2.3",
      platformKey: "win32-x64",
      installer: {
        name: "cindy-meka-1.2.3-Setup.exe",
        sha256: "c".repeat(64),
        size: 1,
      },
      hotfix: { name: "cindy-meka-1.2.3.zip", sha256: "d".repeat(64), size: 1 },
    },
    { runtimeAssets },
  );

  assert.deepEqual(manifest.claudeCode, runtimeAssets.claudeCode);
  assert.deepEqual(manifest.codex, runtimeAssets.codex);
  assert.deepEqual(manifest.ripgrep, runtimeAssets.ripgrep);
});

test("published endpoint manifest keeps CN services but does not inherit Cindy updates", () => {
  const published = JSON.parse(
    buildPublishedEndpointManifest(
      JSON.stringify({
        schemaVersion: 1,
        authApiBaseUrl: "https://auth.cindy.com.cn",
        pluginApiBaseUrl: "https://plugin.cindy.com.cn",
        cdnBaseUrl: "https://hotfix.cindy.com.cn/cindy",
      }),
    ),
  );
  assert.equal(published.authApiBaseUrl, "https://auth.cindy.com.cn");
  assert.equal(published.pluginApiBaseUrl, "https://plugin.cindy.com.cn");
  assert.equal(published.cdnBaseUrl, "");
});

test("RustFS release config keeps non-secret target data separate from credential env names", () => {
  const config = validateReleaseRegions(makeRegions());
  assert.equal(config.cn.oss.bucket, "cindy-meka-cn");
  assert.equal(config.cn.oss.prefix, "cindy-meka");
  assert.equal(config.cn.s3.endpoint, "https://rustfs.example.com");
  assert.equal(config.cn.s3.forcePathStyle, true);
  assert.equal(
    config.cn.s3.secretAccessKeyEnv,
    "CINDY_MEKA_RUSTFS_SECRET_ACCESS_KEY",
  );
});

test("RustFS object keys stay inside the Cindy Meka prefix", () => {
  assert.equal(
    normalizeReleaseObjectKey(
      "cindy-meka",
      "app/win32-x64/cindy-meka-1.2.3-Setup.exe",
    ),
    "cindy-meka/app/win32-x64/cindy-meka-1.2.3-Setup.exe",
  );
  assert.throws(() =>
    normalizeReleaseObjectKey("cindy-meka", "../manifest.json"),
  );
  assert.throws(() => normalizeReleaseObjectKey("cindy-meka", "app\\evil.exe"));
  assert.equal(
    contentTypeForReleaseFile("manifest.json"),
    "application/json; charset=utf-8",
  );
  assert.equal(
    contentTypeForReleaseFile("client.dmg"),
    "application/x-apple-diskimage",
  );
});

test("dedicated cindy-meka bucket may publish at bucket root without a duplicate prefix", () => {
  assert.equal(assertMekaReleaseTargetIsolation("cindy-meka", "/"), "");
  assert.equal(
    normalizeReleaseObjectKey(
      assertMekaReleaseTargetIsolation("cindy-meka", "/"),
      "manifest-win32-x64-canary.json",
    ),
    "manifest-win32-x64-canary.json",
  );
  assert.throws(
    () => assertMekaReleaseTargetIsolation("shared-bucket", "/"),
    /cindy-meka/,
  );
});

test("Cindy Meka release roots are HTTPS-only", () => {
  assert.throws(
    () =>
      validateMekaReleaseCdnBaseUrl("http://insecure.example.test/cindy-meka"),
    /必须使用 HTTPS/,
  );
  assert.equal(
    validateMekaReleaseCdnBaseUrl("https://s3.meka.pawdy.fun/cindy-meka/"),
    "https://s3.meka.pawdy.fun/cindy-meka",
  );
  assert.throws(
    () => validateMekaS3Endpoint("http://insecure.example.test"),
    /无凭证的 HTTPS URL/,
  );
  assert.equal(
    validateMekaS3Endpoint("https://s3.meka.pawdy.fun/"),
    "https://s3.meka.pawdy.fun",
  );
});

test("build-info handoff re-hashes artifacts and requires release-grade signing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cindy-meka-build-info-"));
  try {
    const buildInfoPath = makeBuildInfo(root);
    const release = validateBuildInfo(buildInfoPath);
    assert.equal(release.version, "1.2.3");
    assert.equal(release.hotfix.name, "cindy-meka-1.2.3.zip");

    fs.appendFileSync(release.hotfix.filePath, "tampered");
    assert.throws(
      () => validateBuildInfo(buildInfoPath),
      /大小与 build-info 不一致/,
    );

    const unsignedPath = makeBuildInfo(root, {
      signing: { installerSigned: false, internalExesSigned: false },
    });
    assert.throws(
      () => validateBuildInfo(unsignedPath),
      /Windows 正式发布要求/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("canary manifest preserves compatible baseline fields and points at versioned artifacts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cindy-meka-manifest-"));
  try {
    const release = validateBuildInfo(makeBuildInfo(root));
    const manifest = buildCanaryManifest(
      {
        app: { version: "1.2.2", releaseNotes: "old" },
        claudeCode: {
          version: "2.0.0",
          file: "claude-code/2.0.0/win32-x64/claude.exe.gz",
          sha256: "a".repeat(64),
          size: 10,
        },
      },
      release,
      { releaseNotes: "new" },
    );
    validateManifestForPlatform(manifest, "win32-x64");
    assert.equal(manifest.app.version, "1.2.3");
    assert.equal(
      manifest.app.hotfix.file,
      "hotfix/win32-x64/cindy-meka-1.2.3.zip",
    );
    assert.equal(manifest.claudeCode.version, "2.0.0");
    const withoutNotes = buildCanaryManifest(manifest, release);
    assert.equal(withoutNotes.app.releaseNotes, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("release ordering is SemVer-aware and refuses stable downgrade", () => {
  assert.ok(compareReleaseVersions("1.10.0", "1.9.9") > 0);
  assert.ok(compareReleaseVersions("2.0.0", "2.0.0-rc.1") > 0);
  assert.ok(
    compareReleaseVersions(
      "999999999999999999999.0.0",
      "999999999999999999998.0.0",
    ) > 0,
  );
  assert.throws(
    () => compareReleaseVersions("1.0.0-rc.01", "1.0.0"),
    /非法发布版本/,
  );
  assert.throws(
    () =>
      assertPublishVersionOrder(
        "1.2.3",
        { app: { version: "1.2.4" } },
        { app: { version: "1.2.2" } },
      ),
    /较低版本/,
  );
  assert.throws(
    () =>
      assertPublishVersionOrder("1.2.3", null, { app: { version: "1.2.3" } }),
    /必须高于 stable/,
  );
});

test("versioned RustFS artifact upload is idempotent but never overwrites different bytes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cindy-meka-immutable-"));
  try {
    const release = validateBuildInfo(makeBuildInfo(root));
    const objects = new Map();
    const storage = {
      async head(key) {
        const value = objects.get(key);
        return value
          ? { size: value.size, metadata: { sha256: value.sha256 } }
          : null;
      },
      async putFile(key, filePath, options) {
        objects.set(key, {
          size: fs.statSync(filePath).size,
          sha256: options.metadata.sha256,
        });
      },
      async download() {
        throw new Error("not expected when metadata is present");
      },
    };
    const key = `hotfix/${release.platformKey}/${release.hotfix.name}`;
    assert.deepEqual(await putImmutableArtifact(storage, key, release.hotfix), {
      uploaded: true,
      reused: false,
    });
    assert.deepEqual(await putImmutableArtifact(storage, key, release.hotfix), {
      uploaded: false,
      reused: true,
    });
    objects.set(key, { size: release.hotfix.size, sha256: "f".repeat(64) });
    await assert.rejects(
      putImmutableArtifact(storage, key, release.hotfix),
      /内容不同，拒绝覆盖/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
