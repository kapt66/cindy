/**
 * i18nBrandPlaceholder.test.ts —— {{appName}} 品牌插值的运行时断言。
 *
 * 品牌展示名收敛分两层校验:
 *  - 静态层:locale JSON 不得硬编码品牌名 → scripts/brand-terminology-guard.mjs
 *    (PR #767 建立的品牌治理 CI 入口,错拼检查与 locale 占位符检查同脚本);
 *    ⚠️ 该脚本只拒**上游**错拼,拦不住写死的**当前**品牌名 'Cindy'——
 *    所以新文案是否用占位符,只能靠本文件的固定 key 列表钉住。
 *  - 运行时层(本文件):i18next 的 interpolation.defaultVariables 真的把
 *    {{appName}} 注入为 BRAND_NAME——静态扫描保证"写了占位符",这里保证
 *    "占位符渲染得出来"(defaultVariables 配置被误删时静态扫描不会红)。
 *
 * **收录口径**:新文案指「应用/产品自身」时必须写 `{{appName}}`,修好后把 key
 * 补进下面的 key 列表;指**非应用对象**的文案例外,**不得**收录(收录即断言失败,
 * 且把品牌名替换成展示名会造成事实不符)。当前已知例外:
 *  - `settings.ghosts.market.customSecurityDescription` ——「未经 Cindy 服务端
 *    完整性校验」指的是**上游 Cindy 服务端**,不是本地应用;
 *  - `settings.ghosts.market.securityDescription` ——「经 Cindy 插件清单校验」里的
 *    品牌限定的是**上游 Cindy 插件生态的清单契约**(与 `.cindy` 扩展名同级),
 *    不是应用自身。
 * 两类都属存量(非本轮新增),改名的正确做法是重新措辞而不是把品牌换成 {{appName}}。
 * 其余历史写死项按 migration 报告登记,不逐条列在这里。
 */
import { describe, it, expect } from 'vitest';

import { BRAND_NAME } from '@cindy/maker-shared/branding';
import { i18n } from '../i18n';

describe('locale 品牌名插值', () => {
  it('{{appName}} 由 defaultVariables 注入为 BRAND_NAME(端到端)', () => {
    // update.moveToApplications.message 是含 {{appName}} 的真实 key(main 迷你 i18n 也消费它)。
    const rendered = i18n.t('update.moveToApplications.message');
    expect(rendered).toContain(BRAND_NAME);
    expect(rendered).not.toContain('{{appName}}');
  });

  it('数据库版本恢复页在五种语言中使用当前产品展示名', () => {
    // zh-TW 曾漏在列表外，导致该语两条文案把品牌名写死成 'Cindy' 而门禁假绿
    // (2026-09-24 修复)。新增语言时必须一并加入这里。
    for (const locale of ['en', 'zh-CN', 'zh-TW', 'ja', 'ko']) {
      const t = i18n.getFixedT(locale);
      for (const key of [
        'localDbFatal.updateReady.description',
        'localDbFatal.preparing.description',
        'localDbFatal.applyExhausted.description',
      ]) {
        const rendered = t(key);
        expect(rendered).toContain(BRAND_NAME);
        expect(rendered).not.toContain('{{appName}}');
      }
    }
  });

  it('自动更新放弃后的手动安装引导使用当前产品展示名(5 语言)', () => {
    // 静态扫描（brand-terminology-guard）只拒上游错拼，**拦不住**写死的当前品牌名 ——
    // 写死会让改名漏掉这条文案，所以这里按「渲染结果含 BRAND_NAME」钉住。
    for (const locale of ['en', 'zh-CN', 'zh-TW', 'ja', 'ko']) {
      const t = i18n.getFixedT(locale);
      for (const key of [
        'update.applyExhausted.description',
        'localDbFatal.applyExhausted.description',
      ]) {
        const rendered = t(key);
        expect(rendered).toContain(BRAND_NAME);
        expect(rendered).not.toContain('{{appName}}');
      }
    }
  });

  it('第四轮同步新增文案指应用自身时使用 {{appName}}(5 语言)', () => {
    // 2026-09-25 第四轮上游同步:上游带入的这批文案把品牌名写死成 'Cindy'
    // (taskMove / taskMigration / usageHistory / bots.groupChat),同批改为 {{appName}}。
    // 收录口径见文件头:指应用/产品自身的收进来;指非应用对象(上游 Cindy 服务端、
    // Cindy 插件生态清单契约)的例外不得收录。
    for (const locale of ['en', 'zh-CN', 'zh-TW', 'ja', 'ko']) {
      const t = i18n.getFixedT(locale);
      for (const key of [
        'taskMove.upgradeComputer',
        'taskMigration.limits',
        'taskMigration.defaultFolder',
        'usageHistory.description',
        'usageHistory.device.status.unsupported',
        'bots.groupChat.loadFailedDescription',
        'bots.groupChat.errors.hostNotReady',
      ]) {
        const rendered = t(key);
        expect(rendered).toContain(BRAND_NAME);
        expect(rendered).not.toContain('{{appName}}');
      }
    }
  });
});
