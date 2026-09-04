const COMBAT_WORKFLOW = 'saga2-combat-development-v1';
export const COMBAT_SERVER_EXPLORATION_MARKER = '[SAGA2_SERVER_EXPLORATION_READ_ONLY]';
/**
 * Server exploration is only meaningful after the Lead has reduced the request
 * to concrete skill-entry-model capabilities. Keep this marker separate from
 * the read-only marker so an otherwise valid Worker cannot become an early
 * all-or-nothing implementation oracle.
 */
export const COMBAT_MODULE_FIRST_MARKER = '[SAGA2_MODULE_FIRST]';

type CombatVendorOptions = Record<string, unknown> & {
  source?: unknown;
  mekaProjectId?: unknown;
  mekaWorkflow?: unknown;
  mekaRoleId?: unknown;
  mekaCombatEnvironmentReady?: unknown;
  mekaCombatPhase?: unknown;
  mekaCombatServerCapabilityStatus?: unknown;
};

type DispatchKind = 'create_worker' | 'send_to_worker';

type CombatServerDispatch = {
  generation: number;
  leadSessionId: string;
  vendorOptions: CombatVendorOptions;
  kind: DispatchKind;
  task: string;
  requestedWorkerRef: string | null;
  remoteHostId: string;
  workerId: string | null;
  workerSessionId: string | null;
  report: Record<string, unknown> | null;
  state: 'dispatching' | 'pending' | 'report-ready';
};

const activeDispatches = new Map<string, CombatServerDispatch>();
const trustedWorkerRemoteHosts = new Map<string, Map<string, string>>();
const workerReadCounts = new Map<string, number>();
const leadEvidenceCounts = new Map<string, number>();
/** A server worker gets a small, deterministic evidence budget per dispatch. */
export const COMBAT_SERVER_WORKER_READ_LIMIT = 6;
/** Local Lead exploration is bounded so repetitive reads cannot consume a turn. */
export const COMBAT_LEAD_EVIDENCE_READ_LIMIT = 8;
let nextGeneration = 1;

function normalizeDispatchTask(task: string): string {
  return task.replace(/\r\n?/g, '\n').trim();
}

function isCombatLead(options: CombatVendorOptions): boolean {
  return (
    options.source === 'meka' &&
    options.mekaProjectId === 'saga2' &&
    options.mekaWorkflow === COMBAT_WORKFLOW &&
    options.mekaRoleId === 'combat-development'
  );
}

export function isCombatServerExplorationTask(task: string): boolean {
  return task.includes(COMBAT_SERVER_EXPLORATION_MARKER);
}

export function isModuleFirstCombatServerExplorationTask(task: string): boolean {
  if (!isCombatServerExplorationTask(task) || !task.includes(COMBAT_MODULE_FIRST_MARKER)) {
    return false;
  }
  const hasModuleEvidence =
    /(?:legacy_module_export_json|saga2-entry-model|skill-entry-model|entrymodel|模块(?:图|链|能力|协议)|老版[^\n]{0,60}导出|目标技能(?:的)?模块资产(?:不存在|存在)|skill_id\s*=)/i.test(
      task,
    );
  const hasAtomicMatrix = /(?:atomic|原子)(?:[\s_-]*(?:capabilit|能力|matrix|矩阵))/i.test(task);
  const hasResidualQuestion =
    /(?:residual|remaining|gap|缺口|待核查|待确认|剩余|(?:需|需要|尚需|必须)核实|请[^\n]{0,120}(?:核实|核对))/i.test(
      task,
    );
  return hasModuleEvidence && hasAtomicMatrix && hasResidualQuestion;
}

export function beginCombatServerCapabilityDispatch(input: {
  leadSessionId: string | undefined;
  vendorOptions: Record<string, unknown>;
  kind: DispatchKind;
  task: string;
  requestedWorkerRef?: string;
  remoteHostId?: string;
}): boolean {
  const leadSessionId = input.leadSessionId?.trim();
  const options = input.vendorOptions as CombatVendorOptions;
  const remoteHostId = input.remoteHostId?.trim() ?? '';
  if (
    !leadSessionId ||
    !isCombatLead(options) ||
    !isModuleFirstCombatServerExplorationTask(input.task) ||
    !remoteHostId.startsWith('mcpr:')
  ) {
    return false;
  }

  const current = activeDispatches.get(leadSessionId);
  if (current?.state === 'dispatching' || current?.state === 'pending') return false;

  activeDispatches.set(leadSessionId, {
    generation: nextGeneration++,
    leadSessionId,
    vendorOptions: options,
    kind: input.kind,
    task: normalizeDispatchTask(input.task),
    requestedWorkerRef: input.requestedWorkerRef?.trim() || null,
    remoteHostId,
    workerId: null,
    workerSessionId: null,
    report: null,
    state: 'dispatching',
  });
  options.mekaCombatServerCapabilityStatus = 'dispatching';
  options.mekaCombatPhase = 'server-capability-dispatch';
  return true;
}

export function settleCombatServerCapabilityDispatch(input: {
  leadSessionId: string;
  kind: DispatchKind;
  task: string;
  accepted: boolean;
  workerId?: string;
  workerSessionId?: string;
}): boolean {
  const current = activeDispatches.get(input.leadSessionId);
  if (
    !current ||
    current.kind !== input.kind ||
    current.task !== normalizeDispatchTask(input.task)
  ) {
    return false;
  }

  if (current.kind === 'create_worker' && (input.workerId || input.workerSessionId)) {
    const refs = trustedWorkerRemoteHosts.get(input.leadSessionId) ?? new Map<string, string>();
    if (input.workerId?.trim()) refs.set(input.workerId.trim(), current.remoteHostId);
    if (input.workerSessionId?.trim()) {
      refs.set(input.workerSessionId.trim(), current.remoteHostId);
    }
    trustedWorkerRemoteHosts.set(input.leadSessionId, refs);
  }

  if (!input.accepted) {
    activeDispatches.delete(input.leadSessionId);
    current.vendorOptions.mekaCombatServerCapabilityStatus = 'retry-required';
    current.vendorOptions.mekaCombatPhase = 'server-capability-retry';
    return true;
  }

  current.workerId = input.workerId?.trim() || null;
  current.workerSessionId = input.workerSessionId?.trim() || current.requestedWorkerRef;
  if (current.workerSessionId) workerReadCounts.set(current.workerSessionId, 0);
  current.state = 'pending';
  current.vendorOptions.mekaCombatServerCapabilityStatus = 'pending';
  current.vendorOptions.mekaCombatPhase = 'server-capability-check';
  return true;
}

function parseAutoBridgeReport(message: string): Record<string, unknown> | null {
  const withoutHeader = message.replace(/^\[Auto-bridged:[^\]]+\]\s*/i, '').trim();
  const fenced = withoutHeader.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const payload = (fenced?.[1] ?? withoutHeader).trim();
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const wrapped = record.serverCapabilityReport;
    if (wrapped && typeof wrapped === 'object' && !Array.isArray(wrapped)) {
      return wrapped as Record<string, unknown>;
    }
    return record;
  } catch {
    return null;
  }
}

/**
 * The MCP report schema projects structured evidence entries to display
 * strings before the tool handler receives them. Store and compare the same
 * representation so a trusted auto-bridge report survives that projection.
 */
function normalizeCapabilityReport(report: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(report.codeEvidence)) return report;
  const codeEvidence = report.codeEvidence.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    const value = entry as Record<string, unknown>;
    if (typeof value.path !== 'string' || !value.path.trim()) return entry;
    const symbols = Array.isArray(value.symbols)
      ? value.symbols
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim())
          .filter(Boolean)
      : [];
    const details = typeof value.details === 'string' ? value.details.trim() : '';
    return [value.path.trim(), symbols.length ? `symbols=${symbols.join(',')}` : '', details]
      .filter(Boolean)
      .join(': ');
  });
  return { ...report, codeEvidence };
}

export function recordCombatServerCapabilityAutoBridge(input: {
  leadSessionId: string;
  workerId: string;
  workerSessionId: string;
  message: string;
  accepted: boolean;
  terminalStatus?: 'done' | 'error';
}): 'ignored' | 'report-ready' | 'retry-required' {
  const current = activeDispatches.get(input.leadSessionId);
  if (!current || current.state !== 'pending') return 'ignored';
  const matchesWorker =
    current.workerId === input.workerId ||
    current.workerSessionId === input.workerSessionId ||
    current.requestedWorkerRef === input.workerId ||
    current.requestedWorkerRef === input.workerSessionId;
  if (!matchesWorker) return 'ignored';
  // A rejected delivery remains pending because Orca may retry the same
  // terminal bridge. An accepted error terminal cannot be retried as success.
  if (!input.accepted) return 'ignored';
  if (input.terminalStatus === 'error') {
    activeDispatches.delete(input.leadSessionId);
    current.vendorOptions.mekaCombatServerCapabilityStatus = 'retry-required';
    current.vendorOptions.mekaCombatPhase = 'server-capability-retry';
    return 'retry-required';
  }

  const report = parseAutoBridgeReport(input.message);
  if (!report) {
    activeDispatches.delete(input.leadSessionId);
    current.vendorOptions.mekaCombatServerCapabilityStatus = 'retry-required';
    current.vendorOptions.mekaCombatPhase = 'server-capability-retry';
    return 'retry-required';
  }

  current.report = normalizeCapabilityReport(report);
  current.state = 'report-ready';
  current.vendorOptions.mekaCombatServerCapabilityStatus = 'report-ready';
  current.vendorOptions.mekaCombatPhase = 'server-capability-report-validation';
  return 'report-ready';
}

/** Undo only the exact receipt whose accepted delivery was rolled back. */
export function rollbackCombatServerCapabilityAutoBridge(input: {
  leadSessionId: string;
  workerId: string;
  workerSessionId: string;
  message: string;
}): boolean {
  const current = activeDispatches.get(input.leadSessionId);
  if (!current || current.state !== 'report-ready' || !current.report) return false;
  const matchesWorker =
    current.workerId === input.workerId ||
    current.workerSessionId === input.workerSessionId ||
    current.requestedWorkerRef === input.workerId ||
    current.requestedWorkerRef === input.workerSessionId;
  const report = parseAutoBridgeReport(input.message);
  if (
    !matchesWorker ||
    !report ||
    canonicalJson(current.report) !== canonicalJson(normalizeCapabilityReport(report))
  ) {
    return false;
  }
  current.report = null;
  current.state = 'pending';
  current.vendorOptions.mekaCombatServerCapabilityStatus = 'pending';
  current.vendorOptions.mekaCombatPhase = 'server-capability-check';
  return true;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

export function consumeTrustedCombatServerCapabilityReport(input: {
  leadSessionId: string | undefined;
  report: Record<string, unknown>;
}): { ok: true } | { ok: false; reason: 'not-ready' | 'report-mismatch' } {
  const leadSessionId = input.leadSessionId?.trim();
  if (!leadSessionId) return { ok: false, reason: 'not-ready' };
  const current = activeDispatches.get(leadSessionId);
  if (current?.state !== 'report-ready' || !current.report) {
    return { ok: false, reason: 'not-ready' };
  }
  if (canonicalJson(current.report) !== canonicalJson(normalizeCapabilityReport(input.report))) {
    return { ok: false, reason: 'report-mismatch' };
  }
  activeDispatches.delete(leadSessionId);
  return { ok: true };
}

export function rejectTrustedCombatServerCapabilityReport(leadSessionId: string | undefined): void {
  const id = leadSessionId?.trim();
  if (!id) return;
  const current = activeDispatches.get(id);
  if (!current) return;
  activeDispatches.delete(id);
  current.vendorOptions.mekaCombatServerCapabilityStatus = 'retry-required';
  current.vendorOptions.mekaCombatPhase = 'server-capability-retry';
}

export function resetCombatServerCapabilityFlow(input: {
  leadSessionId?: string;
  vendorOptions: Record<string, unknown>;
  phase: 'exploration' | 'environment-recovery';
}): void {
  const id = input.leadSessionId?.trim();
  if (id) activeDispatches.delete(id);
  const options = input.vendorOptions as CombatVendorOptions;
  if (
    options.mekaCombatServerCapabilityStatus !== 'supported' &&
    options.mekaCombatServerCapabilityStatus !== 'unsupported' &&
    options.mekaCombatServerCapabilityStatus !== 'uncertain'
  ) {
    options.mekaCombatServerCapabilityStatus = 'unchecked';
  }
  options.mekaCombatPhase = input.phase;
}

export function hasTrustedCombatServerCapabilityReport(leadSessionId: string | undefined): boolean {
  const id = leadSessionId?.trim();
  return Boolean(id && activeDispatches.get(id)?.state === 'report-ready');
}

export function consumeCombatServerWorkerReadBudget(workerSessionId: string | undefined): {
  allowed: boolean;
  used: number;
  remaining: number;
} {
  const id = workerSessionId?.trim();
  if (!id) {
    return { allowed: false, used: COMBAT_SERVER_WORKER_READ_LIMIT, remaining: 0 };
  }
  const used = workerReadCounts.get(id) ?? 0;
  if (used >= COMBAT_SERVER_WORKER_READ_LIMIT) {
    return { allowed: false, used, remaining: 0 };
  }
  const next = used + 1;
  workerReadCounts.set(id, next);
  return {
    allowed: true,
    used: next,
    remaining: COMBAT_SERVER_WORKER_READ_LIMIT - next,
  };
}

export function consumeCombatLeadEvidenceBudget(sessionId: string | undefined): {
  allowed: boolean;
  used: number;
  remaining: number;
} {
  const id = sessionId?.trim();
  if (!id) {
    return { allowed: false, used: COMBAT_LEAD_EVIDENCE_READ_LIMIT, remaining: 0 };
  }
  const used = leadEvidenceCounts.get(id) ?? 0;
  if (used >= COMBAT_LEAD_EVIDENCE_READ_LIMIT) {
    return { allowed: false, used, remaining: 0 };
  }
  const next = used + 1;
  leadEvidenceCounts.set(id, next);
  return {
    allowed: true,
    used: next,
    remaining: COMBAT_LEAD_EVIDENCE_READ_LIMIT - next,
  };
}

export function resetCombatServerCapabilityState(): void {
  activeDispatches.clear();
  trustedWorkerRemoteHosts.clear();
  workerReadCounts.clear();
  leadEvidenceCounts.clear();
  nextGeneration = 1;
}

export const resetCombatServerCapabilityStateForTests = resetCombatServerCapabilityState;

export function clearCombatServerCapabilitySession(sessionId: string): void {
  activeDispatches.delete(sessionId);
  trustedWorkerRemoteHosts.delete(sessionId);
  workerReadCounts.delete(sessionId);
  leadEvidenceCounts.delete(sessionId);
}

export function getTrustedCombatServerWorkerRemoteHost(
  leadSessionId: string | undefined,
  workerRef: string | undefined,
): string | null {
  const lead = leadSessionId?.trim();
  const ref = workerRef?.trim();
  if (!lead || !ref) return null;
  return trustedWorkerRemoteHosts.get(lead)?.get(ref) ?? null;
}
