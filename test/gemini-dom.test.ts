import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../extension/gemini-dom.js', import.meta.url), 'utf8');

interface Mode { id: string; title: string; model: string | null; available: boolean; selected: boolean; reason: string | null }
interface GeminiDom {
  conversationId(href?: string): string | null;
  signInState(): 'signed-in' | 'signed-out' | 'unknown';
  account(): { name: string | null; plan: string | null } | null;
  selectedModeLabel(): string | null;
  readOpenModes(): Mode[];
  inspectModes(): Promise<{ modes: Mode[]; thinkingLevels: Array<{ label: string; selected: boolean }> } | null>;
  selectMode(id: string): Promise<boolean>;
  selectThinkingLevel(level: string): Promise<boolean>;
  insertPrompt(text: string): boolean;
  composerText(): string;
  mentionConnector(name: string, current?: () => boolean, openMenu?: (() => Promise<boolean>) | null): Promise<boolean>;
  send(options?: { acceptanceTimeoutMs?: number }): Promise<boolean>;
  generating(): boolean;
  stopGeneration(): boolean;
  turns(): Array<{ id: string | null; user: string; answer: string; final: boolean }>;
  errors(): Array<{ text: string; quota: boolean; signedOut: boolean }>;
  localized(): boolean;
  snapshot(): Record<string, unknown> & { account: unknown; lastTurn: { id: string; final: boolean } | null };
  customAppCard(name: string): HTMLElement | null;
  readCustomAppUrl(name: string, ms?: number): Promise<string | null>;
  fillCreateForm(url: string, ms?: number): Promise<HTMLButtonElement | null>;
  highlight(node: HTMLElement, note: string): void;
  deleteCustomApp(name: string, ms?: number): Promise<boolean>;
  connectStep(): { dialog: HTMLElement; checkbox: HTMLInputElement; connect: HTMLButtonElement } | null;
}

// Shapes copied from the live gemini.google.com page (2026-11-20, Google AI Pro account).
const PAGE = `
<a role="button" aria-label="Google Account: Pat  (pat@example.com), Google membership" href="#"></a>
<sidenav-mavatar-footer><span>Pat</span><span>Pro</span></sidenav-mavatar-footer>
<chat-window><chat-window-content>
  <infinite-scroller data-test-id="chat-history-container"></infinite-scroller>
</chat-window-content>
<input-area-v2>
  <rich-textarea><div class="ql-editor ql-blank" contenteditable="true" aria-label="Enter a prompt for Gemini"></div></rich-textarea>
  <bard-mode-switcher><div><button data-test-id="bard-mode-menu-button" aria-label="Open mode picker, currently Hydrogen" aria-expanded="false">Hydrogen</button></div></bard-mode-switcher>
  <button aria-label="Send message">send</button>
</input-area-v2></chat-window>
<div id="overlay"></div>`;

const MENU = `
<gem-menu-item role="menuitemradio" data-mode-id="8c46e95b1a07cecc" aria-checked="false" aria-disabled="false">Auto Adapts to your needs</gem-menu-item>
<gem-menu-item role="menuitemradio" data-mode-id="56fdd199312815e2" aria-checked="true" aria-disabled="false">Everyday help 4 Hydrogen</gem-menu-item>
<gem-menu-item role="menuitemradio" data-mode-id="e6fa609c3fa255c0" aria-checked="false" aria-disabled="false">Deeper analysis 4 Neon New</gem-menu-item>
<gem-menu-item role="menuitemradio" data-mode-id="upsell_MODE_CATEGORY_ULTRA" aria-checked="false" aria-disabled="false">Code &amp; complex work 4 Carbon</gem-menu-item>
<gem-menu-item role="menuitem" aria-haspopup="true">Thinking level</gem-menu-item>
<gem-menu-item role="menuitemradio" aria-checked="true">Low Fast and efficient</gem-menu-item>
<gem-menu-item role="menuitemradio" aria-checked="false">Medium Balanced depth</gem-menu-item>
<gem-menu-item role="menuitemradio" aria-checked="false">High Extra thorough</gem-menu-item>`;

let dom: JSDOM;
let api: GeminiDom;
let document: Document;

beforeEach(() => {
  dom = new JSDOM(PAGE, { url: 'https://gemini.google.com/app/0819834086544111', runScripts: 'outside-only', pretendToBeVisual: true });
  document = dom.window.document;
  document.documentElement.lang = 'en';
  Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', { value() { return this.hidden ? [] : [{ width: 10, height: 10 }]; } });
  // The real picker renders its options into a CDK overlay when the button is clicked.
  const button = document.querySelector('[data-test-id="bard-mode-menu-button"]')!;
  button.addEventListener('click', () => {
    document.getElementById('overlay')!.innerHTML = MENU;
    button.setAttribute('aria-expanded', 'true');
    for (const item of document.querySelectorAll('[data-mode-id]')) {
      item.addEventListener('click', () => {
        for (const other of document.querySelectorAll('[data-mode-id]')) other.setAttribute('aria-checked', String(other === item));
        button.setAttribute('aria-label', `Open mode picker, currently ${item.textContent!.match(/4 (\w+)/)?.[1] ?? 'Auto'}`);
      });
    }
  });
  document.addEventListener('keydown', event => {
    if ((event as KeyboardEvent).key === 'Escape') { document.getElementById('overlay')!.innerHTML = ''; button.setAttribute('aria-expanded', 'false'); }
  });
  dom.window.eval(source);
  api = (dom.window as unknown as { CLF_GEMINI_DOM: GeminiDom }).CLF_GEMINI_DOM;
});
afterEach(() => dom.window.close());

function addTurn(id: string, user: string, answer: string, busy = false) {
  const turn = document.createElement('div');
  turn.className = 'conversation-container';
  turn.id = id;
  // Live Gemini keeps `processing-state-visible` on finished answers too; only aria-busy marks work.
  turn.innerHTML = `<user-query><div class="query-text"><h5>You said</h5><p class="query-text-line">${user}</p></div></user-query>
    <model-response><structured-content-container class="model-response-text processing-state-visible" ${busy ? 'aria-busy="true"' : ''}>
    <message-content><div class="markdown"><p>${answer}</p></div></message-content></structured-content-container></model-response>`;
  document.querySelector('[data-test-id="chat-history-container"]')!.append(turn);
}

describe('Gemini page adapter', () => {
  it('reads the conversation id from app, gem and account-index paths and null on a new chat', () => {
    expect(api.conversationId()).toBe('0819834086544111');
    expect(api.conversationId('https://gemini.google.com/gem/coding-partner/abcdef0123456789')).toBe('abcdef0123456789');
    expect(api.conversationId('https://gemini.google.com/u/1/app/ABCDEF0123456789')).toBe('abcdef0123456789');
    expect(api.conversationId('https://gemini.google.com/app')).toBeNull();
    expect(api.conversationId('https://gemini.google.com/app/not-an-id')).toBeNull();
  });

  it('reports sign-in and plan without ever returning the Google address', () => {
    expect(api.signInState()).toBe('signed-in');
    const account = api.account();
    expect(account).toEqual({ name: 'Pat', plan: 'Pro' });
    expect(JSON.stringify(api.snapshot())).not.toContain('pat@example.com');
  });

  it('reports signed-out when only a sign-in link is present', () => {
    document.querySelector('[aria-label^="Google Account:"]')!.remove();
    const link = document.createElement('a');
    link.href = 'https://accounts.google.com/ServiceLogin?continue=x';
    document.body.append(link);
    expect(api.signInState()).toBe('signed-out');
    expect(api.account()).toBeNull();
  });

  it('inspects modes from the picker, marks the upsell model unavailable and closes the menu', async () => {
    const result = await api.inspectModes();
    expect(result).not.toBeNull();
    expect(result!.modes.map(m => [m.model, m.available, m.selected])).toEqual([
      [null, true, false],
      ['Gemini 4 Hydrogen', true, true],
      ['Gemini 4 Neon', true, false],
      ['Gemini 4 Carbon', false, false],
    ]);
    expect(result!.modes[3]!.reason).toBe('requires-upgrade');
    expect(result!.modes[2]!.title).toBe('Deeper analysis');
    expect(result!.thinkingLevels.map(l => l.label)).toEqual(['Low', 'Medium', 'High']);
    expect(api.readOpenModes()).toEqual([]);
  });

  it('selects Neon by its stable id and refuses the locked model', async () => {
    expect(await api.selectMode('e6fa609c3fa255c0')).toBe(true);
    expect(api.selectedModeLabel()).toBe('Neon');
    expect(await api.selectMode('upsell_MODE_CATEGORY_ULTRA')).toBe(false);
    expect(api.selectedModeLabel()).toBe('Neon');
    expect(await api.selectMode('no-such-mode')).toBe(false);
  });

  it('selects a thinking level by label', async () => {
    expect(await api.selectThinkingLevel('High')).toBe(true);
    expect(await api.selectThinkingLevel('Ludicrous')).toBe(false);
  });

  it('inserts a prompt and sends it, accepting when Gemini shows Stop', async () => {
    expect(api.insertPrompt('Reply with PONG')).toBe(true);
    expect(api.composerText()).toBe('Reply with PONG');
    const sendButton = document.querySelector('button[aria-label="Send message"]')!;
    sendButton.addEventListener('click', () => {
      sendButton.setAttribute('aria-label', 'Stop response');
    });
    expect(await api.send({ acceptanceTimeoutMs: 1000 })).toBe(true);
    expect(api.generating()).toBe(true);
    expect(api.stopGeneration()).toBe(true);
  });

  it('does not claim a send when the button never becomes usable', async () => {
    document.querySelector('button[aria-label="Send message"]')!.setAttribute('disabled', '');
    api.insertPrompt('x');
    expect(await api.send({ acceptanceTimeoutMs: 300 })).toBe(false);
  });

  it('lists turns with Gemini turn ids and final state', () => {
    addTurn('4b3e398afa4ee324', 'Reply with exactly PONG', 'PONG');
    addTurn('5c4f', 'next', 'partial', true);
    const all = api.turns();
    expect(all).toEqual([
      { id: '4b3e398afa4ee324', user: 'Reply with exactly PONG', answer: 'PONG', answerHtml: '<p>PONG</p>', final: true },
      { id: '5c4f', user: 'next', answer: 'partial', answerHtml: '<p>partial</p>', final: false },
    ]);
    expect(api.snapshot().lastTurn).toEqual({ id: '5c4f', final: false, answerChars: 7 });
  });

  describe('@-mentioning a connected app', () => {
    // The live menu: `button[role=menuitem]` "Name, description" entries. It opens on the key events
    // around an inserted "@" only after the page saw a real keystroke (`armed`).
    let armed = false;
    const showMenu = () => {
      document.getElementById('overlay')!.innerHTML = ['Gemini Notebook, Notebooks', 'Verify AI, provenance', 'Chat On Steroids Core']
        .map(label => `<button role="menuitem" aria-label="${label}">${label}</button>`).join('');
      for (const option of document.querySelectorAll('#overlay button')) option.addEventListener('click', () => {
        const box = document.querySelector('rich-textarea .ql-editor')!;
        box.innerHTML = `<p><strong>@${option.getAttribute('aria-label')!.split(',')[0]}</strong> </p>`;
        document.getElementById('overlay')!.innerHTML = '';
      });
    };
    beforeEach(() => {
      armed = false;
      document.querySelector('rich-textarea .ql-editor')!.addEventListener('keyup', event => { if ((event as KeyboardEvent).key === '@' && armed) showMenu(); });
    });

    it('picks the exact connector from the opened menu after synthetic keys once the page is armed', async () => {
      armed = true;
      expect(await api.mentionConnector('Chat On Steroids Core')).toBe(true);
      expect(document.querySelector('rich-textarea strong')!.textContent).toBe('@Chat On Steroids Core');
    });

    it('asks for one trusted "@" when synthetic keys do not open the menu, and never guesses a name', async () => {
      let asked = 0;
      const openMenu = async () => { asked += 1; showMenu(); return true; };
      expect(await api.mentionConnector('Chat On Steroids Core', () => true, openMenu)).toBe(true);
      expect(asked).toBe(1);
      expect(await api.mentionConnector('Chat On Steroids', () => true, openMenu)).toBe(false);
      expect(api.composerText()).toBe('');
    });

    it('fails without a trusted fallback instead of sending a plain-text mention', async () => {
      expect(await api.mentionConnector('Chat On Steroids Core')).toBe(false);
      expect(api.composerText()).toBe('');
    });
  });

  it('classifies visible quota and sign-in errors and flags non-English pages', () => {
    const alert = document.createElement('div');
    alert.setAttribute('role', 'alert');
    alert.textContent = "You've reached your limit for Deeper analysis. Try again later.";
    document.body.append(alert);
    expect(api.errors()).toEqual([{ text: alert.textContent, quota: true, signedOut: false }]);
    expect(api.localized()).toBe(false);
    document.documentElement.lang = 'de';
    expect(api.localized()).toBe(true);
  });

  it('never throws when the page has none of its anchors', () => {
    document.body.innerHTML = '';
    expect(api.snapshot()).toMatchObject({ signIn: 'unknown', account: null, composerReady: false, generating: false, turnCount: 0, lastTurn: null });
    expect(api.insertPrompt('x')).toBe(false);
    expect(api.stopGeneration()).toBe(false);
  });
});

// Shapes copied from the live custom apps page (gemini.google.com/customize/connectors, 2026-11-22).
const APPS = `
<a aria-label="Google Account: Pat (pat@example.com)" href="#"></a>
<button aria-label="Create custom app">Custom</button>
<section class="category-section"><h2>Custom apps</h2><div class="apps-grid">
  <customize-card><button class="card-primary-action" aria-label="Chat On Steroids Core"></button>
  <div class="content">Chat On Steroids Core</div><div class="card-action-container"><button aria-label="More options"></button></div></customize-card>
</div></section>
<div id="details"></div><div id="dialogs"></div>`;

describe('Gemini custom apps page', () => {
  const url = `https://new-name.trycloudflare.com/mcp/core/${'a'.repeat(43)}`;
  let next: HTMLButtonElement;
  beforeEach(() => {
    dom.window.close();
    dom = new JSDOM(APPS, { url: 'https://gemini.google.com/customize/connectors', runScripts: 'outside-only', pretendToBeVisual: true });
    document = dom.window.document;
    document.documentElement.lang = 'en';
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', { value() { return this.hidden ? [] : [{ width: 10, height: 10 }]; } });
    document.querySelector('.card-primary-action')!.addEventListener('click', () => {
      document.getElementById('details')!.innerHTML = `<div class="details-content-column" role="region"><h1>Chat On Steroids Core</h1>
        <button aria-label="More options"></button><dl class="info-list">
        <div class="info-row"><dt>Handle</dt><dd>@Chat On Steroids Core</dd></div>
        <div class="info-row"><dt>MCP URL</dt><dd>https://old-name.trycloudflare.com/mcp/core/${'b'.repeat(43)}</dd></div></dl></div>`;
    });
    document.querySelector('button[aria-label="Create custom app"]')!.addEventListener('click', () => {
      document.getElementById('dialogs')!.innerHTML = `<mat-dialog-container role="dialog"><h2>Connect to an MCP server</h2>
        <input type="url" name="url"><input type="text" name="clientId"><input type="password" name="clientSecret">
        <button>Cancel</button><button disabled>Next</button></mat-dialog-container>`;
      const input = document.querySelector<HTMLInputElement>('input[name="url"]')!;
      next = [...document.querySelectorAll('button')].find(b => b.textContent === 'Next') as HTMLButtonElement;
      next.addEventListener('click', () => { throw new Error('the companion must never press Next'); });
      input.addEventListener('input', () => { next.disabled = !input.value.startsWith('https://'); });
    });
    dom.window.eval(source);
    api = (dom.window as unknown as { CLF_GEMINI_DOM: GeminiDom }).CLF_GEMINI_DOM;
  });

  it('reads the address an existing custom app has', async () => {
    expect(api.customAppCard('Chat On Steroids Core')).not.toBeNull();
    expect(api.customAppCard('Someone else')).toBeNull();
    expect(await api.readCustomAppUrl('Chat On Steroids Core', 500)).toBe(`https://old-name.trycloudflare.com/mcp/core/${'b'.repeat(43)}`);
  });

  it('fills only the address, leaves the optional fields empty and returns Next without pressing it', async () => {
    const button = await api.fillCreateForm(url, 500);
    expect(button).toBe(next);
    expect(button!.disabled).toBe(false);
    expect(document.querySelector<HTMLInputElement>('input[name="url"]')!.value).toBe(url);
    expect(document.querySelector<HTMLInputElement>('input[name="clientId"]')!.value).toBe('');
    expect(document.querySelector<HTMLInputElement>('input[name="clientSecret"]')!.value).toBe('');
    api.highlight(button!, 'Click Next yourself.');
    expect(document.getElementById('clf-gemini-note')!.textContent).toBe('Click Next yourself.');
  });

  it('fills nothing when the page layout is not recognized', async () => {
    // A redesign: no Create button, or a dialog without the URL field.
    document.querySelector('button[aria-label="Create custom app"]')!.remove();
    expect(await api.fillCreateForm(url, 300)).toBeNull();
    document.body.insertAdjacentHTML('beforeend', '<button aria-label="Create custom app" id="c2">Custom</button>');
    document.getElementById('c2')!.addEventListener('click', () => {
      document.getElementById('dialogs')!.innerHTML = '<mat-dialog-container role="dialog"><input name="link"><button>Next</button></mat-dialog-container>';
    });
    expect(await api.fillCreateForm(url, 300)).toBeNull();
    expect(document.querySelector<HTMLInputElement>('input[name="link"]')!.value).toBe('');
    expect(await api.readCustomAppUrl('Chat On Steroids Core', 0)).toBeNull();
  });

  // More options on the details page offers Use now and Delete (live, 2026-11-22).
  it('deletes the app with the old address through More options → Delete, and confirms only a Delete', async () => {
    const doc = document;
    expect(await api.readCustomAppUrl('Chat On Steroids Core', 500)).toMatch(/old-name/);
    const pressed: string[] = [];
    doc.querySelector('#details button[aria-label="More options"]')!.addEventListener('click', () => {
      doc.body.insertAdjacentHTML('beforeend', '<div role="menu"><button role="menuitem">Use now</button><button role="menuitem" id="del">Delete</button></div>');
      doc.getElementById('del')!.addEventListener('click', () => {
        pressed.push('Delete');
        doc.getElementById('dialogs')!.innerHTML = '<mat-dialog-container role="dialog"><p>Delete this app?</p><button>Cancel</button><button id="confirm">Delete</button></mat-dialog-container>';
        doc.getElementById('confirm')!.addEventListener('click', () => {
          pressed.push('confirm');
          doc.getElementById('dialogs')!.innerHTML = '';
          doc.querySelector('customize-card')!.remove();
        });
      });
    });
    expect(await api.deleteCustomApp('Chat On Steroids Core', 2000)).toBe(true);
    expect(pressed).toEqual(['Delete', 'confirm']);
    expect(api.customAppCard('Chat On Steroids Core')).toBeNull();
  });

  it('gives up without a Delete item, deleting nothing', async () => {
    await api.readCustomAppUrl('Chat On Steroids Core', 500);
    expect(await api.deleteCustomApp('Chat On Steroids Core', 300)).toBe(false);
    expect(api.customAppCard('Chat On Steroids Core')).not.toBeNull();
  });

  // After Next: "Connect this MCP server" with Google's notice (a mat-checkbox) and Connect (live, 2026-11-22).
  it('finds the notice and Connect after Next, and nothing in a dialog of another shape', () => {
    expect(api.connectStep()).toBeNull();
    document.getElementById('dialogs')!.innerHTML = `<mat-dialog-container role="dialog"><h2>Connect this MCP server</h2>
      <mat-checkbox><input type="checkbox"><label>I understand and accept the security and privacy risks of connecting this custom app.</label></mat-checkbox>
      <button>Cancel</button><button disabled>Connect</button></mat-dialog-container>`;
    const step = api.connectStep()!;
    expect(step.checkbox.checked).toBe(false);
    expect(step.connect.textContent).toBe('Connect');
    document.querySelector('mat-dialog-container')!.insertAdjacentHTML('beforeend', '<mat-checkbox><input type="checkbox"></mat-checkbox>');
    expect(api.connectStep()).toBeNull();
  });
});
