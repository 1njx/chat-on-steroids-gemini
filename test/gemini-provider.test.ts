import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { flushDurable, initDurableStore, readDurable, resetDurableForTests } from '../src/main/durable.js';
import {
  cancelGeminiCommand, completeGeminiCommand, configureGemini, geminiPagesToOpen, geminiStatus, observeGeminiPage,
  queueGeminiFill, queueGeminiSend, requestGeminiModes, resetGeminiForTests, restoreGemini, saveGeminiSettings, sweep,
} from '../src/main/gemini.js';
import { geminiUrlFingerprint } from '../src/shared/gemini.js';
import { flushRecorder, resetRecorderForTests } from '../src/main/session/recorder.js';
import { findSessionByConversation, flushSessions, initSessionStore, readEvents, resetSessionStoreForTests, unsetSessionRootForTests } from '../src/main/session/store.js';
import { geminiConversationKey, geminiNativeId, providerConversationUrl, providerOfConversation } from '../src/shared/providers.js';
import { chatUrl } from '../src/main/bridge.js';

let dir = '';
const page = (fields: Record<string, unknown> = {}) => ({
  url: 'https://gemini.google.com/app', conversationId: null, signIn: 'signed-in', account: { name: 'Pat', plan: 'Pro' },
  selectedMode: 'Hydrogen', composerReady: true, generating: false, turnCount: 0, errors: [], localized: false, ...fields,
});
const MODES = [
  { id: '8c46e95b1a07cecc', title: 'Auto', model: null, available: true, selected: false, reason: null },
  { id: '56fdd199312815e2', title: 'Everyday help', model: 'Gemini 4 Hydrogen', available: true, selected: true, reason: null },
  { id: 'e6fa609c3fa255c0', title: 'Deeper analysis', model: 'Gemini 4 Neon', available: true, selected: false, reason: null },
  { id: 'upsell_MODE_CATEGORY_ULTRA', title: 'Code & complex work', model: 'Gemini 4 Carbon', available: false, selected: false, reason: 'requires-upgrade' },
];

async function loadModes(tab = 1) {
  const { id } = requestGeminiModes();
  expect(observeGeminiPage({ tab, snapshot: page() }).commands.map(c => c.id)).toEqual([id]);
  expect(await completeGeminiCommand({ id, tab, stage: 'completed', modes: MODES, thinkingLevels: [{ label: 'Low', selected: true, available: true }] })).toEqual({ ok: true });
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-gemini-'));
  initConfigPath(dir); initSessionStore(dir); initDurableStore(dir);
  await saveConfig(defaultConfig());
  resetGeminiForTests();
});
afterEach(async () => {
  resetGeminiForTests();
  await flushRecorder(); await flushSessions(); await flushDurable();
  resetRecorderForTests(); resetSessionStoreForTests(); unsetSessionRootForTests(); resetDurableForTests();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('provider descriptors', () => {
  it('keeps Gemini conversation keys apart from ChatGPT ids and builds the right URLs', () => {
    expect(geminiConversationKey('0819834086544111')).toBe('gemini:0819834086544111');
    expect(geminiConversationKey('../evil')).toBeNull();
    expect(geminiNativeId('gemini:0819834086544111')).toBe('0819834086544111');
    expect(geminiNativeId('6820a1b2-0000-4000-8000-000000000000')).toBeNull();
    expect(providerOfConversation('gemini:0819834086544111')).toBe('gemini');
    expect(providerOfConversation('6820a1b2-0000-4000-8000-000000000000')).toBe('chatgpt');
    expect(providerConversationUrl('gemini:0819834086544111')).toBe('https://gemini.google.com/app/0819834086544111');
    expect(chatUrl('gemini:0819834086544111')).toBe('https://gemini.google.com/app/0819834086544111');
    expect(chatUrl('6820a1b2-0000-4000-8000-000000000000')).toBe('https://chatgpt.com/c/6820a1b2-0000-4000-8000-000000000000');
  });
});

describe('Gemini provider', () => {
  it('reports page status without the Google address and drops pages that stop reporting', () => {
    expect(geminiStatus().pages).toBe(0);
    observeGeminiPage({ tab: 7, snapshot: page() }, 1_000);
    expect(geminiStatus(2_000)).toMatchObject({ pages: 1, signIn: 'signed-in', account: { name: 'Pat', plan: 'Pro' }, selectedMode: 'Hydrogen' });
    expect(geminiStatus(1_000 + 61_000).pages).toBe(0);
  });

  it('rejects malformed page reports instead of trusting them', () => {
    expect(observeGeminiPage({ tab: 'x', snapshot: {} }).ok).toBe(false);
    const report = observeGeminiPage({ tab: 3, snapshot: { conversationId: '../../etc', signIn: 'admin', errors: 'x' } });
    expect(report.ok).toBe(true);
    expect(geminiStatus()).toMatchObject({ signIn: 'unknown' });
  });

  it('stores the observed mode catalog durably, with the locked model unavailable', async () => {
    await loadModes();
    expect(geminiStatus().catalog?.modes.map(m => [m.model, m.available])).toEqual([
      [null, true], ['Gemini 4 Hydrogen', true], ['Gemini 4 Neon', true], ['Gemini 4 Carbon', false]]);
    await flushDurable();
    resetGeminiForTests();
    await restoreGemini();
    expect(geminiStatus().catalog?.modes).toHaveLength(4);
  });

  it('refuses a model the account showed as unavailable, before any page is involved', async () => {
    await loadModes();
    expect(queueGeminiSend({ prompt: 'hi', modeId: 'upsell_MODE_CATEGORY_ULTRA' })).toEqual({ ok: false, error: 'requires-upgrade' });
    expect(queueGeminiSend({ prompt: '   ' })).toEqual({ ok: false, error: 'invalid-request' });
    expect(queueGeminiSend({ prompt: 'x', conversation: 'gemini:nothex!' })).toEqual({ ok: false, error: 'invalid-conversation' });
  });

  it('delivers a send at most once: one tab, authorized once, recorded as a Gemini session', async () => {
    await loadModes();
    const queued = queueGeminiSend({ prompt: 'List the files in my project', modeId: 'e6fa609c3fa255c0', connector: 'Chat On Steroids Core' });
    expect(queued.ok).toBe(true);
    const id = (queued as { id: string }).id;
    // A signed-out page and a busy page are not offered it.
    expect(observeGeminiPage({ tab: 2, snapshot: page({ signIn: 'signed-out' }) }).commands).toEqual([]);
    expect(observeGeminiPage({ tab: 3, snapshot: page({ generating: true }) }).commands).toEqual([]);
    const handed = observeGeminiPage({ tab: 1, snapshot: page() }).commands;
    expect(handed).toEqual([expect.objectContaining({ id, kind: 'send', modeId: 'e6fa609c3fa255c0', connector: 'Chat On Steroids Core', conversationId: null })]);
    // No other tab can take it, and the owner gets it again only while it is still unsent.
    expect(observeGeminiPage({ tab: 4, snapshot: page() }).commands).toEqual([]);
    expect(await completeGeminiCommand({ id, tab: 4, stage: 'sending' })).toEqual({ ok: false });
    expect(await completeGeminiCommand({ id, tab: 1, stage: 'sending' })).toEqual({ ok: true, authorized: true });
    // A second authorization request (e.g. a duplicate content script) is refused.
    expect(await completeGeminiCommand({ id, tab: 1, stage: 'sending' })).toEqual({ ok: true, authorized: false });
    expect(observeGeminiPage({ tab: 1, snapshot: page({ generating: true }) }).commands).toEqual([]);
    expect(await completeGeminiCommand({ id, tab: 1, stage: 'sent', conversationId: '0819834086544111' })).toEqual({ ok: true });
    expect(await completeGeminiCommand({ id, tab: 1, stage: 'completed', conversationId: '0819834086544111', turnId: '4b3e398afa4ee324', answer: 'README.md, src/' })).toEqual({ ok: true });
    const summary = geminiStatus().commands.find(c => c.id === id)!;
    expect(summary).toMatchObject({ stage: 'completed', conversation: 'gemini:0819834086544111', answerChars: 15 });
    await flushRecorder();
    const session = await findSessionByConversation('gemini:0819834086544111');
    expect(session?.id).toBe(summary.sessionId);
    const events = await readEvents(session!.id);
    const kinds = events.map(e => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(['user_message', 'assistant_message']));
    expect(JSON.stringify(events)).toContain('List the files in my project');
    expect(JSON.stringify(events)).toContain('Gemini 4 Neon');
    // Completed work never comes back.
    expect(observeGeminiPage({ tab: 1, snapshot: page() }).commands).toEqual([]);
    expect(await completeGeminiCommand({ id, tab: 1, stage: 'completed', answer: 'again' })).toEqual({ ok: false });
  });

  it('re-hands a claimed send only to its own tab after that tab navigated for it', async () => {
    const id = (queueGeminiSend({ prompt: 'continue', conversation: 'gemini:abcdef0123456789', connector: null }) as { id: string }).id;
    expect(observeGeminiPage({ tab: 5, snapshot: page({ conversationId: '1111111111111111' }) }).commands.map(c => c.id)).toEqual([id]);
    expect(await completeGeminiCommand({ id, tab: 5, stage: 'navigating' })).toEqual({ ok: true });
    expect(observeGeminiPage({ tab: 6, snapshot: page({ conversationId: null }) }).commands).toEqual([]);
    expect(observeGeminiPage({ tab: 5, snapshot: page({ conversationId: 'abcdef0123456789' }) }).commands.map(c => c.id)).toEqual([id]);
  });

  it('prefers the tab already showing the conversation', () => {
    const id = (queueGeminiSend({ prompt: 'x', conversation: 'abcdef0123456789' }) as { id: string }).id;
    observeGeminiPage({ tab: 9, snapshot: page({ conversationId: 'abcdef0123456789', generating: true }) });
    // Another idle tab may not take it while the right tab is open (it is only busy).
    expect(observeGeminiPage({ tab: 8, snapshot: page() }).commands).toEqual([]);
    expect(observeGeminiPage({ tab: 9, snapshot: page({ conversationId: 'abcdef0123456789' }) }).commands.map(c => c.id)).toEqual([id]);
  });

  it('refuses a second send into the same conversation while one is on its way', () => {
    expect(queueGeminiSend({ prompt: 'a', conversation: 'abcdef0123456789' }).ok).toBe(true);
    expect(queueGeminiSend({ prompt: 'b', conversation: 'abcdef0123456789' })).toEqual({ ok: false, error: 'conversation-busy' });
  });

  it('ends an authorized but unconfirmed send as unknown, never completed and never resent', async () => {
    const id = (queueGeminiSend({ prompt: 'x' }) as { id: string }).id;
    observeGeminiPage({ tab: 1, snapshot: page() });
    await completeGeminiCommand({ id, tab: 1, stage: 'sending' });
    expect(sweep(Date.now() + 61_000)).toBe(true);
    expect(geminiStatus().commands[0]).toMatchObject({ stage: 'unknown', error: 'send-outcome-not-observed' });
    expect(observeGeminiPage({ tab: 1, snapshot: page() }).commands).toEqual([]);
  });

  it('fails queued work that no page takes, naming whether any page is connected', () => {
    queueGeminiSend({ prompt: 'x' });
    expect(geminiPagesToOpen()).toEqual(['https://gemini.google.com/app']);
    sweep(Date.now() + 3 * 60_000 + 1);
    expect(geminiStatus().commands[0]).toMatchObject({ stage: 'failed', error: 'gemini-page-not-connected' });
    expect(geminiPagesToOpen()).toEqual([]);
  });

  it('opens nothing while a Gemini page reports, and the conversation URL for a continuation', () => {
    queueGeminiSend({ prompt: 'x', conversation: 'abcdef0123456789' });
    expect(geminiPagesToOpen()).toEqual(['https://gemini.google.com/app/abcdef0123456789']);
    observeGeminiPage({ tab: 1, snapshot: page({ signIn: 'signed-out' }) });
    expect(geminiPagesToOpen()).toEqual([]);
  });

  it('records a failure after sending as a failed turn, keeping that it was sent', async () => {
    const id = (queueGeminiSend({ prompt: 'big job' }) as { id: string }).id;
    observeGeminiPage({ tab: 1, snapshot: page() });
    await completeGeminiCommand({ id, tab: 1, stage: 'sending' });
    await completeGeminiCommand({ id, tab: 1, stage: 'sent', conversationId: 'abcdef0123456789' });
    await completeGeminiCommand({ id, tab: 1, stage: 'failed', error: "You've reached your limit", quota: true });
    expect(geminiStatus().commands[0]).toMatchObject({ stage: 'failed', error: "sent; You've reached your limit" });
    await flushRecorder();
    const session = await findSessionByConversation('gemini:abcdef0123456789');
    expect(JSON.stringify(await readEvents(session!.id))).toContain("You've reached your limit");
  });

  it('cancels only work that no page was authorized to send', async () => {
    const id = (queueGeminiSend({ prompt: 'x' }) as { id: string }).id;
    expect(cancelGeminiCommand(id)).toEqual({ ok: true });
    const other = (queueGeminiSend({ prompt: 'y' }) as { id: string }).id;
    observeGeminiPage({ tab: 1, snapshot: page() });
    await completeGeminiCommand({ id: other, tab: 1, stage: 'sending' });
    expect(cancelGeminiCommand(other)).toEqual({ ok: false, error: 'already-sending' });
    // A page holding a cancelled command is not allowed to send it.
    const third = (queueGeminiSend({ prompt: 'z' }) as { id: string }).id;
    observeGeminiPage({ tab: 2, snapshot: page() });
    cancelGeminiCommand(third);
    expect(await completeGeminiCommand({ id: third, tab: 2, stage: 'sending' })).toEqual({ ok: false });
  });

  it('applies saved defaults (connector, mode) and persists them; explicit null means no mention', async () => {
    const pushes: number[] = [];
    configureGemini({ changed: () => pushes.push(1) });
    expect(saveGeminiSettings({ connectorName: 'Chat On Steroids Core', defaultModeId: 'e6fa609c3fa255c0' })).toEqual({ ok: true });
    expect(saveGeminiSettings({ defaultModeId: 'bad id!' })).toEqual({ ok: false, error: 'invalid-settings' });
    queueGeminiSend({ prompt: 'a' });
    queueGeminiSend({ prompt: 'b', connector: null, modeId: null });
    const handed = observeGeminiPage({ tab: 1, snapshot: page() }).commands;
    expect(handed[0]).toMatchObject({ connector: 'Chat On Steroids Core', modeId: 'e6fa609c3fa255c0' });
    expect(pushes.length).toBeGreaterThan(0);
    await flushDurable();
    expect(await readDurable<{ settings: { connectorName: string } }>('gemini')).toMatchObject({ settings: { connectorName: 'Chat On Steroids Core' } });
  });

  it('bounds retained command history', () => {
    for (let i = 0; i < 60; i += 1) { const r = queueGeminiSend({ prompt: `p${i}` }) as { id: string }; cancelGeminiCommand(r.id); }
    sweep();
    expect(geminiStatus().commands.length).toBeLessThanOrEqual(20);
  });

  it('fills the custom app form through one page and keeps only a fingerprint of the address', async () => {
    const url = `https://merit-totally-iowa-billion.trycloudflare.com/mcp/core/${'a'.repeat(43)}`;
    const old = `https://old-name.trycloudflare.com/mcp/core/${'b'.repeat(43)}`;
    expect(queueGeminiFill('http://localhost:1234/mcp/core/x')).toEqual({ ok: false, error: 'invalid-url' });
    expect(geminiPagesToOpen()).toEqual([]);
    const { id } = queueGeminiFill(url) as { id: string };
    // With no Gemini page reporting, the extension opens the custom apps page itself.
    expect(geminiPagesToOpen()).toEqual(['https://gemini.google.com/customize/connectors']);
    // Any idle signed-in page takes it, composer or not; a busy one does not.
    expect(observeGeminiPage({ tab: 2, snapshot: page({ generating: true }) }).commands).toEqual([]);
    const handed = observeGeminiPage({ tab: 1, snapshot: page({ url: 'https://gemini.google.com/customize/connectors', composerReady: false }) }).commands;
    expect(handed).toEqual([expect.objectContaining({ id, kind: 'fill-app', url })]);
    // The page found the app with another address: remembered as that address, so the app can say it is old.
    expect(await completeGeminiCommand({ id, tab: 1, stage: 'completed', outcome: 'old', existingUrl: old })).toEqual({ ok: true });
    const after = geminiStatus();
    expect(after.settings.givenUrlHash).toBe(geminiUrlFingerprint(old));
    expect(after.commands.at(-1)).toMatchObject({ kind: 'fill-app', stage: 'completed', outcome: 'old' });
    expect(JSON.stringify(after)).not.toContain('old-name');
    await flushDurable();
    expect(JSON.stringify(await readDurable('gemini'))).not.toContain('trycloudflare');

    // Filled in: the address given is the new one.
    const second = queueGeminiFill(url) as { id: string };
    observeGeminiPage({ tab: 1, snapshot: page({ composerReady: false }) });
    expect(await completeGeminiCommand({ id: second.id, tab: 1, stage: 'completed', outcome: 'filled' })).toEqual({ ok: true });
    expect(geminiStatus().settings.givenUrlHash).toBe(geminiUrlFingerprint(url));

    // A page that reports no outcome filled nothing: that is the layout fallback, never a success.
    const third = queueGeminiFill(url) as { id: string };
    observeGeminiPage({ tab: 1, snapshot: page() });
    await completeGeminiCommand({ id: third.id, tab: 1, stage: 'completed' });
    expect(geminiStatus().commands.at(-1)).toMatchObject({ stage: 'failed', error: 'custom-apps-layout-unknown' });
  });

  it('keeps one fill request at a time and refuses a bad fingerprint or hostname', () => {
    const url = `https://gemini.example.com/mcp/core/${'c'.repeat(43)}`;
    const first = queueGeminiFill(url) as { id: string };
    queueGeminiFill(url);
    expect(geminiStatus().commands.find(c => c.id === first.id)?.stage).toBe('cancelled');
    expect(saveGeminiSettings({ givenUrlHash: url })).toEqual({ ok: false, error: 'invalid-settings' });
    expect(saveGeminiSettings({ namedTunnelHost: 'https://x' })).toEqual({ ok: false, error: 'invalid-settings' });
    expect(saveGeminiSettings({ namedTunnelHost: 'Gemini.Example.com' })).toEqual({ ok: true });
    expect(geminiStatus().settings.namedTunnelHost).toBe('gemini.example.com');
  });
});
