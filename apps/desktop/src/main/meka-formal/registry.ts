import type { MekaFormalWorkflowProvider } from './provider.js';

const providers = new Map<string, MekaFormalWorkflowProvider>();

export function registerFormalProvider(provider: MekaFormalWorkflowProvider): void {
  if (providers.has(provider.type)) throw new Error(`formal provider already registered: ${provider.type}`);
  providers.set(provider.type, provider);
}

export function getFormalProvider(type: string | null | undefined): MekaFormalWorkflowProvider | null {
  return type ? providers.get(type) ?? null : null;
}

export function listFormalProviderTypes(): string[] {
  return [...providers.keys()].sort();
}
