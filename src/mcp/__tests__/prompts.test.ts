import { describe, expect, it } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { textViolations } from '../../compliance/rules.js';
import { createCallRecord } from '../../observability/call-log.js';
import { createMcpServer } from '../create-server.js';
import { SERVER_PROMPTS, type ServerPrompt } from '../prompts.js';

// The MCP prompts of the server, one per case: "sign in, pick a place, book
// your usual" (D-03), "two people side by side" (CASE-02, CASE-05) and "watch
// for a free time" (CASE-03, D-03, a scheduled task of the host) and "hold a
// slot" (CASE-04, D-04, a booking plus a one-time reminder), served
// over prompts/list and prompts/get. They walk the own-places flow and ask for
// nothing about the sign-in.

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

function promptNamed(name: string): ServerPrompt | undefined {
  return SERVER_PROMPTS.find((prompt) => prompt.name === name);
}

describe('SERVER_PROMPTS', () => {
  it('holds exactly book_my_usual, book_side_by_side, watch_for_a_free_slot and hold_a_slot', () => {
    expect(SERVER_PROMPTS.map((prompt) => prompt.name)).toEqual([
      'book_my_usual',
      'book_side_by_side',
      'watch_for_a_free_slot',
      'hold_a_slot',
    ]);
  });

  it('hold_a_slot books with me_book after a yes and sets up a one-time reminder that only asks keep or cancel (D-04, T-05-13)', () => {
    const prompt = promptNamed('hold_a_slot');
    const text = prompt?.text ?? '';
    expect(text).toContain('me_book');
    expect(text).toContain('me_cancel_booking');
    expect(text).toMatch(/only after I say yes/i);
    expect(text).toMatch(/one-time/i);
    expect(text).toMatch(/scheduled task/i);
    expect(text).toMatch(/keep it or cancel it/i);
    expect(text).toMatch(/latest online cancellation time/i);
    expect(text).toMatch(/one day before/i);
    expect(text).toMatch(/has passed/i);
    expect(text).toMatch(/changes nothing on its own/i);
    expect(text).toMatch(/cancel only after I say yes/i);
    expect(text.indexOf('me_cancel_booking')).toBeGreaterThan(
      text.indexOf('keep it or cancel it')
    );
    for (const move of ['me_reschedule_booking', 'business_list_dates']) {
      expect(text).not.toContain(move);
    }
    expect(prompt?.title).toBeTruthy();
    expect(prompt?.description).toBeTruthy();
  });

  it('hold_a_slot makes no hold without online cancellation or a known limit, holds one per place, and leaves prepaid services to the widget (T-05-14)', () => {
    const text = promptNamed('hold_a_slot')?.text ?? '';
    expect(text).toMatch(/does not allow online cancellation/i);
    expect(text).toMatch(/no latest online cancellation time/i);
    expect(text).toMatch(/hold is not possible/i);
    expect(text).toMatch(/one hold per place/i);
    expect(text).toMatch(/online prepayment/i);
  });

  it('watch_for_a_free_slot sets up a scheduled task whose runs only read, and books in the chat after a yes', () => {
    const prompt = promptNamed('watch_for_a_free_slot');
    const text = prompt?.text ?? '';
    for (const name of [
      'business_list_dates',
      'business_list_time_slots',
      'me_list_places',
      'me_book',
      'book_check',
    ]) {
      expect(text).toContain(name);
    }
    expect(text).toMatch(/scheduled task/i);
    expect(text).toMatch(/hour/i);
    expect(text).toMatch(/only after I say yes/i);
    expect(text).toMatch(/a run books nothing/i);
    expect(text).toMatch(/only the ids, the dates and the times of day/i);
    expect(text).toMatch(/62 days/);
    expect(text).toMatch(/pausing or deleting/i);
    expect(text.indexOf('business_list_dates')).toBeLessThan(
      text.indexOf('business_list_time_slots')
    );
    expect(text.indexOf('me_book')).toBeGreaterThan(
      text.indexOf('business_list_time_slots')
    );
    for (const write of ['me_reschedule_booking', 'me_cancel_booking']) {
      expect(text).not.toContain(write);
    }
    expect(prompt?.title).toBeTruthy();
    expect(prompt?.description).toBeTruthy();
  });

  it('names the whole own-places flow', () => {
    const prompt = promptNamed('book_my_usual');
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
    const prompt = promptNamed('book_my_usual');
    const text = prompt?.text ?? '';
    expect(text).toContain('me_book');
    expect(text).toMatch(/only after I say yes/i);
    expect(text).toContain('pre-filled booking link');
    expect(text.indexOf('me_book')).toBeGreaterThan(
      text.indexOf('business_list_time_slots')
    );
    expect(prompt?.description).toMatch(/books/i);
  });

  it('book_side_by_side books two appointments at one start with two different team members through one me_book call', () => {
    const prompt = promptNamed('book_side_by_side');
    const text = prompt?.text ?? '';
    for (const name of [
      'me_list_places',
      'business_list_team_members',
      'business_list_time_slots',
      'me_book',
      'second_appointment',
    ]) {
      expect(text).toContain(name);
    }
    expect(text).toMatch(/only after I say yes/i);
    expect(text).toMatch(/same time/i);
    expect(text).toMatch(/two different team members/i);
    expect(text).toMatch(/both bookings (will be )?under my name/i);
    expect(text).toMatch(/nothing about the other person is needed/i);
    expect(text.indexOf('me_book')).toBeGreaterThan(
      text.indexOf('business_list_time_slots')
    );
    expect(prompt?.title).toBeTruthy();
    expect(prompt?.description).toBeTruthy();
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

  it('lists the four prompts, each with a title and a description and no arguments', async () => {
    await withClient(async (client) => {
      const { prompts } = await client.listPrompts();
      expect(prompts.map((prompt) => prompt.name)).toEqual([
        'book_my_usual',
        'book_side_by_side',
        'watch_for_a_free_slot',
        'hold_a_slot',
      ]);
      for (const prompt of prompts) {
        expect(prompt.title).toBeTruthy();
        expect(prompt.description).toBeTruthy();
        expect(prompt.arguments ?? []).toEqual([]);
      }
    });
  });

  it('gets one user message with the text of book_side_by_side', async () => {
    await withClient(async (client) => {
      const result = await client.getPrompt({ name: 'book_side_by_side' });
      expect(result.messages).toHaveLength(1);
      const [message] = result.messages;
      expect(message?.role).toBe('user');
      const text = message?.content.type === 'text' ? message.content.text : '';
      expect(text).toBe(promptNamed('book_side_by_side')?.text);
      expect(text).toContain('second_appointment');
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
      expect(text).toBe(promptNamed('book_my_usual')?.text);
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
