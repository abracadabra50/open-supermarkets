import { getManifest } from './providers/registry.js';
import type { ProviderName } from './providers/index.js';

export type McpCapability = 'search' | 'basket';

export interface ProviderAccess {
  error: string | null;
  requiresStoredSession: boolean;
}

/** Resolve MCP access rules from the provider manifest. */
export function getProviderAccess(provider: ProviderName, capability: McpCapability): ProviderAccess {
  const manifest = getManifest(provider);
  if (!manifest.capabilities.includes(capability)) {
    return {
      error: `${manifest.label} does not support ${capability} operations.`,
      requiresStoredSession: false,
    };
  }
  return {
    error: null,
    requiresStoredSession: manifest.auth !== 'anonymous' && manifest.auth !== 'none',
  };
}
