import { describe, expect, it } from 'vitest';
import { mcpClientFamily } from '../src/main/mcp/inbound.js';
import { GEMINI_RESULT_NOTE, singleTextForGemini } from '../src/main/mcp/kernel.js';

describe('MCP client family', () => {
  it('recognizes Gemini\'s connector client by its User-Agent (observed live: "Google")', () => {
    expect(mcpClientFamily('Google')).toBe('gemini');
    expect(mcpClientFamily(['Google'])).toBe('gemini');
    expect(mcpClientFamily('Gemini-MCP/1')).toBe('gemini');
    expect(mcpClientFamily('openai-mcp/1.0')).toBe('chatgpt');
    expect(mcpClientFamily('GoogleChrome-Updater')).toBe('other');
    expect(mcpClientFamily(undefined)).toBe('other');
    expect(mcpClientFamily('curl/8')).toBe('other');
  });

  it('joins every text part in order, keeps images, and appends one short note', () => {
    const merged = singleTextForGemini({ content: [
      { type: 'text', text: 'a' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      { type: 'text', text: 'b' },
    ], isError: true } as never);
    expect(merged.isError).toBe(true);
    expect(merged.content).toEqual([
      { type: 'text', text: `a\nb\n${GEMINI_RESULT_NOTE}` },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    ]);
  });
});
