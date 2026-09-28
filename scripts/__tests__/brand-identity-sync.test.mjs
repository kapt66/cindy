// brand-identity-sync.test.mjs — 品牌标识符「TS 单点 ↔ .mjs 脚本镜像字面量」一致性断言。
//
// 背景:packages/maker-shared/src/brandIdentity.ts 是标识符层身份的单一事实源,
// 但 smoke / restart 等 .mjs 脚本无法 import TS,只能在各自文件顶部
// 镜像字面量(均带注释指回单点)。本测试用正则读 TS 源码抽出字面量,与各脚本的
// 镜像常量逐一比对——单点翻转后漏改任何一处镜像,这里立刻红灯。
//
// 刻意用「读源码 + 正则」而不 import 被测脚本:避免脚本模块顶层副作用
// (ali-oss / env 加载等),node --test 环境零依赖即可跑。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

function readSource(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), "utf8");
}

/** 从源码里抽取对象字段或常量声明中的字符串字面量。 */
function extractLiteral(source, regex, label) {
  const match = regex.exec(source);
  assert.ok(match, `pattern not found: ${label} (${regex})`);
  return match[1];
}

const brandIdentitySource = readSource(
  "packages/maker-shared/src/brandIdentity.ts",
);
const EXECUTABLE_NAME = extractLiteral(
  brandIdentitySource,
  /executableName:\s*'([^']+)'/,
  "brandIdentity.ts executableName",
);
const USER_DATA_DIR_NAME = extractLiteral(
  brandIdentitySource,
  /userDataDirName:\s*'([^']+)'/,
  "brandIdentity.ts userDataDirName",
);
const DB_FILE_PREFIX = extractLiteral(
  brandIdentitySource,
  /^\s*dbFilePrefix:\s*'([^']+)'/m,
  "brandIdentity.ts dbFilePrefix",
);
/**
 * 从源码里抽取形如 `<mapName>: Object.freeze({ cn: '...', ... })` 的区域映射。
 * 锚定到 `Object.freeze({` 赋值处:字段名可能还出现在 interface 声明里。
 */
function extractRegionMap(source, mapName, label) {
  const blockRe = new RegExp(
    `${mapName}\\s*[:=]\\s*Object\\.freeze\\(\\{([\\s\\S]*?)\\}\\)`,
  );
  const block = blockRe.exec(source);
  assert.ok(block, `pattern not found: ${label} (${blockRe})`);
  const map = {};
  for (const [, key, , value] of block[1].matchAll(
    /(cn|global|dev):\s*(['"])([^'"]+)\2/g,
  )) {
    map[key] = value;
  }
  assert.deepEqual(
    Object.keys(map).sort(),
    ["cn", "dev", "global"],
    `${label} 缺区域键`,
  );
  return map;
}

/** 身份正本的区域映射副本,供下面各镜像点比对。 */
const EXECUTABLE_NAME_BY_REGION = extractRegionMap(
  brandIdentitySource,
  "executableNameByRegion",
  "brandIdentity.ts executableNameByRegion",
);
const FILE_ASSOCIATION_PROG_ID_BY_REGION = extractRegionMap(
  brandIdentitySource,
  "fileAssociationProgIdByRegion",
  "brandIdentity.ts fileAssociationProgIdByRegion",
);

test("ci/lib.mjs PACKAGED_APP_NAME_BY_REGION mirrors brandIdentity.executableNameByRegion", () => {
  const expected = extractRegionMap(
    brandIdentitySource,
    "executableNameByRegion",
    "brandIdentity.ts executableNameByRegion",
  );
  const libSource = readSource("apps/desktop/scripts/ci/lib.mjs");
  const actual = extractRegionMap(
    libSource,
    "PACKAGED_APP_NAME_BY_REGION",
    "ci/lib.mjs PACKAGED_APP_NAME_BY_REGION",
  );
  assert.deepEqual(actual, expected);
});

test("smoke-packaged.mjs PACKAGED_APP_NAME mirrors brandIdentity.executableName", () => {
  const smokeSource = readSource("apps/desktop/scripts/smoke-packaged.mjs");
  const value = extractLiteral(
    smokeSource,
    /const PACKAGED_APP_NAME = '([^']+)';/,
    "smoke-packaged.mjs PACKAGED_APP_NAME",
  );
  assert.equal(value, EXECUTABLE_NAME);
});

test("restart-desktop-remote.mjs BRAND_USER_DATA_DIR_NAME mirrors brandIdentity.userDataDirName", () => {
  const restartSource = readSource("scripts/restart-desktop-remote.mjs");
  const value = extractLiteral(
    restartSource,
    /export const BRAND_USER_DATA_DIR_NAME = ['"]([^'"]+)['"];/,
    "restart-desktop-remote.mjs BRAND_USER_DATA_DIR_NAME",
  );
  assert.equal(value, USER_DATA_DIR_NAME);
});

test("desktop dev userData region map mirrors brandIdentity.userDataDirNameByRegion", () => {
  const expected = extractRegionMap(
    brandIdentitySource,
    "userDataDirNameByRegion",
    "brandIdentity.ts userDataDirNameByRegion",
  );
  const regionSource = readSource("scripts/shared/desktop-dev-region.mjs");
  const actual = extractRegionMap(
    regionSource,
    "DESKTOP_USER_DATA_DIR_NAME_BY_REGION",
    "desktop-dev-region.mjs DESKTOP_USER_DATA_DIR_NAME_BY_REGION",
  );
  assert.deepEqual(actual, expected);
});

test("desktop package.json productName mirrors brandIdentity.userDataDirName", () => {
  // Electron userData 目录名默认派生自 productName;brandIdentity.userDataDirName
  // 的注释也声明二者同源——两边漂移会让主进程 <userData>-dev 沙箱与 restart 脚本
  // 的 XDT_USER_DATA_DIR 落在不同目录。
  const pkg = JSON.parse(readSource("apps/desktop/package.json"));
  assert.equal(pkg.productName, USER_DATA_DIR_NAME);
});

test("installer.nsh Windows 安装身份字面量镜像 brandIdentity.executableName / fileAssociationProgIdByRegion", () => {
  // ⚠️ 该文件只对正式区(cn/global)身份做 StrCmp/注册表判据,dev 身份走
  // ${PRODUCT_FILENAME} 宏而不是字面量;因此这里断言的是 cn/global 正本值。
  const source = readSource("apps/desktop/resources/installer.nsh");
  assert.equal(
    FILE_ASSOCIATION_PROG_ID_BY_REGION.cn,
    FILE_ASSOCIATION_PROG_ID_BY_REGION.global,
    "brandIdentity.ts cn/global 文件关联 ProgID 必须同值(共用安装身份)",
  );
  assert.ok(
    source.includes(`"${EXECUTABLE_NAME}"`),
    `installer.nsh 必须逐字出现 "${EXECUTABLE_NAME}"(正本 executableName;它同时是 NSIS productName 判据、旧快捷方式清理判据与文件关联归属判据)`,
  );
  assert.ok(
    source.includes(`"${FILE_ASSOCIATION_PROG_ID_BY_REGION.cn}"`),
    `installer.nsh 必须逐字出现 "${FILE_ASSOCIATION_PROG_ID_BY_REGION.cn}"(正本 cn/global fileAssociationProgIdByRegion)`,
  );
});

test("forge-third-party-notices.ts 的 mac bundle 兜底名镜像 brandIdentity.executableName", () => {
  // 扫不到 *.app 时按 productName 兜底拼 <App>.app;写死上游名会让 macOS
  // packaged resources 定位到错误路径。
  const value = extractLiteral(
    readSource("apps/desktop/forge-third-party-notices.ts"),
    /path\.join\(buildPath, '([^']+\.app)'\)/,
    "forge-third-party-notices.ts mac bundle 兜底路径",
  );
  assert.equal(value, `${EXECUTABLE_NAME}.app`);
});

test("dev-embed-search.mjs DB_FILE_PREFIX (known gap: 仍写死上游 'cindy',不等于正本 dbFilePrefix)", () => {
  // 已知缺口 —— 登记见 `docs/migrations/2026-09-25-origin-main-to-meka-main.md` §5 /
  // `docs/migrations/2026-09-24-origin-main-to-meka-main.md` §6.17;修复这几处时必须同步更新本条断言。
  // ⚠️ 事实核对:`2026-09-24` §6.17 只点名了 Linux 安装链路三处,未点名本文件;
  // 本条由第四轮同步报告补登记。正本 `<dbFilePrefix>-<userId>.db` 现为
  // `cindy-meka-<userId>.db`(apps/desktop/src/main/localDb/modelDefaultsProfile.ts),
  // 故本脚本当前 glob 的是**不存在**的文件。
  // 断言的是**当前实际值**(上游 'cindy')而不是正本值:缺口未修时保持绿,
  // 一旦有人改动(修好或再次漂移)立刻变红,迫使同批更新本条。
  const value = extractLiteral(
    readSource("scripts/dev-embed-search.mjs"),
    /const DB_FILE_PREFIX = '([^']+)';/,
    "dev-embed-search.mjs DB_FILE_PREFIX",
  );
  assert.equal(value, "cindy");
  assert.notEqual(value, DB_FILE_PREFIX);
});

test("forge-linux.ts build-info executable 名 (known gap: 仍写死上游 'Cindy' / 'CindyDev',不等于 executableNameByRegion)", () => {
  // 已知缺口 —— 登记见 `docs/migrations/2026-09-24-origin-main-to-meka-main.md` §6.17
  // 「只登记、未修(用户裁决 B:不动 Linux 安装链路)」/ `2026-09-25-…md` §5;
  // 修复这几处时必须同步更新本条断言。
  // 该字段是 install-user.sh / install-omarchy.sh 读取的权威 executable 值,
  // 三处必须同批改(见下面两个用例),否则 Meka 载荷(正本 CindyMeka)会被安装器拒绝。
  const source = readSource("apps/desktop/forge-linux.ts");
  const match = /region === 'dev' \? '([^']+)' : '([^']+)'/.exec(source);
  assert.ok(match, "pattern not found: forge-linux.ts build-info executable 三元表达式");
  assert.equal(match[1], "CindyDev");
  assert.equal(match[2], "Cindy");
  assert.notEqual(match[1], EXECUTABLE_NAME_BY_REGION.dev);
  assert.notEqual(match[2], EXECUTABLE_NAME_BY_REGION.global);
});

test("linux 用户级安装脚本要求的可执行名 (known gap: 仍写死上游 'Cindy',不等于 executableName)", () => {
  // 已知缺口 —— 登记见 `docs/migrations/2026-09-24-origin-main-to-meka-main.md` §6.17
  // 「只登记、未修(用户裁决 B:不动 Linux 安装链路)」/ `2026-09-25-…md` §5;
  // 修复这几处时必须同步更新本条断言。与 forge-linux.ts 的 build-info executable 同批改。
  // 断言的是**当前实际值**(上游 'Cindy'):缺口未修时保持绿,一旦被改动立刻变红。
  const installUser = readSource("apps/desktop/resources/linux/install-user.sh");
  const launchName = extractLiteral(
    installUser,
    /%s\/current\/([A-Za-z0-9_.-]+)'/,
    "install-user.sh launch 包装脚本 executable",
  );
  const identityName = extractLiteral(
    installUser,
    /\[\[ \$executable == ([A-Za-z0-9_.-]+) \]\]/,
    "install-user.sh build-info executable 断言",
  );

  const omarchy = readSource("apps/desktop/resources/linux/install-omarchy.sh");
  const payloadName = extractLiteral(
    omarchy,
    /\/usr\/lib\/cindy\/([A-Za-z0-9_.-]+) /,
    "install-omarchy.sh 系统安装探测路径",
  );
  const pgrepName = extractLiteral(
    omarchy,
    /pgrep -u "\$\(id -u\)" -x ([A-Za-z0-9_.-]+)/,
    "install-omarchy.sh 运行中进程名",
  );
  const fieldName = extractLiteral(
    omarchy,
    /\$\{fields\[4\]\} == ([A-Za-z0-9_.-]+) \]\]/,
    "install-omarchy.sh build-info executable 断言",
  );

  assert.equal(launchName, "Cindy");
  assert.equal(identityName, "Cindy");
  assert.equal(payloadName, "Cindy");
  assert.equal(pgrepName, "Cindy");
  assert.equal(fieldName, "Cindy");
  for (const value of [launchName, identityName, payloadName, pgrepName, fieldName]) {
    assert.notEqual(value, EXECUTABLE_NAME);
  }
});
