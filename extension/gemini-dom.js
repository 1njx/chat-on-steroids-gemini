/**
 * Everything that knows what the Gemini web app (gemini.google.com) looks like.
 *
 * Like chatgpt-dom.js for ChatGPT, this is the only file allowed to contain a Gemini selector.
 * Every reader returns a safe empty value instead of throwing, so a Gemini redesign degrades the
 * companion to "sees nothing" rather than breaking the page the user is working in.
 *
 * Anchors, all observed on the live page on 2026-11-20 (Google AI Pro account):
 *   · conversation id: the `/app/<hex>` path segment (also `/gem/<gem>/<hex>`)
 *   · composer: `rich-textarea .ql-editor[contenteditable]`
 *   · send / stop: buttons with aria-label "Send message" / "Stop response"
 *   · turns: `infinite-scroller[data-test-id="chat-history-container"] .conversation-container`
 *     (its id is Gemini's own turn id) holding `user-query` and `model-response`
 *   · answer prose: `model-response message-content .markdown`
 *   · mode picker: `[data-test-id="bard-mode-menu-button"]` and its `gem-menu-item[role=menuitemradio]`
 *     options, each with a stable `data-mode-id`; an `upsell_*` id is a model the account cannot use.
 *     2026-11-22: it renders after the composer and only once the tab has been on screen (a covered
 *     window has none), sits beside a Chat / Task switch, is a popover that ignores Escape, and a
 *     long press opens a "periodic table" dialog instead (never pressed here)
 *   · account: the Google Account button's aria-label, and the plan badge under the side-nav avatar
 *   · custom apps (/customize/connectors, observed 2026-11-22): a "Custom apps" section of
 *     `customize-card`s whose `button.card-primary-action` carries the app name as aria-label; its
 *     details page lists `dt` "MCP URL" / `dd` value and a "More options" menu (Use now, Disconnect,
 *     Delete: no edit); "Create custom app" opens a `mat-dialog-container` with `input[name=url]`,
 *     optional `clientId`/`clientSecret`, and Cancel / Next
 *
 * Aria labels are English. Gemini custom MCP apps are themselves English-only (Google's help page),
 * so the integration requires the English UI; `localized()` reports when the page is not.
 *
 * None of these are a public Gemini API.
 */

var CLF_GEMINI_DOM = (() => {
  const COMPOSER = 'rich-textarea .ql-editor[contenteditable="true"], rich-textarea [contenteditable="true"]';
  const SEND = 'button[aria-label="Send message"]';
  const STOP = 'button[aria-label="Stop response"], button[aria-label="Stop generating"]';
  const HISTORY = '[data-test-id="chat-history-container"]';
  const TURN = '.conversation-container';
  const MODE_BUTTON = '[data-test-id="bard-mode-menu-button"]';
  const MODE_OPTION = 'gem-menu-item[role="menuitemradio"][data-mode-id], [role="menuitemradio"][data-mode-id]';
  const MENU_ITEM = 'gem-menu-item[role="menuitem"], [role="menuitem"]';
  const RADIO = 'gem-menu-item[role="menuitemradio"], [role="menuitemradio"]';
  const ACCOUNT = '[aria-label^="Google Account:"]';
  const SIGN_IN = 'a[href*="accounts.google.com/ServiceLogin"], a[href*="accounts.google.com/signin"], a[aria-label="Sign in"]';
  const ERROR = 'error-notification, [role="alert"], snack-bar-container, mat-snack-bar-container';
  const PLANS = ['Ultra', 'Pro', 'Plus'];

  const text = node => (node && (node.innerText ?? node.textContent) || '').replace(/\s+/g, ' ').trim();
  const visible = node => !!node && !node.hidden && (typeof node.getClientRects !== 'function' || node.getClientRects().length > 0);
  const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };
  /**
   * Waits ms. Chrome runs a hidden tab's timers at most once a minute after 5 minutes, which stalled
   * every Gemini step for minutes and failed sends (seen live 2026-11-25), so a hidden page has the
   * extension's worker keep time: a message reply is not throttled like a timer. A reply that comes
   * early (an old worker without gemini_sleep) leaves the rest to an ordinary timer.
   */
  function sleep(ms) {
    return new Promise(resolve => {
      const started = Date.now();
      const rest = () => { const left = ms - (Date.now() - started); if (left > 20) setTimeout(resolve, left); else resolve(); };
      let runtime = null;
      try { runtime = document.visibilityState === 'hidden' && globalThis.chrome?.runtime?.id ? chrome.runtime : null; } catch { runtime = null; }
      if (!runtime) return void setTimeout(resolve, ms);
      try { runtime.sendMessage({ type: 'gemini_sleep', ms }, () => { void runtime.lastError; rest(); }); }
      catch { rest(); }
    });
  }

  /**
   * test() polled every 100 ms for up to ms; its last value. Gemini's page redraws on a timer, which a
   * hidden tab runs about once a second (live 2026-11-25), so a step waits seconds for Gemini to show
   * the result of a click, never a fixed few polls.
   */
  async function until(test, ms, current = () => true) {
    for (const end = Date.now() + ms; ; await sleep(100)) {
      const value = safe(test, null);
      if (value || Date.now() >= end || !current()) return value;
    }
  }

  /** Gemini's own conversation id, or null on a new/unsaved chat. */
  function conversationId(href = location.href) {
    return safe(() => {
      const path = new URL(href).pathname;
      const match = path.match(/^\/(?:u\/\d+\/)?(?:app|gem\/[^/]+)\/([0-9a-f]{8,32})(?:\/|$)/i);
      return match ? match[1].toLowerCase() : null;
    }, null);
  }

  function composer() { return safe(() => document.querySelector(COMPOSER), null); }
  /** A chat page (/app, a chat, or a Gem), as opposed to custom apps, settings and the like. */
  const onChatPage = () => safe(() => /^\/(?:u\/\d+\/)?(?:app|gem\/[^/]+)(?:\/|$)/.test(location.pathname), false);
  function sendButton() { return safe(() => [...document.querySelectorAll(SEND)].find(visible) || null, null); }
  function stopButton() { return safe(() => [...document.querySelectorAll(STOP)].find(visible) || null, null); }
  function generating() { return !!stopButton(); }

  /** Signed-in proof is the Google Account control; a sign-in link with no account is signed out. */
  function signInState() {
    return safe(() => {
      if (document.querySelector(ACCOUNT)) return 'signed-in';
      if (document.querySelector(SIGN_IN)) return 'signed-out';
      return 'unknown';
    }, 'unknown');
  }

  /**
   * Account label and plan. The address in the account control's label is deliberately not
   * returned: the app needs to know *that* an account is signed in and which plan it shows,
   * never to store or transmit the Google address.
   */
  function account() {
    return safe(() => {
      const control = document.querySelector(ACCOUNT);
      if (!control) return null;
      const label = (control.getAttribute('aria-label') || '').replace(/^Google Account:\s*/, '');
      const name = label.split(/\s*\(/)[0].trim() || null;
      let plan = null;
      for (const node of document.querySelectorAll('sidenav-mavatar-footer, [data-test-id="side-nav-footer"]')) {
        // The badge is its own element ("Pro" under the avatar name); match a whole leaf's text.
        const leaves = [...node.querySelectorAll('*')].filter(n => !n.children.length).map(text);
        plan = PLANS.find(p => leaves.includes(p)) || plan;
      }
      return { name, plan };
    }, null);
  }

  /** The mode (model) the picker button currently names, e.g. "Hydrogen". */
  function selectedModeLabel() {
    return safe(() => {
      const button = document.querySelector(MODE_BUTTON);
      if (!button) return null;
      const aria = button.getAttribute('aria-label') || '';
      const match = aria.match(/currently\s+(.+)$/i);
      // Gemini appends a level other than Low: "currently Hydrogen Medium" (seen live 2026-11-24).
      return (match ? match[1] : text(button)).trim().replace(/\s+(?:Low|Medium|High|Extra high)$/i, '') || null;
    }, null);
  }

  /**
   * Parse one picker option: "Deeper analysis 4 Neon New" → title, model "4 Neon", badge. The live
   * option (2026-11-22) splits it into `.label` "Auto" and `.sublabel` "Adapts to your needs".
   */
  function parseOption(node) {
    const id = node.getAttribute('data-mode-id') || '';
    const full = text(node);
    const named = /\b(\d+(?:\.\d+)?\s+[A-Z][A-Za-z]+)\b/;
    const model = (text(node.querySelector('.sublabel')).match(named) || full.match(named) || [])[1] || null;
    const title = text(node.querySelector('.label')) || (model ? full.slice(0, full.indexOf(model)).trim() : full);
    const upsell = /^upsell_/i.test(id);
    return {
      id,
      title: title || full,
      model: model ? `Gemini ${model}` : null,
      available: !upsell && node.getAttribute('aria-disabled') !== 'true',
      selected: node.getAttribute('aria-checked') === 'true',
      reason: upsell ? 'requires-upgrade' : null,
    };
  }

  /** Options in an already open mode picker; [] when it is closed. */
  function readOpenModes() {
    return safe(() => [...document.querySelectorAll(MODE_OPTION)].map(parseOption).filter(o => o.id), []);
  }

  /** Thinking-level radios in an open picker (the radios without a mode id). */
  function readOpenThinkingLevels() {
    return safe(() => [...document.querySelectorAll(RADIO)]
      .filter(n => !n.hasAttribute('data-mode-id'))
      .map(n => ({ label: text(n).split(' ')[0], detail: text(n).split(' ').slice(1).join(' '),
        selected: n.getAttribute('aria-checked') === 'true', available: n.getAttribute('aria-disabled') !== 'true' }))
      .filter(l => /^(Low|Medium|High|Extra)$/i.test(l.label)), []);
  }

  async function closeMenus() {
    const button = document.querySelector(MODE_BUTTON);
    // The 2026-11-22 picker is a popover that ignores Escape and has no backdrop; its button shuts it.
    // Only a picker that shows itself open is clicked: a second click would open it again.
    if (button?.getAttribute('aria-expanded') === 'true') safe(() => button.click(), null);
    else {
      safe(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), null);
      safe(() => document.querySelector('.cdk-overlay-backdrop')?.click(), null);
    }
    await until(() => !readOpenModes().length && !readOpenThinkingLevels().length, 2000);
  }

  async function openPicker(current = () => true) {
    // The picker renders a moment after the composer; wait up to 3 s before calling it missing.
    let button = null;
    for (let i = 0; i < 30 && current() && !(button = document.querySelector(MODE_BUTTON)); i += 1) await sleep(100);
    if (!button) return false;
    // Right after a model switch the first click often opens nothing (seen live 2026-11-24): click again, 3 times in all.
    for (let tries = 0; tries < 3 && current(); tries += 1) {
      button = document.querySelector(MODE_BUTTON) || button;
      if (!readOpenModes().length && button.getAttribute('aria-expanded') !== 'true') button.click();
      if (await until(() => readOpenModes().length, 3000, current)) return true;
      // Open without options: shut it, and wait until Gemini shows it shut, before the next try.
      if (button.getAttribute('aria-expanded') === 'true') {
        button.click();
        await until(() => button.getAttribute('aria-expanded') !== 'true', 2000, current);
      }
    }
    return readOpenModes().length > 0;
  }

  /** The open picker's thinking levels, waiting a moment for them (Auto has none: [] then). */
  async function openLevels(ms = 3000) {
    const item = [...document.querySelectorAll(MENU_ITEM)].find(n => /Thinking level/i.test(text(n)));
    if (item && !readOpenThinkingLevels().length) item.click();
    for (const end = Date.now() + (item ? ms : 300); Date.now() < end && !readOpenThinkingLevels().length; ) await sleep(100);
    return readOpenThinkingLevels();
  }

  /**
   * Read the account's modes and each one's thinking levels (live 2026-11-24: Auto offers none,
   * Hydrogen and Neon Low/Medium/High). Gemini shows only the selected model's levels, so each
   * other available model is selected in turn to read them, and the model selected before is
   * selected again at the end; no level is ever clicked. Returns null when the picker could not be
   * read (no list is better than a guessed list).
   */
  async function inspectModes(current = () => true) {
    if (!(await openPicker(current))) return null;
    const modes = readOpenModes().map(mode => ({ ...mode, levels: null }));
    const original = modes.find(mode => mode.selected) || null;
    const levelsOf = async () => (await openLevels()).map(level => level.label);
    const thinkingLevels = await openLevels();
    if (original) original.levels = thinkingLevels.map(level => level.label);
    await closeMenus();
    for (const mode of modes) {
      if (mode === original || !mode.available || !current()) continue;
      if (!(await selectMode(mode.id, current)) || !(await openPicker(current))) continue;
      mode.levels = await levelsOf();
      await closeMenus();
    }
    if (original && modes.some(mode => mode !== original && mode.levels)) await selectMode(original.id, current);
    // Every level any model offers, as the default list (the selected model's selection marked).
    const seen = new Set(thinkingLevels.map(level => level.label));
    for (const mode of modes) for (const label of mode.levels || []) if (!seen.has(label)) { seen.add(label); thinkingLevels.push({ label, detail: '', selected: false, available: true }); }
    return { modes, thinkingLevels };
  }

  /** Select a mode by its stable data-mode-id. Refuses an upsell/disabled option. */
  async function selectMode(modeId, current = () => true) {
    if (!modeId) return true;
    if (!(await openPicker(current))) return false;
    const node = [...document.querySelectorAll(MODE_OPTION)].find(n => n.getAttribute('data-mode-id') === modeId);
    const option = node && parseOption(node);
    if (!option || !option.available) { await closeMenus(); return false; }
    if (!option.selected) {
      node.click();
      // Picking a model shuts the picker. Wait for that: closing it before Gemini redrew opened it again.
      await until(() => !readOpenModes().length, 3000);
    }
    await closeMenus();
    return true;
  }

  /**
   * Select a thinking level by label (Low/Medium/High/Extra high). A model that offers no levels
   * (Auto) needs none: true, and nothing is clicked. False only when levels are shown without this one.
   */
  async function selectThinkingLevel(level, current = () => true) {
    if (!level) return true;
    if (!(await openPicker(current))) return false;
    const shown = await openLevels();
    if (!shown.length) { await closeMenus(); return true; }
    const node = [...document.querySelectorAll(RADIO)]
      .find(n => !n.hasAttribute('data-mode-id') && text(n).toLowerCase().startsWith(String(level).toLowerCase()));
    const ok = !!node && node.getAttribute('aria-disabled') !== 'true';
    if (ok && node.getAttribute('aria-checked') !== 'true') {
      node.click();
      await until(() => !node.isConnected || node.getAttribute('aria-checked') === 'true', 3000);
    }
    await closeMenus();
    return ok;
  }

  /** Put text into the Quill composer the way a paste would, replacing any draft. */
  function insertPrompt(value) {
    const box = composer();
    if (!box) return false;
    box.focus();
    const selection = box.ownerDocument.getSelection?.();
    if (selection) { const range = box.ownerDocument.createRange(); range.selectNodeContents(box); selection.removeAllRanges(); selection.addRange(range); }
    const ok = safe(() => box.ownerDocument.execCommand('insertText', false, value), false);
    if (!ok || text(box) !== value.replace(/\s+/g, ' ').trim()) {
      box.textContent = '';
      for (const line of String(value).split('\n')) { const p = box.ownerDocument.createElement('p'); p.textContent = line; box.append(p); }
      box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    }
    return text(box).length > 0;
  }

  function composerText() { return text(composer()); }

  /** Visible @-mention menu entries: [{ name, node }]. Entries are `button[role=menuitem]` "Name, description". */
  function mentionOptions() {
    return safe(() => [...document.querySelectorAll('button[role="menuitem"]')].filter(visible).map(node => ({
      name: (node.getAttribute('aria-label') || text(node)).split(',')[0].trim(), node,
    })), []);
  }

  /**
   * Start the composer with an @-mention of a connected app, which is how Google says to make sure
   * Gemini uses that custom app for the prompt. Replaces any draft. False when no connected app
   * with exactly that name is offered (not connected, turned off, or renamed) — never a guess.
   */
  async function mentionConnector(name, current = () => true, openMenu = null) {
    const box = composer();
    if (!box || !name) return false;
    const doc = box.ownerDocument;
    const clear = () => {
      box.focus();
      const selection = doc.getSelection?.();
      if (selection) { const range = doc.createRange(); range.selectNodeContents(box); selection.removeAllRanges(); selection.addRange(range); }
      safe(() => doc.execCommand('delete'), false);
      if (text(box)) { box.textContent = ''; box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContent' })); }
    };
    const wanted = name.trim().toLowerCase();
    const find = ms => until(() => mentionOptions().find(o => o.name.toLowerCase() === wanted), ms, current);
    // Gemini opens the menu from the key events around an inserted "@". Synthetic events work once
    // the page has seen a real keystroke; otherwise the extension types one trusted "@" (openMenu).
    // The unfiltered list is read whole: typing a multi-word name closes the menu at its first space.
    const key = (type, k) => box.dispatchEvent(new KeyboardEvent(type, { key: k, bubbles: true }));
    clear();
    key('keydown', '@'); safe(() => doc.execCommand('insertText', false, '@'), false); key('keyup', '@');
    let option = await find(3000);
    if (!option && openMenu) {
      clear();
      if (await openMenu()) option = await find(5000);
    }
    const fail = async () => { key('keydown', 'Escape'); await closeMenus(); clear(); return false; };
    if (!option) return fail();
    option.node.click();
    // The chip: `span.inline-chip[data-chip-raw-text="@Name"]` since 2026-11-25, `<strong>@Name</strong>` before.
    const chipped = () => [...box.querySelectorAll('[data-chip-raw-text], strong')]
      .some(n => (n.getAttribute('data-chip-raw-text') || text(n)).trim().toLowerCase() === `@${wanted}`);
    // A failed mention leaves nothing behind: a stray "@" stayed in the composer (live 2026-11-25).
    return (await until(chipped, 3000)) ? true : fail();
  }

  /**
   * Insert text at the composer's own caret, which Gemini leaves just after an @-mention chip.
   * Moving the selection ourselves put the caret inside the chip, and Gemini then sent the chip
   * alone without the text (live, 2026-11-20); so the caret is only set when it is outside the box.
   */
  function appendPrompt(value) {
    const box = composer();
    if (!box) return false;
    const doc = box.ownerDocument;
    const selection = doc.getSelection?.();
    if (!selection || !selection.anchorNode || !box.contains(selection.anchorNode)) {
      box.focus();
      if (selection) { const range = doc.createRange(); range.selectNodeContents(box); range.collapse(false); selection.removeAllRanges(); selection.addRange(range); }
    }
    const before = text(box).length;
    const ok = safe(() => doc.execCommand('insertText', false, value), false);
    return ok && text(box).length > before;
  }

  /** Click Send once it is enabled; true when Gemini took the message (Stop appears or the composer empties). */
  async function send({ acceptanceTimeoutMs = 8000, stillCurrent = () => true } = {}) {
    const deadline = Date.now() + acceptanceTimeoutMs;
    let button = sendButton();
    while ((!button || button.disabled || button.getAttribute('aria-disabled') === 'true') && Date.now() < deadline && stillCurrent()) {
      await sleep(100); button = sendButton();
    }
    if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') return false;
    const before = turns().length;
    button.click();
    while (Date.now() < deadline && stillCurrent()) {
      if (generating() || turns().length > before || !composerText()) return true;
      await sleep(100);
    }
    return generating() || turns().length > before;
  }

  function stopGeneration() { const button = stopButton(); if (!button) return false; button.click(); return true; }

  /**
   * Gemini's tool approval card ("Let Gemini use exec command?" with Don't allow, Allow once and
   * Always allow; seen live 2026-11-25) is drawn inside the answer. It is not answer text.
   */
  const CARD = 'action-card, remy-confirmation-card-v2';
  const enabled = b => !b.disabled && b.getAttribute('aria-disabled') !== 'true';
  /** The answer's prose without approval cards (a copy only when it holds one). */
  function prose(node) {
    if (!node?.querySelector(CARD)) return node;
    const copy = node.cloneNode(true);
    copy.querySelectorAll(CARD).forEach(card => (card.closest('.attachment-container') || card).remove());
    return copy;
  }
  /** A card in this answer still waiting for a choice: its app, its question and its Always allow button. */
  function pendingApproval(answer) {
    return safe(() => {
      for (const card of answer?.querySelectorAll('remy-confirmation-card-v2') ?? []) {
        const buttons = [...card.querySelectorAll('button')].filter(enabled);
        const always = buttons.find(b => text(b) === 'Always allow');
        if (!always && !buttons.some(b => text(b) === 'Allow once')) continue;
        const ask = text(card.querySelector('.v2-body-content .body-text') || card.querySelector('.body-text'));
        return { card, app: text(card.querySelector('.header-text')), ask, always: always || null };
      }
      return null;
    }, null);
  }

  /** Conversation turns in page order, each with Gemini's own turn id. */
  function turns() {
    return safe(() => {
      const root = document.querySelector(HISTORY) || document;
      return [...root.querySelectorAll(TURN)].map(node => {
        const user = node.querySelector('user-query');
        const answer = node.querySelector('model-response');
        const shown = answer ? answer.querySelector('message-content .markdown') || answer.querySelector('message-content') : null;
        const clean = prose(shown);
        const userText = user ? text(user.querySelector('.query-text') || user).replace(/^You said\s*/, '') : '';
        return {
          id: node.id || null,
          user: userText,
          answer: clean ? text(clean) : '',
          answerHtml: clean ? clean.innerHTML : '',
          approval: pendingApproval(answer),
          // Gemini keeps `processing-state-visible` on finished answers too (live, 2026-11-20), so it
          // proves nothing; only a busy marker does. The page-level Stop button is the real signal,
          // which snapshot() and the content script combine with this.
          final: !!answer && !answer.querySelector('[aria-busy="true"]'),
        };
      });
    }, []);
  }

  /** Visible provider errors (quota, sign-in, policy). Text is returned as Gemini shows it. */
  function errors() {
    return safe(() => [...document.querySelectorAll(ERROR)].filter(visible).map(n => {
      const t = text(n);
      return {
        text: t,
        quota: /limit|quota|try again later|reached/i.test(t),
        signedOut: /sign in/i.test(t),
      };
    }).filter(e => e.text), []);
  }

  /** True when the page's own UI language is not English (custom apps and our aria anchors need English). */
  function localized() {
    return safe(() => { const lang = (document.documentElement.lang || '').toLowerCase(); return !!lang && !lang.startsWith('en'); }, false);
  }

  // ---- custom apps page (Delete, Next, the notice and Connect only for "Add it in Gemini for me")

  const CREATE_APP = 'button[aria-label="Create custom app"]';
  const onCustomApps = () => safe(() => /\/customize\/connectors\/?$/.test(location.pathname), false);
  async function waitFor(find, ms = 8000) {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) {
      const found = safe(find, null);
      if (found) return found;
    }
    return null;
  }
  const visibleCreate = () => [...document.querySelectorAll(CREATE_APP)].find(visible) || null;

  /** An app name compared loosely: any case, "-"/"_" as spaces, and no " (2)" a duplicate may get. */
  const appName = name => String(name || '').toLowerCase().replace(/[-_\s]+/g, ' ').replace(/\s*\(\d+\)$/, '').trim();

  /**
   * Every listed custom app with this name, first to last (an earlier add can leave duplicates).
   * A card's label is "Name, description" (seen live 2026-11-23), so the name is read from its
   * title, then the label, then the label's part before the first comma.
   */
  function customAppCards(name) {
    const wanted = appName(name);
    return safe(() => [...document.querySelectorAll('button.card-primary-action')].filter(b => {
      const label = b.getAttribute('aria-label') || '';
      const title = text(b.closest('customize-card')?.querySelector('.title-text'));
      return [title, label, label.split(',')[0]].some(candidate => candidate && appName(candidate) === wanted);
    }), []);
  }

  /** Waits until the app list stops changing (same card count for 1 s, 8 s at most): a list still loading must not read as "no app". */
  async function settledList(ms = 8000) {
    let last = -1, since = Date.now();
    for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) {
      const count = safe(() => document.querySelectorAll('button.card-primary-action').length, 0);
      if (count !== last) { last = count; since = Date.now(); } else if (Date.now() - since >= 1000) return true;
    }
    return false;
  }

  /** The first listed custom app with this name, or null. */
  function customAppCard(name) {
    return customAppCards(name)[0] || null;
  }

  /** A row's value on the open app's details page ("MCP URL", "Last synced"), or ''. */
  const detailsValue = label => safe(() => text([...document.querySelectorAll('dt')].find(dt => text(dt) === label)?.nextElementSibling), '');

  /** The "MCP URL" shown on the open app's details page, or null. */
  function detailsUrl() {
    const value = detailsValue('MCP URL');
    return /^https:\/\/\S+$/.test(value) ? value : null;
  }

  /**
   * Opens an app's details page (by name: the first such app, or the given card) and reads its address. Null when unreadable.
   * Gemini first paints the details from a cache that can still hold a deleted app with the same name (seen live
   * 2026-11-24: the day before's address, replaced 0.3 s later along with "Last synced"). So the address is read once it
   * synced: 0.3 s after "Last synced" or the address changed, or once both stayed the same for 2 s.
   */
  async function readCustomAppUrl(target, ms = 10000) {
    const card = typeof target === 'string' ? customAppCard(target) : target;
    if (!card) return null;
    card.click();
    let first = null, last = null, since = 0;
    for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
      const url = detailsUrl();
      if (!url) continue;
      const state = `${url}\n${detailsValue('Last synced')}`;
      first ??= state;
      if (state !== last) { last = state; since = Date.now(); continue; }
      if (Date.now() - since >= (state === first ? 2000 : 300)) return url;
    }
    return null;
  }

  function backToList() {
    safe(() => document.querySelector('button[aria-label="Back to Connectors"]')?.click(), null);
  }

  /** The open details page's "More options" button (where Gemini's own Delete is). */
  function detailsMoreOptions() {
    return safe(() => [...document.querySelectorAll('button[aria-label="More options"]')]
      .find(b => visible(b) && !b.closest('customize-card')) || null, null);
  }

  /** Opens "Create custom app" and fills the MCP Server URL. Returns the Next button, or null if the form was not recognized. */
  async function fillCreateForm(url, ms = 6000) {
    const create = await waitFor(visibleCreate, ms);
    if (!create) return null;
    create.click();
    const input = await waitFor(() => document.querySelector('mat-dialog-container input[name="url"], [role="dialog"] input[name="url"]'), ms);
    if (!input) return null;
    input.focus();
    // Angular's form listens for input events; the native setter makes it see the new value.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, url);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    const dialog = input.closest('mat-dialog-container, [role="dialog"]') || document;
    const next = await waitFor(() => [...dialog.querySelectorAll('button')].find(b => text(b) === 'Next' && !b.disabled) || null, Math.min(ms, 3000));
    return input.value === url ? next : null;
  }

  /**
   * Deletes the open app from its details page: More options → Delete, then the confirmation
   * "Remove <name>?" → Remove (both observed 2026-11-23; "Delete" is accepted there too). True once
   * the list shows fewer apps with this name than `before` (one card, by default). On failure a
   * confirmation still open is cancelled, so a retry starts from a clean page.
   */
  async function deleteCustomApp(name, ms = 8000, before = 1) {
    const dialogs = () => [...document.querySelectorAll('mat-dialog-container, [role="dialog"], [role="alertdialog"]')].filter(visible);
    const button = (labels, scope) => scope.flatMap(node => [...node.querySelectorAll('button')]
      .filter(b => labels.includes(text(b)) && !b.disabled)).at(0) || null;
    const more = detailsMoreOptions();
    if (!more) return false;
    more.click();
    const item = await waitFor(() => [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].find(b => visible(b) && text(b) === 'Delete') || null, 3000);
    if (!item) { await closeMenus(); return false; }
    item.click();
    const confirm = await waitFor(() => button(['Remove', 'Delete'], dialogs()), 3000);
    if (confirm) confirm.click();
    await sleep(800);
    if (!onCustomApps() || !visibleCreate()) backToList();
    if (await waitFor(() => visibleCreate() && customAppCards(name).length < before ? true : null, ms)) return true;
    button(['Cancel'], dialogs())?.click();
    return false;
  }

  /** The step after Next: "Connect this MCP server", with Google's notice to tick and Connect. */
  function connectStep() {
    return safe(() => {
      const dialog = [...document.querySelectorAll('mat-dialog-container, [role="dialog"]')]
        .find(node => visible(node) && node.querySelector('mat-checkbox input[type="checkbox"]'));
      if (!dialog) return null;
      const checkboxes = dialog.querySelectorAll('mat-checkbox input[type="checkbox"]');
      const connect = [...dialog.querySelectorAll('button')].filter(b => text(b) === 'Connect');
      return checkboxes.length === 1 && connect.length === 1 ? { dialog, checkbox: checkboxes[0], connect: connect[0] } : null;
    }, null);
  }

  /**
   * The step Gemini can show after the notice's Connect (seen 2026-11-24, not every time): "Save your
   * custom app" with the app's name, its actions and a second Connect. Null while it is not shown.
   */
  function saveStep() {
    return safe(() => {
      const dialog = [...document.querySelectorAll('mat-dialog-container, [role="dialog"]')]
        .find(node => visible(node) && !node.querySelector('mat-checkbox input[type="checkbox"]') &&
          [...node.querySelectorAll('button')].some(b => text(b) === 'Connect'));
      if (!dialog) return null;
      const connect = [...dialog.querySelectorAll('button')].filter(b => text(b) === 'Connect');
      return connect.length === 1 ? { dialog, connect: connect[0] } : null;
    }, null);
  }

  /** Points the person at the control they press themselves; never clicks it. */
  function highlight(node, note) {
    safe(() => {
      node.style.outline = '3px solid #f5a524';
      node.style.outlineOffset = '3px';
      node.scrollIntoView?.({ block: 'center' });
      document.getElementById('clf-gemini-note')?.remove();
      const box = document.createElement('div');
      box.id = 'clf-gemini-note';
      box.setAttribute('role', 'status');
      box.textContent = note;
      Object.assign(box.style, { position: 'fixed', zIndex: '2147483647', left: '50%', bottom: '24px', transform: 'translateX(-50%)',
        maxWidth: '520px', padding: '12px 16px', borderRadius: '10px', background: '#1f1f1f', color: '#fff',
        border: '2px solid #f5a524', font: '14px/1.4 system-ui, sans-serif', boxShadow: '0 6px 24px rgba(0,0,0,.4)' });
      document.body.append(box);
      setTimeout(() => box.remove(), 60_000);
    }, null);
  }

  /** One compact snapshot the content script reports to the app. */
  function snapshot() {
    const all = turns();
    const last = all[all.length - 1] || null;
    return {
      url: safe(() => location.origin + location.pathname, ''),
      conversationId: conversationId(),
      signIn: signInState(),
      account: account(),
      selectedMode: selectedModeLabel(),
      composerReady: !!composer(),
      generating: generating(),
      turnCount: all.length,
      lastTurn: last && { id: last.id, final: last.final && !generating(), answerChars: last.answer.length },
      errors: errors(),
      localized: localized(),
    };
  }

  return {
    conversationId, composer, onChatPage, sendButton, stopButton, generating, signInState, account,
    selectedModeLabel, readOpenModes, readOpenThinkingLevels, inspectModes, selectMode,
    selectThinkingLevel, insertPrompt, composerText, mentionOptions, mentionConnector, appendPrompt,
    send, stopGeneration, turns, errors, sleep,
    localized, snapshot, parseOption,
    onCustomApps, customAppCard, customAppCards, settledList, readCustomAppUrl, backToList, detailsMoreOptions, fillCreateForm, highlight, waitFor, visibleCreate, deleteCustomApp, connectStep, saveStep,
  };
})();
