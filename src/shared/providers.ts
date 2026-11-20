/**
 * Chat providers the app can drive in the browser.
 *
 * ChatGPT is the original provider and owns every unprefixed conversation id (its UUIDs). Other
 * providers keep their own conversation ids behind a `<provider>:` prefix in the local session
 * store, so their ids can never collide with, or be mistaken for, a ChatGPT conversation by any
 * ChatGPT-specific path (recovery, URLs, the outbox, which only accepts ChatGPT UUIDs).
 */
export type ProviderId = 'chatgpt' | 'gemini';

export interface ProviderDescriptor {
  id: ProviderId;
  label: string;
  origin: string;
  /** Where the person adds this app's MCP connector in the provider's own UI. */
  connectorSettingsUrl: string;
  /** Whether the provider can reach the OpenAI Secure MCP Tunnel (only ChatGPT can). */
  secureTunnel: boolean;
}

export const PROVIDERS: Readonly<Record<ProviderId, ProviderDescriptor>> = {
  chatgpt: {
    id: 'chatgpt', label: 'ChatGPT', origin: 'https://chatgpt.com',
    connectorSettingsUrl: 'https://chatgpt.com/plugins', secureTunnel: true,
  },
  gemini: {
    id: 'gemini', label: 'Gemini', origin: 'https://gemini.google.com',
    connectorSettingsUrl: 'https://gemini.google.com/customize/connectors', secureTunnel: false,
  },
};

export const GEMINI_PREFIX = 'gemini:';
/** Gemini's own conversation ids are lower-case hex, 16 characters on the live page (2026-11). */
export const GEMINI_NATIVE_ID = /^[0-9a-f]{8,32}$/;

export function geminiConversationKey(nativeId: string): string | null {
  const id = String(nativeId ?? '').toLowerCase();
  return GEMINI_NATIVE_ID.test(id) ? `${GEMINI_PREFIX}${id}` : null;
}

export function geminiNativeId(conversationKey: string | null | undefined): string | null {
  if (typeof conversationKey !== 'string' || !conversationKey.startsWith(GEMINI_PREFIX)) return null;
  const id = conversationKey.slice(GEMINI_PREFIX.length);
  return GEMINI_NATIVE_ID.test(id) ? id : null;
}

export function providerOfConversation(conversationKey: string | null | undefined): ProviderId {
  return typeof conversationKey === 'string' && conversationKey.startsWith(GEMINI_PREFIX) ? 'gemini' : 'chatgpt';
}

/** The provider's own page for a recorded conversation key. */
export function providerConversationUrl(conversationKey: string): string {
  const gemini = geminiNativeId(conversationKey);
  if (gemini) return `${PROVIDERS.gemini.origin}/app/${gemini}`;
  return `${PROVIDERS.chatgpt.origin}/c/${encodeURIComponent(conversationKey)}`;
}
