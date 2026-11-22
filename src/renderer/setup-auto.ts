/**
 * Setup done through the browser extension in the person's signed-in tabs:
 * - "Set it up for me" in the Tunnel and Key steps: a tunnel and a restricted key at platform.openai.com.
 * - "Set everything up": tunnel + key → Connect → the plugins in ChatGPT (with Allow all tools) →
 *   Gemini when its tunnel is on. The person only picks a folder and the access level first.
 * Each part shows its own progress; a part that fails says so plainly and points at its step.
 * shortcut: English only, like the Gemini panel (translate="no"); translate once the flow settles.
 */
export type TaskSeen = { id: string; state: string; outcome: string | null; progress: string | null; error: string | null };
export interface SetupAutoDeps {
  /** Whether the OpenAI tunnel ID and key are still missing (false on a Cloudflare or own tunnel). */
  needsOpenai: () => boolean;
  startOpenai: () => Promise<{ ok: true; id: string } | { ok: false; error: string } | null>;
  waitTask: (kind: 'openai-setup', id: string, each: (status: TaskSeen) => void) => Promise<TaskSeen | null>;
  refresh: () => Promise<void>;
  /** Connects when not connected; resolves with an error text, or null once every plugin is live. */
  connect: () => Promise<string | null>;
  /** One "Add it in ChatGPT for me" per plugin not yet in ChatGPT; each paints its own card. */
  plugins: () => Array<() => Promise<boolean>>;
  /** Gemini's custom app, when Gemini's tunnel is on: resolves with an error text or null. */
  gemini: (() => Promise<string | null>) | null;
  openStep: (step: string) => void;
}
type Tone = 'wait' | 'ok' | 'bad' | 'off';

/** The person's words for the platform.openai.com part. */
export function openaiText(status: Pick<TaskSeen, 'state' | 'progress' | 'error'>): [Tone, string] {
  if (status.state === 'failed') return ['bad', `${status.error || 'It did not finish'}. Use the Tunnel and Key steps by hand.`];
  if (status.state === 'done') return ['ok', 'Tunnel and key saved. The key is only in this computer\'s secure storage.'];
  if (status.state === 'requested') return ['wait', 'Opening platform.openai.com in your browser…'];
  return ['wait', status.progress === 'tunnel' ? 'Creating a restricted key (Tunnels: Read and Use)…' : 'Finding or creating the tunnel…'];
}

function row(list: HTMLElement, label: string): (tone: Tone, text: string) => void {
  const item = document.createElement('li');
  const name = document.createElement('strong');
  name.textContent = `${label}: `;
  const text = document.createElement('span');
  item.append(name, text);
  list.append(item);
  return (tone, value) => { item.dataset.tone = tone; text.textContent = value; };
}

/** Runs the platform.openai.com part, painting `show`; true once the tunnel ID and key are saved. */
export async function runOpenai(deps: SetupAutoDeps, show: (tone: Tone, text: string) => void): Promise<boolean> {
  const queued = await deps.startOpenai();
  if (!queued?.ok) { show('bad', 'The browser extension could not be asked. Use the Tunnel and Key steps by hand.'); return false; }
  show(...openaiText({ state: 'requested', progress: null, error: null }));
  const last = await deps.waitTask('openai-setup', queued.id, status => show(...openaiText(status)));
  if (!last || last.state !== 'done') {
    if (!last || last.state !== 'failed') show('bad', 'platform.openai.com did not finish in time. Use the Tunnel and Key steps by hand.');
    return false;
  }
  await deps.refresh();
  return true;
}

/** Chains every part; a failed prerequisite stops the parts that need it, the rest still run. */
export async function runEverything(deps: SetupAutoDeps, list: HTMLElement): Promise<void> {
  list.replaceChildren();
  const openai = row(list, 'Tunnel and key');
  const connect = row(list, 'Connect');
  const plugins = row(list, 'Plugins in ChatGPT');
  const gemini = deps.gemini ? row(list, 'Gemini') : null;
  if (deps.needsOpenai()) {
    if (!(await runOpenai(deps, openai))) {
      connect('off', 'Waits for the tunnel and key.'); plugins('off', 'Waits for Connect.'); gemini?.('off', 'Waits for Connect.');
      deps.openStep('tunnel');
      return;
    }
  } else openai('ok', 'Already set.');
  connect('wait', 'Connecting…');
  const connectError = await deps.connect();
  if (connectError) {
    connect('bad', `${connectError}. Use the Connect step.`);
    plugins('off', 'Waits for Connect.'); gemini?.('off', 'Waits for Connect.');
    deps.openStep('connect');
    return;
  }
  connect('ok', 'Connected.');
  const adds = deps.plugins();
  if (!adds.length) plugins('ok', 'Already in ChatGPT.');
  else {
    plugins('wait', 'Creating them in ChatGPT; each card below shows its own progress…');
    let failed = 0;
    for (const add of adds) if (!(await add())) failed++;
    if (failed) { plugins('bad', 'Not every plugin was created: its card says why. Use the ChatGPT step by hand for it.'); deps.openStep('chatgpt'); }
    else plugins('ok', 'Created in ChatGPT.');
  }
  if (gemini && deps.gemini) {
    gemini('wait', 'Adding the app in Gemini…');
    const geminiError = await deps.gemini();
    gemini(geminiError ? 'bad' : 'ok', geminiError ? `${geminiError}` : 'Added in Gemini.');
  }
}

/** Adds the buttons to Setup: "Set everything up" above the steps, "Set it up for me" in Tunnel and Key. */
export function mountSetupAuto(deps: () => Promise<SetupAutoDeps>): void {
  const steps = document.querySelector('li.step[data-step="tunnel"]')?.parentElement;
  if (!steps || document.getElementById('setupEverything')) return;
  const box = document.createElement('div');
  box.className = 'setup-auto';
  box.setAttribute('translate', 'no');
  box.innerHTML = `<button class="btn btn-solid" id="setupEverything" type="button">Set everything up</button>
    <p class="hint">After you pick a folder and the access level: the browser extension, in your signed-in tabs, creates or
    picks the OpenAI tunnel and a restricted key, connects, creates the plugins in ChatGPT with Allow all tools, and adds
    the app in Gemini when Gemini's tunnel is on. It never signs in for you; signed out, it stops and says so.</p>
    <ol class="setup-auto-parts" id="setupEverythingParts"></ol>`;
  steps.before(box);
  const button = box.querySelector<HTMLButtonElement>('#setupEverything')!;
  button.addEventListener('click', () => {
    button.disabled = true;
    void deps().then(ready => runEverything(ready, box.querySelector('ol')!)).finally(() => { button.disabled = false; });
  });
  for (const step of ['tunnel', 'key']) {
    const actions = document.querySelector(`li.step[data-step="${step}"] .step-actions`);
    if (!actions) continue;
    const mine = document.createElement('button');
    mine.className = 'btn';
    mine.type = 'button';
    mine.setAttribute('translate', 'no');
    mine.textContent = 'Set it up for me';
    const note = document.createElement('p');
    note.className = 'hint';
    note.setAttribute('translate', 'no');
    note.textContent = 'Opens platform.openai.com in your signed-in browser, takes the tunnel this app uses or one named "Chat On Steroids" (or creates it), then creates a Restricted key with Tunnels: Read and Use. The key goes only into this computer\'s secure storage.';
    mine.addEventListener('click', () => {
      mine.disabled = true;
      void deps().then(ready => runOpenai(ready, (tone, text) => { note.dataset.tone = tone; note.textContent = text; })).finally(() => { mine.disabled = false; });
    });
    actions.append(mine);
    actions.after(note);
  }
}
