/** Gemini web provider state shared by main, preload and renderer (owner: src/main/gemini.ts). */
export interface GeminiMode {
  /** Gemini's stable `data-mode-id`. */
  id: string;
  /** The picker's title, e.g. "Deeper analysis". */
  title: string;
  /** The model the option names, e.g. "Gemini 4 Neon"; null for Auto. */
  model: string | null;
  available: boolean;
  selected: boolean;
  /** Why it is unavailable as the page showed it, e.g. "requires-upgrade". */
  reason: string | null;
  /** The thinking levels Gemini offers with this model ([] for none, e.g. Auto); null when not read. */
  levels?: string[] | null;
}

export interface GeminiThinkingLevel { label: string; selected: boolean; available: boolean }

export interface GeminiCommandSummary {
  id: string;
  kind: 'send' | 'inspect-modes' | 'stop' | 'fill-app';
  stage: 'queued' | 'claimed' | 'sending' | 'sent' | 'completed' | 'failed' | 'cancelled' | 'unknown';
  error: string | null;
  createdAt: number;
  updatedAt: number;
  conversation: string | null;
  sessionId: string | null;
  modeId: string | null;
  promptPreview: string | null;
  answerChars: number | null;
  /** fill-app only: 'filled' (form filled, the person clicks Next), 'current' or 'old' (Gemini already has the app). */
  outcome?: string | null;
}

export interface GeminiStatus {
  /** Gemini pages that reported within the last minute. */
  pages: number;
  signIn: 'signed-in' | 'signed-out' | 'unknown' | null;
  account: { name: string | null; plan: string | null } | null;
  selectedMode: string | null;
  /** A Gemini page uses a non-English UI; custom apps and this integration need English. */
  localized: boolean;
  errors: string[];
  quotaLimited: boolean;
  catalog: { modes: GeminiMode[]; thinkingLevels: GeminiThinkingLevel[]; observedAt: number } | null;
  /** The last failed read of Gemini's models (GEMINI_ERRORS code); no automatic read before retryAt. */
  modesFailure?: { error: string; at: number; retryAt: number } | null;
  settings: {
    connectorName: string | null; defaultModeId: string | null; defaultThinkingLevel: string | null; httpsTunnel?: boolean;
    /** geminiUrlFingerprint of the address last given for Gemini's custom app (copied, filled in, or read there). */
    givenUrlHash?: string | null;
    /** geminiUrlFingerprint of the address Gemini's list showed exactly once under the name after the last add. */
    verifiedUrlHash?: string | null;
    /** The hostname of the person's own Cloudflare tunnel for Gemini; its token is in the secret store. */
    namedTunnelHost?: string | null;
  };
  commands: GeminiCommandSummary[];
  /** When an MCP request from Gemini's connector client (User-Agent "Google") last arrived this run. */
  connectorSeenAt?: number | null;
  /** When Gemini last called one of this app's tools in this run (null: never). */
  toolCallSeenAt?: number | null;
  /** The fill-app the app queued by itself because the Core address changed (quick tunnel), this run. */
  autoFill?: { id: string; at: number; retryAt?: number | null } | null;
  /** When Gemini last listed this app's tools in this run (null: never). */
  toolsListedAt?: number | null;
  /** Gemini's current Core address (fingerprint) and since when, this run. */
  address?: { urlHash: string; since: number } | null;
  /** The last check that the Core address answers from outside, through the tunnel. */
  reach?: { urlHash: string; ok: boolean; at: number } | null;
}

/**
 * A short fingerprint of a connector address, to tell whether it changed without storing it: the
 * address ends in a secret path token. shortcut: 53-bit non-cryptographic hash, enough to notice a
 * changed address; use SHA-256 if it ever has to prove anything.
 */
export function geminiUrlFingerprint(url: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < url.length; i++) {
    const ch = url.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

/** Plain-language text for a command error code; unknown codes are shown as Gemini/the page gave them. */
export const GEMINI_ERRORS: Record<string, string> = {
  'signed-out': 'Gemini is signed out in the browser. Sign in at gemini.google.com.',
  'page-not-english': 'The Gemini page is not in English. Custom MCP apps and this integration require Gemini in English.',
  'mode-unavailable': 'That Gemini model is not available on this account.',
  'requires-upgrade': 'That Gemini model needs a higher Google AI plan on this account.',
  'thinking-level-unavailable': 'That thinking level is not offered for the selected model.',
  'connector-not-offered': 'Gemini did not offer a connected app with that name. Add the Core MCP server under Gemini → Connectors → Custom and enter the exact name it shows.',
  'composer-unavailable': 'The Gemini composer was not available.',
  'send-not-accepted': 'Gemini did not accept the message.',
  'withdrawn': 'The message was withdrawn before it was sent.',
  'busy': 'Gemini was still answering in that chat.',
  'answer-timeout': 'Gemini did not finish answering within 30 minutes.',
  'no-ready-gemini-page': 'No signed-in, idle Gemini page took the message within 3 minutes.',
  'gemini-page-not-connected': "No Gemini page is connected. Open gemini.google.com, signed in, in your own browser with the Chat On Steroids extension (Google does not allow signing in inside the app's built-in browser).",
  'page-did-not-respond': 'The Gemini page stopped responding before sending.',
  'send-outcome-not-observed': 'The page was told to send but never confirmed. Check the Gemini chat; it was not sent again.',
  'answer-not-observed': 'The message was sent but the answer was not observed.',
  'conversation-id-not-observed': 'Gemini answered but the chat id could not be read.',
  'navigation-loop': 'The Gemini page kept navigating instead of opening the chat.',
  'mode-picker-unreadable': 'The Gemini model picker could not be read.',
  'no-model-picker': "Gemini's model picker was not on the page. Gemini draws it only once its tab has been on screen: bring the Gemini tab to the front, then press Refresh (or wait for the next automatic read).",
  'mode-list-invalid': "Gemini's model picker did not look as expected, so no models were read.",
  'invalid-request': 'The request was not valid.',
  'invalid-conversation': 'That is not a Gemini chat.',
  'conversation-busy': 'A message to that Gemini chat is already on its way.',
  'custom-apps-layout-unknown': "Gemini's custom apps page did not look as expected, so nothing was filled in. Add the app by hand: click Custom, paste the address, then Next.",
  'invalid-url': 'Gemini needs an https address. Finish the Tunnel step first.',
  'delete-failed': "Gemini did not delete the app with the old address after 3 tries. Delete it by hand (open it, More options, Delete, then Remove), then press the button again.",
  'connect-failed': "Gemini did not finish connecting the app. Check the open Gemini tab, or add the app by hand: click Custom, paste the address, then Next and Connect.",
  'verify-failed': "After adding, Gemini's custom apps did not show exactly one app with this name and address. Check the list in Gemini (delete any extra copy), then press the button again.",
};
