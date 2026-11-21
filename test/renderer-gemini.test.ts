import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GeminiStatus } from '../src/shared/gemini.js';

const html = readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8');
let dom: JSDOM;

const status = (fields: Partial<GeminiStatus> = {}): GeminiStatus => ({
  pages: 1, signIn: 'signed-in', account: { name: 'Pat', plan: 'Pro' }, selectedMode: 'Hydrogen', localized: false,
  errors: [], quotaLimited: false, settings: { connectorName: 'Chat On Steroids Core', defaultModeId: 'e6fa609c3fa255c0', defaultThinkingLevel: null },
  catalog: { observedAt: Date.now(), thinkingLevels: [{ label: 'Low', selected: true, available: true }, { label: 'High', selected: false, available: true }], modes: [
    { id: '56fdd199312815e2', title: 'Everyday help', model: 'Gemini 4 Hydrogen', available: true, selected: true, reason: null },
    { id: 'e6fa609c3fa255c0', title: 'Deeper analysis', model: 'Gemini 4 Neon', available: true, selected: false, reason: null },
    { id: 'upsell_MODE_CATEGORY_ULTRA', title: 'Code & complex work', model: 'Gemini 4 Carbon', available: false, selected: false, reason: 'requires-upgrade' },
  ] },
  commands: [], connectorSeenAt: null, ...fields,
});

beforeEach(() => {
  dom = new JSDOM(html, { url: 'file:///index.html' });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('Option', dom.window.Option);
});
afterEach(() => { vi.unstubAllGlobals(); dom.window.close(); });

describe('Settings → Gemini', () => {
  it('has a Gemini tab and panel', () => {
    const doc = dom.window.document;
    expect(doc.querySelector('[data-tab="gemini"]')).not.toBeNull();
    expect(doc.querySelector('[data-panel="gemini"]')).not.toBeNull();
  });

  it('shows status and offers only the account\'s available models, keeping the saved default', async () => {
    const { paintGemini } = await import('../src/renderer/gemini.js');
    paintGemini(status({ connectorSeenAt: Date.now() - 5_000 }));
    const doc = dom.window.document;
    expect(doc.getElementById('geminiAccountStatus')!.textContent).toContain('Google AI Pro');
    expect(doc.getElementById('geminiConnectorStatus')!.textContent).toMatch(/last reached .* 5s ago/);
    expect(doc.getElementById('geminiModelList')!.textContent).toContain('Gemini 4 Carbon (unavailable: needs a higher plan)');
    const select = doc.getElementById('geminiDefaultMode') as HTMLSelectElement;
    expect([...select.options].map(o => o.value)).toEqual(['', '56fdd199312815e2', 'e6fa609c3fa255c0']);
    expect(select.value).toBe('e6fa609c3fa255c0');
    expect((doc.getElementById('geminiConnectorName') as HTMLInputElement).value).toBe('Chat On Steroids Core');
    expect(doc.getElementById('geminiWarnings')!.hidden).toBe(true);
  });

  it('states restrictions and failures in plain words instead of hiding them', async () => {
    const { paintGemini, geminiErrorText } = await import('../src/renderer/gemini.js');
    paintGemini(status({ pages: 0, signIn: null, localized: true, quotaLimited: true, commands: [
      { id: 'a', kind: 'send', stage: 'unknown', error: 'send-outcome-not-observed', createdAt: 1, updatedAt: Date.now(), conversation: null, sessionId: null, modeId: null, promptPreview: 'hello', answerChars: null },
    ] }));
    const doc = dom.window.document;
    expect(doc.getElementById('geminiPageStatus')!.textContent).toContain('No Gemini page is reporting');
    expect(doc.getElementById('geminiWarnings')!.hidden).toBe(false);
    expect(doc.getElementById('geminiWarningText')!.textContent).toContain('English');
    expect(doc.getElementById('geminiWarningText')!.textContent).toContain('usage limit');
    expect(doc.getElementById('geminiCommands')!.textContent).toContain('Outcome unknown');
    expect(doc.getElementById('geminiCommands')!.textContent).toContain('it was not sent again');
    expect(geminiErrorText('sent; answer-timeout')).toBe('Sent, then: Gemini did not finish answering within 30 minutes.');
    expect(geminiErrorText('Some text Gemini showed')).toBe('Some text Gemini showed');
  });

  it('never offers the OpenAI Secure Tunnel as a Gemini address', async () => {
    const { paintGeminiConnector } = await import('../src/renderer/gemini.js');
    const doc = dom.window.document;
    paintGeminiConnector(app());
    expect(doc.getElementById('geminiCoreUrl')!.textContent).toContain('only serves ChatGPT');
    expect((doc.getElementById('geminiCopyUrl') as HTMLButtonElement).disabled).toBe(true);
    paintGeminiConnector(app({ kind: 'cloudflared', url: 'https://x.trycloudflare.com/mcp/core/t' }));
    expect(doc.getElementById('geminiCoreUrl')!.textContent).toBe('https://x.trycloudflare.com/mcp/core/t');
    expect((doc.getElementById('geminiCopyUrl') as HTMLButtonElement).disabled).toBe(false);
  });

  it('walks Set up Gemini one step at a time, each marked done by what the app sees', async () => {
    const { initGemini, paintGeminiConnector } = await import('../src/renderer/gemini.js');
    const doc = dom.window.document;
    let push: (s: GeminiStatus) => void = () => undefined;
    const hooks = { openSetupStep: vi.fn(), addFolder: vi.fn(), useHttpsTunnel: vi.fn() };
    const api = {
      getGeminiStatus: () => new Promise(() => undefined), onGeminiChanged: (fn: typeof push) => { push = fn; },
      writeClipboard: async () => ({ ok: true }), openGemini: vi.fn(), openGeminiConnectors: vi.fn(),
    };
    initGemini(api as never, () => undefined, hooks);
    const open = () => doc.querySelector<HTMLElement>('#geminiWizard > .step.is-open')!.dataset.geminiStep;
    const progress = () => doc.getElementById('geminiSetupProgressText')!.textContent;

    paintGeminiConnector(app());
    push(status({ pages: 0, signIn: null }));
    expect(open()).toBe('browser');
    expect(progress()).toBe('0 of 6 steps done');
    expect(doc.getElementById('geminiTunnelWarn')!.hidden).toBe(false);
    expect(doc.getElementById('geminiTunnelGoLabel')!.textContent).toBe('Switch to Cloudflare and connect');
    doc.getElementById('geminiBrowserSetup')!.click();
    expect(hooks.openSetupStep).toHaveBeenCalledWith('browser');

    // The rail and Back/Next move between steps without changing what is done.
    doc.querySelector<HTMLElement>('[data-gemini-rail="tunnel"]')!.click();
    expect(open()).toBe('tunnel');
    doc.getElementById('geminiTunnelGo')!.click();
    expect(hooks.useHttpsTunnel).toHaveBeenCalledOnce();
    doc.querySelector<HTMLElement>('[data-gemini-step="tunnel"] [data-gemini-nav="next"]')!.click();
    expect(open()).toBe('add');
    expect((doc.getElementById('geminiSetupCopy') as HTMLButtonElement).disabled).toBe(true);
    doc.getElementById('geminiSetupOpenApps')!.click();
    doc.getElementById('geminiSetupOpenAppsDefault')!.click();
    expect(api.openGeminiConnectors.mock.calls).toEqual([[], [{ external: true }]]);
    doc.getElementById('geminiOpenGeminiDefault')!.click();
    expect(api.openGemini).toHaveBeenCalledWith({ external: true });

    paintGeminiConnector(app({ present: true, roots: 1, kind: 'cloudflared', url: 'https://x.trycloudflare.com/mcp/core/t' }));
    push(status({ connectorSeenAt: Date.now() }));
    expect(progress()).toBe('5 of 6 steps done');
    doc.querySelector<HTMLElement>('[data-gemini-rail="try"]')!.click();
    expect(open()).toBe('try');
    expect(doc.getElementById('geminiTryPrompt')!.textContent).toContain('@Chat On Steroids Core');
    expect(doc.getElementById('geminiSetupUrl')!.textContent).toBe('https://x.trycloudflare.com/mcp/core/t');

    push(status({ connectorSeenAt: Date.now(), toolCallSeenAt: Date.now() }));
    expect(open()).toBe('ready');
    expect(progress()).toBe('All 6 steps done');
    expect(doc.getElementById('geminiReadyTitle')!.textContent).toBe('Gemini is set up');
    expect(doc.querySelectorAll('#geminiReadyChecks .is-passed')).toHaveLength(6);
  });
});

function app(over: { present?: boolean; roots?: number; kind?: string; url?: string } = {}): never {
  const url = over.url ?? null;
  return {
    bridge: { present: !!over.present, paired: !!over.present },
    config: { roots: Array.from({ length: over.roots ?? 0 }, (_, i) => ({ path: `C:/w${i}` })), tunnel: { kind: over.kind ?? 'openai' } },
    status: { state: url ? 'connected' : 'disconnected', surfaces: [{ id: 'core', publicUrl: url }] },
  } as never;
}
