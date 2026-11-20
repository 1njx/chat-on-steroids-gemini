/**
 * Gemini page companion (gemini.google.com).
 *
 * Reports what this page shows (sign-in, plan, selected mode, conversation, whether Gemini is
 * answering) and runs the app's Gemini commands that the app handed to exactly this tab:
 *   · inspect-modes: read the account's mode picker without changing it
 *   · send: select a mode/thinking level, optionally @-mention a connected app, send one prompt,
 *     then wait for Gemini's answer and report it
 *   · stop: press Stop on the running answer
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

  async function run(command) {
    if (!command || typeof command.id !== 'string' || running.has(command.id)) return;
    running.add(command.id);
    try {
      if (command.kind === 'inspect-modes') {
        const found = await dom.inspectModes();
        await result(command, found ? { stage: 'completed', modes: found.modes, thinkingLevels: found.thinkingLevels }
          : { stage: 'failed', error: 'mode-picker-unreadable' });
      } else if (command.kind === 'send') {
        await send(command);
      } else if (command.kind === 'stop') {
        await result(command, dom.stopGeneration() ? { stage: 'completed' } : { stage: 'failed', error: 'not-generating' });
      } else {
        await result(command, { stage: 'failed', error: 'unknown-command' });
      }
    } catch (error) {
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
