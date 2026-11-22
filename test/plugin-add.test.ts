import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PLUGIN_ADD_CLAIM_MS, pendingPluginAdds, pluginAddStatus, reportPluginAdd, requestPluginAdd, resetPluginAdd } from '../src/main/plugin-add.js';

const TUNNEL = `tunnel_${'a1'.repeat(16)}`;
const CORE = { surface: 'core', name: 'Chat On Steroids Core', description: 'Read and edit code.', tunnelId: TUNNEL };

describe('"Add it in ChatGPT for me" request', () => {
  beforeEach(() => resetPluginAdd());

  it('takes one tunnel or one https URL, never both or neither', () => {
    expect(requestPluginAdd({ ...CORE, tunnelId: 'tunnel_short' })).toEqual({ ok: false, error: 'invalid-request' });
    expect(requestPluginAdd({ ...CORE, url: 'https://x.trycloudflare.com/mcp/core/a' })).toEqual({ ok: false, error: 'invalid-request' });
    expect(requestPluginAdd({ surface: 'core', name: 'Core', description: '', url: 'http://localhost:1/mcp' })).toEqual({ ok: false, error: 'invalid-request' });
    expect(requestPluginAdd({ ...CORE, surface: 'plugins' })).toEqual({ ok: false, error: 'invalid-request' });
    expect(requestPluginAdd({ surface: 'desktop', name: 'Desktop', description: '', url: 'https://x.trycloudflare.com/mcp/desktop/a' }).ok).toBe(true);
  });

  it('is claimed by one page, finished only by that page, and a quiet claim is offered again', () => {
    const queued = requestPluginAdd(CORE);
    if (!queued.ok) throw new Error('not queued');
    const id = queued.id;
    expect(pendingPluginAdds()).toEqual([{ id, state: 'requested', name: CORE.name, description: CORE.description, tunnelId: TUNNEL }]);
    expect(reportPluginAdd({ id, client: 'page-a', action: 'done', outcome: 'created' })).toBe(false);
    expect(reportPluginAdd({ id, client: 'page-a', action: 'claim' }, 1000)).toBe(true);
    expect(reportPluginAdd({ id, client: 'page-b', action: 'claim' }, 1001)).toBe(false);
    expect(reportPluginAdd({ id, client: 'page-b', action: 'done', outcome: 'created' }, 1002)).toBe(false);
    // Page A went away: after the claim window the request is offered again.
    expect(pendingPluginAdds(1000 + PLUGIN_ADD_CLAIM_MS + 1)[0]!.state).toBe('requested');
    expect(reportPluginAdd({ id, client: 'page-b', action: 'claim' }, 1000 + PLUGIN_ADD_CLAIM_MS + 2)).toBe(true);
    expect(reportPluginAdd({ id, client: 'page-b', action: 'done' }, 1000 + PLUGIN_ADD_CLAIM_MS + 3)).toBe(false);
    expect(reportPluginAdd({ id, client: 'page-b', action: 'done', outcome: 'exists' }, 1000 + PLUGIN_ADD_CLAIM_MS + 3)).toBe(true);
    expect(pluginAddStatus()).toEqual({ id, surface: 'core', state: 'done', outcome: 'exists', error: null });
    expect(pendingPluginAdds()).toEqual([]);
  });

  it('keeps the failure the page reported, and a new press replaces the old request', () => {
    const first = requestPluginAdd(CORE);
    if (!first.ok) throw new Error('not queued');
    expect(reportPluginAdd({ id: first.id, client: 'p', action: 'claim' })).toBe(true);
    expect(reportPluginAdd({ id: first.id, client: 'p', action: 'fail', error: 'ChatGPT did not create the plugin' })).toBe(true);
    expect(pluginAddStatus()).toMatchObject({ state: 'failed', error: 'ChatGPT did not create the plugin' });
    const second = requestPluginAdd(CORE);
    if (!second.ok) throw new Error('not queued');
    expect(reportPluginAdd({ id: first.id, client: 'p', action: 'claim' })).toBe(false);
    expect(pluginAddStatus()).toMatchObject({ id: second.id, state: 'requested' });
  });
});

// Shapes copied from ChatGPT's live Add custom MCP server dialog (chatgpt.com/plugins, 2026-11-22).
const DIALOG = `
<nav><a href="/plugins/plugin_asdk_app_1">Other Plugin</a></nav>
<main><a href="/settings/plugins-settings">Settings</a><button type="button">Add</button>
  <a href="/plugins/plugin_asdk_app_2">Chat On Steroids Core</a></main>
<div role="dialog"><form>
  <h2>Add custom MCP server</h2>
  <input type="file" name="app-icon">
  <label>Name<input placeholder="Custom Tool" value=""></label>
  <label>Description (optional)<textarea placeholder="Explain what it does in a few words"></textarea></label>
  <fieldset><legend>Connection</legend>
    <div role="group" aria-label="Connection"><button type="button" aria-pressed="true" id="u">Server URL</button><button type="button" aria-pressed="false" id="t">Tunnel</button></div>
    <div id="conn"><input aria-label="Server URL" placeholder="https://example.com/mcp" type="url" value=""></div>
  </fieldset>
  <label>Authentication<select><option value="OAUTH">OAuth</option><option value="NONE">No authentication</option><option value="MIXED">OAuth or no authentication</option></select></label>
  <button type="button" role="checkbox" aria-checked="false" id="consent"></button><span>I understand and want to continue</span>
  <button type="button">Cancel</button><button type="submit" disabled>Create as a plugin</button>
</form></div>`;

type Dom = {
  pluginAddForm(): null | { dialog: HTMLElement; name: HTMLInputElement; description: HTMLTextAreaElement; urlToggle: HTMLButtonElement; tunnelToggle: HTMLButtonElement; auth: HTMLSelectElement; consent: HTMLElement; submit: HTMLButtonElement };
  pluginConnectionInput(dialog: HTMLElement, tunnel: boolean): HTMLInputElement | null;
  fillField(field: HTMLElement, value: string): boolean;
  installedPluginNamed(name: string): boolean;
  pluginAddControl(): HTMLButtonElement | null;
};

describe("ChatGPT's Add custom MCP server dialog", () => {
  const source = readFileSync(new URL('../extension/chatgpt-dom.js', import.meta.url), 'utf8');
  let page: JSDOM;
  let dom: Dom;
  beforeEach(() => {
    page = new JSDOM(DIALOG, { url: 'https://chatgpt.com/plugins?cos-plugin-add=x', runScripts: 'outside-only' });
    const win = page.window, doc = win.document;
    Object.defineProperty(win.HTMLElement.prototype, 'getClientRects', { value() { return this.isConnected && !this.hidden ? [{}] : []; } });
    // The Tunnel switch swaps the URL field for a Tunnel ID field and clears the consent box, as ChatGPT does.
    doc.getElementById('t')!.addEventListener('click', () => {
      doc.getElementById('t')!.setAttribute('aria-pressed', 'true'); doc.getElementById('u')!.setAttribute('aria-pressed', 'false');
      doc.getElementById('conn')!.innerHTML = '<input aria-label="Tunnel ID" placeholder="tunnel_..." value="">';
      doc.getElementById('consent')!.setAttribute('aria-checked', 'false');
    });
    win.eval(source);
    dom = (win as unknown as { CLF_DOM: Dom }).CLF_DOM;
  });
  afterEach(() => page.window.close());

  it('finds every field, fills them and reads the tunnel field the Tunnel switch shows', () => {
    expect(dom.pluginAddControl()?.textContent).toBe('Add');
    const form = dom.pluginAddForm()!;
    expect(form).not.toBeNull();
    expect(dom.pluginConnectionInput(form.dialog, false)?.type).toBe('url');
    expect(dom.pluginConnectionInput(form.dialog, true)).toBeNull();
    form.tunnelToggle.click();
    const tunnel = dom.pluginConnectionInput(form.dialog, true)!;
    expect(dom.fillField(form.name, 'Chat On Steroids Core')).toBe(true);
    expect(dom.fillField(form.description, 'Read and edit code.')).toBe(true);
    expect(dom.fillField(tunnel, TUNNEL)).toBe(true);
    expect(dom.fillField(form.auth, 'NONE')).toBe(true);
    expect([form.name.value, form.description.value, tunnel.value, form.auth.value]).toEqual(['Chat On Steroids Core', 'Read and edit code.', TUNNEL, 'NONE']);
  });

  it('knows a plugin the Installed list already has, but not one only in the directory', () => {
    expect(dom.installedPluginNamed('Other Plugin')).toBe(true);
    expect(dom.installedPluginNamed('Chat On Steroids Core')).toBe(false);
  });

  it('finds no form when the dialog does not look as observed', () => {
    const doc = page.window.document;
    doc.querySelector('textarea')!.remove();
    expect(dom.pluginAddForm()).toBeNull();
    doc.querySelector('label:nth-of-type(2)')!.append(doc.createElement('textarea'));
    doc.querySelector('select option[value="NONE"]')!.remove();
    expect(dom.pluginAddForm()).toBeNull();
  });
});
