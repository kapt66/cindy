// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CindyAuthClient, reduceAuthFlow, type AuthFlowState } from '@cindy/auth-client';
import { createScenarioFetch } from '@cindy/auth-client/fixtures';

/**
 * Cindy Meka 单安装模式的登录服务区选择器回归。
 */

const loginHook = vi.hoisted(() => ({
  value: {
    isLoading: false,
    errorCode: null as string | null,
    loginState: null as unknown,
    dispatch: vi.fn(async () => true),
    clearError: vi.fn(),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/hooks/useLogin', () => ({ useLogin: () => loginHook.value }));
vi.mock('@/components/title-bar/WindowControls', () => ({ WindowControls: () => null }));

import { LoginPage } from '../LoginPage';

/** 构造指定服务区的 identifier 屏状态。 */
async function identifierState(realm: 'cn' | 'global' = 'cn'): Promise<AuthFlowState> {
  const client = new CindyAuthClient({
    baseUrl: 'https://auth.scenario.invalid',
    region: realm,
    deviceId: 'region-pill-test',
    clientType: 'desktop',
    fetch: createScenarioFetch('providers:both', { region: realm })!,
  });
  const providers = await client.getProviders();
  return reduceAuthFlow(null, { type: 'providers-loaded', providers });
}

function mount(state: AuthFlowState) {
  loginHook.value = {
    isLoading: false,
    errorCode: null,
    loginState: state,
    dispatch: vi.fn(async () => true),
    clearError: vi.fn(),
  };
  return render(<LoginPage />);
}

beforeEach(() => {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { platform: 'darwin', acceptPrivacyConsent: async () => ({ allowed: true }) },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('登录页服务区选择器', () => {
  it('按 provider realm 选中 CN', async () => {
    mount(await identifierState());
    expect(screen.getByTestId('login-realm-cn').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('login-realm-global').getAttribute('aria-checked')).toBe('false');
  });

  it('按 provider realm 选中 Global', async () => {
    mount(await identifierState('global'));
    expect(screen.getByTestId('login-realm-global').getAttribute('aria-checked')).toBe('true');
  });

  it('不再展示构建版别徽标', async () => {
    mount(await identifierState());
    expect(screen.queryByTestId('login-region-pill')).toBeNull();
  });

  it('点击另一区派发显式 select-realm 动作', async () => {
    mount(await identifierState());
    fireEvent.click(screen.getByTestId('login-realm-global'));
    expect(loginHook.value.dispatch).toHaveBeenCalledWith({
      type: 'select-realm',
      realm: 'global',
    });
  });
});
