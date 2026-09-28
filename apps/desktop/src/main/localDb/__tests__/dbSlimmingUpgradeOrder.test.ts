import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('database cleanup and upgrade startup order', () => {
  it('derives both the cleanup database path and request owner from the same user id', () => {
    const source = readFileSync(path.resolve(__dirname, '..', 'index.ts'), 'utf8');
    const pathBinding = source.indexOf('const filePath = dbPath(userId)');
    const cleanup = source.indexOf('maintenance = await runPendingDbSlimmingAtStartup', pathBinding);
    const cleanupBlock = source.slice(cleanup, source.indexOf('});', cleanup) + 3);

    expect(pathBinding).toBeGreaterThanOrEqual(0);
    expect(cleanup).toBeGreaterThan(pathBinding);
    expect(cleanupBlock).toContain('dbFilePath: filePath');
    expect(cleanupBlock).toContain('ownerId: userId');
  });

  it('finishes cleanup recovery before opening the database for migration', () => {
    const source = readFileSync(path.resolve(__dirname, '..', 'index.ts'), 'utf8');
    const cleanup = source.indexOf('maintenance = await runPendingDbSlimmingAtStartup');
    const recoveryGuard = source.indexOf('if (!maintenance.originalDatabaseReady)', cleanup);
    const open = source.indexOf('_db = openWithPragmas(filePath)', recoveryGuard);
    const schemaStartup = source.indexOf(
      'const schemaStartup = await runSchemaStartupPolicy',
      open,
    );
    // 上游把迁移执行改成 startup policy 的回调（`runMigrations: () => runMigrations(db, filePath)`），
    // 不再在 policy 之后内联 await。顺序不变量改为「符号优先」表达：先把源码去掉全部空白，
    // 再比较符号位置——既能容忍上游微调缩进/换行/箭头两侧空格，也不必再依赖一整行字面量。
    const compact = source.replace(/\s+/g, '');
    const callbackBody = 'runMigrations:()=>runMigrations(db,filePath)';
    const migrationCall = 'runMigrations(db,filePath)';
    const policyAt = compact.indexOf('constschemaStartup=awaitrunSchemaStartupPolicy');
    const callbackAt = compact.indexOf(callbackBody);
    const firstMigrationCallAt = compact.indexOf(migrationCall);

    expect(cleanup).toBeGreaterThanOrEqual(0);
    expect(recoveryGuard).toBeGreaterThan(cleanup);
    expect(open).toBeGreaterThan(recoveryGuard);
    expect(schemaStartup).toBeGreaterThan(open);
    expect(policyAt).toBeGreaterThanOrEqual(0);
    // 迁移必须仍然接线为 policy 的 runMigrations 回调，且该回调位于 policy 调用之后。
    expect(callbackAt).toBeGreaterThan(policyAt);
    // 全源码中第一次迁移调用必须正好是那个回调体本身：只要出现更早的 eager `runMigrations`
    // 调用（本轮要守住的顺序不变量），这条等式就不再成立。
    expect(firstMigrationCallAt).toBe(callbackAt + callbackBody.indexOf(migrationCall));
  });
});
