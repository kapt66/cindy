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
let nextGeneration = 1;

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
  const hasModuleEvidence = /skill-entry-model|entrymodel|模块(?:图|链|能力)/i.test(task);
  const hasAtomicMatrix = /(?:atomic|原子)(?:[\s_-]*(?:capabilit|能力|matrix|矩阵))/i.test(task);
  const hasResidualQuestion = /(?:residual|remaining|gap|缺口|待核查|剩余)/i.test(task);
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
    task: input.task,
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
  if (!current || current.kind !== input.kind || current.task !== input.task) return false;

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

  current.report = report;
  current.state = 'report-ready';
  current.vendorOptions.mekaCombatServerCapabilityStatus = 'report-ready';
  current.vendorOptions.mekaCombatPhase = 'server-capability-report-validation';
  return 'report-ready';
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
  if (canonicalJson(current.report) !== canonicalJson(input.report)) {
    return { ok: false, reason: 'report-mismatch' };
  }
  activeDispatches.delete(leadSessionId);
  return { ok: true };
}

export function rejectTrustedCombatServerCapabilityReport(
  leadSessionId: string | undefined,
): void {
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

export function hasTrustedCombatServerCapabilityReport(
  leadSessionId: string | undefined,
): boolean {
  const id = leadSessionId?.trim();
  return Boolean(id && activeDispatches.get(id)?.state === 'report-ready');
}

export function resetCombatServerCapabilityState(): void {
  activeDispatches.clear();
  trustedWorkerRemoteHosts.clear();
  nextGeneration = 1;
}

export const resetCombatServerCapabilityStateForTests = resetCombatServerCapabilityState;

export function clearCombatServerCapabilitySession(sessionId: string): void {
  activeDispatches.delete(sessionId);
  trustedWorkerRemoteHosts.delete(sessionId);
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
