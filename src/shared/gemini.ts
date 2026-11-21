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
}

export interface GeminiThinkingLevel { label: string; selected: boolean; available: boolean }

export interface GeminiCommandSummary {
  id: string;
  kind: 'send' | 'inspect-modes' | 'stop';
  stage: 'queued' | 'claimed' | 'sending' | 'sent' | 'completed' | 'failed' | 'cancelled' | 'unknown';
  error: string | null;
  createdAt: number;
  updatedAt: number;
  conversation: string | null;
  sessionId: string | null;
  modeId: string | null;
  promptPreview: string | null;
  answerChars: number | null;
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
  settings: { connectorName: string | null; defaultModeId: string | null; defaultThinkingLevel: string | null };
  commands: GeminiCommandSummary[];
  /** When an MCP request from Gemini's connector client (User-Agent "Google") last arrived this run. */
  connectorSeenAt?: number | null;
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
  'gemini-page-not-connected': 'No Gemini page is connected. Open gemini.google.com in the browser with the extension.',
  'page-did-not-respond': 'The Gemini page stopped responding before sending.',
  'send-outcome-not-observed': 'The page was told to send but never confirmed. Check the Gemini chat; it was not sent again.',
  'answer-not-observed': 'The message was sent but the answer was not observed.',
  'conversation-id-not-observed': 'Gemini answered but the chat id could not be read.',
  'navigation-loop': 'The Gemini page kept navigating instead of opening the chat.',
  'mode-picker-unreadable': 'The Gemini model picker could not be read.',
  'invalid-request': 'The request was not valid.',
  'invalid-conversation': 'That is not a Gemini chat.',
  'conversation-busy': 'A message to that Gemini chat is already on its way.',
};
