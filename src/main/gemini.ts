/**
 * Gemini web provider: the one owner of what the companion sees on gemini.google.com, the
 * account's observed Gemini modes, and the queue of prompts the app sends to Gemini.
 *
 * Tool use does not run through here. Gemini calls this app's Core/Desktop/Plugins MCP connector
 * itself once the person added it under Gemini → Connectors → Custom; those calls go through the
 * same MCP kernel, permissions and recording as ChatGPT's. This module drives and observes the
 * page only.
 *
 * Delivery is at-most-once. A command is handed to exactly one tab; that tab must be authorized
 * (`sending`) before it presses Send; once authorized it is never handed out again. A send whose
 * outcome was not observed ends `unknown` — never `completed` and never resent.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { readDurable, writeDurableSoon } from './durable.js';
import { logInfo, logWarn } from './logger.js';
import { recordChatObservations, type ChatObservation } from './session/recorder.js';
import { GEMINI_NATIVE_ID, PROVIDERS, geminiConversationKey } from '../shared/providers.js';
import { geminiUrlFingerprint, type GeminiCommandSummary, type GeminiMode, type GeminiStatus, type GeminiThinkingLevel } from '../shared/gemini.js';

export const PAGE_LIVE_MS = 60_000;
const QUEUE_MS = 3 * 60_000;
/** Gemini's custom apps page: the one address "Add it in Gemini for me" opens in the default browser. */
export const GEMINI_CUSTOM_APPS_URL = 'https://gemini.google.com/customize/connectors';
/**
 * How long a fill waits for the custom apps page the default browser opened before the extension
 * opens one itself (in its own browser, when that is not the default one).
 */
export const FILL_OPEN_FALLBACK_MS = 15_000;
const CLAIM_MS = 2 * 60_000;
const SENDING_MS = 60_000;
const ANSWER_MS = 35 * 60_000;
const MAX_PROMPT = 100_000;
const MAX_COMMANDS = 40;
const MAX_NAVIGATIONS = 3;
/** A saved model list older than this is read again when a signed-in page reports. */
export const MODES_STALE_MS = 24 * 60 * 60_000;
/** After a failed read, no automatic read for this long (Refresh still reads at once). */
export const MODES_BACKOFF_MS = 10 * 60_000;
// Queue timeouts mean no page took the read, not that reading failed: no backoff for those.
const NOT_A_READ_FAILURE = ['gemini-page-not-connected', 'no-ready-gemini-page'];

type Stage = 'queued' | 'claimed' | 'sending' | 'sent' | 'completed' | 'failed' | 'cancelled' | 'unknown';
type Kind = 'send' | 'inspect-modes' | 'stop' | 'fill-app';

interface Command {
  id: string;
  kind: Kind;
  stage: Stage;
  prompt: string | null;
  modeId: string | null;
  thinkingLevel: string | null;
  connector: string | null;
  /** Gemini's native id the send continues, or null for a new chat. */
  conversationId: string | null;
  tab: number | null;
  navigations: number;
  createdAt: number;
  updatedAt: number;
  sentAt: number | null;
  error: string | null;
  sessionId: string | null;
  answerChars: number | null;
  /** fill-app: the https address to fill in Gemini's custom app form. */
  url: string | null;
  outcome: string | null;
  /** Whether the extension may open a Gemini page for this command when none reports. */
  openPage: boolean;
}

const snapshotSchema = z.object({
  url: z.string().max(400).catch(''),
  conversationId: z.string().regex(GEMINI_NATIVE_ID).nullable().catch(null),
  signIn: z.enum(['signed-in', 'signed-out', 'unknown']).catch('unknown'),
  account: z.object({ name: z.string().max(120).nullable().catch(null), plan: z.string().max(20).nullable().catch(null) }).nullable().catch(null),
  selectedMode: z.string().max(80).nullable().catch(null),
  composerReady: z.boolean().catch(false),
  generating: z.boolean().catch(false),
  turnCount: z.number().int().min(0).max(100_000).catch(0),
  errors: z.array(z.object({ text: z.string().max(500), quota: z.boolean().catch(false), signedOut: z.boolean().catch(false) })).max(5).catch([]),
  localized: z.boolean().catch(false),
});
type Snapshot = z.infer<typeof snapshotSchema>;

const modeSchema = z.object({
  id: z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/),
  title: z.string().max(80),
  model: z.string().max(60).nullable(),
  available: z.boolean(),
  selected: z.boolean(),
  reason: z.string().max(40).nullable(),
  levels: z.array(z.string().min(1).max(20)).max(8).nullable().catch(null).default(null),
});
const FINGERPRINT = z.string().regex(/^[0-9a-f]{14}$/);
const HOSTNAME = z.string().trim().toLowerCase().max(253).regex(/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/);
const HTTPS_URL = z.string().max(600).url().refine(url => url.startsWith('https://'));
const levelSchema = z.object({ label: z.string().min(1).max(20), selected: z.boolean().catch(false), available: z.boolean().catch(true) });
const settingsSchema = z.object({
  connectorName: z.string().trim().min(1).max(80).nullable().catch(null),
  defaultModeId: z.string().max(80).regex(/^[A-Za-z0-9_-]+$/).nullable().catch(null),
  defaultThinkingLevel: z.string().max(20).nullable().catch(null),
  // A Cloudflare quick tunnel for Gemini beside the OpenAI one (connection.ts), so ChatGPT keeps its tunnel.
  httpsTunnel: z.boolean().catch(false),
  givenUrlHash: FINGERPRINT.nullable().catch(null),
  // The address Gemini's list showed exactly once under the connector's name after "Add it in Gemini for me".
  verifiedUrlHash: FINGERPRINT.nullable().catch(null),
  namedTunnelHost: HOSTNAME.nullable().catch(null),
});
export type GeminiSettings = z.infer<typeof settingsSchema>;

const pages = new Map<number, { snapshot: Snapshot; seenAt: number }>();
let commands: Command[] = [];
let catalog: { modes: GeminiMode[]; thinkingLevels: GeminiThinkingLevel[]; observedAt: number } | null = null;
/** The last failed read of Gemini's model picker; cleared by a successful read. */
let modesFailure: { error: string; at: number } | null = null;
const NO_SETTINGS: GeminiSettings = { connectorName: null, defaultModeId: null, defaultThinkingLevel: null, httpsTunnel: false, givenUrlHash: null, verifiedUrlHash: null, namedTunnelHost: null };
let settings: GeminiSettings = { ...NO_SETTINGS };
let changed = (): void => {};
/** Opens the custom apps page in the default browser (ipc.ts: Electron's shell.openExternal). */
let openCustomApps = (): unknown => undefined;
/** Asks the Core address from outside, through the tunnel (ipc.ts); true when this app's MCP server answered. */
let probeAddress = (_url: string): unknown => false;
let sweepTimer: ReturnType<typeof setInterval> | null = null;

export function configureGemini(options: { changed: () => void; openCustomApps?: () => unknown; probeAddress?: (url: string) => unknown }): void {
  changed = options.changed;
  if (options.openCustomApps) openCustomApps = options.openCustomApps;
  if (options.probeAddress) probeAddress = options.probeAddress;
  if (!sweepTimer) { sweepTimer = setInterval(() => { if (sweep()) changed(); followGeminiAddress(followedUrl); }, 10_000); sweepTimer.unref?.(); }
}

export async function restoreGemini(): Promise<void> {
  const saved = z.object({
    settings: settingsSchema.catch(settings),
    catalog: z.object({ modes: z.array(modeSchema).max(20), thinkingLevels: z.array(levelSchema).max(8), observedAt: z.number().positive() }).nullable().catch(null),
  }).safeParse(await readDurable('gemini'));
  if (!saved.success) return;
  settings = saved.data.settings;
  catalog = saved.data.catalog;
}

function persist(): void { writeDurableSoon('gemini', { settings, catalog }); }

function livePages(now = Date.now()): Array<[number, Snapshot]> {
  const live: Array<[number, Snapshot]> = [];
  for (const [tab, page] of pages) {
    if (now - page.seenAt <= PAGE_LIVE_MS) live.push([tab, page.snapshot]);
    else pages.delete(tab);
  }
  return live;
}

function finish(command: Command, stage: Stage, error: string | null = null): void {
  command.stage = stage;
  command.error = error;
  command.updatedAt = Date.now();
  if (command.kind === 'inspect-modes' && stage === 'failed' && !NOT_A_READ_FAILURE.includes(error ?? '')) {
    modesFailure = { error: error ?? 'failed', at: command.updatedAt };
  }
  if (stage === 'failed' || stage === 'unknown') logWarn(`gemini: ${command.kind} ${command.id.slice(0, 8)} ${stage}${error ? ` (${error})` : ''}`);
  else logInfo(`gemini: ${command.kind} ${command.id.slice(0, 8)} ${stage}`);
}

/** Expire work nobody can take or that went silent. Returns true when anything changed. */
export function sweep(now = Date.now()): boolean {
  let any = false;
  const live = livePages(now);
  const pagesLive = live.length > 0;
  const signedOutOnly = pagesLive && live.every(([, page]) => page.signIn === 'signed-out');
  for (const command of commands) {
    const age = now - command.updatedAt;
    if (command.stage === 'queued' && age > QUEUE_MS) {
      finish(command, 'failed', !pagesLive ? 'gemini-page-not-connected' : signedOutOnly ? 'signed-out' : 'no-ready-gemini-page'); any = true;
    } else if (command.stage === 'claimed' && age > CLAIM_MS) {
      finish(command, 'failed', 'page-did-not-respond'); any = true;
    } else if (command.stage === 'sending' && age > SENDING_MS) {
      // The page was allowed to press Send and then went silent: it may or may not have been sent.
      finish(command, 'unknown', 'send-outcome-not-observed'); any = true;
    } else if (command.stage === 'sent' && age > ANSWER_MS) {
      finish(command, 'unknown', 'answer-not-observed'); any = true;
    }
  }
  if (commands.length > MAX_COMMANDS) {
    const open = commands.filter(c => !settled(c));
    const done = commands.filter(settled).slice(-(MAX_COMMANDS - Math.min(open.length, MAX_COMMANDS)));
    commands = [...done, ...open].sort((a, b) => a.createdAt - b.createdAt);
    any = true;
  }
  return any;
}

const settled = (c: Command): boolean => ['completed', 'failed', 'cancelled', 'unknown'].includes(c.stage);

function eligible(command: Command, tab: number, page: Snapshot, live: Array<[number, Snapshot]>): boolean {
  if (page.signIn !== 'signed-in') return false;
  if (command.kind === 'stop') return page.conversationId === command.conversationId;
  // Filling the custom app form needs no composer: any idle page can open the custom apps page.
  if (command.kind === 'fill-app') return !page.generating;
  if (!page.composerReady) {
    // A page without a composer (custom apps, settings) opens a chat page for a send, when no page with
    // one can take it: otherwise a send waited for a page that never came (seen live 2026-11-24 after
    // "Add it in Gemini for me" left only the custom apps page open).
    return command.kind === 'send' && !page.generating &&
      !live.some(([other, p]) => other !== tab && p.signIn === 'signed-in' && p.composerReady && !p.generating);
  }
  if (command.kind === 'inspect-modes') return !page.generating;
  if (page.generating) return false;
  if (command.conversationId) {
    // Prefer the tab already showing that conversation; navigate another only when none does.
    if (page.conversationId === command.conversationId) return true;
    return !live.some(([other, p]) => other !== tab && p.conversationId === command.conversationId);
  }
  // A new chat prefers an empty chat page, but any idle page can navigate to /app. Only a page that
  // could take it counts: custom apps pages also have no conversation, and a chat page deferring to
  // them while they deferred to it failed every send (no-ready-gemini-page, seen live 2026-11-25).
  return page.conversationId === null || !live.some(([other, p]) => other !== tab && p.conversationId === null && p.composerReady && p.signIn === 'signed-in' && !p.generating);
}

function wire(command: Command): Record<string, unknown> {
  return {
    id: command.id, kind: command.kind, prompt: command.prompt, modeId: command.modeId,
    thinkingLevel: command.thinkingLevel, connector: command.connector, conversationId: command.conversationId,
    ...(command.kind === 'fill-app' ? { url: command.url } : {}),
  };
}

/** An idle signed-in page reads the models by itself when none are saved or they are stale: one read at a time, none during backoff. */
function modesWanted(page: Snapshot, now: number): boolean {
  if (page.signIn !== 'signed-in' || !page.composerReady || page.generating) return false;
  // A list saved before levels were read per model (2.2.17 and older) is read again; a newer one that
  // missed one model's levels waits for the usual 24 h, so a model that will not switch is not retried on every report.
  const levelsKnown = catalog?.modes.some(mode => Array.isArray(mode.levels));
  if (catalog && levelsKnown && now - catalog.observedAt < MODES_STALE_MS) return false;
  if (modesFailure && now - modesFailure.at < MODES_BACKOFF_MS) return false;
  // Not while other work waits or runs: the read switches models, and a send meanwhile failed (seen live 2026-11-25).
  return !commands.some(c => !settled(c));
}

/** A Gemini page's report. Returns the commands this exact tab should run now. */
export function observeGeminiPage(body: unknown, now = Date.now()): { ok: boolean; commands: Array<Record<string, unknown>> } {
  const parsed = z.object({ tab: z.number().int().nonnegative(), snapshot: z.unknown() }).safeParse(body);
  if (!parsed.success) return { ok: false, commands: [] };
  const snapshot = snapshotSchema.parse(parsed.data.snapshot ?? {});
  const { tab } = parsed.data;
  const before = JSON.stringify(pages.get(tab)?.snapshot ?? null);
  pages.set(tab, { snapshot, seenAt: now });
  if (modesWanted(snapshot, now)) {
    logInfo(`gemini: reading Gemini's models (${catalog ? 'saved list older than 24 h' : 'no saved list'})`);
    newCommand('inspect-modes', { openPage: false }, now);
  }
  const live = livePages(now);
  const handed: Array<Record<string, unknown>> = [];
  // One command per page at a time, Stop aside: a model read handed to a page that was sending
  // switched the model under the send, and both failed (seen live 2026-11-25).
  let busy = commands.some(c => c.tab === tab && c.kind !== 'stop' && ['claimed', 'sending', 'sent'].includes(c.stage));
  for (const command of commands) {
    // A claimed command goes back only to its own tab (after that tab navigated for it).
    if (command.stage === 'claimed' && command.tab === tab) { handed.push(wire(command)); continue; }
    if (command.stage !== 'queued' || !eligible(command, tab, snapshot, live)) continue;
    if (busy && command.kind !== 'stop') continue;
    command.stage = 'claimed'; command.tab = tab; command.updatedAt = now;
    handed.push(wire(command));
    if (command.kind !== 'stop') busy = true;
  }
  if (handed.length || before !== JSON.stringify(snapshot)) changed();
  return { ok: true, commands: handed };
}

const resultSchema = z.object({
  id: z.string().uuid(),
  tab: z.number().int().nonnegative(),
  stage: z.enum(['navigating', 'sending', 'sent', 'completed', 'failed']),
  conversationId: z.string().regex(GEMINI_NATIVE_ID).nullable().optional(),
  turnId: z.string().max(80).nullable().optional(),
  answer: z.string().max(512_000).optional(),
  answerHtml: z.string().max(512_000).optional(),
  error: z.string().max(600).optional(),
  quota: z.boolean().optional(),
  signedOut: z.boolean().optional(),
  connector: z.string().max(80).optional(),
  modes: z.array(z.unknown()).max(20).optional(),
  thinkingLevels: z.array(z.unknown()).max(8).optional(),
  outcome: z.enum(['filled', 'connected', 'current', 'old']).optional(),
  existingUrl: z.string().max(600).optional(),
  verified: z.boolean().optional(),
});

/** A page's progress on a command it was handed. Only the tab holding the command may report it. */
export async function completeGeminiCommand(body: unknown, now = Date.now()): Promise<{ ok: boolean; authorized?: boolean }> {
  const parsed = resultSchema.safeParse(body);
  if (!parsed.success) return { ok: false };
  const result = parsed.data;
  const command = commands.find(c => c.id === result.id);
  if (!command || command.tab !== result.tab || settled(command)) return { ok: false };
  command.updatedAt = now;
  if (result.stage === 'navigating') {
    if (command.stage !== 'claimed') return { ok: false };
    command.navigations += 1;
    if (command.navigations > MAX_NAVIGATIONS) finish(command, 'failed', 'navigation-loop');
    changed();
    return { ok: true };
  }
  if (result.stage === 'sending') {
    if (command.stage !== 'claimed') { changed(); return { ok: true, authorized: false }; }
    command.stage = 'sending';
    changed();
    return { ok: true, authorized: true };
  }
  if (result.stage === 'sent') {
    if (command.stage !== 'sending') return { ok: false };
    command.stage = 'sent'; command.sentAt = now;
    command.conversationId = result.conversationId ?? command.conversationId;
    changed();
    return { ok: true };
  }
  if (result.stage === 'failed') {
    // A failure after Gemini accepted the prompt keeps that fact: it was sent, the answer failed.
    const error = result.error ?? 'failed';
    const wasSent = command.stage === 'sent';
    finish(command, 'failed', wasSent ? `sent; ${error}` : error);
    const conversationId = result.conversationId ?? command.conversationId;
    if (command.kind === 'send' && wasSent && conversationId) {
      command.conversationId = conversationId;
      await recordTurn(command, conversationId, result.turnId ?? null, null, error);
    }
    changed();
    return { ok: true };
  }
  // completed
  if (command.kind === 'inspect-modes') {
    const modes = z.array(modeSchema).safeParse(result.modes ?? []);
    const levels = z.array(levelSchema).safeParse(result.thinkingLevels ?? []);
    if (!modes.success || !modes.data.length || !levels.success) { finish(command, 'failed', 'mode-list-invalid'); changed(); return { ok: true }; }
    catalog = { modes: modes.data, thinkingLevels: levels.data, observedAt: now };
    modesFailure = null;
    persist();
    finish(command, 'completed');
    changed();
    return { ok: true };
  }
  if (command.kind === 'fill-app') {
    if (!result.outcome) { finish(command, 'failed', 'custom-apps-layout-unknown'); changed(); return { ok: true }; }
    command.outcome = result.outcome;
    // Remember which address Gemini has (read on its page) or was given (filled in), never the address itself.
    const given = result.outcome === 'filled' || result.outcome === 'connected' ? command.url : HTTPS_URL.safeParse(result.existingUrl).data;
    if (given) settings.givenUrlHash = geminiUrlFingerprint(given);
    // Verified: the page saw exactly one app with the name afterwards, holding this command's address.
    settings.verifiedUrlHash = result.verified && command.url && given === command.url ? geminiUrlFingerprint(command.url) : null;
    persist();
    finish(command, 'completed');
    changed();
    return { ok: true };
  }
  if (command.kind === 'send') {
    if (command.stage !== 'sent') return { ok: false };
    const conversationId = result.conversationId ?? command.conversationId;
    if (!conversationId) { finish(command, 'unknown', 'conversation-id-not-observed'); changed(); return { ok: true }; }
    command.conversationId = conversationId;
    command.answerChars = (result.answer ?? '').length;
    await recordTurn(command, conversationId, result.turnId ?? null, result.answer ?? '', null, result.answerHtml);
    finish(command, 'completed');
    changed();
    return { ok: true };
  }
  finish(command, 'completed');
  changed();
  return { ok: true };
}

async function recordTurn(command: Command, nativeId: string, turnId: string | null, answer: string | null, error: string | null, html?: string): Promise<void> {
  const key = geminiConversationKey(nativeId);
  if (!key) return;
  const turn = turnId ?? `cos-${command.id}`;
  const sentAt = command.sentAt ?? command.createdAt;
  const model = modeLabel(command.modeId);
  const observations: ChatObservation[] = [
    { kind: 'turn_start', time: sentAt, turnId: turn },
    { kind: 'user_message', time: sentAt, messageId: `${turn}:user`, turnId: turn, text: command.prompt ?? '', authoredNow: true, ...(model ? { model } : {}) },
  ];
  const now = Date.now();
  if (answer !== null) {
    observations.push({ kind: 'assistant_message', time: now, messageId: `${turn}:answer`, turnId: turn, text: answer, final: true, state: 'final',
      ...(html ? { renderedHtml: html } : {}), ...(model ? { resolvedModel: model } : {}) });
  }
  if (error) observations.push({ kind: 'chat_error', time: now, turnId: turn, text: error, recoverable: false });
  observations.push({ kind: 'turn_end', time: now, turnId: turn, outcome: error ? 'failed' : 'completed' });
  try {
    const recorded = await recordChatObservations(key, observations);
    command.sessionId = recorded.sessionId;
  } catch (cause) {
    logWarn(`gemini: could not record turn ${turn}: ${(cause as Error).message}`);
  }
}

function modeLabel(modeId: string | null): string | null {
  if (!modeId) return null;
  const mode = catalog?.modes.find(m => m.id === modeId);
  return mode ? (mode.model ?? mode.title) : null;
}

export interface GeminiSendRequest {
  prompt: string;
  modeId?: string | null;
  thinkingLevel?: string | null;
  /** Continue this recorded conversation (`gemini:<id>` key or native id); omit for a new chat. */
  conversation?: string | null;
  /** @-mention this connected app (defaults to the configured connector name; null for none). */
  connector?: string | null;
}

const sendSchema = z.object({
  prompt: z.string().trim().min(1).max(MAX_PROMPT),
  modeId: z.string().max(80).regex(/^[A-Za-z0-9_-]+$/).nullable().optional(),
  thinkingLevel: z.string().max(20).nullable().optional(),
  conversation: z.string().max(80).nullable().optional(),
  connector: z.string().trim().max(80).nullable().optional(),
});

/** The app's name in Gemini when none is set (the name "Add it in Gemini for me" looks for). */
export const GEMINI_CORE_NAME = 'Chat On Steroids Core';

/**
 * The app a send @-mentions by default: the set name, else the Core once it was added in Gemini.
 * Without a mention Gemini answers without the app's tools, so an app chat could not see any folder.
 */
function defaultConnector(): string | null {
  return settings.connectorName ?? (settings.givenUrlHash ? GEMINI_CORE_NAME : null);
}

/**
 * The thinking level a send asks for with this model: none when the model offers none (Auto) or
 * not the asked one, so Gemini keeps its own; the asked one when the model's levels are not known.
 */
function levelFor(mode: GeminiMode | null, level: string | null): string | null {
  if (!level || !mode || !Array.isArray(mode.levels)) return level;
  return mode.levels.find(offered => offered.toLowerCase() === level.toLowerCase()) ?? null;
}

/** Queue one prompt. Refuses a mode the account showed as unavailable instead of trying it. */
export function queueGeminiSend(input: GeminiSendRequest): { ok: true; id: string } | { ok: false; error: string } {
  const parsed = sendSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid-request' };
  const request = parsed.data;
  const modeId = request.modeId === undefined ? settings.defaultModeId : request.modeId;
  const mode = modeId ? catalog?.modes.find(m => m.id === modeId) : null;
  if (modeId && mode && !mode.available) return { ok: false, error: mode.reason ?? 'mode-unavailable' };
  let conversationId: string | null = null;
  if (request.conversation) {
    const raw = request.conversation.startsWith('gemini:') ? request.conversation.slice(7) : request.conversation;
    if (!GEMINI_NATIVE_ID.test(raw)) return { ok: false, error: 'invalid-conversation' };
    conversationId = raw;
  }
  if (conversationId && commands.some(c => c.kind === 'send' && c.conversationId === conversationId && !settled(c))) {
    return { ok: false, error: 'conversation-busy' };
  }
  const wanted = request.thinkingLevel === undefined ? settings.defaultThinkingLevel : request.thinkingLevel;
  const command = newCommand('send', {
    prompt: request.prompt, modeId: modeId ?? null,
    thinkingLevel: levelFor(mode ?? null, wanted ?? null),
    connector: request.connector === undefined ? defaultConnector() : request.connector || null,
    conversationId,
  });
  return { ok: true, id: command.id };
}

/**
 * Ask a signed-in Gemini page to read the mode picker (never changes the selection). With
 * `openPage: false` it waits for a page the person opens instead of opening one.
 */
export function requestGeminiModes(options: { openPage?: boolean } = {}): { ok: true; id: string } {
  const openPage = options.openPage !== false;
  const pending = commands.find(c => c.kind === 'inspect-modes' && !settled(c));
  if (pending) { pending.openPage ||= openPage; return { ok: true, id: pending.id }; }
  return { ok: true, id: newCommand('inspect-modes', { openPage }).id };
}

export function stopGemini(conversation: string): { ok: boolean; error?: string } {
  const raw = conversation.startsWith('gemini:') ? conversation.slice(7) : conversation;
  if (!GEMINI_NATIVE_ID.test(raw)) return { ok: false, error: 'invalid-conversation' };
  newCommand('stop', { conversationId: raw });
  return { ok: true };
}

/**
 * Ask a signed-in Gemini page to add the custom app with this address: it deletes every app already
 * there under the connector's name with an old address (and duplicates), then adds and connects
 * the new one (gemini-content.js).
 */
export function queueGeminiFill(url: unknown): { ok: true; id: string } | { ok: false; error: string } {
  const parsed = HTTPS_URL.safeParse(url);
  if (!parsed.success) return { ok: false, error: 'invalid-url' };
  for (const old of commands.filter(c => c.kind === 'fill-app' && !settled(c))) finish(old, 'cancelled');
  const id = newCommand('fill-app', { url: parsed.data, connector: settings.connectorName }).id;
  // The default browser opens the custom apps page in front; the page there takes the command.
  // Only that fixed page is opened, never the Core address (it ends in a secret token).
  try { void Promise.resolve(openCustomApps()).catch(() => undefined); } catch { /* the extension's own fallback still opens it */ }
  return { ok: true, id };
}

/** Automatic re-adds for one address: the first and the retries after a failed one. */
export const AUTO_FILL_TRIES = 3;
export const AUTO_FILL_RETRY_MS = 2 * 60_000;

/** The automatic re-add queued last: its command, the fingerprint of the address it was for, and the tries so far. */
let autoFill: { id: string; urlHash: string; at: number; tries: number } | null = null;
/** Gemini's Core address as last reported (ipc.ts); the sweep follows it too, so a retry needs no status change. */
let followedUrl: string | null = null;
/** The current address (fingerprint) and since when; Gemini's requests count for it only after that. */
let address: { urlHash: string; since: number } | null = null;
/** The last check that the address answers from outside, through the tunnel. */
let reach: { urlHash: string; ok: boolean; at: number } | null = null;
let probing = false;
export const REACH_OK_MS = 5 * 60_000;
export const REACH_RETRY_MS = 30_000;

/** Asks the address from outside once it was given to Gemini: again every REACH_OK_MS, or REACH_RETRY_MS after a failure. */
function checkReach(url: string, urlHash: string, now: number): void {
  if (probing || !settings.givenUrlHash) return;
  if (reach?.urlHash === urlHash && now - reach.at < (reach.ok ? REACH_OK_MS : REACH_RETRY_MS)) return;
  probing = true;
  let answer: Promise<unknown>;
  try { answer = Promise.resolve(probeAddress(url)); } catch { answer = Promise.resolve(false); }
  void answer.then(ok => ok === true, () => false).then(ok => {
    probing = false;
    if (address?.urlHash !== urlHash) return;
    const was = reach?.ok;
    reach = { urlHash, ok, at: Date.now() };
    if (!ok && was !== false) logWarn('gemini: the Core address did not answer through the tunnel');
    if (was !== ok) changed();
  });
}

/** When a failed or unobserved automatic re-add is tried again, or null when it is not. */
function autoFillRetryAt(fill: NonNullable<typeof autoFill>): number | null {
  const last = commands.find(c => c.id === fill.id);
  // Cancelled means the person stopped it or pressed the button themselves: theirs to redo.
  if (!last || !['failed', 'unknown'].includes(last.stage) || fill.tries >= AUTO_FILL_TRIES) return null;
  return last.updatedAt + AUTO_FILL_RETRY_MS;
}

/**
 * A quick tunnel (trycloudflare) gets a new address at every start, which leaves Gemini's custom
 * app on the old one. Once the app was added before (givenUrlHash) and Gemini's connected Core
 * address differs, add it again for that address: never while a fill is pending; a failed or
 * unobserved re-add is tried again after AUTO_FILL_RETRY_MS, AUTO_FILL_TRIES in all per address
 * (each opens the custom apps page in front). Returns whether it queued.
 */
export function followGeminiAddress(url: string | null, now = Date.now()): boolean {
  followedUrl = url;
  if (!url || !HTTPS_URL.safeParse(url).success) return false;
  const urlHash = geminiUrlFingerprint(url);
  if (address?.urlHash !== urlHash) { address = { urlHash, since: now }; reach = null; changed(); }
  checkReach(url, urlHash, now);
  if (!settings.givenUrlHash) return false;
  if (urlHash === settings.givenUrlHash) return false;
  let tries = 1;
  if (urlHash === autoFill?.urlHash) {
    const retryAt = autoFillRetryAt(autoFill);
    if (retryAt === null || now < retryAt) return false;
    tries = autoFill.tries + 1;
  }
  if (commands.some(c => c.kind === 'fill-app' && !settled(c))) return false;
  const queued = queueGeminiFill(url);
  if (!queued.ok) return false;
  autoFill = { id: queued.id, urlHash, at: now, tries };
  logInfo(`gemini app address changed; re-adding it in Gemini (try ${tries} of ${AUTO_FILL_TRIES})`);
  changed();
  return true;
}

/** Withdraw a command that no page has been authorized to send. */
export function cancelGeminiCommand(id: string): { ok: boolean; error?: string } {
  const command = commands.find(c => c.id === id);
  if (!command) return { ok: false, error: 'not-found' };
  if (!['queued', 'claimed'].includes(command.stage)) return { ok: false, error: 'already-sending' };
  finish(command, 'cancelled');
  changed();
  return { ok: true };
}

function newCommand(kind: Kind, fields: Partial<Command>, now = Date.now()): Command {
  const command: Command = {
    id: randomUUID(), kind, stage: 'queued', prompt: null, modeId: null, thinkingLevel: null, connector: null,
    conversationId: null, tab: null, navigations: 0, createdAt: now, updatedAt: now, sentAt: null, error: null,
    sessionId: null, answerChars: null, url: null, outcome: null, openPage: true, ...fields,
  };
  commands.push(command);
  sweep(now);
  changed();
  return command;
}

export function saveGeminiSettings(patch: unknown): { ok: boolean; error?: string } {
  // Saved files recover damaged fields as null (settingsSchema); a person's patch is refused instead.
  const parsed = z.object({
    connectorName: z.string().trim().min(1).max(80).nullable(),
    defaultModeId: z.string().max(80).regex(/^[A-Za-z0-9_-]+$/).nullable(),
    defaultThinkingLevel: z.string().max(20).nullable(),
    httpsTunnel: z.boolean(),
    givenUrlHash: FINGERPRINT.nullable(),
    namedTunnelHost: HOSTNAME.nullable(),
  }).partial().strict().safeParse(patch);
  if (!parsed.success) return { ok: false, error: 'invalid-settings' };
  settings = { ...settings, ...Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined)) };
  persist();
  changed();
  return { ok: true };
}

/** Whether the person asked for Gemini's own https tunnel next to the OpenAI one. */
export function geminiWantsHttpsTunnel(): boolean { return settings.httpsTunnel; }

/** The hostname of the person's own Cloudflare tunnel for Gemini, or null for a quick tunnel. */
export function geminiNamedTunnelHost(): string | null { return settings.namedTunnelHost; }

/** Pages the extension should open: only when work waits and no Gemini page is reporting at all. */
export function geminiPagesToOpen(now = Date.now()): string[] {
  if (livePages(now).length) return [];
  const waiting = commands.find(c => c.stage === 'queued' && c.kind !== 'stop' && c.openPage);
  if (!waiting) return [];
  // The default browser was asked first; the extension opens its own page only if none reported by then.
  if (waiting.kind === 'fill-app') return now - waiting.createdAt >= FILL_OPEN_FALLBACK_MS ? [GEMINI_CUSTOM_APPS_URL] : [];
  return [waiting.conversationId ? `${PROVIDERS.gemini.origin}/app/${waiting.conversationId}` : `${PROVIDERS.gemini.origin}/app`];
}

export function geminiStatus(now = Date.now()): GeminiStatus {
  const live = livePages(now);
  const signedIn = live.find(([, p]) => p.signIn === 'signed-in')?.[1] ?? null;
  const any = signedIn ?? live[0]?.[1] ?? null;
  const summary = (c: Command): GeminiCommandSummary => ({
    id: c.id, kind: c.kind, stage: c.stage, error: c.error, createdAt: c.createdAt, updatedAt: c.updatedAt,
    conversation: c.conversationId ? `gemini:${c.conversationId}` : null, sessionId: c.sessionId,
    modeId: c.modeId, promptPreview: c.prompt ? c.prompt.slice(0, 120) : null, answerChars: c.answerChars, outcome: c.outcome,
  });
  return {
    pages: live.length,
    signIn: any ? (live.some(([, p]) => p.signIn === 'signed-in') ? 'signed-in' : any.signIn) : null,
    account: signedIn?.account ?? null,
    selectedMode: signedIn?.selectedMode ?? null,
    localized: live.some(([, p]) => p.localized),
    errors: any?.errors.map(e => e.text) ?? [],
    quotaLimited: live.some(([, p]) => p.errors.some(e => e.quota)),
    catalog: catalog ? structuredClone(catalog) : null,
    modesFailure: modesFailure ? { ...modesFailure, retryAt: modesFailure.at + MODES_BACKOFF_MS } : null,
    settings: { ...settings },
    commands: commands.slice(-20).map(summary),
    autoFill: autoFill ? { id: autoFill.id, at: autoFill.at, retryAt: autoFillRetryAt(autoFill) } : null,
    address: address ? { ...address } : null,
    reach: reach ? { ...reach } : null,
  };
}

export function resetGeminiForTests(): void {
  pages.clear(); commands = []; catalog = null; modesFailure = null; autoFill = null; followedUrl = null; address = null; reach = null; probing = false;
  probeAddress = () => false;
  settings = { ...NO_SETTINGS };
  changed = () => {};
  openCustomApps = () => undefined;
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
}
