/**
 * Settings → Gemini: connection status, connector setup, the account's models and a send box.
 * Projection only: every fact comes from the main process (src/main/gemini.ts) and every action
 * goes back through it. The page is English-only, like Gemini's own custom apps.
 */
import type { AppApi } from '../preload/index.js';
import type { AppState } from '../shared/types.js';
import { GEMINI_ERRORS, type GeminiCommandSummary, type GeminiStatus } from '../shared/gemini.js';

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

export function paintGeminiConnector(state: AppState): void {
  const core = state.status.surfaces.find(s => s.id === 'core');
  const url = core?.publicUrl ?? null;
  const https = !!url && url.startsWith('https://');
  byId('geminiCoreUrl').textContent = https ? url
    : state.config.tunnel.kind === 'openai' ? 'The OpenAI Secure Tunnel only serves ChatGPT. Choose Cloudflare or your own HTTPS tunnel in Setup for Gemini.'
      : 'Connect a Cloudflare or HTTPS tunnel first (Setup → Tunnel).';
  byId<HTMLButtonElement>('geminiCopyUrl').disabled = !https;
  byId('geminiCopyUrl').dataset.url = https ? url : '';
}

export function initGemini(api: AppApi, toast: (message: string) => void): void {
  let last: GeminiStatus | null = null;
  const paint = (status: GeminiStatus): void => { last = status; paintGemini(status); };
  void api.getGeminiStatus().then(reply => { if (reply.ok) paint(reply.data); });
  api.onGeminiChanged(paint);
  setInterval(() => { if (last && !byId('geminiPageStatus').closest('[hidden]')) paintGemini(last); }, 15_000);

  const save = async (patch: Parameters<AppApi['saveGeminiSettings']>[0]): Promise<void> => {
    const reply = await api.saveGeminiSettings(patch);
    if (!reply.ok || !reply.data.ok) toast('That Gemini setting was not saved.');
  };
  byId('geminiCopyUrl').addEventListener('click', async () => {
    const url = byId('geminiCopyUrl').dataset.url;
    if (url && (await api.writeClipboard(url)).ok) toast('Core URL copied. Treat it like a password.');
  });
  byId('geminiOpenConnectors').addEventListener('click', () => { void api.openGeminiConnectors(); });
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
