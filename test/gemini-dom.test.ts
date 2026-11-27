import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../extension/gemini-dom.js', import.meta.url), 'utf8');

interface Mode { id: string; title: string; model: string | null; available: boolean; selected: boolean; reason: string | null; note?: string | null }
interface GeminiDom {
  conversationId(href?: string): string | null;
  signInState(): 'signed-in' | 'signed-out' | 'unknown';
  account(): { name: string | null; plan: string | null } | null;
  selectedModeLabel(): string | null;
  readOpenModes(): Mode[];
  inspectModes(): Promise<{ modes: Mode[]; thinkingLevels: Array<{ label: string; selected: boolean }> } | null>;
  selectMode(id: string, current?: () => boolean, ms?: number): Promise<boolean>;
  modeFailure(): string | null;
  selectThinkingLevel(level: string): Promise<boolean>;
  insertPrompt(text: string): boolean;
  composerText(): string;
  mentionConnector(name: string, current?: () => boolean, openMenu?: (() => Promise<boolean>) | null): Promise<boolean>;
  send(options?: { acceptanceTimeoutMs?: number }): Promise<boolean>;
  generating(): boolean;
  stopGeneration(): boolean;
  turns(): Array<{ id: string | null; user: string; answer: string; answerHtml: string; final: boolean }>;
  errors(): Array<{ text: string; quota: boolean; signedOut: boolean }>;
  localized(): boolean;
  snapshot(): Record<string, unknown> & { account: unknown; lastTurn: { id: string; final: boolean } | null };
  customAppCard(name: string): HTMLElement | null;
  readCustomAppUrl(name: string, ms?: number): Promise<string | null>;
  fillCreateForm(url: string, ms?: number): Promise<HTMLButtonElement | null>;
  highlight(node: HTMLElement, note: string): void;
  deleteCustomApp(name: string, ms?: number): Promise<boolean>;
  connectStep(): { dialog: HTMLElement; checkbox: HTMLInputElement; connect: HTMLButtonElement } | null;
  sleep(ms: number): Promise<void>;
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

const MODES_MENU = [
  ['8c46e95b1a07cecc', 'Auto Adapts to your needs'],
  ['56fdd199312815e2', 'Everyday help 4 Hydrogen'],
  ['e6fa609c3fa255c0', 'Deeper analysis 4 Neon New'],
  ['upsell_MODE_CATEGORY_ULTRA', 'Code &amp; complex work 4 Carbon'],
];
const LEVELS_MENU = [['Low', 'Fast and efficient'], ['Medium', 'Balanced depth'], ['High', 'Extra thorough']];
/**
 * The picker as seen live on 2026-11-24: the selected model checked; Thinking level and its radios
 * only for a model that has levels (Auto has none); one level setting shared by the models.
 */
const menu = (selected: string, level: string) => MODES_MENU.map(([id, label]) =>
  `<gem-menu-item role="menuitemradio" data-mode-id="${id}" aria-checked="${id === selected}" aria-disabled="false">${label}</gem-menu-item>`).join('') +
  (selected === '8c46e95b1a07cecc' ? '' : '<gem-menu-item role="menuitem" aria-haspopup="true">Thinking level</gem-menu-item>' +
    LEVELS_MENU.map(([name, detail]) => `<gem-menu-item role="menuitemradio" aria-checked="${name === level}">${name} ${detail}</gem-menu-item>`).join(''));

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
  const overlay = document.getElementById('overlay')!;
  let selected = '56fdd199312815e2', level = 'Low';
  const close = () => { overlay.innerHTML = ''; button.setAttribute('aria-expanded', 'false'); };
  button.addEventListener('click', () => {
    if (button.getAttribute('aria-expanded') === 'true') { close(); return; }
    overlay.innerHTML = menu(selected, level);
    button.setAttribute('aria-expanded', 'true');
    for (const item of overlay.querySelectorAll('[data-mode-id]')) {
      item.addEventListener('click', () => {
        selected = item.getAttribute('data-mode-id')!;
        button.setAttribute('aria-label', `Open mode picker, currently ${item.textContent!.match(/4 (\w+)/)?.[1] ?? 'Auto'}`);
        close(); // Picking a model shuts the picker, as live.
      });
    }
    const radios = () => overlay.querySelectorAll('[role="menuitemradio"]:not([data-mode-id])');
    for (const item of radios()) {
      item.addEventListener('click', () => { level = item.textContent!.split(' ')[0]!; for (const other of radios()) other.setAttribute('aria-checked', String(other === item)); });
    }
  });
  document.addEventListener('keydown', event => { if ((event as KeyboardEvent).key === 'Escape') close(); });
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

  it("reads each model's thinking levels (none for Auto), then selects the model that was selected before", async () => {
    const result = await api.inspectModes();
    expect(result!.modes.map(m => [m.title, (m as Mode & { levels: string[] | null }).levels])).toEqual([
      ['Auto Adapts to your needs', []],
      ['Everyday help', ['Low', 'Medium', 'High']],
      ['Deeper analysis', ['Low', 'Medium', 'High']],
      ['Code & complex work', null],
    ]);
    expect(api.selectedModeLabel()).toBe('Hydrogen');
    expect(api.readOpenModes()).toEqual([]);
  });

  it('asks for no thinking level with a model that offers none, and still refuses one the model does not offer', async () => {
    expect(await api.selectMode('8c46e95b1a07cecc')).toBe(true);
    expect(await api.selectThinkingLevel('High')).toBe(true);
    expect(await api.selectMode('e6fa609c3fa255c0')).toBe(true);
    expect(await api.selectThinkingLevel('Ludicrous')).toBe(false);
  });

  it('opens the picker again when the first click right after a model switch opens nothing', async () => {
    const button = document.querySelector('[data-test-id="bard-mode-menu-button"]')!;
    let swallow = 1;
    button.addEventListener('click', event => { if (swallow > 0) { swallow -= 1; event.stopImmediatePropagation(); } }, true);
    expect(await api.selectMode('e6fa609c3fa255c0')).toBe(true);
    expect(api.selectedModeLabel()).toBe('Neon');
  });

  it('reads the selected model without the level Gemini appends to its label', () => {
    document.querySelector('[data-test-id="bard-mode-menu-button"]')!.setAttribute('aria-label', 'Open mode picker, currently Hydrogen Medium');
    expect(api.selectedModeLabel()).toBe('Hydrogen');
  });

  it('reads the 2026-11-22 popover picker: waits for it, titles from .label, shuts it, leaves Neon selected', async () => {
    // Live 2026-11-22: the switcher renders after the composer, options split into .label/.sublabel,
    // and the menu is a popover that ignores Escape; only its button closes it.
    const old = document.querySelector('bard-mode-switcher')!;
    old.remove();
    const option = (id: string, label: string, sub: string, checked = false) =>
      `<gem-menu-item role="menuitemradio" data-mode-id="${id}" aria-checked="${checked}" aria-disabled="false">` +
      `<div class="label-container"><span class="label">${label}</span><div class="sublabel">${sub}</div></div></gem-menu-item>`;
    setTimeout(() => {
      const switcher = document.createElement('bard-mode-switcher');
      switcher.innerHTML = '<button data-test-id="bard-mode-menu-button" aria-label="Open mode picker, currently Neon" aria-expanded="false">Neon</button>' +
        '<gem-menu id="picker" data-visible="false"></gem-menu>';
      document.querySelector('input-area-v2')!.append(switcher);
      const button = switcher.querySelector('button')!, menu = switcher.querySelector('gem-menu')!;
      button.addEventListener('click', () => {
        const open = button.getAttribute('aria-expanded') !== 'true';
        button.setAttribute('aria-expanded', String(open));
        menu.innerHTML = open ? option('8c46e95b1a07cecc', 'Auto', 'Adapts to your needs') + option('56fdd199312815e2', 'Everyday help', '4 Hydrogen') +
          option('e6fa609c3fa255c0', 'Deeper analysis', '4 Neon', true) + option('upsell_MODE_CATEGORY_ULTRA', 'Code &amp; complex work', '4 Carbon') +
          // Live 2026-11-26: a model at its usage limit is greyed out and says when it is back instead of its name.
          option('limited', 'Everyday help', 'Limit resets Nov 26, 12:22 PM').replace('aria-disabled="false"', 'aria-disabled="true"') : '';
      });
    }, 400);
    const result = await api.inspectModes();
    expect(result!.modes.map(m => [m.title, m.model, m.available, m.selected, m.note])).toEqual([
      ['Auto', null, true, false, null],
      ['Everyday help', 'Gemini 4 Hydrogen', true, false, null],
      ['Deeper analysis', 'Gemini 4 Neon', true, true, null],
      ['Code & complex work', 'Gemini 4 Carbon', false, false, null],
      ['Everyday help', null, false, false, 'Limit resets Nov 26, 12:22 PM'],
    ]);
    expect(document.querySelector('[data-test-id="bard-mode-menu-button"]')!.getAttribute('aria-expanded')).toBe('false');
    expect(api.readOpenModes()).toEqual([]);
    expect(api.selectedModeLabel()).toBe('Neon');
  });

  it('reads no models from a page without a picker, and presses nothing', async () => {
    // A tab not yet on screen (2026-11-22): the composer and Chat / Task switch, but no picker.
    document.querySelector('bard-mode-switcher')!.outerHTML =
      '<gem-segmented-button><button aria-pressed="true">Chat</button><button aria-pressed="false">Task</button></gem-segmented-button>';
    const clicked: string[] = [];
    document.addEventListener('click', event => clicked.push((event.target as Element).textContent ?? ''), true);
    expect(await api.inspectModes()).toBeNull();
    expect(api.selectedModeLabel()).toBeNull();
    expect(clicked).toEqual([]);
    expect(document.querySelector('[aria-pressed="true"]')!.textContent).toBe('Chat');
  });

  it('selects Neon by its stable id and refuses the locked model', async () => {
    expect(await api.selectMode('e6fa609c3fa255c0')).toBe(true);
    expect(api.selectedModeLabel()).toBe('Neon');
    expect(await api.selectMode('upsell_MODE_CATEGORY_ULTRA')).toBe(false);
    expect(api.selectedModeLabel()).toBe('Neon');
    expect(api.modeFailure()).toBe('upsell');
    expect(await api.selectMode('no-such-mode', () => true, 100)).toBe(false);
    expect(api.modeFailure()).toBe('missing');
  });

  it('tries the picker again while a model is still disabled after a reload, then selects it', async () => {
    // Live 2026-11-25: right after a new chat reloaded a never-shown tab, picking the model failed 2 times in 3.
    const button = document.querySelector('[data-test-id="bard-mode-menu-button"]')!;
    const enableAt = Date.now() + 2000;
    button.addEventListener('click', () => {
      if (Date.now() < enableAt) document.querySelector('[data-mode-id="e6fa609c3fa255c0"]')?.setAttribute('aria-disabled', 'true');
    });
    expect(await api.selectMode('e6fa609c3fa255c0')).toBe(true);
    expect(api.selectedModeLabel()).toBe('Neon');
    expect(api.modeFailure()).toBeNull();
  }, 30_000);

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
      { id: '4b3e398afa4ee324', user: 'Reply with exactly PONG', answer: 'PONG', answerHtml: '<p>PONG</p>', final: true, approval: null },
      { id: '5c4f', user: 'next', answer: 'partial', answerHtml: '<p>partial</p>', final: false, approval: null },
    ]);
    expect(api.snapshot().lastTurn).toEqual({ id: '5c4f', final: false, answerChars: 7 });
  });

  it("names Gemini's web image and video cards in the answer instead of their captions (live markup 2026-11-26, trimmed)", () => {
    const image = '<div class="attachment-container search-images"><response-element class="no-md"><single-image><div class="image-container">' +
      '<img alt="Otter floating on water"><div class="caption"> Otter floating on water. <span>Source: River Otter Ecology Project</span></div></div></single-image></response-element></div>';
    const videos = '<div class="attachment-container unknown"><response-element class="no-md"><base-carousel><base-video><div class="base-video-timestamp-badge"> 6:34 </div>' +
      '<div class="base-video-title"> Funny Otters </div></base-video></base-carousel></response-element></div>';
    addTurn('7d1e', 'otters', `Otters use tools.</p>${image}<p>They groom often.</p>${videos}<p>`);
    const [turn] = api.turns();
    expect(turn!.answer).toBe('Otters use tools.\n\n*Image, shown in Gemini: Otter floating on water*\n\nThey groom often.\n\n*Video, shown in Gemini: Funny Otters*');
    expect(turn!.answerHtml).not.toMatch(/Source|Funny Otters|<img/);
  });

  it("keeps code, tables, lists and emphasis as Markdown, without Gemini's own buttons (live markup 2026-11-26, trimmed)", () => {
    const code = '<response-element><code-block><div class="code-block"><div class="code-block-decoration"><span>Python</span><div class="buttons">' +
      '<gem-icon-button><button aria-label="Copy code"><mat-icon fonticon="copy">copy</mat-icon></button></gem-icon-button></div></div>' +
      '<pre><code data-test-id="code-content"><span class="hljs-keyword">def</span> add(a, b):\n    <span>return</span> a + b\n</code></pre></div></code-block></response-element>';
    const table = '<div class="horizontal-scroll-wrapper"><div class="table-block-component"><response-element><table-block><div class="table-block">' +
      '<div class="table-content"><table><thead><tr><th><span>Planet</span></th><th><span>Moons</span></th></tr></thead>' +
      '<tbody><tr><td>Earth</td><td>1</td></tr><tr><td>Mars</td><td>2</td></tr></tbody></table></div>' +
      '<div class="table-footer"><gem-icon-button><button aria-label="More options">more_horiz</button></gem-icon-button></div></div></table-block></response-element></div></div>';
    addTurn('8e2f', 'code', `Here you go:</p>${code}${table}<h3>Notes</h3><ul><li>Uses <b>floats</b></li><li>Has <code>a + b</code><ol><li>nested</li></ol></li></ul><p>Done.`);
    expect(api.turns()[0]!.answer).toBe([
      'Here you go:',
      '```python\ndef add(a, b):\n    return a + b\n```',
      '| Planet | Moons |\n| --- | --- |\n| Earth | 1 |\n| Mars | 2 |',
      '### Notes',
      '- Uses **floats**\n- Has `a + b`\n   1. nested',
      'Done.',
    ].join('\n\n'));
  });

  it('keeps time through the extension worker in a hidden tab, whose own timers Chrome slows to once a minute', async () => {
    const asked: number[] = [];
    let early = false;
    const visibility = (state: string) => Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    (dom.window as unknown as { chrome: unknown }).chrome = { runtime: { id: 'test', lastError: undefined, sendMessage(message: { type: string; ms: number }, reply: () => void) {
      if (message.type === 'gemini_sleep') asked.push(message.ms);
      dom.window.setTimeout(reply, early ? 0 : message.ms);
    } } };
    visibility('hidden');
    let started = Date.now();
    await api.sleep(120);
    expect(asked).toEqual([120]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(110);
    // A worker that answers at once (one without gemini_sleep) must not turn every wait into a busy loop.
    early = true; started = Date.now();
    await api.sleep(120);
    expect(Date.now() - started).toBeGreaterThanOrEqual(110);
    // A visible tab uses its own timer.
    visibility('visible');
    await api.sleep(10);
    expect(asked).toEqual([120, 120]);
  });

  describe('@-mentioning a connected app', () => {
    // The live menu (2026-11-25): `button[role=menuitem]` "Name, description" entries, Avatar/Skills/Styles
    // first. It opens on the key events around an inserted "@" only after the page saw a real keystroke (`armed`).
    let armed = false;
    const showMenu = () => {
      document.getElementById('overlay')!.innerHTML = ['Avatar, Add a likeness', 'Skills, Reusable instructions', 'Styles, Saved aesthetics',
        'Gemini Notebook, Notebooks', 'Verify AI, provenance', 'Gem Web Code Core', 'View all connectors, Get smarter help']
        .map(label => `<button role="menuitem" aria-label="${label}">${label}</button>`).join('');
      for (const option of document.querySelectorAll('#overlay button')) option.addEventListener('click', () => {
        const box = document.querySelector('rich-textarea .ql-editor')!;
        const name = option.getAttribute('aria-label')!.split(',')[0];
        // The chip as seen live on 2026-11-25 (it was `<strong>@Name</strong>` before).
        box.innerHTML = `<p><span class="inline-chip" data-chip-raw-text="@${name}">\ufeff<span contenteditable="false"><span class="inline-chip-pill" data-at-mention-chip="true" data-doc-chip-title="${name}"><span class="inline-chip-label">${name}</span></span></span>\ufeff</span> </p>`;
        document.getElementById('overlay')!.innerHTML = '';
      });
    };
    beforeEach(() => {
      armed = false;
      document.querySelector('rich-textarea .ql-editor')!.addEventListener('keyup', event => { if ((event as KeyboardEvent).key === '@' && armed) showMenu(); });
    });

    it('picks the exact connector from the opened menu after synthetic keys once the page is armed', async () => {
      armed = true;
      expect(await api.mentionConnector('Gem Web Code Core')).toBe(true);
      expect(document.querySelector('rich-textarea [data-chip-raw-text]')!.getAttribute('data-chip-raw-text')).toBe('@Gem Web Code Core');
    });

    it('asks for one trusted "@" when synthetic keys do not open the menu, and never guesses a name', async () => {
      let asked = 0;
      const openMenu = async () => { asked += 1; showMenu(); return true; };
      expect(await api.mentionConnector('Gem Web Code Core', () => true, openMenu)).toBe(true);
      expect(asked).toBe(1);
      expect(await api.mentionConnector('Gem Web Code', () => true, openMenu)).toBe(false);
      expect(api.composerText()).toBe('');
    });

    it('fails without a trusted fallback instead of sending a plain-text mention', async () => {
      expect(await api.mentionConnector('Gem Web Code Core')).toBe(false);
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
  <customize-card><button class="card-primary-action" aria-label="Gem Web Code Core"></button>
  <div class="content">Gem Web Code Core</div><div class="card-action-container"><button aria-label="More options"></button></div></customize-card>
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
      document.getElementById('details')!.innerHTML = `<div class="details-content-column" role="region"><h1>Gem Web Code Core</h1>
        <button aria-label="More options"></button><dl class="info-list">
        <div class="info-row"><dt>Handle</dt><dd>@Gem Web Code Core</dd></div>
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
    expect(api.customAppCard('Gem Web Code Core')).not.toBeNull();
    expect(api.customAppCard('Someone else')).toBeNull();
    expect(await api.readCustomAppUrl('Gem Web Code Core', 3000)).toBe(`https://old-name.trycloudflare.com/mcp/core/${'b'.repeat(43)}`);
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
    expect(await api.readCustomAppUrl('Gem Web Code Core', 0)).toBeNull();
  });

  // More options on the details page offers Use now and Delete (live, 2026-11-22).
  it('deletes the app with the old address through More options → Delete, and confirms only a Delete', async () => {
    const doc = document;
    expect(await api.readCustomAppUrl('Gem Web Code Core', 3000)).toMatch(/old-name/);
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
    expect(await api.deleteCustomApp('Gem Web Code Core', 2000)).toBe(true);
    expect(pressed).toEqual(['Delete', 'confirm']);
    expect(api.customAppCard('Gem Web Code Core')).toBeNull();
  });

  it('gives up without a Delete item, deleting nothing', async () => {
    await api.readCustomAppUrl('Gem Web Code Core', 500);
    expect(await api.deleteCustomApp('Gem Web Code Core', 300)).toBe(false);
    expect(api.customAppCard('Gem Web Code Core')).not.toBeNull();
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
