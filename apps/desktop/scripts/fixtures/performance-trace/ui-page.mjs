import assert from 'node:assert/strict';

export default {
  name: 'performance-trace',
  entry: './entry.tsx',
  viewport: { width: 720, height: 600 },
  real: 'PerformanceTrace, MenuButton, DropdownMenu, ConfirmDialog, Button, recording probe and all five locale catalogs',
  notCovered:
    'Native capture, IPC sender authorization and shared-task hooks; capture has a separate isolated Electron smoke test. WL-26: there is no submission surface to cover',
  stubs: {
    'src/renderer/features/device-link/useSharedTaskTasks':
      'export function useSharedTaskTasks() {}',
    'src/renderer/features/device-link/SharedTaskEndedNotice':
      'export const SharedTaskEndedNotice = () => null;',
  },
  cases: {
    'main-menu': {
      about: 'Main window offers performance tracing',
      viewport: { width: 360, height: 500 },
    },
    'secondary-menu': {
      about: 'Secondary window hides the unsupported trace action',
      viewport: { width: 360, height: 500 },
    },
    default: { about: 'Start instructions and local-only scope' },
    recording: { about: 'Non-modal recording status and stop action' },
    ready: { about: 'Completed report and local files entry' },
    partial: { about: 'Incomplete capture is explicitly disclosed' },
    narrow: { about: 'Completed report at narrow width', viewport: { width: 320, height: 640 } },
    reopened: {
      about: 'Menu reentry offers recording first; previous report requires an explicit action',
      viewport: { width: 320, height: 640 },
    },
  },
  async ready(page) {
    await page.getByRole('button').first().waitFor();
  },
  async check(page, ui) {
    if (ui.case.endsWith('-menu')) {
      await page.getByRole('button', { name: await ui.t('titleBar.menu'), exact: true }).click();
      await page.getByRole('menu').waitFor();
      assert.equal(
        await page
          .getByRole('menuitem', { name: await ui.t('performanceTrace.title'), exact: true })
          .count(),
        ui.case === 'secondary-menu' ? 0 : 1,
      );
      return;
    }
    if (ui.case === 'recording') {
      assert.ok(
        await page
          .getByRole('button', { name: await ui.t('performanceTrace.stop'), exact: true })
          .isVisible(),
      );
      return;
    }
    assert.ok(
      await page.getByText(await ui.t('performanceTrace.localScope'), { exact: true }).isVisible(),
    );
    // WL-26：任何状态都不再有提交按钮或说明输入框。
    assert.equal(
      await page
        .getByRole('button', { name: await ui.t('performanceTrace.submit'), exact: true })
        .count(),
      0,
    );
    if (ui.case.startsWith('reopened')) {
      assert.ok(
        await page
          .getByRole('button', { name: await ui.t('performanceTrace.start'), exact: true })
          .isEnabled(),
      );
      await page
        .getByRole('button', { name: await ui.t('performanceTrace.previous'), exact: true })
        .click();
      await page
        .getByRole('alertdialog', {
          name: await ui.t('performanceTrace.previousResult'),
          exact: true,
        })
        .waitFor();
      assert.ok(
        await page
          .getByRole('button', { name: await ui.t('performanceTrace.keepLocal'), exact: true })
          .isEnabled(),
      );
    }
    if (ui.case === 'default') {
      await page
        .getByRole('button', { name: await ui.t('performanceTrace.start'), exact: true })
        .click();
      await page
        .getByRole('button', { name: await ui.t('performanceTrace.stop'), exact: true })
        .click();
      await page.getByText(await ui.t('performanceTrace.localScope'), { exact: true }).waitFor();
      assert.ok(
        await page
          .getByRole('button', { name: await ui.t('performanceTrace.new'), exact: true })
          .isEnabled(),
      );
      await page
        .getByRole('button', { name: await ui.t('performanceTrace.new'), exact: true })
        .click();
      assert.ok(
        await page
          .getByRole('button', { name: await ui.t('performanceTrace.stop'), exact: true })
          .isVisible(),
      );
    }
  },
};
