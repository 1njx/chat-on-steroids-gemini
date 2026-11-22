/**
 * Settings → Gemini: a setup wizard like Setup's, connection status, the account's models and a send box.
 * Projection only: every fact comes from the main process (src/main/gemini.ts) and every action
 * goes back through it. The page is English-only, like Gemini's own custom apps.
 */
import type { AppApi } from '../preload/index.js';
import type { AppState } from '../shared/types.js';
import { GEMINI_ERRORS, geminiUrlFingerprint, type GeminiCommandSummary, type GeminiStatus } from '../shared/gemini.js';
import { el, icon } from './dom.js';

const byId = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

const STAGES: Record<GeminiCommandSummary['stage'], string> = {
  queued: 'Waiting for a Gemini page', claimed: 'Taken by a Gemini page', sending: 'Sending',
  sent: 'Sent; Gemini is answering', completed: 'Answered', failed: 'Failed', cancelled: 'Withdrawn', unknown: 'Outcome unknown',
};

export function geminiErrorText(code: string | null): string {
  if (!code) return '';
  const sent = code.startsWith('sent; ');
  const bare = sent ? code.slice(6) : code;
  const text = GEMINI_ERRORS[bare] ?? bare;
  return sent ? `Sent, then: ${text}` : text;
}

function ago(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
}

export function paintGemini(status: GeminiStatus, now = Date.now()): void {
  byId('geminiPageStatus').textContent = status.pages
    ? `${status.pages} Gemini page${status.pages === 1 ? '' : 's'} connected through the extension.`
    : 'No Gemini page is reporting. Open gemini.google.com in the browser where the extension is connected.';
  byId('geminiAccountStatus').textContent = status.signIn === 'signed-in'
    ? `Signed in${status.account?.plan ? ` · Google AI ${status.account.plan}` : ''}${status.selectedMode ? ` · Gemini shows ${status.selectedMode}` : ''}`
    : status.signIn === 'signed-out' ? 'Signed out. Sign in at gemini.google.com.' : 'Unknown until a Gemini page reports.';
  byId('geminiConnectorStatus').textContent = status.connectorSeenAt
    ? `Gemini last reached this app's MCP server ${ago(status.connectorSeenAt, now)}.`
    : 'No call from Gemini yet in this run. Add the Core URL below in Gemini, then mention it in a chat.';
  const warnings = [
    ...(status.localized ? ['A Gemini page is not in English. Google offers custom apps in English only, and this integration needs the English page.'] : []),
    ...(status.quotaLimited ? ['Gemini shows a usage limit. Wait for the reset Gemini names; switching accounts or chats to avoid it is not supported.'] : []),
    ...status.errors.slice(0, 2),
  ];
  byId('geminiWarnings').hidden = !warnings.length;
  byId('geminiWarningText').textContent = warnings.join(' ');

  const modes = status.catalog?.modes ?? [];
  byId('geminiModelList').textContent = modes.length
    ? modes.map(m => `${m.model ?? m.title}${m.available ? '' : ` (unavailable${m.reason === 'requires-upgrade' ? ': needs a higher plan' : ''})`}`).join(' · ') +
      ` — read ${ago(status.catalog!.observedAt, now)}`
    : 'Not read yet. Refresh reads Gemini\'s picker without changing it.';
  fillSelect(byId<HTMLSelectElement>('geminiDefaultMode'), 'As in Gemini',
    modes.filter(m => m.available).map(m => [m.id, m.model ? `${m.model} (${m.title})` : m.title]), status.settings.defaultModeId ?? '');
  fillSelect(byId<HTMLSelectElement>('geminiThinking'), 'As in Gemini',
    (status.catalog?.thinkingLevels ?? []).filter(l => l.available).map(l => [l.label, l.label]), status.settings.defaultThinkingLevel ?? '');
  const name = byId<HTMLInputElement>('geminiConnectorName');
  if (document.activeElement !== name) name.value = status.settings.connectorName ?? '';

  const chats = [...new Map(status.commands.filter(c => c.conversation && c.kind === 'send')
    .map(c => [c.conversation!, c.promptPreview ?? c.conversation!])).entries()].reverse();
  fillSelect(byId<HTMLSelectElement>('geminiContinue'), 'New chat', chats.map(([key, label]) => [key, label.slice(0, 60)]), byId<HTMLSelectElement>('geminiContinue').value);

  const list = byId('geminiCommands');
  list.replaceChildren(...status.commands.filter(c => c.kind === 'send').slice(-8).reverse().map(c => {
    const row = document.createElement('div');
    row.className = 'gemini-command';
    row.dataset.stage = c.stage;
    const head = document.createElement('b');
    head.textContent = `${STAGES[c.stage]} · ${ago(c.updatedAt, now)}`;
    const body = document.createElement('span');
    body.textContent = [c.promptPreview ?? '', geminiErrorText(c.error), c.answerChars !== null ? `${c.answerChars} characters answered` : '']
      .filter(Boolean).join(' — ');
    row.append(head, body);
    return row;
  }));
}

function fillSelect(select: HTMLSelectElement, empty: string, options: Array<[string, string]>, value: string): void {
  const wanted = JSON.stringify([empty, ...options]);
  if (select.dataset.options !== wanted) {
    select.replaceChildren(new Option(empty, ''), ...options.map(([v, label]) => new Option(label, v)));
    select.dataset.options = wanted;
  }
  select.value = options.some(([v]) => v === value) ? value : '';
}

/** The Core MCP address Gemini can use: only an https one (Gemini refuses anything else). */
function coreHttpsUrl(state: AppState): string | null {
  // On the OpenAI path Gemini has its own tunnel beside ChatGPT's (connection.ts).
  const url = state.status.geminiTunnel?.url ?? state.status.surfaces.find(s => s.id === 'core')?.publicUrl ?? null;
  return url && url.startsWith('https://') ? url : null;
}

/** What the wizard's buttons ask of the rest of the app: Setup's own steps and the connection. */
export interface GeminiSetupHooks {
  openSetupStep(step: 'browser' | 'access'): void;
  addFolder(): void;
  /** Gemini's own Cloudflare tunnel beside the OpenAI one, then connect if not connected. */
  useHttpsTunnel(): void;
  /** Stops Gemini's own tunnel; ChatGPT's stays. */
  stopHttpsTunnel(): void;
  /** The whole app back on the OpenAI Secure Tunnel, with Gemini's own tunnel beside it. */
  switchBackToOpenAi(): void;
  /** Gemini on the person's own Cloudflare tunnel (null host: back to a quick tunnel). */
  useNamedTunnel(host: string | null, token: string): void;
}

export const GEMINI_SETUP_STEPS = ['browser', 'signin', 'folder', 'tunnel', 'add', 'try'] as const;
type TaskStep = typeof GEMINI_SETUP_STEPS[number];
type SetupStep = TaskStep | 'ready';
const STEP_LABELS: Record<TaskStep, string> = {
  browser: 'Browser extension connected', signin: 'Signed in to Gemini', folder: 'Folder shared', tunnel: 'https address ready',
  add: 'App added in Gemini', try: 'Gemini ran one of the app\'s tools',
};
let appState: AppState | null = null;
let geminiState: GeminiStatus | null = null;
/** The step the user opened by hand; null follows progress (the first unfinished step). */
let pickedStep: SetupStep | null = null;

function pill(id: string, tone: 'ok' | 'wait' | 'off' | 'bad', text: string): void {
  const node = byId(id);
  node.dataset.tone = tone;
  node.textContent = text;
}

/** Which setup steps are done, judged only from what the app itself sees. */
export function geminiSetupDone(state: AppState, status: GeminiStatus | null): Set<TaskStep> {
  const done = new Set<TaskStep>();
  if (state.bridge.present) done.add('browser');
  if (status?.signIn === 'signed-in') done.add('signin');
  if (state.config.roots.length > 0) done.add('folder');
  if (state.status.state === 'connected' && coreHttpsUrl(state)) done.add('tunnel');
  if (status?.connectorSeenAt) done.add('add');
  if (status?.toolCallSeenAt) done.add('try');
  return done;
}

export function paintGeminiSetup(now = Date.now()): void {
  const state = appState;
  if (!state || !document.getElementById('geminiWizard')) return;
  const status = geminiState;
  const done = geminiSetupDone(state, status);
  const current = GEMINI_SETUP_STEPS.find(name => !done.has(name)) ?? null;
  const isDone = (name: SetupStep): boolean => name === 'ready' ? current === null : done.has(name);
  // Picking the first unfinished step is following progress, so the page moves on when it is done.
  if (pickedStep === current) pickedStep = null;
  const open: SetupStep = pickedStep ?? current ?? 'ready';
  const path: SetupStep[] = [...GEMINI_SETUP_STEPS, 'ready'];
  for (const name of path) {
    const node = document.querySelector<HTMLElement>(`[data-gemini-step="${name}"]`)!;
    node.classList.toggle('is-open', name === open);
    node.classList.toggle('is-done', isDone(name));
    node.classList.toggle('is-current', name === current);
    const button = document.querySelector<HTMLElement>(`[data-gemini-rail="${name}"]`)!;
    const item = button.closest('li')!;
    item.classList.toggle('is-done', isDone(name));
    item.classList.toggle('is-current', name === current);
    if (name === open) button.setAttribute('aria-current', 'step'); else button.removeAttribute('aria-current');
    const nav = node.querySelector<HTMLElement>(':scope > .step-body > .step-nav');
    if (nav) {
      const at = path.indexOf(name);
      nav.querySelector<HTMLElement>('[data-gemini-nav="back"]')!.hidden = at === 0;
      nav.querySelector<HTMLElement>('[data-gemini-nav="next"]')!.hidden = at === path.length - 1;
      nav.classList.toggle('is-ready', isDone(name));
    }
  }
  const finished = GEMINI_SETUP_STEPS.filter(name => done.has(name)).length;
  const progress = byId('geminiSetupProgress');
  progress.setAttribute('aria-valuenow', String(finished));
  progress.classList.toggle('is-complete', current === null);
  byId('geminiSetupProgressText').textContent = current === null
    ? `All ${GEMINI_SETUP_STEPS.length} steps done` : `${finished} of ${GEMINI_SETUP_STEPS.length} steps done`;

  pill('geminiBrowserPill', done.has('browser') ? 'ok' : state.bridge.paired ? 'wait' : 'off', done.has('browser')
    ? 'Extension connected' : state.bridge.paired ? 'Set up, but not connected now: open your browser' : 'Waiting for the extension…');
  pill('geminiSigninPill', done.has('signin') ? 'ok' : status?.signIn === 'signed-out' ? 'bad' : status?.pages ? 'wait' : 'off', done.has('signin')
    ? `Signed in${status?.account?.plan ? ` · Google AI ${status.account.plan}` : ''}`
    : status?.signIn === 'signed-out' ? 'Signed out: sign in on the Gemini page'
      : status?.pages ? 'Gemini page open; waiting for it to report…' : 'No Gemini page open yet');
  const signinWarn = status?.localized ? 'This Gemini page is not in English. Set Gemini to English: custom apps are offered in English only.' : '';
  byId('geminiSigninWarn').hidden = !signinWarn;
  byId('geminiSigninWarn').textContent = signinWarn;
  const roots = state.config.roots.length;
  pill('geminiFolderPill', roots ? 'ok' : 'off', roots ? `${roots} folder${roots === 1 ? '' : 's'} shared` : 'No folder shared yet');

  const kind = state.config.tunnel.kind;
  const connected = state.status.state === 'connected';
  const busy = state.status.state === 'starting-server' || state.status.state === 'connecting-tunnel' || state.status.state === 'disconnecting';
  const side = state.status.geminiTunnel ?? null;
  const wanted = status?.settings.httpsTunnel === true;
  const sideBusy = kind === 'openai' && wanted && connected && side?.state !== 'error' && !side?.url;
  const sideFailed = kind === 'openai' && side?.state === 'error';
  pill('geminiTunnelPill', done.has('tunnel') ? 'ok' : busy || sideBusy ? 'wait' : sideFailed ? 'bad' : 'off', done.has('tunnel') ? 'Connected with an https address'
    : busy ? 'Connecting…' : sideBusy ? "Starting Gemini's tunnel…" : sideFailed ? `Gemini's tunnel failed: ${side?.detail ?? ''}`
    : kind === 'manual' && connected ? 'Connected, but your own tunnel has no https address yet (Setup → Advanced)' : 'Not connected');
  byId('geminiTunnelBeside').hidden = kind !== 'openai';
  byId('geminiTunnelWarn').hidden = kind !== 'cloudflared';
  byId('geminiTunnelBack').hidden = kind !== 'cloudflared';
  byId('geminiTunnelOff').hidden = kind !== 'openai' || !wanted;
  byId('geminiTunnelGoLabel').textContent = kind === 'openai' && !wanted ? 'Start a tunnel for Gemini' : 'Connect';
  byId<HTMLButtonElement>('geminiTunnelGo').disabled = done.has('tunnel') || busy || sideBusy
    || (connected && (kind !== 'openai' || (wanted && !sideFailed)));

  const named = status?.settings.namedTunnelHost ?? null;
  byId('geminiNamedRemove').hidden = !named;
  const namedHost = byId<HTMLInputElement>('geminiNamedHost');
  if (document.activeElement !== namedHost && !namedHost.value) namedHost.value = named ?? '';
  const local = state.status.surfaces.find(s => s.id === 'core')?.localUrl;
  byId('geminiNamedService').textContent = local ? new URL(local).origin.replace('127.0.0.1', 'localhost') : 'http://localhost:port';

  const url = coreHttpsUrl(state);
  byId('geminiSetupUrl').textContent = url ?? 'Finish the Tunnel step first.';
  byId<HTMLButtonElement>('geminiSetupCopy').disabled = !url;
  byId<HTMLButtonElement>('geminiFillApp').disabled = !url;
  pill('geminiAddPill', ...addPill(status, url, now));
  const fill = [...(status?.commands ?? [])].reverse().find(c => c.kind === 'fill-app');
  byId('geminiFillPill').hidden = !fill;
  if (fill) pill('geminiFillPill', ...fillPill(fill, url));
  const name = status?.settings.connectorName || 'Chat On Steroids Core';
  byId('geminiTryPrompt').textContent = `@${name} list the files in my shared folder`;
  pill('geminiTryPill', done.has('try') ? 'ok' : 'off', status?.toolCallSeenAt ? `Gemini ran one of the app's tools ${ago(status.toolCallSeenAt, now)}`
    : 'Waiting for Gemini to run one of the app\'s tools…');

  byId('geminiReadyChecks').replaceChildren(...GEMINI_SETUP_STEPS.map(step => {
    const row = el('li', `ready-check${done.has(step) ? ' is-passed' : ''}`);
    row.append(icon(done.has(step) ? 'i-check-circle' : 'i-warning'), el('span', '', STEP_LABELS[step]));
    if (!done.has(step)) {
      const go = el('button', 'ready-go', 'Go to step');
      go.setAttribute('type', 'button');
      go.addEventListener('click', () => openStep(step));
      row.append(go);
    }
    return row;
  }));
  byId('geminiReadyTitle').textContent = current === null ? 'Gemini is set up' : 'Almost there';
}

/**
 * The Add step's status. Only a call from Gemini proves the app is added; until then the address
 * Gemini last got (copied, filled in or read on its page, kept as a fingerprint) tells an app with
 * an old address from one never added.
 */
export function addPill(status: GeminiStatus | null, url: string | null, now = Date.now()): ['ok' | 'wait' | 'off' | 'bad', string] {
  if (status?.connectorSeenAt) return ['ok', `Gemini reached the app ${ago(status.connectorSeenAt, now)}`];
  const given = status?.settings.givenUrlHash ?? null;
  if (url && given && given !== geminiUrlFingerprint(url)) {
    return ['bad', `Your Gemini custom app has an old address. Update it to ${url} — Gemini cannot edit an address, so "Add it in Gemini for me" deletes the old app and adds it again.`];
  }
  if (url && given) return ['wait', 'Gemini has this address. Mention the app in a Gemini chat (next step) so Gemini reaches it.'];
  return ['off', status?.settings.namedTunnelHost
    ? 'Waiting for Gemini to reach the app. Your own tunnel keeps this address across restarts.'
    : 'Waiting for Gemini to reach the app. A quick tunnel gets a new address at each start: add the app again with it.'];
}

/** What the last "Add it in Gemini for me" did, in the person's words. */
export function fillPill(fill: GeminiCommandSummary, url: string | null): ['ok' | 'wait' | 'off' | 'bad', string] {
  if (fill.stage === 'queued' || fill.stage === 'claimed') return ['wait', 'Opening Gemini custom apps in your browser…'];
  if (fill.stage === 'failed') {
    return ['bad', `${geminiErrorText(fill.error)}${fill.error === 'custom-apps-layout-unknown' ? '' : ' Add the app by hand: Open custom apps, click Custom, paste the address, then Next.'}`];
  }
  if (fill.stage !== 'completed') return ['off', STAGES[fill.stage]];
  if (fill.outcome === 'connected') return ['ok', 'Added in Gemini and connected. Mention the app in a Gemini chat to use it.'];
  if (fill.outcome === 'filled') return ['ok', 'Filled in. In Gemini, check the address, click the highlighted Next, tick Google\'s notice and Connect, then Connect once more to save.'];
  if (fill.outcome === 'current') return ['ok', 'Gemini already has this app with this address. Nothing to change.'];
  if (fill.outcome === 'old') return ['bad', `Gemini has the app with an old address and cannot edit it. In Gemini, open the highlighted More options and choose Delete, then press Add it in Gemini for me again${url ? ` to add ${url}` : ''}.`];
  return ['off', 'Done.'];
}

function openStep(name: SetupStep): void {
  pickedStep = name;
  paintGeminiSetup();
  document.querySelector('.gemini-setup .setup-track')?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
}

export function paintGeminiConnector(state: AppState): void {
  appState = state;
  paintGeminiSetup();
  const url = coreHttpsUrl(state);
  byId('geminiCoreUrl').textContent = url ?? (state.config.tunnel.kind === 'openai'
    ? 'The OpenAI Secure Tunnel only serves ChatGPT. Start a tunnel for Gemini in the Tunnel step of Set up Gemini above.'
    : 'Connect first: the Tunnel step of Set up Gemini above.');
  byId<HTMLButtonElement>('geminiCopyUrl').disabled = !url;
  byId('geminiCopyUrl').dataset.url = url ?? '';
}

export function initGemini(api: AppApi, toast: (message: string) => void, hooks?: GeminiSetupHooks): void {
  let last: GeminiStatus | null = null;
  // A reply without a status (an older main process, a harness) leaves the page as it is.
  const paint = (status: GeminiStatus | null | undefined): void => {
    if (!status) return;
    last = status;
    geminiState = status;
    paintGemini(status);
    paintGeminiSetup();
  };
  initGeminiSetup(api, toast, hooks);
  void api.getGeminiStatus().then(reply => { if (reply?.ok) paint(reply.data); }, () => undefined);
  // No repaint timer: status pushes arrive every few seconds while a Gemini page reports, and an
  // uncleared interval kept every mounted window alive (renderer test workers ran out of memory on macOS CI).
  api.onGeminiChanged(paint);
  byId('geminiRefreshModels').closest('section')?.parentElement?.addEventListener('pointerenter', () => { if (last) paintGemini(last); });

  const save = async (patch: Parameters<AppApi['saveGeminiSettings']>[0]): Promise<void> => {
    const reply = await api.saveGeminiSettings(patch);
    if (!reply.ok || !reply.data.ok) toast('That Gemini setting was not saved.');
  };
  byId('geminiCopyUrl').addEventListener('click', async () => {
    const url = byId('geminiCopyUrl').dataset.url;
    if (url && (await api.writeClipboard(url)).ok) { toast('Core URL copied. Treat it like a password.'); void rememberGiven(api, url); }
  });
  byId('geminiOpenConnectors').addEventListener('click', () => { void api.openGeminiConnectors(); });
  byId('geminiOpenConnectorsDefault').addEventListener('click', () => { void api.openGeminiConnectors({ external: true }); });
  byId('geminiRefreshModels').addEventListener('click', async () => {
    const reply = await api.requestGeminiModes();
    toast(reply.ok ? 'Reading Gemini\'s model picker in your browser…' : 'Could not ask the browser.');
  });
  byId<HTMLInputElement>('geminiConnectorName').addEventListener('change', event => {
    void save({ connectorName: (event.target as HTMLInputElement).value.trim() || null });
  });
  byId<HTMLSelectElement>('geminiDefaultMode').addEventListener('change', event => {
    void save({ defaultModeId: (event.target as HTMLSelectElement).value || null });
  });
  byId<HTMLSelectElement>('geminiThinking').addEventListener('change', event => {
    void save({ defaultThinkingLevel: (event.target as HTMLSelectElement).value || null });
  });
  byId('geminiSend').addEventListener('click', async () => {
    const prompt = byId<HTMLTextAreaElement>('geminiPrompt');
    const text = prompt.value.trim();
    if (!text) { toast('Write a message first.'); return; }
    const conversation = byId<HTMLSelectElement>('geminiContinue').value || null;
    const reply = await api.sendToGemini({ prompt: text, conversation });
    if (!reply.ok) { toast('The app did not accept the message.'); return; }
    if (!reply.data.ok) { toast(geminiErrorText(reply.data.error)); return; }
    prompt.value = '';
    toast('Queued for Gemini.');
  });
}

/** The address handed out for Gemini's custom app, kept only as a fingerprint. */
function rememberGiven(api: AppApi, url: string): Promise<unknown> {
  return api.saveGeminiSettings({ givenUrlHash: geminiUrlFingerprint(url) }).catch(() => undefined);
}

/** The wizard's Back/Next, rail and buttons, wired once. */
function initGeminiSetup(api: AppApi, toast: (message: string) => void, hooks?: GeminiSetupHooks): void {
  const wizard = document.getElementById('geminiWizard');
  if (!wizard) return;
  for (const body of wizard.querySelectorAll<HTMLElement>(':scope > .step > .step-body')) {
    const nav = el('div', 'step-nav');
    const back = el('button', 'btn step-back');
    back.setAttribute('type', 'button');
    back.dataset.geminiNav = 'back';
    back.append(icon('i-arrow-left'), el('span', '', 'Back'));
    const next = el('button', 'btn step-next');
    next.setAttribute('type', 'button');
    next.dataset.geminiNav = 'next';
    next.append(el('span', '', 'Next'), icon('i-arrow-right'));
    nav.append(back, next);
    body.append(nav);
  }
  const path: SetupStep[] = [...GEMINI_SETUP_STEPS, 'ready'];
  wizard.addEventListener('click', event => {
    const nav = (event.target as HTMLElement).closest<HTMLElement>('[data-gemini-nav]');
    const here = nav?.closest<HTMLElement>('[data-gemini-step]')?.dataset.geminiStep as SetupStep | undefined;
    if (!nav || !here) return;
    const to = path[path.indexOf(here) + (nav.dataset.geminiNav === 'next' ? 1 : -1)];
    if (to) openStep(to);
  });
  document.querySelector('.gemini-setup .setup-rail')?.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLElement>('[data-gemini-rail]');
    if (button) openStep(button.dataset.geminiRail as SetupStep);
  });
  byId('geminiBrowserSetup').addEventListener('click', () => hooks?.openSetupStep('browser'));
  byId('geminiAccess').addEventListener('click', () => hooks?.openSetupStep('access'));
  byId('geminiAddFolder').addEventListener('click', () => hooks?.addFolder());
  byId('geminiTunnelGo').addEventListener('click', () => hooks?.useHttpsTunnel());
  byId('geminiTunnelOff').addEventListener('click', () => hooks?.stopHttpsTunnel());
  byId('geminiTunnelBack').addEventListener('click', () => hooks?.switchBackToOpenAi());
  byId('geminiNamedSave').addEventListener('click', () => {
    const host = byId<HTMLInputElement>('geminiNamedHost').value.trim();
    if (!host) { toast('Enter the public hostname of your Cloudflare tunnel.'); return; }
    hooks?.useNamedTunnel(host, byId<HTMLInputElement>('geminiNamedToken').value);
    byId<HTMLInputElement>('geminiNamedToken').value = '';
  });
  byId('geminiNamedRemove').addEventListener('click', () => { byId<HTMLInputElement>('geminiNamedHost').value = ''; hooks?.useNamedTunnel(null, ''); });
  byId('geminiFillApp').addEventListener('click', async () => {
    const url = appState ? coreHttpsUrl(appState) : null;
    if (!url) return;
    const reply = await api.fillGeminiApp(url);
    if (!reply.ok || !reply.data.ok) toast(reply.ok && !reply.data.ok ? geminiErrorText(reply.data.error) : 'The app did not accept that.');
  });
  byId('geminiOpenGemini').addEventListener('click', () => { void api.openGemini(); });
  byId('geminiOpenGeminiDefault').addEventListener('click', () => { void api.openGemini({ external: true }); });
  byId('geminiSetupOpenApps').addEventListener('click', () => { void api.openGeminiConnectors(); });
  byId('geminiSetupOpenAppsDefault').addEventListener('click', () => { void api.openGeminiConnectors({ external: true }); });
  byId('geminiSetupCopy').addEventListener('click', async () => {
    const url = appState ? coreHttpsUrl(appState) : null;
    if (url && (await api.writeClipboard(url)).ok) { toast('Address copied. Treat it like a password.'); void rememberGiven(api, url); }
  });
  byId('geminiTryCopy').addEventListener('click', async () => {
    if ((await api.writeClipboard(byId('geminiTryPrompt').textContent ?? '')).ok) toast('Copied. Paste it in a new Gemini chat.');
  });
}
