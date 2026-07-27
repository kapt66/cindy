import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  artifactBaseName,
  buildBuildInfo,
} from '../../apps/desktop/scripts/ci/package-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('Cindy Meka release artifacts use the independent new channel names', () => {
  assert.equal(
    artifactBaseName({ version: '0.0.65', versionless: false }),
    'cindy-meka-0.0.65',
  );
  assert.equal(
    artifactBaseName({ version: '0.0.0', versionless: true }),
    'cindy-meka-unversioned',
  );
  assert.equal(
    buildBuildInfo({
      version: '0.0.65',
      versionless: false,
      region: 'cn',
      platform: 'win32',
      arch: 'x64',
      commitSha: 'abc',
      electronVersion: '1',
      schemaVersionMax: 88,
      migrationFiles: [],
      files: [],
      signing: {},
    }).product,
    'cindy-meka-desktop',
  );
});

test('packaging mirrors Cindy Meka executable, updater destination and ZIP names', () => {
  const ciLib = read('apps/desktop/scripts/ci/lib.mjs');
  const smoke = read('apps/desktop/scripts/smoke-packaged.mjs');
  const forge = read('apps/desktop/forge.config.ts');
  const packager = read('apps/desktop/scripts/package-desktop.mjs');

  assert.match(ciLib, /export const PACKAGED_APP_NAME = 'CindyMeka';/);
  assert.match(smoke, /const PACKAGED_APP_NAME = 'CindyMeka';/);
  assert.match(
    forge,
    /target', 'release', 'cindy-updater\.exe'\)/,
    'Cargo source bin remains cindy-updater',
  );
  assert.match(
    forge,
    /resources', UPDATER_EXE\)/,
    'packaged updater destination follows cindy-meka-updater identity',
  );
  assert.match(
    packager,
    /path\.join\(artifactDir, `\$\{baseName\}\.zip`\)/,
    'Windows keeps the old architecture-free hotfix name',
  );
  assert.match(
    packager,
    /path\.join\(artifactDir, `\$\{baseName\}-\$\{arch\}\.zip`\)/,
    'macOS keeps the old architecture-qualified hotfix name',
  );
  assert.doesNotMatch(packager, /`\$\{baseName\}-hotfix\.zip`/);
});

test('release packaging can pin the endpoint bootstrap to the Cindy Meka CDN', () => {
  const packager = read('apps/desktop/scripts/package-desktop.mjs');
  assert.match(packager, /process\.env\.XDT_CDN_BASE_URL/);
  assert.match(
    packager,
    /region === 'cn' && !versionless && !mekaReleaseCdnBaseUrl/,
  );
  assert.match(
    packager,
    /clientBuildEnv\.VITE_ENDPOINT_MANIFEST_BASE_URL = validatedCdnBaseUrl/,
  );
});

test('release completion prints installer and hotfix download URLs', () => {
  const publisher = read('apps/desktop/scripts/publish-desktop.mjs');
  assert.match(publisher, /storage\.cdnUrl\(installerKey\)/);
  assert.match(publisher, /storage\.cdnUrl\(hotfixKey\)/);
});

test('Windows release keeps the old Meka signing service without exposing its token', () => {
  const forge = read('apps/desktop/forge.config.ts');
  const packager = read('apps/desktop/scripts/package-desktop.mjs');
  const signer = read('apps/desktop/scripts/sign.py');

  assert.match(forge, /process\.env\.NPKG_TOKEN\?\.trim\(\)/);
  assert.match(forge, /return `python "\$\{signScript\}" \{file\}`/);
  assert.doesNotMatch(forge, /NPKG_TOKEN\}.*\{file\}|\{file\}.*NPKG_TOKEN\}/);
  assert.match(packager, /delete forgeEnv\.NPKG_TOKEN/);
  assert.match(signer, /os\.environ\.get\("NPKG_TOKEN"/);
  assert.doesNotMatch(signer, /sys\.argv\[2\]/);
});

test('macOS release accepts the existing Meka certificate without requiring notarization credentials', () => {
  const packager = read('apps/desktop/scripts/package-desktop.mjs');
  const ciLib = read('apps/desktop/scripts/ci/lib.mjs');
  const envExample = read('apps/desktop/.env.example');

  assert.match(packager, /requestedSigningMode === 'self-signed'/);
  assert.match(packager, /timestamp: false/);
  assert.match(packager, /signingMode = 'self-signed'/);
  assert.match(ciLib, /identity\.timestamp === false \? '' : ' --timestamp'/);
  assert.match(envExample, /MAC_SIGNING_MODE=developer-id/);
});
