import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertPublishVersionOrder,
  buildCanaryManifest,
  compareReleaseVersions,
  putImmutableArtifact,
  sha256File,
  validateBuildInfo,
  validateManifestForPlatform,
} from "../../apps/desktop/scripts/ci/release-lib.mjs";
import {
  contentTypeForReleaseFile,
  normalizeReleaseObjectKey,
} from "../../apps/desktop/scripts/ci/release-storage.mjs";
import { validateReleaseRegions } from "../../apps/desktop/scripts/ci/release-regions.mjs";

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
