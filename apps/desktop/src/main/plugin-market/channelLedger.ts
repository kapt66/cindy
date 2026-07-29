import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const CHANNEL_LEDGER_SCHEMA_VERSION = 1;

interface PluginChannelLedgerData {
  schemaVersion: typeof CHANNEL_LEDGER_SCHEMA_VERSION;
  mekaGhostIds: string[];
}

/**
 * Owner-scoped UI channel attribution for packages installed from a local
 * `.cindy` file. Remote provenance remains in each market service's ledger;
 * this file only records the user's explicit Meka/local channel choice.
 */
export class PluginChannelLedger {
  constructor(private readonly filePathSource: string | (() => string)) {}

  readMekaGhostIds(): string[] {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.filePath(), 'utf8'));
    } catch {
      return [];
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const value = raw as Record<string, unknown>;
    if (
      value.schemaVersion !== CHANNEL_LEDGER_SCHEMA_VERSION ||
      !Array.isArray(value.mekaGhostIds)
    ) {
      return [];
    }
    return [
      ...new Set(
        value.mekaGhostIds.filter(
          (ghostId): ghostId is string => typeof ghostId === 'string' && ghostId.length > 0,
        ),
      ),
    ];
  }

  setMeka(ghostId: string, meka: boolean): void {
    const ids = new Set(this.readMekaGhostIds());
    if (meka) ids.add(ghostId);
    else ids.delete(ghostId);
    this.write({
      schemaVersion: CHANNEL_LEDGER_SCHEMA_VERSION,
      mekaGhostIds: [...ids].sort(),
    });
  }

  private filePath(): string {
    return typeof this.filePathSource === 'function'
      ? this.filePathSource()
      : this.filePathSource;
  }

  private write(data: PluginChannelLedgerData): void {
    const filePath = this.filePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, {
        mode: 0o600,
        flag: 'wx',
      });
      try {
        fs.renameSync(tempPath, filePath);
      } catch (error) {
        const code =
          error && typeof error === 'object' && 'code' in error
            ? (error as NodeJS.ErrnoException).code
            : undefined;
        if (process.platform !== 'win32' || (code !== 'EPERM' && code !== 'EEXIST')) {
          throw error;
        }
        fs.rmSync(filePath, { force: true });
        fs.renameSync(tempPath, filePath);
      }
    } finally {
      fs.rmSync(tempPath, { force: true });
    }
  }
}
