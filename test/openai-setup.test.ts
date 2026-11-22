import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';

// Shapes copied from the live platform.openai.com pages (Tunnels and API keys, 2026-11-22, English).
// Its pickers open and choose on pointer-down, so the fixtures do the same.
const source = readFileSync(new URL('../extension/openai-setup.js', import.meta.url), 'utf8');
const OLD = `tunnel_${'6b'.repeat(16)}`;
const NEW = `tunnel_${'c0'.repeat(16)}`;
const KEY = `sk-proj-${'K'.repeat(48)}`;
type Api = {
  tunnelRows(): Array<{ name: string; id: string }>;
  findTunnel(task: Record<string, unknown>): string | null;
  createTunnel(task: Record<string, unknown>): Promise<{ tunnelId?: string; error?: string }>;
  createKey(task: Record<string, unknown>): Promise<{ key?: string; error?: string }>;
};
let page: JSDOM;
afterEach(() => page?.window.close());

function load(html: string, path: string) {
  page = new JSDOM(`<main>${html}</main><div id="portal"></div>`, { url: `https://platform.openai.com${path}`, runScripts: 'outside-only' });
  const win = page.window;
  Object.defineProperty(win.HTMLElement.prototype, 'getClientRects', { value() { return this.isConnected && !this.closest('[hidden]') ? [{}] : []; } });
  if (!('PointerEvent' in win)) (win as unknown as { PointerEvent: unknown }).PointerEvent = win.MouseEvent;
  return win;
}
const api = () => { page.window.eval(source); return (page.window as unknown as { CLF_OPENAI: Api }).CLF_OPENAI; };
const row = (name: string, id: string) => `<tr><td><div><span>${name}</span><span>${name} (description)</span></div></td><td>${id}<button aria-label="Copy tunnel ID"></button></td></tr>`;
/** A listbox of these options under the portal, opened by pointer-down on `trigger`. */
function picker(doc: Document, trigger: Element, options: string[], multi = false, onChange = () => {}) {
  trigger.addEventListener('pointerdown', () => {
    doc.getElementById('portal')!.innerHTML = `<div role="listbox">${options.map(text => `<div role="option" aria-selected="false">${text}</div>`).join('')}</div>`;
    for (const option of doc.querySelectorAll('[role="option"]')) option.addEventListener('pointerdown', () => {
      if (!multi) doc.querySelectorAll('[role="option"]').forEach(other => other.setAttribute('aria-selected', 'false'));
      option.setAttribute('aria-selected', option.getAttribute('aria-selected') === 'true' ? 'false' : 'true');
      trigger.textContent = option.textContent!;
      onChange();
    });
  });
}

describe('platform.openai.com Tunnels page', () => {
  const tunnels = (workspaces: string[]) => {
    const win = load(`<button>Create tunnel</button><table><tbody>${row('chat on steriods', OLD)}</tbody></table><div id="dialog"></div>`, '/settings/organization/tunnels');
    const doc = win.document;
    const created: string[] = [];
    doc.querySelector('main > button')!.addEventListener('click', () => {
      doc.getElementById('dialog')!.innerHTML = `<div role="dialog"><h2>Create tunnel</h2>
        <div><label>Name *</label><input type="text"></div><div><label>Description *</label><textarea></textarea></div>
        <div><label>Organizations</label><span role="button">org-1</span></div>
        <div><label><div><div>ChatGPT workspaces</div></div></label><span role="button">Search workspaces by name or ID</span></div>
        <button type="button">Cancel</button><button type="button" disabled>Create</button></div>`;
      const dialog = doc.querySelector('[role="dialog"]')!;
      const create = [...dialog.querySelectorAll('button')].find(button => button.textContent === 'Create')!;
      const name = dialog.querySelector('input')!, description = dialog.querySelector('textarea')!;
      const check = () => { create.disabled = !(name.value && description.value); };
      name.addEventListener('input', check); description.addEventListener('input', check);
      picker(doc, dialog.querySelectorAll('[role="button"]')[1]!, workspaces, true);
      create.addEventListener('click', () => {
        created.push(name.value);
        doc.querySelector('tbody')!.insertAdjacentHTML('beforeend', row(name.value, NEW));
        doc.getElementById('dialog')!.innerHTML = '';
      });
    });
    return created;
  };

  it('takes the tunnel the app already uses, or the one named for this app', () => {
    tunnels(['47672693-160b-4bb2-bd37-8db4ecf01aa2']);
    const openai = api();
    expect(openai.tunnelRows()).toEqual([{ name: 'chat on steriods', id: OLD }]);
    expect(openai.findTunnel({ knownTunnelId: OLD, tunnelName: 'Chat On Steroids' })).toBe(OLD);
    expect(openai.findTunnel({ tunnelName: 'Chat On Steriods' })).toBe(OLD);
    expect(openai.findTunnel({ tunnelName: 'Chat On Steroids' })).toBeNull();
  });

  it('creates one in the only ChatGPT workspace and reads its new ID', async () => {
    const created = tunnels(['47672693-160b-4bb2-bd37-8db4ecf01aa2']);
    expect(await api().createTunnel({ tunnelName: 'Chat On Steroids', tunnelDescription: 'Chat On Steroids on this computer' })).toEqual({ tunnelId: NEW });
    expect(created).toEqual(['Chat On Steroids']);
  });

  it('creates nothing when there are several workspaces to choose from', async () => {
    const created = tunnels(['ws-a', 'ws-b']);
    expect((await api().createTunnel({ tunnelName: 'Chat On Steroids', tunnelDescription: 'x' })).error).toMatch(/several ChatGPT workspaces/);
    expect(created).toEqual([]);
  });
});

describe('platform.openai.com API keys page', () => {
  const keys = (options: { restricted?: boolean } = {}) => {
    const win = load('<button>Create new secret key</button><div id="dialog"></div>', '/settings/organization/api-keys');
    const doc = win.document;
    const submitted: string[] = [];
    doc.querySelector('main > button')!.addEventListener('click', () => {
      doc.getElementById('dialog')!.innerHTML = `<div role="dialog"><h2>Create new secret key</h2>
        <div><button role="radio" aria-checked="true">You</button><button role="radio" aria-checked="false">Service account</button></div>
        <div><label>Name</label><input type="text" placeholder="My Test Key"></div>
        <div><label>Project</label><span role="button" data-state="closed">Select project...</span></div>
        <div><button role="radio" aria-checked="true">All</button>${options.restricted === false ? '' : '<button role="radio" aria-checked="false">Restricted</button>'}<button role="radio" aria-checked="false">Read only</button></div>
        <div id="scopes" hidden><div><button>Agents</button><span role="button" data-state="closed">None</span></div><div><button>Tunnels</button><span role="button" data-state="closed">None</span></div></div>
        <button type="button">Cancel</button><button type="submit" disabled>Create secret key</button></div>`;
      const dialog = doc.querySelector('[role="dialog"]')!;
      const submit = dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!;
      const state = { project: false, scopes: 0 };
      const check = () => { submit.disabled = !(state.project && state.scopes === 2); };
      picker(doc, dialog.querySelector('[data-state]')!, ['Default project'], false, () => { state.project = true; check(); });
      for (const radio of dialog.querySelectorAll('[role="radio"]')) radio.addEventListener('click', () => {
        radio.parentElement!.querySelectorAll('[role="radio"]').forEach(other => other.setAttribute('aria-checked', String(other === radio)));
        doc.getElementById('scopes')!.hidden = radio.textContent !== 'Restricted';
      });
      const tunnelsPicker = doc.querySelectorAll('#scopes [role="button"]')[1]!;
      picker(doc, tunnelsPicker, ['Read', 'Use'], true, () => { state.scopes = doc.querySelectorAll('[role="option"][aria-selected="true"]').length; check(); });
      submit.addEventListener('click', () => {
        submitted.push(dialog.querySelector('input')!.value);
        doc.getElementById('dialog')!.innerHTML = `<div role="dialog"><h2>Save your key</h2><input readonly value="${KEY}"><button>Done</button></div>`;
      });
    });
    return submitted;
  };

  it('creates a Restricted key with Tunnels Read and Use in the default project, and reads it once', async () => {
    const submitted = keys();
    expect(await api().createKey({ keyName: 'Chat On Steroids' })).toEqual({ key: KEY });
    expect(submitted).toEqual(['Chat On Steroids']);
  });

  it('creates nothing when the form does not look as observed', async () => {
    const submitted = keys({ restricted: false });
    expect((await api().createKey({ keyName: 'Chat On Steroids' })).error).toMatch(/did not look as expected/);
    expect(submitted).toEqual([]);
  });
});
