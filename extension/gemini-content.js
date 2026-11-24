/**
 * Gemini page companion (gemini.google.com).
 *
 * Reports what this page shows (sign-in, plan, selected mode, conversation, whether Gemini is
 * answering) and runs the app's Gemini commands that the app handed to exactly this tab:
 *   · inspect-modes: read the account's mode picker without changing it
 *   · send: select a mode/thinking level, optionally @-mention a connected app, send one prompt,
 *     then wait for Gemini's answer and report it
 *   · stop: press Stop on the running answer
 *   · fill-app: on the custom apps page, find every app already there under the connector's name,
 *     delete each with an old address and each duplicate, then add the app with the new address
 *     (Next, Google's notice, Connect), as the app's "Add it in Gemini for me" button says.
 *
 * The page never executes a local tool; Gemini calls CoS's MCP connector itself. Every result is
 * reported as observed: a send is "sent" only once Gemini accepted it, and "completed" only once
 * the answer settled. A command interrupted by a reload after it was sent is never sent again.
 */
(() => {
  // After an extension reload the previous copy's runtime is gone; only a live copy blocks a second one.
  if (typeof window.__clfGeminiAlive === 'function' && window.__clfGeminiAlive()) return;
  window.__clfGeminiAlive = () => { try { return !!chrome.runtime?.id; } catch { return false; } };
  const dom = CLF_GEMINI_DOM;
  const REPORT_MS = 4000;
  const ANSWER_LIMIT_MS = 30 * 60_000;
  const running = new Set();
  let reportTimer = null;
  let lastSent = '';

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const message = payload => new Promise(resolve => {
    try { chrome.runtime.sendMessage(payload, reply => { void chrome.runtime.lastError; resolve(reply || null); }); }
    catch { resolve(null); }
  });

  async function report(force = false) {
    const snapshot = dom.snapshot();
    const key = JSON.stringify(snapshot);
    if (!force && key === lastSent && !running.size) return;
    lastSent = key;
    const reply = await message({ type: 'gemini_state', snapshot });
    for (const command of Array.isArray(reply?.commands) ? reply.commands : []) void run(command);
  }

  function schedule(delay = 1500) {
    if (reportTimer) return;
    reportTimer = setTimeout(() => { reportTimer = null; void report(); }, delay);
  }

  const result = (command, fields) => message({ type: 'gemini_result', id: command.id, ...fields });

  async function waitForAnswer(command, before) {
    const deadline = Date.now() + ANSWER_LIMIT_MS;
    let quietSince = 0;
    while (Date.now() < deadline) {
      await sleep(700);
      const errors = dom.errors();
      const all = dom.turns();
      const last = all[all.length - 1];
      const settled = !dom.generating() && last && all.length > before && last.final;
      if (settled) {
        // Gemini can flip Stop off a moment before the last tokens render; require a short quiet period.
        if (!quietSince) quietSince = Date.now();
        if (Date.now() - quietSince >= 1200) {
          // The bridge takes at most 2 MiB per request: keep the text, drop markup that would not fit whole.
          return { stage: 'completed', conversationId: dom.conversationId(), turnId: last.id,
            answer: last.answer.slice(0, 400_000), ...(last.answerHtml.length <= 400_000 ? { answerHtml: last.answerHtml } : {}) };
        }
      } else quietSince = 0;
      if (!dom.generating() && errors.length && (!last || all.length <= before || !last.answer)) {
        return { stage: 'failed', conversationId: dom.conversationId(), error: errors.map(e => e.text).join(' · '),
          quota: errors.some(e => e.quota), signedOut: errors.some(e => e.signedOut) };
      }
    }
    return { stage: 'failed', conversationId: dom.conversationId(), error: 'answer-timeout' };
  }

  async function send(command) {
    if (dom.signInState() === 'signed-out') return result(command, { stage: 'failed', error: 'signed-out', signedOut: true });
    if (dom.localized()) return result(command, { stage: 'failed', error: 'page-not-english' });
    if (command.conversationId && dom.conversationId() !== command.conversationId) {
      location.assign(`/app/${encodeURIComponent(command.conversationId)}`);
      return result(command, { stage: 'navigating' });
    }
    if (!command.conversationId && dom.conversationId()) {
      location.assign('/app');
      return result(command, { stage: 'navigating' });
    }
    if (dom.generating()) return result(command, { stage: 'failed', error: 'busy' });
    if (command.modeId && !(await dom.selectMode(command.modeId))) {
      return result(command, { stage: 'failed', error: 'mode-unavailable' });
    }
    if (command.thinkingLevel && !(await dom.selectThinkingLevel(command.thinkingLevel))) {
      return result(command, { stage: 'failed', error: 'thinking-level-unavailable' });
    }
    if (command.connector) {
      const trustedAt = async () => !!(await message({ type: 'gemini_type_at' }))?.ok;
      if (!(await dom.mentionConnector(command.connector, () => true, trustedAt))) {
        return result(command, { stage: 'failed', error: 'connector-not-offered', connector: command.connector });
      }
      if (!dom.appendPrompt(` ${command.prompt}`)) return result(command, { stage: 'failed', error: 'composer-unavailable' });
    } else if (!dom.insertPrompt(command.prompt)) {
      return result(command, { stage: 'failed', error: 'composer-unavailable' });
    }
    const before = dom.turns().length;
    // Claim the send with the app first: only a command the app still owns may be sent, once.
    const claim = await result(command, { stage: 'sending' });
    if (!claim?.ok || !claim.authorized) return result(command, { stage: 'failed', error: 'withdrawn' });
    if (!(await dom.send())) return result(command, { stage: 'failed', error: 'send-not-accepted' });
    for (let i = 0; i < 30 && !dom.conversationId(); i += 1) await sleep(200);
    await result(command, { stage: 'sent', conversationId: dom.conversationId() });
    return result(command, await waitForAnswer(command, before));
  }

  /**
   * The setup errors in the same words the app shows (src/shared/gemini.ts GEMINI_ERRORS), for the
   * status panel on the page. test/gemini-fill-app.test.ts keeps the two equal.
   */
  const FILL_ERRORS = {
    'signed-out': 'Gemini is signed out in the browser. Sign in at gemini.google.com.',
    'page-not-english': 'The Gemini page is not in English. Custom MCP apps and this integration require Gemini in English.',
    'invalid-url': 'Gemini needs an https address. Finish the Tunnel step first.',
    'custom-apps-layout-unknown': "Gemini's custom apps page did not look as expected, so nothing was filled in. Add the app by hand: click Custom, paste the address, then Next.",
    'delete-failed': 'Gemini did not delete the app with the old address after 3 tries. Delete it by hand (open it, More options, Delete, then Remove), then press the button again.',
    'connect-failed': "Gemini did not finish connecting the app. Check the open Gemini tab, or add the app by hand: click Custom, paste the address, then Next and Connect.",
    'verify-failed': "After adding, Gemini's custom apps did not show exactly one app with this name and address. Check the list in Gemini (delete any extra copy), then press the button again.",
  };

  /**
   * Add the app in Gemini with this address. Outcomes: 'current' (Gemini already has this address;
   * any duplicates and old addresses were deleted), 'connected' (old ones deleted, the new one added
   * and connected). An unrecognized page fills nothing. The tab is brought to the front first (a
   * covered page barely loads) and a status panel on the page shows each step.
   */
  async function fillApp(command) {
    const panel = globalThis.CLF_SETUP_PANEL;
    const failed = (error, extra = {}) => { panel?.fail(FILL_ERRORS[error] || error); return result(command, { stage: 'failed', error, ...extra }); };
    await message({ type: 'gemini_focus' });
    if (dom.signInState() === 'signed-out') return failed('signed-out', { signedOut: true });
    if (dom.localized()) return failed('page-not-english');
    if (typeof command.url !== 'string' || !command.url.startsWith('https://')) return failed('invalid-url');
    if (!dom.onCustomApps()) {
      panel?.start('Opening custom apps');
      location.assign('/customize/connectors');
      return result(command, { stage: 'navigating' });
    }
    panel?.start('Opening custom apps');
    if (!(await dom.waitFor(dom.visibleCreate))) return failed('custom-apps-layout-unknown');
    const name = command.connector || 'Chat On Steroids Core';
    const toList = async () => { dom.backToList(); return !!(await dom.waitFor(dom.visibleCreate)) && (await dom.settledList(), true); };
    panel?.step('Checking existing apps');
    await dom.settledList();
    // Every app already there under this name is found first. One with this address is kept; each
    // with an old address, and each duplicate, is deleted before anything is added: Gemini cannot
    // edit an address, and two apps cannot share a name.
    let kept = null, failures = 0;
    for (let pass = 0; ; pass += 1) {
      kept = null;
      for (let index = 0, rounds = 0; rounds < 15; rounds += 1) {
        const cards = dom.customAppCards(name);
        if (index >= cards.length) break;
        const existing = await dom.readCustomAppUrl(cards[index]);
        if (!existing) { dom.backToList(); return failed('custom-apps-layout-unknown'); }
        if (existing === command.url && !kept) {
          kept = existing;
          index += 1;
          if (!(await toList())) return failed('custom-apps-layout-unknown');
          continue;
        }
        panel?.step(`Deleting the old app (try ${failures + 1} of 3)`);
        if (await dom.deleteCustomApp(name, 8000, cards.length)) { failures = 0; await dom.settledList(); continue; }
        // A delete that did not take is tried again from the list (3 tries), which also finds it done late.
        if ((failures += 1) >= 3) return failed('delete-failed');
        if (!(await toList())) return failed('custom-apps-layout-unknown');
      }
      // Checked once more on a settled list: nothing is added while an app with this name is left.
      if (!(await toList())) return failed('custom-apps-layout-unknown');
      if (dom.customAppCards(name).length === (kept ? 1 : 0)) break;
      if (pass >= 2) return failed('delete-failed');
    }
    if (kept) {
      panel?.done(`Done: Gemini already has ${name} with this address, and only once.`);
      return result(command, { stage: 'completed', outcome: 'current', existingUrl: kept, verified: true });
    }
    panel?.step('Adding the app');
    const next = await dom.fillCreateForm(command.url);
    if (!next) return failed('custom-apps-layout-unknown');
    panel?.step('Next');
    next.click();
    const step = await dom.waitFor(dom.connectStep, 15000);
    if (!step) return failed('custom-apps-layout-unknown');
    panel?.step("Ticking Google's notice");
    if (!step.checkbox.checked) step.checkbox.click();
    if (!(await dom.waitFor(() => step.checkbox.checked && !step.connect.disabled ? true : null, 3000))) return failed('custom-apps-layout-unknown');
    panel?.step('Connect');
    step.connect.click();
    if (!(await dom.waitFor(() => !step.dialog.isConnected || step.dialog.getClientRects().length === 0 ? true : null, 20000))) return failed('connect-failed');
    // Verified on the list: exactly one app with this name, and it has the new address.
    panel?.step('Checking the app in Gemini');
    if (!(await toList())) return failed('verify-failed');
    const added = dom.customAppCards(name);
    if (added.length !== 1) return failed('verify-failed');
    const shown = await dom.readCustomAppUrl(added[0]);
    dom.backToList();
    if (shown !== command.url) return failed('verify-failed');
    panel?.done(`Done: ${name} is added and connected in Gemini, once, with this address.`);
    return result(command, { stage: 'completed', outcome: 'connected', verified: true });
  }

  async function run(command) {
    if (!command || typeof command.id !== 'string' || running.has(command.id)) return;
    running.add(command.id);
    try {
      if (command.kind === 'inspect-modes') {
        const found = await dom.inspectModes();
        await result(command, found ? { stage: 'completed', modes: found.modes, thinkingLevels: found.thinkingLevels }
          : { stage: 'failed', error: document.querySelector('[data-test-id="bard-mode-menu-button"]') ? 'mode-picker-unreadable' : 'no-model-picker' });
      } else if (command.kind === 'send') {
        await send(command);
      } else if (command.kind === 'fill-app') {
        await fillApp(command);
      } else if (command.kind === 'stop') {
        await result(command, dom.stopGeneration() ? { stage: 'completed' } : { stage: 'failed', error: 'not-generating' });
      } else {
        await result(command, { stage: 'failed', error: 'unknown-command' });
      }
    } catch (error) {
      if (command.kind === 'fill-app') globalThis.CLF_SETUP_PANEL?.fail(`The page stopped with an error: ${String(error?.message || error).slice(0, 200)}`);
      await result(command, { stage: 'failed', error: `page-error: ${String(error?.message || error).slice(0, 200)}` });
    } finally {
      running.delete(command.id);
      schedule(100);
    }
  }

  new MutationObserver(() => schedule()).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-label', 'aria-checked'] });
  setInterval(() => void report(true), REPORT_MS);
  window.addEventListener('pageshow', () => void report(true));
  void report(true);
})();
