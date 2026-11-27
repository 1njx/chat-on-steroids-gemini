import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import pages from '../renderer/setup-images/pages/manifest.json';

/**
 * Setup steps the browser extension does in the person's signed-in tabs, one helper tab at a time:
 * - `plugin-add`: ChatGPT's Add custom MCP server dialog (Setup → ChatGPT, "Add it in ChatGPT for me").
 * - `plugin-permission`: Allow all tools on a plugin's Permissions page, after it is created or
 *   after its first tool call was allowed.
 * - `openai-setup`: a tunnel and a restricted key (Tunnels: Read and Use) at platform.openai.com.
 * One task of each kind, kept in memory only: a restart forgets it and the person presses again.
 * A task carries no secret; the key the extension reads is stored by the caller of `reportSetupTask`.
 */
export type SetupTaskKind = 'plugin-add' | 'plugin-permission' | 'openai-setup';
export type SetupTaskState = 'requested' | 'claimed' | 'done' | 'failed';
export interface SetupTaskStatus {
  id: string;
  kind: SetupTaskKind;
  surface: string | null;
  state: SetupTaskState;
  /** plugin-add: created | exists; plugin-permission: set | already | unavailable; openai-setup: done. */
  outcome: string | null;
  /** openai-setup: which part is finished (tunnel, then key). */
  progress: string | null;
  error: string | null;
}
interface SetupTask extends SetupTaskStatus {
  payload: Record<string, unknown>;
  owner: string | null;
  claimedAt: number;
}

/** A page that claimed a task and then went quiet gives it back after this. */
export const SETUP_TASK_CLAIM_MS = 120_000;
export const TUNNEL_ID = /^tunnel_[0-9a-f]{32}$/;
export const OPENAI_KEY = /^sk-[A-Za-z0-9_-]{20,300}$/;
const APP_ID = /^asdk_app_[a-zA-Z0-9_-]{1,160}$/;

/** ChatGPT's Add button and its "Add custom MCP server" item, in every language Setup shows. */
const labels = (key: 'add' | 'item') => [...new Set(Object.values(pages['plugin-add'] as Record<string, { labels: Record<string, string> }>)
  .map(entry => entry.labels[key]).filter((label): label is string => typeof label === 'string' && label.length > 0))];

const pluginAddSchema = z.object({
  surface: z.enum(['core', 'desktop']),
  name: z.string().trim().min(1).max(80),
  description: z.string().max(1000),
  tunnelId: z.string().regex(/^tunnel_[a-zA-Z0-9]{8,80}$/).optional(),
  url: z.string().max(600).regex(/^https:\/\/[^\s]+$/).optional()
}).refine(value => !!value.tunnelId !== !!value.url, 'tunnelId or url');

const tasks = new Map<SetupTaskKind, SetupTask>();

function queue(kind: SetupTaskKind, surface: string | null, payload: Record<string, unknown>): string {
  const id = randomUUID();
  tasks.set(kind, { id, kind, surface, state: 'requested', outcome: null, progress: null, error: null, payload, owner: null, claimedAt: 0 });
  return id;
}

export function requestPluginAdd(input: unknown): { ok: true; id: string } | { ok: false; error: string } {
  const parsed = pluginAddSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid-request' };
  const { surface, ...rest } = parsed.data;
  return { ok: true, id: queue('plugin-add', surface, { ...rest, addLabels: labels('add'), itemLabels: labels('item') }) };
}

export function requestPluginPermission(appId: string, name: string, surface: string | null = null): { ok: true; id: string } | { ok: false; error: string } {
  if (!APP_ID.test(appId) || !name || name.length > 120) return { ok: false, error: 'invalid-request' };
  return { ok: true, id: queue('plugin-permission', surface, { appId, name }) };
}

export function requestOpenaiSetup(names: { tunnelName: string; keyName: string; knownTunnelId?: string }): { ok: true; id: string } | { ok: false; error: string } {
  const schema = z.object({ tunnelName: z.string().trim().min(1).max(60), keyName: z.string().trim().min(1).max(60),
    knownTunnelId: z.string().regex(TUNNEL_ID).optional().catch(undefined) });
  const parsed = schema.safeParse(names);
  if (!parsed.success) return { ok: false, error: 'invalid-request' };
  return { ok: true, id: queue('openai-setup', null, { ...parsed.data, tunnelDescription: 'Gem Web Code on this computer' }) };
}

/** What the extension's status pass offers: open tasks, a lapsed claim offered again. */
export function pendingSetupTasks(now = Date.now()): Array<{ id: string; kind: SetupTaskKind; state: 'requested' | 'claimed'; progress: string | null } & Record<string, unknown>> {
  const out: Array<{ id: string; kind: SetupTaskKind; state: 'requested' | 'claimed'; progress: string | null } & Record<string, unknown>> = [];
  for (const task of tasks.values()) {
    if (task.state === 'claimed' && now - task.claimedAt > SETUP_TASK_CLAIM_MS) Object.assign(task, { state: 'requested', owner: null });
    if (task.state === 'requested' || task.state === 'claimed')
      out.push({ ...task.payload, id: task.id, kind: task.kind, state: task.state, progress: task.progress });
  }
  return out;
}

const reportSchema = z.object({
  id: z.string().uuid(),
  client: z.string().min(1).max(80),
  action: z.enum(['claim', 'progress', 'done', 'fail']),
  outcome: z.string().max(40).optional(),
  progress: z.enum(['tunnel', 'key']).optional(),
  appId: z.string().optional(),
  tunnelId: z.string().optional(),
  key: z.string().optional(),
  error: z.string().max(500).optional()
});

export type SetupTaskEffect =
  | { kind: 'tunnel'; tunnelId: string }
  | { kind: 'key'; key: string }
  | { kind: 'permission'; appId: string; name: string; surface: string | null };

/**
 * One page claims a task; only that page may move it on. `client: 'background'` may fail a task
 * nobody claimed (the helper tab landed on a sign-in page). Returns what the caller must apply
 * (a tunnel ID to save, a key for the secret store, a permission task to queue), or null if refused.
 */
export function reportSetupTask(body: unknown, now = Date.now()): SetupTaskEffect[] | null {
  const parsed = reportSchema.safeParse(body);
  if (!parsed.success) return null;
  const report = parsed.data;
  pendingSetupTasks(now); // lapse a stale claim first
  const task = [...tasks.values()].find(candidate => candidate.id === report.id);
  if (!task) return null;
  if (report.action === 'claim') {
    if (task.state !== 'requested' || report.client === 'background') return null;
    Object.assign(task, { state: 'claimed', owner: report.client, claimedAt: now });
    return [];
  }
  const owned = task.state === 'claimed' && task.owner === report.client;
  const unclaimedFail = report.action === 'fail' && report.client === 'background' && task.state === 'requested';
  if (!owned && !unclaimedFail) return null;
  if (report.action === 'fail') {
    Object.assign(task, { state: 'failed', error: (report.error || 'The page did not finish this step').slice(0, 300) });
    return [];
  }
  task.claimedAt = now;
  if (report.action === 'progress') {
    if (task.kind !== 'openai-setup') return null;
    if (report.progress === 'tunnel' && report.tunnelId && TUNNEL_ID.test(report.tunnelId)) {
      task.progress = 'tunnel';
      return [{ kind: 'tunnel', tunnelId: report.tunnelId }];
    }
    if (report.progress === 'key' && task.progress === 'tunnel' && report.key && OPENAI_KEY.test(report.key)) {
      task.progress = 'key';
      return [{ kind: 'key', key: report.key }];
    }
    return null;
  }
  // done
  const allowed: Record<SetupTaskKind, string[]> = { 'plugin-add': ['created', 'exists'], 'plugin-permission': ['set', 'already', 'unavailable'], 'openai-setup': ['done'] };
  if (!report.outcome || !allowed[task.kind].includes(report.outcome)) return null;
  if (task.kind === 'openai-setup' && task.progress !== 'key') return null;
  Object.assign(task, { state: 'done', outcome: report.outcome });
  if (task.kind === 'plugin-add' && report.appId && APP_ID.test(report.appId))
    return [{ kind: 'permission', appId: report.appId, name: String(task.payload.name), surface: task.surface }];
  return [];
}

export function setupTaskStatus(kind: SetupTaskKind): SetupTaskStatus | null {
  const task = tasks.get(kind);
  if (!task) return null;
  const { id, surface, state, outcome, progress, error } = task;
  return { id, kind, surface, state, outcome, progress, error };
}

/** Tests only. */
export function resetSetupTasks(): void { tasks.clear(); }
