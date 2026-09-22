/**
 * The shared built-in default role (`<projectId>-default-role`) is read-only by contract.
 *
 * Both interceptors in `localDb/ipc/mekaRoles.ts` are load-bearing rather than cosmetic: the
 * default role deliberately has NO bundled manifest file (`resources/meka/roles/<id>.json`
 * does not exist), and `readBuiltinRoleManifest` *throws* when the file is missing. So if the
 * read-manifest short-circuit regressed, the role panel would fail to load instead of
 * degrading; if the update guard regressed, editing would fall through to the generic
 * builtin path. Neither was covered before this test.
 *
 * These exercise the real registered IPC handlers rather than a test-only export, so the
 * assertions still hold if the registration wiring changes.
 *
 * This lives here rather than beside the module on purpose: `src/main/localDb/**` is excluded
 * from the desktop `unit` tier (see scripts/test-workspaces.config.mjs) and the `db` tier is
 * `status: 'manual'`, so a test in `localDb/ipc/__tests__` would run in neither the mandated
 * pre-commit gate nor CI. Mocking the same modules the way `mekaProjectsImport.test.ts` does
 * keeps this in the unit tier.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  roleRow: null as Record<string, unknown> | null,
  exec: vi.fn(async () => undefined),
  readBuiltinRoleManifest: vi.fn(),
  readCustomRoleManifest: vi.fn(),
  saveProjectConfig: vi.fn(async () => undefined),
  writeCustomRoleManifest: vi.fn(async () => undefined),
  builtinProjectFile: null as Record<string, unknown> | null,
}));

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => 'C:\\CindyMekaTest' },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      h.handlers.set(channel, handler);
    },
  },
}));

vi.mock('../../localDb/client/current.js', () => ({
  getDbClient: () => ({
    queryOne: async (sql: string) => (sql.includes('FROM meka_roles') ? h.roleRow : undefined),
    query: async () => (h.roleRow ? [h.roleRow] : []),
    exec: h.exec,
  }),
}));

vi.mock('../../meka-settings/ipc.js', () => ({
  getMekaP4SettingsService: () => ({ get: async () => ({ p4RootPath: 'C:\\Workspace\\saga2' }) }),
}));

vi.mock('../projectConfig.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../projectConfig.js')>();
  return {
    ...actual,
    readProjectConfigState: async () => ({ file: h.builtinProjectFile, source: 'builtin' }),
    readBuiltinRoleManifest: h.readBuiltinRoleManifest,
    readCustomRoleManifest: h.readCustomRoleManifest,
    saveProjectConfig: h.saveProjectConfig,
    writeCustomRoleManifest: h.writeCustomRoleManifest,
  };
});

vi.mock('../../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: vi.fn(),
}));

const SAGA2_DEFAULT_ROLE = 'saga2-default-role';

function installDefaultRoleRow(): void {
  h.roleRow = {
    id: SAGA2_DEFAULT_ROLE,
    project_id: 'saga2',
    name: SAGA2_DEFAULT_ROLE,
    display_name: '默认角色',
    description: null,
    tags: '["builtin","default"]',
    file_path: `meka/roles/${SAGA2_DEFAULT_ROLE}.json`,
    is_builtin: 1,
    content_digest: null,
    sort_order: -1,
    created_at: 1,
    updated_at: 1,
  };
}

function handler(channel: string): (...args: unknown[]) => unknown {
  const found = h.handlers.get(channel);
  if (!found) throw new Error(`handler not registered: ${channel}`);
  return found;
}

beforeEach(async () => {
  h.handlers.clear();
  h.roleRow = null;
  h.builtinProjectFile = null;
  h.exec.mockClear();
  h.saveProjectConfig.mockClear();
  h.writeCustomRoleManifest.mockClear();
  // The real module throws for a missing file — exactly what the default role relies on
  // never being reached.
  h.readBuiltinRoleManifest.mockReset().mockImplementation(async (roleId: string) => {
    throw new Error(`bundled Meka role manifest is missing: ${roleId}`);
  });
  h.readCustomRoleManifest.mockReset().mockResolvedValue(null);
  const mod = await import('../../localDb/ipc/mekaRoles.js');
  mod.registerMekaRolesIpc();
});

describe('shared default role read-only contract', () => {
  it('resolves its manifest in memory instead of reading a bundled file', async () => {
    installDefaultRoleRow();

    const manifest = (await handler('meka-role:read-manifest')(
      {},
      SAGA2_DEFAULT_ROLE,
    )) as Record<string, unknown> | null;

    expect(manifest).toMatchObject({
      id: SAGA2_DEFAULT_ROLE,
      projectId: 'saga2',
      displayName: '默认角色',
      skills: [],
      mcp: [],
      promptFragments: [],
      projectMetadataSelection: [],
    });
    // The contract: no prompt at all, and no opt-in to project defaults.
    expect(manifest?.prompt ?? '').toBe('');
    expect(manifest?.useProjectDefaults).toBeUndefined();
    expect(manifest?.includeAllProjectMetadata).toBeUndefined();
    // A missing bundled file must never be consulted for this role.
    expect(h.readBuiltinRoleManifest).not.toHaveBeenCalled();
  });

  it('rejects an update with MEKA_BUILTIN_READ_ONLY and writes nothing', async () => {
    installDefaultRoleRow();

    await expect(
      handler('meka-role:update')(
        {},
        {
          projectId: 'saga2',
          roleFile: {
            schemaVersion: 1,
            id: SAGA2_DEFAULT_ROLE,
            projectId: 'saga2',
            name: SAGA2_DEFAULT_ROLE,
            displayName: 'hijacked',
            skills: [],
            promptFragments: [],
            mcp: [],
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'MEKA_BUILTIN_READ_ONLY' });

    expect(h.saveProjectConfig).not.toHaveBeenCalled();
    expect(h.writeCustomRoleManifest).not.toHaveBeenCalled();
  });

  it('rejects deleting the default role as a built-in', async () => {
    installDefaultRoleRow();

    await expect(handler('meka-role:delete')({}, SAGA2_DEFAULT_ROLE)).rejects.toMatchObject({
      code: 'MEKA_BUILTIN_READ_ONLY',
    });
  });
});
