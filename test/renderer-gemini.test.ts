import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { geminiUrlFingerprint, type GeminiStatus } from '../src/shared/gemini.js';

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
    // A failed model read is shown beside Refresh with when it tries again.
    const at = Date.now() - 60_000;
    paintGemini(status({ catalog: null, modesFailure: { error: 'mode-list-invalid', at, retryAt: at + 600_000 } }));
    const models = doc.getElementById('geminiModelList')!.textContent!;
    expect(models).toContain("Reading Gemini's models failed 1 min ago: Gemini's model picker did not look as expected");
    expect(models).toContain('tries again by itself in 9 min; Refresh tries now.');
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
    const hooks = { openSetupStep: vi.fn(), addFolder: vi.fn(), useHttpsTunnel: vi.fn(), stopHttpsTunnel: vi.fn(), switchBackToOpenAi: vi.fn(), useNamedTunnel: vi.fn() };
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
    // On the OpenAI tunnel Gemini gets a tunnel of its own; nothing says ChatGPT will stop.
    expect(doc.getElementById('geminiTunnelWarn')!.hidden).toBe(true);
    expect(doc.getElementById('geminiTunnelBeside')!.hidden).toBe(false);
    expect(doc.getElementById('geminiTunnelGoLabel')!.textContent).toBe('Start a tunnel for Gemini');
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

  it('gives Gemini its own tunnel beside the OpenAI one, and offers the way back from Cloudflare', async () => {
    const { initGemini, paintGeminiConnector } = await import('../src/renderer/gemini.js');
    const doc = dom.window.document;
    let push: (s: GeminiStatus) => void = () => undefined;
    const hooks = { openSetupStep: vi.fn(), addFolder: vi.fn(), useHttpsTunnel: vi.fn(), stopHttpsTunnel: vi.fn(), switchBackToOpenAi: vi.fn(), useNamedTunnel: vi.fn() };
    const api = { getGeminiStatus: () => new Promise(() => undefined), onGeminiChanged: (fn: typeof push) => { push = fn; },
      writeClipboard: async () => ({ ok: true }), openGemini: vi.fn(), openGeminiConnectors: vi.fn() };
    initGemini(api as never, () => undefined, hooks);
    const wanted = status({ settings: { ...status().settings, httpsTunnel: true } });
    const pill = () => doc.getElementById('geminiTunnelPill')!.textContent;

    // Connected on OpenAI, Gemini's tunnel still starting: ChatGPT's own address is never offered.
    paintGeminiConnector(app({ connected: true, url: 'tunnel_ok', side: { state: 'starting', detail: '', url: null } }));
    push(wanted);
    expect(pill()).toBe("Starting Gemini's tunnel…");
    expect(doc.getElementById('geminiCoreUrl')!.textContent).toContain('only serves ChatGPT');
    expect(doc.getElementById('geminiTunnelOff')!.hidden).toBe(false);
    expect(doc.getElementById('geminiTunnelBack')!.hidden).toBe(true);

    paintGeminiConnector(app({ connected: true, side: { state: 'connected', detail: '', url: 'https://g.trycloudflare.com/mcp/core/t' } }));
    expect(pill()).toBe('Connected with an https address');
    expect(doc.getElementById('geminiCoreUrl')!.textContent).toBe('https://g.trycloudflare.com/mcp/core/t');
    doc.getElementById('geminiTunnelOff')!.click();
    expect(hooks.stopHttpsTunnel).toHaveBeenCalledOnce();

    // A failed Gemini tunnel says why and can be started again.
    paintGeminiConnector(app({ connected: true, side: { state: 'error', detail: 'cloudflared was not found.', url: null } }));
    expect(pill()).toBe("Gemini's tunnel failed: cloudflared was not found.");
    expect((doc.getElementById('geminiTunnelGo') as HTMLButtonElement).disabled).toBe(false);

    // The whole app on Cloudflare (what 2.2.x's wizard did): say what it costs ChatGPT, offer the way back.
    paintGeminiConnector(app({ kind: 'cloudflared', url: 'https://x.trycloudflare.com/mcp/core/t' }));
    expect(doc.getElementById('geminiTunnelWarn')!.hidden).toBe(false);
    expect(doc.getElementById('geminiTunnelBack')!.hidden).toBe(false);
    expect(doc.getElementById('geminiTunnelOff')!.hidden).toBe(true);
    doc.getElementById('geminiTunnelBack')!.click();
    expect(hooks.switchBackToOpenAi).toHaveBeenCalledOnce();
  });
});

describe('Gemini custom app address', () => {
  const url = `https://new-name.trycloudflare.com/mcp/core/${'a'.repeat(43)}`;
  const old = `https://old-name.trycloudflare.com/mcp/core/${'b'.repeat(43)}`;
  const withGiven = (given: string | null, extra: Partial<GeminiStatus> = {}) =>
    status({ settings: { connectorName: null, defaultModeId: null, defaultThinkingLevel: null, givenUrlHash: given ? geminiUrlFingerprint(given) : null }, ...extra });

  it('says the custom app has an old address, with the new one, instead of "not added"', async () => {
    const { addPill } = await import('../src/renderer/gemini.js');
    const [tone, text] = addPill(withGiven(old), url);
    expect(tone).toBe('bad');
    expect(text).toContain(`Your Gemini custom app has an old address. Update it to ${url}`);
    expect(addPill(withGiven(url), url)).toEqual(['wait', expect.stringContaining('Gemini has this address')]);
    expect(addPill(withGiven(null), url)[1]).toContain('A quick tunnel gets a new address at each start');
    // Only a call from Gemini proves it is added, whatever was given before.
    expect(addPill(withGiven(old, { connectorSeenAt: Date.now() }), url)[0]).toBe('ok');
  });

  it('says in Settings → Gemini that the app is adding itself again after the tunnel address changed, and how it went', async () => {
    const { autoFillText, paintGemini } = await import('../src/renderer/gemini.js');
    const now = 1_000_000_000;
    const base = { id: 'auto', kind: 'fill-app', createdAt: now, updatedAt: now, conversation: null, sessionId: null, modeId: null, promptPreview: null, answerChars: null, outcome: null } as const;
    const withFill = (stage: 'queued' | 'completed' | 'failed', error: string | null = null) =>
      status({ autoFill: { id: 'auto', at: now - 120_000 }, commands: [{ ...base, stage, error }] });
    expect(autoFillText(status(), now)).toBe('');
    expect(autoFillText(withFill('queued'), now)).toMatch(/^Your tunnel address changed .*, so the app is adding Chat On Steroids Core in Gemini again with the new address, in your browser\.$/);
    expect(autoFillText(withFill('completed'), now)).toContain('so the app added Chat On Steroids Core in Gemini again with the new address.');
    expect(autoFillText(withFill('failed', 'delete-failed'), now)).toContain('which failed: Gemini did not delete the app with the old address after 3 tries.');
    paintGemini(withFill('queued'), now);
    expect(dom.window.document.getElementById('geminiConnectorStatus')!.textContent).toContain('so the app is adding Chat On Steroids Core in Gemini again');
    // The address itself is never shown there.
    expect(dom.window.document.getElementById('geminiConnectorStatus')!.textContent).not.toContain('trycloudflare');
  });

  it('falls back to the manual steps in plain words when the custom apps page is not recognized', async () => {
    const { fillPill } = await import('../src/renderer/gemini.js');
    const base = { id: 'x', kind: 'fill-app', createdAt: 1, updatedAt: 1, conversation: null, sessionId: null, modeId: null, promptPreview: null, answerChars: null } as const;
    const [tone, text] = fillPill({ ...base, stage: 'failed', error: 'custom-apps-layout-unknown', outcome: null }, url);
    expect(tone).toBe('bad');
    expect(text).toBe("Gemini's custom apps page did not look as expected, so nothing was filled in. Add the app by hand: click Custom, paste the address, then Next.");
    expect(fillPill({ ...base, stage: 'completed', error: null, outcome: 'filled' }, url)[1]).toContain('click the highlighted Next');
    expect(fillPill({ ...base, stage: 'completed', error: null, outcome: 'old' }, url)[1]).toContain('choose Delete');
    expect(fillPill({ ...base, stage: 'failed', error: 'signed-out', outcome: null }, url)[1]).toContain('Add the app by hand');
  });
});

function app(over: { present?: boolean; roots?: number; kind?: string; url?: string; connected?: boolean;
  side?: { state: 'starting' | 'connected' | 'error'; detail: string; url: string | null } } = {}): never {
  const url = over.url ?? null;
  return {
    bridge: { present: !!over.present, paired: !!over.present },
    config: { roots: Array.from({ length: over.roots ?? 0 }, (_, i) => ({ path: `C:/w${i}` })), tunnel: { kind: over.kind ?? 'openai' } },
    status: { state: url || over.connected ? 'connected' : 'disconnected', surfaces: [{ id: 'core', publicUrl: url }], geminiTunnel: over.side ?? null },
  } as never;
}
