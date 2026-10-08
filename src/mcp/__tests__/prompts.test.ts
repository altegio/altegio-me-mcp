import { describe, expect, it } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { textViolations } from '../../compliance/rules.js';
import { createCallRecord } from '../../observability/call-log.js';
import { createMcpServer } from '../create-server.js';
import { SERVER_PROMPTS } from '../prompts.js';

// The one MCP prompt of the server (D-03): "sign in, pick a place, book your
// usual", served over prompts/list and prompts/get. It walks the own-places
// flow and asks for nothing about the sign-in.

// A phone, SMS, code, OTP, e-mail or password request has no place in it.
const SIGN_IN_WORDS = /phone|sms|\bcode\b|otp|e-?mail|password/i;

async function withClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const server = createMcpServer({
    name: 'jest-server',
    version: '0.0.0',
    specs: [],
    toolsByName: new Map(),
    toolDeps: undefined,
    secrets: [],
    record: createCallRecord(),
  });
  const client = new Client({ name: 'jest-client', version: '0.0.0' });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  try {
    return await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

describe('SERVER_PROMPTS', () => {
  it('holds exactly book_my_usual', () => {
    expect(SERVER_PROMPTS.map((prompt) => prompt.name)).toEqual([
      'book_my_usual',
    ]);
  });

  it('names the whole own-places flow', () => {
    const [prompt] = SERVER_PROMPTS;
    for (const tool of [
      'me_list_places',
      'me_list_bookings',
      'business_list_dates',
      'business_list_time_slots',
      'book_check',
    ]) {
      expect(prompt?.text).toContain(tool);
    }
  });

  it('ends with a me_book preview and a booking after the user says yes, and the pre-filled link for a business that needs its widget', () => {
    const [prompt] = SERVER_PROMPTS;
    const text = prompt?.text ?? '';
    expect(text).toContain('me_book');
    expect(text).toMatch(/only after I say yes/i);
    expect(text).toContain('pre-filled booking link');
    expect(text.indexOf('me_book')).toBeGreaterThan(
      text.indexOf('business_list_time_slots')
    );
    expect(prompt?.description).toMatch(/books/i);
  });

  it('asks for nothing about the sign-in and passes the description deny-list', () => {
    for (const prompt of SERVER_PROMPTS) {
      for (const text of [prompt.title, prompt.description, prompt.text]) {
        expect(text).not.toMatch(SIGN_IN_WORDS);
        expect(textViolations(text)).toEqual([]);
        expect(text).not.toMatch(/https?:\/\//i);
      }
    }
  });
});

describe('prompts over MCP', () => {
  it('advertises the prompts capability', async () => {
    await withClient((client) => {
      expect(client.getServerCapabilities()?.prompts).toBeDefined();
      return Promise.resolve();
    });
  });

  it('lists exactly one prompt, book_my_usual, with a title and a description', async () => {
    await withClient(async (client) => {
      const { prompts } = await client.listPrompts();
      expect(prompts).toHaveLength(1);
      expect(prompts[0]?.name).toBe('book_my_usual');
      expect(prompts[0]?.title).toBeTruthy();
      expect(prompts[0]?.description).toBeTruthy();
      expect(prompts[0]?.arguments ?? []).toEqual([]);
    });
  });

  it('gets one user message that names the flow tools', async () => {
    await withClient(async (client) => {
      const result = await client.getPrompt({ name: 'book_my_usual' });
      expect(result.messages).toHaveLength(1);
      const [message] = result.messages;
      expect(message?.role).toBe('user');
      expect(message?.content.type).toBe('text');
      const text = message?.content.type === 'text' ? message.content.text : '';
      expect(text).toBe(SERVER_PROMPTS[0]?.text);
      for (const tool of [
        'me_list_places',
        'me_list_bookings',
        'business_list_dates',
        'business_list_time_slots',
        'book_check',
      ]) {
        expect(text).toContain(tool);
      }
    });
  });

  it('answers an unknown prompt with a JSON-RPC error that names prompts/list', async () => {
    await withClient(async (client) => {
      const failure = await client
        .getPrompt({ name: 'no_such_prompt' })
        .then(() => null)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(McpError);
      expect((failure as McpError).message).toContain('prompts/list');
    });
  });
});
