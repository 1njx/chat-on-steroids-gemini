import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SETUP_TASK_CLAIM_MS, pendingSetupTasks, reportSetupTask, requestOpenaiSetup, requestPluginAdd, requestPluginPermission, resetSetupTasks, setupTaskStatus } from '../src/main/setup-tasks.js';

const TUNNEL = `tunnel_${'a1'.repeat(16)}`;
const CORE = { surface: 'core', name: 'Chat On Steroids Core', description: 'Read and edit code.', tunnelId: TUNNEL };
const APP = 'asdk_app_6b0126ccc060819198ba0063b3c2e052';
const KEY = `sk-proj-${'x'.repeat(40)}`;
const queued = (reply: { ok: true; id: string } | { ok: false; error: string }) => { if (!reply.ok) throw new Error(reply.error); return reply.id; };

describe('setup tasks the extension does in the person\'s tabs', () => {
  beforeEach(() => resetSetupTasks());

  it('takes one tunnel or one https URL for a plugin, never both or neither', () => {
    expect(requestPluginAdd({ ...CORE, tunnelId: 'tunnel_short' })).toEqual({ ok: false, error: 'invalid-request' });
    expect(requestPluginAdd({ ...CORE, url: 'https://x.trycloudflare.com/mcp/core/a' })).toEqual({ ok: false, error: 'invalid-request' });
    expect(requestPluginAdd({ surface: 'core', name: 'Core', description: '', url: 'http://localhost:1/mcp' })).toEqual({ ok: false, error: 'invalid-request' });
    expect(requestPluginAdd({ ...CORE, surface: 'plugins' })).toEqual({ ok: false, error: 'invalid-request' });
    expect(requestPluginAdd({ surface: 'desktop', name: 'Desktop', description: '', url: 'https://x.trycloudflare.com/mcp/desktop/a' }).ok).toBe(true);
  });

  it("offers ChatGPT's Add labels in every language Setup shows", () => {
    queued(requestPluginAdd(CORE));
    const [task] = pendingSetupTasks();
    expect(task).toMatchObject({ kind: 'plugin-add', state: 'requested', name: CORE.name, tunnelId: TUNNEL });
    expect(task!.addLabels).toEqual(expect.arrayContaining(['Add', 'Hinzufügen', '追加']));
    expect(task!.itemLabels).toEqual(expect.arrayContaining(['Add custom MCP server', 'Benutzerdefinierten MCP-Server hinzufügen']));
  });

  it('is claimed by one tab, finished only by that tab, and a quiet claim is offered again', () => {
    const id = queued(requestPluginAdd(CORE));
    expect(reportSetupTask({ id, client: 'tab:1', action: 'done', outcome: 'created' })).toBeNull();
    expect(reportSetupTask({ id, client: 'tab:1', action: 'claim' }, 1000)).toEqual([]);
    expect(reportSetupTask({ id, client: 'tab:2', action: 'claim' }, 1001)).toBeNull();
    expect(reportSetupTask({ id, client: 'tab:2', action: 'done', outcome: 'created' }, 1002)).toBeNull();
    expect(pendingSetupTasks(1000 + SETUP_TASK_CLAIM_MS + 1)[0]!.state).toBe('requested');
    expect(reportSetupTask({ id, client: 'tab:2', action: 'claim' }, 1000 + SETUP_TASK_CLAIM_MS + 2)).toEqual([]);
    expect(reportSetupTask({ id, client: 'tab:2', action: 'done', outcome: 'nonsense' }, 1000 + SETUP_TASK_CLAIM_MS + 3)).toBeNull();
    expect(reportSetupTask({ id, client: 'tab:2', action: 'done', outcome: 'exists' }, 1000 + SETUP_TASK_CLAIM_MS + 3)).toEqual([]);
    expect(setupTaskStatus('plugin-add')).toMatchObject({ id, surface: 'core', state: 'done', outcome: 'exists', error: null });
    expect(pendingSetupTasks()).toEqual([]);
  });

  it('asks for Allow all tools once a created plugin reports its app id', () => {
    const id = queued(requestPluginAdd(CORE));
    reportSetupTask({ id, client: 'tab:1', action: 'claim' });
    expect(reportSetupTask({ id, client: 'tab:1', action: 'done', outcome: 'created', appId: APP })).toEqual([{ kind: 'permission', appId: APP, name: CORE.name, surface: 'core' }]);
    expect(requestPluginPermission('not-an-app', CORE.name)).toEqual({ ok: false, error: 'invalid-request' });
    const permission = queued(requestPluginPermission(APP, CORE.name, 'core'));
    expect(pendingSetupTasks()).toEqual([expect.objectContaining({ id: permission, kind: 'plugin-permission', appId: APP })]);
    reportSetupTask({ id: permission, client: 'tab:1', action: 'claim' });
    expect(reportSetupTask({ id: permission, client: 'tab:1', action: 'done', outcome: 'unavailable' })).toEqual([]);
    expect(setupTaskStatus('plugin-permission')).toMatchObject({ state: 'done', outcome: 'unavailable' });
  });

  it('hands over the tunnel first, then a well-formed key, and only then finishes', () => {
    const id = queued(requestOpenaiSetup({ tunnelName: 'Gem Web Code', keyName: 'Gem Web Code', knownTunnelId: 'junk' }));
    expect(pendingSetupTasks()[0]).toMatchObject({ kind: 'openai-setup', tunnelName: 'Gem Web Code', progress: null });
    expect(pendingSetupTasks()[0]!.knownTunnelId).toBeUndefined();
    reportSetupTask({ id, client: 'tab:7', action: 'claim' });
    expect(reportSetupTask({ id, client: 'tab:7', action: 'progress', progress: 'key', key: KEY })).toBeNull();
    expect(reportSetupTask({ id, client: 'tab:7', action: 'done', outcome: 'done' })).toBeNull();
    expect(reportSetupTask({ id, client: 'tab:7', action: 'progress', progress: 'tunnel', tunnelId: 'tunnel_nothex' })).toBeNull();
    expect(reportSetupTask({ id, client: 'tab:7', action: 'progress', progress: 'tunnel', tunnelId: TUNNEL })).toEqual([{ kind: 'tunnel', tunnelId: TUNNEL }]);
    expect(reportSetupTask({ id, client: 'tab:7', action: 'progress', progress: 'key', key: 'sk-short' })).toBeNull();
    expect(reportSetupTask({ id, client: 'tab:7', action: 'progress', progress: 'key', key: KEY })).toEqual([{ kind: 'key', key: KEY }]);
    expect(reportSetupTask({ id, client: 'tab:7', action: 'done', outcome: 'done' })).toEqual([]);
    // The key is handed to the caller once and never kept in the task or its status.
    expect(JSON.stringify(setupTaskStatus('openai-setup'))).not.toContain(KEY);
    expect(JSON.stringify(pendingSetupTasks())).not.toContain(KEY);
  });

  it('lets the extension fail a task nobody claimed (a sign-in page), and nothing else', () => {
    const id = queued(requestOpenaiSetup({ tunnelName: 'Gem Web Code', keyName: 'Gem Web Code' }));
    expect(reportSetupTask({ id, client: 'background', action: 'claim' })).toBeNull();
    expect(reportSetupTask({ id, client: 'background', action: 'fail', error: 'Sign in to platform.openai.com in this browser, then press the button again' })).toEqual([]);
    expect(setupTaskStatus('openai-setup')).toMatchObject({ state: 'failed', error: expect.stringContaining('Sign in') });
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
  pluginAddMenuItem(labels?: string[]): HTMLElement | null;
  installedPluginAppId(name: string): string | null;
  pluginPermissionRadio(): HTMLInputElement | null;
  pluginAddForm(): null | { dialog: HTMLElement; name: HTMLInputElement; description: HTMLTextAreaElement; urlToggle: HTMLButtonElement; tunnelToggle: HTMLButtonElement; auth: HTMLSelectElement; consent: HTMLElement; submit: HTMLButtonElement };
  pluginConnectionInput(dialog: HTMLElement, tunnel: boolean): HTMLInputElement | null;
  fillField(field: HTMLElement, value: string): boolean;
  installedPluginNamed(name: string): boolean;
  pluginAddControl(labels?: string[]): HTMLButtonElement | null;
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

  it("finds Add and its menu item in the page's language, and a plugin's app id", () => {
    const doc = page.window.document;
    doc.querySelector('main button')!.textContent = 'Hinzufügen';
    doc.body.insertAdjacentHTML('beforeend', '<div role="menu"><div role="menuitem">Plugin erstellen</div><div role="menuitem">Benutzerdefinierten MCP-Server hinzufügen</div></div>');
    expect(dom.pluginAddControl()).toBeNull();
    expect(dom.pluginAddControl(['Add', 'Hinzufügen'])?.textContent).toBe('Hinzufügen');
    expect(dom.pluginAddMenuItem(['Add custom MCP server', 'Benutzerdefinierten MCP-Server hinzufügen'])?.textContent).toBe('Benutzerdefinierten MCP-Server hinzufügen');
    expect(dom.pluginAddMenuItem(['Add custom MCP server'])).toBeNull();
    expect(dom.installedPluginAppId('Other Plugin')).toBe('asdk_app_1');
    expect(dom.installedPluginAppId('Chat On Steroids Core')).toBeNull();
  });
});

// The Permissions page of a plugin (settings/plugins-settings/plugin_<id>/permissions, 2026-11-22).
describe("a ChatGPT plugin's Permissions page", () => {
  const source = readFileSync(new URL('../extension/chatgpt-dom.js', import.meta.url), 'utf8');
  const radios = (values: string[], checked = 'review_important_actions') => `<main><h1>Permissions</h1>${values.map(value =>
    `<input type="radio" name="_r_cj_" id="r-${value}" value="${value}" ${value === checked ? 'checked' : ''}><label for="r-${value}">${value}</label>`).join('')}</main>`;
  const load = (html: string) => {
    const page = new JSDOM(html, { url: 'https://chatgpt.com/settings/plugins-settings/plugin_asdk_app_1/permissions', runScripts: 'outside-only' });
    Object.defineProperty(page.window.HTMLElement.prototype, 'getClientRects', { value() { return this.isConnected ? [{}] : []; } });
    page.window.eval(source);
    return (page.window as unknown as { CLF_DOM: Dom }).CLF_DOM;
  };
  it('finds Allow all tools by its value, in any language, only when all four choices are there', () => {
    const all = ['always_ask', 'ask_before_writes', 'review_important_actions', 'full_access'];
    expect(load(radios(all)).pluginPermissionRadio()?.value).toBe('full_access');
    expect(load(radios(all, 'full_access')).pluginPermissionRadio()?.checked).toBe(true);
    expect(load(radios(all.slice(0, 3))).pluginPermissionRadio()).toBeNull();
    expect(load(radios([...all, 'something_new'])).pluginPermissionRadio()).toBeNull();
  });
});
