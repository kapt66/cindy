/**
 * Orca lead「无角色兜底」的接线断言（方案 §3.4 第 6 条：**漏一处 = 会话冷启动硬失败**）。
 *
 * `maker-ipc/register.ts` 里给 `createOrcaWorkerCreationService` 注入的 `getLeadSessionRow` 是
 * 一个内联闭包：它把 `mekaRoleId` 为空的 lead 兜底到**该 lead 自己项目**的共享默认角色。
 * 「通用开发」退役后，这里若仍写死旧角色 id（或写死 saga2），这类 lead 就派不出 worker
 * —— `resolveMekaRuntimeConfig` 会以 `Meka role not found` 失败，而整条路径没有任何
 * 单测覆盖（`register.ts` 无法在 unit 层整体拉起，`registerMakerIpc` 需要整个主进程依赖图）。
 *
 * 因此这里做两件事，缺一不可：
 * 1. **源码锚点断言**：兜底表达式必须存在、必须由 `leadRow.mekaProjectId` 派生、且必须排在
 *    `leadRow.mekaRoleId ??` 之后（已绑定角色的 lead 绝不被改写）；
 * 2. **用真实 `mekaDefaultRoleId` 断言派生目标**：它的输出被**字面量**钉住，且内置项目的角色
 *    清单真的注册了这个 id ⇒ 兜底目标一定解析得出来。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { BUILTIN_MEKA_PROJECTS, mekaDefaultRoleId } from '../../../shared/meka-projects.js';

const registerSource = readFileSync(path.resolve(__dirname, '..', 'register.ts'), 'utf8').replace(
  /\r\n?/g,
  '\n',
);

/** 截出 `createOrcaWorkerCreationService({ … })` 的参数块（含 `getLeadSessionRow` 闭包）。 */
function orcaWorkerCreationWiring(): string {
  const start = registerSource.indexOf('const orcaWorkerCreationService = createOrcaWorkerCreationService({');
  const end = registerSource.indexOf('resolveWorkerTarget: resolveMekaWorkerTarget,', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return registerSource.slice(start, end);
}

describe('Orca lead missing-role fallback wiring', () => {
  it('derives the fallback from the lead own project instead of a hardcoded role id', () => {
    const wiring = orcaWorkerCreationWiring();

    expect(wiring).toContain('getLeadSessionRow: async (leadSessionId) => {');
    expect(wiring).toContain('mekaProjectId: leadRow.mekaProjectId ?? null,');
    // 兜底表达式逐字：`mekaProjectId` 决定项目，`mekaDefaultRoleId` 决定角色。
    expect(wiring).toContain(
      '(leadRow.mekaProjectId ? mekaDefaultRoleId(leadRow.mekaProjectId) : null),',
    );
    // 已绑定的角色优先级更高：兜底只补空值，绝不覆盖用户/迁移选定的角色。
    const explicit = wiring.indexOf('leadRow.mekaRoleId ??');
    const fallback = wiring.indexOf('mekaDefaultRoleId(leadRow.mekaProjectId)');
    expect(explicit).toBeGreaterThanOrEqual(0);
    expect(fallback).toBeGreaterThan(explicit);
    // 无项目时不编造角色（返回 null 让上层报错，而不是指向别的项目的默认角色）。
    expect(wiring).toContain('mekaProjectId ? mekaDefaultRoleId(');

    // 退役 id 与硬编码项目都不得出现在兜底里。
    expect(wiring).not.toContain('general-development');
    expect(wiring).not.toContain("'saga2-default-role'");
    expect(wiring).not.toContain("\"saga2-default-role\"");
  });

  it('resolves the derived target to the role manifest the seed actually registers', () => {
    // 派生目标就是「项目 id + 固定后缀」：用**字面量**钉住这条确定性契约。
    expect(mekaDefaultRoleId('saga2')).toBe('saga2-default-role');
    expect(mekaDefaultRoleId('custom-project')).toBe('custom-project-default-role');

    // 内置项目的角色清单真的包含派生目标 ⇒ 「无角色 lead」兜底后一定解析得出来
    // （`readMekaRuntimeConfig` 不会抛 `Meka role not found`）。
    expect(BUILTIN_MEKA_PROJECTS.length).toBeGreaterThan(0);
    for (const project of BUILTIN_MEKA_PROJECTS) {
      const roleIds = project.roles.map((role) => role.id);
      expect(roleIds).toContain(mekaDefaultRoleId(project.id));
    }

    // 反向证据：退役别名与包内角色清单不再包含 —— 兜底跟它走的话必然解析失败。
    expect(
      BUILTIN_MEKA_PROJECTS.flatMap((project) => project.roles.map((role) => role.id)),
    ).toEqual(['saga2-default-role', 'combat-development']);
  });
});
