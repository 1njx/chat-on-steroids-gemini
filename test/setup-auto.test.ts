// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { openaiText, runEverything, type SetupAutoDeps } from '../src/renderer/setup-auto.js';

function deps(overrides: Partial<SetupAutoDeps> = {}): SetupAutoDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    needsOpenai: () => true,
    startOpenai: async () => { calls.push('openai'); return { ok: true, id: 'task-1' }; },
    waitTask: async (_kind, id, each) => { const done = { id, state: 'done', outcome: 'done', progress: 'key', error: null }; each(done); return done; },
    refresh: async () => { calls.push('refresh'); },
    connect: async () => { calls.push('connect'); return null; },
    plugins: () => [async () => { calls.push('core'); return true; }, async () => { calls.push('desktop'); return true; }],
    gemini: async () => { calls.push('gemini'); return null; },
    openStep: step => calls.push(`open:${step}`),
    ...overrides
  };
}
const lines = (list: HTMLElement) => [...list.querySelectorAll('li')].map(item => `${item.dataset.tone}|${item.textContent}`);

describe('"Set everything up"', () => {
  it('runs tunnel + key, Connect, each plugin, then Gemini, in that order', async () => {
    const list = document.createElement('ol');
    const run = deps();
    await runEverything(run, list);
    expect(run.calls).toEqual(['openai', 'refresh', 'connect', 'core', 'desktop', 'gemini']);
    expect(lines(list).map(line => line.split('|')[0])).toEqual(['ok', 'ok', 'ok', 'ok']);
  });

  it('stops at a failed tunnel step, says why, and opens that step', async () => {
    const list = document.createElement('ol');
    const run = deps({ waitTask: async (_kind, id, each) => {
      const failed = { id, state: 'failed', outcome: null, progress: null, error: 'Sign in to platform.openai.com in this browser, then press the button again' };
      each(failed); return failed;
    } });
    await runEverything(run, list);
    expect(run.calls).toEqual(['openai', 'open:tunnel']);
    expect(lines(list)[0]).toBe('bad|Tunnel and key: Sign in to platform.openai.com in this browser, then press the button again. Use the Tunnel and Key steps by hand.');
    expect(lines(list).slice(1).every(line => line.startsWith('off|'))).toBe(true);
  });

  it('skips a tunnel that is already set, falls back on a failed plugin, and still adds Gemini', async () => {
    const list = document.createElement('ol');
    const run = deps({ needsOpenai: () => false, plugins: () => [async () => false], gemini: vi.fn(async () => "Gemini did not finish connecting the app.") });
    await runEverything(run, list);
    expect(run.calls).toEqual(['connect', 'open:chatgpt']);
    expect(lines(list)).toEqual([
      'ok|Tunnel and key: Already set.', 'ok|Connect: Connected.',
      'bad|Plugins in ChatGPT: Not every plugin was created: its card says why. Use the ChatGPT step by hand for it.',
      'bad|Gemini: Gemini did not finish connecting the app.']);
  });

  it('stops after a failed Connect and leaves Gemini out when its tunnel is off', async () => {
    const list = document.createElement('ol');
    const run = deps({ needsOpenai: () => false, connect: async () => 'The tunnel did not come up within 90 seconds', gemini: null });
    await runEverything(run, list);
    expect(run.calls).toEqual(['open:connect']);
    expect(lines(list)).toHaveLength(3);
    expect(lines(list)[1]).toBe('bad|Connect: The tunnel did not come up within 90 seconds. Use the Connect step.');
  });

  it('says which platform.openai.com part it is on', () => {
    expect(openaiText({ state: 'claimed', progress: null, error: null })[1]).toMatch(/tunnel/);
    expect(openaiText({ state: 'claimed', progress: 'tunnel', error: null })[1]).toMatch(/Tunnels: Read and Use/);
  });
});
