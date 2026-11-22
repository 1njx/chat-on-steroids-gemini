import { randomUUID } from 'node:crypto';
import { z } from 'zod';

/**
 * "Add it in ChatGPT for me": one plugin to create through ChatGPT's own Add custom MCP server
 * dialog, in a ChatGPT tab the extension opens. One request at a time, kept in memory only: a
 * restart forgets it, and the person presses the button again.
 */
export type PluginAddState = 'requested' | 'claimed' | 'done' | 'failed';
export interface PluginAddStatus {
  id: string;
  surface: string;
  state: PluginAddState;
  outcome: 'created' | 'exists' | null;
  error: string | null;
}
interface PluginAdd extends PluginAddStatus {
  name: string;
  description: string;
  tunnelId: string | null;
  url: string | null;
  owner: string | null;
  claimedAt: number;
}

/** A page that claimed the request and then went quiet gives it back after this. */
export const PLUGIN_ADD_CLAIM_MS = 90_000;

const requestSchema = z.object({
  surface: z.enum(['core', 'desktop']),
  name: z.string().trim().min(1).max(80),
  description: z.string().max(1000),
  tunnelId: z.string().regex(/^tunnel_[a-zA-Z0-9]{8,80}$/).optional(),
  url: z.string().max(600).regex(/^https:\/\/[^\s]+$/).optional()
}).refine(value => !!value.tunnelId !== !!value.url, 'tunnelId or url');

let current: PluginAdd | null = null;

export function requestPluginAdd(input: unknown): { ok: true; id: string } | { ok: false; error: string } {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid-request' };
  const { surface, name, description, tunnelId, url } = parsed.data;
  current = { id: randomUUID(), surface, name, description, tunnelId: tunnelId ?? null, url: url ?? null,
    state: 'requested', outcome: null, error: null, owner: null, claimedAt: 0 };
  return { ok: true, id: current.id };
}

/** What the extension's status pass offers: the open request, a lapsed claim offered again. */
export function pendingPluginAdds(now = Date.now()): Array<{ id: string; state: 'requested' | 'claimed'; name: string; description: string; tunnelId?: string; url?: string }> {
  if (!current || (current.state !== 'requested' && current.state !== 'claimed')) return [];
  if (current.state === 'claimed' && now - current.claimedAt > PLUGIN_ADD_CLAIM_MS) { current.state = 'requested'; current.owner = null; }
  const { id, state, name, description, tunnelId, url } = current;
  return [{ id, state: state as 'requested' | 'claimed', name, description, ...(tunnelId ? { tunnelId } : {}), ...(url ? { url } : {}) }];
}

const reportSchema = z.object({
  id: z.string().uuid(),
  client: z.string().min(1).max(64),
  action: z.enum(['claim', 'done', 'fail']),
  outcome: z.enum(['created', 'exists']).optional(),
  error: z.string().max(500).optional()
});

/** One page claims the request; only that page may finish it. */
export function reportPluginAdd(body: unknown, now = Date.now()): boolean {
  const parsed = reportSchema.safeParse(body);
  if (!parsed.success || !current || current.id !== parsed.data.id) return false;
  const { client, action, outcome, error } = parsed.data;
  pendingPluginAdds(now); // lapse a stale claim first
  if (action === 'claim') {
    if (current.state !== 'requested') return false;
    Object.assign(current, { state: 'claimed', owner: client, claimedAt: now });
    return true;
  }
  if (current.state !== 'claimed' || current.owner !== client) return false;
  if (action === 'done') {
    if (!outcome) return false;
    Object.assign(current, { state: 'done', outcome });
  } else {
    Object.assign(current, { state: 'failed', error: (error || 'ChatGPT did not create the plugin').slice(0, 300) });
  }
  return true;
}

export function pluginAddStatus(): PluginAddStatus | null {
  if (!current) return null;
  const { id, surface, state, outcome, error } = current;
  return { id, surface, state, outcome, error };
}

/** Tests only. */
export function resetPluginAdd(): void { current = null; }
