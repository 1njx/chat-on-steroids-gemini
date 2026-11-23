import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it } from 'vitest';

const domSource = readFileSync(new URL('../extension/gemini-dom.js', import.meta.url), 'utf8');
const contentSource = readFileSync(new URL('../extension/gemini-content.js', import.meta.url), 'utf8');
const address = (host: string) => `https://${host}.trycloudflare.com/mcp/core/${'a'.repeat(43)}`;
const NEW = address('new-name');

let dom: JSDOM | null = null;
afterEach(() => { dom?.window.close(); dom = null; });

interface App { name: string; url: string }

/**
 * Gemini's custom apps page as observed on 2026-11-22: a card per app, a details page with the
 * MCP URL and More options → Delete, and Create custom app → Next → Google's notice → Connect.
 */
async function addInGemini(apps: App[], { flakyMenus = 0 } = {}) {
  dom = new JSDOM(`<a aria-label="Google Account: Pat (pat@example.com)" href="#"></a>
    <button aria-label="Create custom app">Custom</button><section><h2>Custom apps</h2><div id="grid"></div></section>
    <div id="details"></div><div id="menus"></div><div id="dialogs"></div>`,
  { url: 'https://gemini.google.com/customize/connectors', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const doc = window.document;
  doc.documentElement.lang = 'en';
  Object.defineProperty(window.HTMLElement.prototype, 'getClientRects', { value() { return this.isConnected ? [{ width: 10, height: 10 }] : []; } });
  const pressed: string[] = [];
  const button = (parent: Element, html: string, onClick: () => void) => {
    parent.insertAdjacentHTML('beforeend', html);
    const node = parent.lastElementChild!;
    node.addEventListener('click', onClick);
    return node as HTMLElement;
  };
  const render = () => {
    const grid = doc.getElementById('grid')!;
    grid.replaceChildren();
    for (const app of apps) {
      const card = doc.createElement('customize-card');
      grid.append(card);
      button(card, `<button class="card-primary-action" aria-label="${app.name}"></button>`, () => open(app));
    }
  };
  const open = (app: App) => {
    const details = doc.getElementById('details')!;
    details.innerHTML = `<dl><dt>MCP URL</dt><dd>${app.url}</dd></dl>`;
    button(details, '<button aria-label="Back to Connectors"></button>', () => { details.innerHTML = ''; });
    button(details, '<button aria-label="More options"></button>', () => {
      // A menu that does not open (a slow page) the first `flakyMenus` times.
      if (flakyMenus > 0) { flakyMenus -= 1; pressed.push('menu did not open'); return; }
      const menu = doc.getElementById('menus')!;
      menu.innerHTML = '<div role="menu"></div>';
      button(menu.firstElementChild!, '<button role="menuitem">Use now</button>', () => { throw new Error('never Use now'); });
      button(menu.firstElementChild!, '<button role="menuitem">Delete</button>', () => {
        menu.innerHTML = '';
        // Gemini's confirmation, as seen live on 2026-11-23: "Remove <name>?" with Cancel / Remove.
        const dialogs = doc.getElementById('dialogs')!;
        dialogs.innerHTML = `<mat-dialog-container role="dialog"><p>Remove ${app.name}? This removes the MCP server from Gemini.</p></mat-dialog-container>`;
        button(dialogs.firstElementChild!, '<button>Cancel</button>', () => { dialogs.innerHTML = ''; });
        button(dialogs.firstElementChild!, '<button>Remove</button>', () => {
          pressed.push(`delete ${app.url}`);
          apps.splice(apps.indexOf(app), 1);
          dialogs.innerHTML = ''; details.innerHTML = '';
          render();
        });
      });
    });
  };
  doc.querySelector('button[aria-label="Create custom app"]')!.addEventListener('click', () => {
    const dialogs = doc.getElementById('dialogs')!;
    dialogs.innerHTML = '<mat-dialog-container role="dialog"><input type="url" name="url"></mat-dialog-container>';
    const input = dialogs.querySelector('input')!;
    const next = button(dialogs.firstElementChild!, '<button disabled>Next</button>', () => {
      dialogs.innerHTML = '<mat-dialog-container role="dialog"><mat-checkbox><input type="checkbox"></mat-checkbox></mat-dialog-container>';
      const box = dialogs.querySelector('input')!;
      const connect = button(dialogs.firstElementChild!, '<button disabled>Connect</button>', () => {
        pressed.push(`add ${input.value}`);
        apps.push({ name: 'Chat On Steroids Core', url: input.value });
        dialogs.innerHTML = '';
        render();
      }) as HTMLButtonElement;
      box.addEventListener('click', () => { connect.disabled = !box.checked; });
    }) as HTMLButtonElement;
    input.addEventListener('input', () => { next.disabled = !input.value.startsWith('https://'); });
  });
  render();

  const results: Array<Record<string, unknown>> = [];
  let handed = false;
  (window as unknown as { chrome: unknown }).chrome = { runtime: { id: 'test', lastError: undefined, sendMessage(payload: Record<string, unknown>, reply: (value: unknown) => void) {
    if (payload.type === 'gemini_result') results.push(payload);
    const commands = payload.type === 'gemini_state' && !handed ? [{ id: 'fill-1', kind: 'fill-app', url: NEW, connector: null }] : [];
    if (commands.length) handed = true;
    setTimeout(() => reply({ ok: true, commands }), 0);
  } } };
  window.eval(domSource);
  window.eval(contentSource);
  for (const end = Date.now() + 25_000; Date.now() < end; await new Promise(resolve => setTimeout(resolve, 100))) {
    const last = results.at(-1);
    if (last && ['completed', 'failed'].includes(String(last.stage))) break;
  }
  return { final: results.at(-1), pressed, apps };
}

it('deletes every old and duplicate Core app first, keeps the one with this address, and adds nothing', async () => {
  const { final, pressed, apps } = await addInGemini([
    { name: 'Chat On Steroids Core', url: address('old-one') },
    { name: 'Other app', url: address('someone-else') },
    { name: 'chat-on-steroids core (2)', url: NEW },
    { name: 'Chat On Steroids Core', url: address('old-two') },
    { name: 'Chat On Steroids Core', url: NEW },
  ]);
  expect(final).toMatchObject({ stage: 'completed', outcome: 'current', existingUrl: NEW });
  expect(pressed).toEqual([`delete ${address('old-one')}`, `delete ${address('old-two')}`, `delete ${NEW}`]);
  expect(apps.map(app => [app.name, app.url])).toEqual([['Other app', address('someone-else')], ['chat-on-steroids core (2)', NEW]]);
}, 30_000);

it('tries a delete that did not take again, and gives up after three tries without adding', async () => {
  const retried = await addInGemini([{ name: 'Chat On Steroids Core', url: address('old-one') }], { flakyMenus: 2 });
  expect(retried.final).toMatchObject({ stage: 'completed', outcome: 'connected' });
  expect(retried.pressed).toEqual(['menu did not open', 'menu did not open', `delete ${address('old-one')}`, `add ${NEW}`]);
  dom!.window.close(); dom = null;
  const stuck = await addInGemini([{ name: 'Chat On Steroids Core', url: address('old-one') }], { flakyMenus: 9 });
  expect(stuck.final).toMatchObject({ stage: 'failed', error: 'delete-failed' });
  expect(stuck.pressed).toEqual(['menu did not open', 'menu did not open', 'menu did not open']);
  expect(stuck.apps).toEqual([{ name: 'Chat On Steroids Core', url: address('old-one') }]);
}, 60_000);

it('deletes every old Core app before it adds and connects the new one', async () => {
  const { final, pressed, apps } = await addInGemini([
    { name: 'Chat On Steroids Core', url: address('old-one') },
    { name: 'Chat On Steroids Core (2)', url: address('old-two') },
  ]);
  expect(final).toMatchObject({ stage: 'completed', outcome: 'connected' });
  expect(pressed).toEqual([`delete ${address('old-one')}`, `delete ${address('old-two')}`, `add ${NEW}`]);
  expect(apps).toEqual([{ name: 'Chat On Steroids Core', url: NEW }]);
}, 30_000);
