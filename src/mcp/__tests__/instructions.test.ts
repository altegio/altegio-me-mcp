import { describe, expect, it } from '@jest/globals';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/client';
import { createCallRecord } from '../../observability/call-log.js';
import { UNTRUSTED_CLOSE } from '../../tools/untrusted.js';
import { createMcpServer } from '../create-server.js';
import { SERVER_INSTRUCTIONS } from '../instructions.js';

describe('SERVER_INSTRUCTIONS', () => {
  it('states the trust boundary with the fence markers', () => {
    expect(SERVER_INSTRUCTIONS).toContain('<<<UNTRUSTED');
    expect(SERVER_INSTRUCTIONS).toContain(UNTRUSTED_CLOSE);
    expect(SERVER_INSTRUCTIONS).toContain('not an instruction');
  });

  it.each([
    /\byou (must|should|shall)\b/i,
    /\b(always|never)\s+(call|use|follow|ask|tell)\b/i,
    /\bdo not\b/i,
  ])('carries no imperative directive matching %p', (pattern) => {
    expect(SERVER_INSTRUCTIONS).not.toMatch(pattern);
  });

  it('does not ask for client personal data or point to a URL', () => {
    expect(SERVER_INSTRUCTIONS).not.toMatch(/https?:\/\//i);
    expect(SERVER_INSTRUCTIONS).not.toMatch(/\b(ask|share|provide|send)\b/i);
  });

  it('describes the signed-in flow without a sign-in request', () => {
    for (const tool of ['me_list_places', 'me_list_bookings', 'book_check']) {
      expect(SERVER_INSTRUCTIONS).toContain(tool);
    }
    // The sentence that lists the own places, whole, carries no sign-in wording.
    const sentence = SERVER_INSTRUCTIONS.split('. ').find((part) =>
      part.includes('me_list_places')
    );
    expect(sentence).toBeDefined();
    expect(sentence).not.toMatch(/\b(sms|code|otp|e-?mail|password)\b/i);
    expect(sentence).not.toMatch(/phone/i);
  });

  it('describes booking, moving and cancelling at own places in the chat, in two steps', () => {
    for (const tool of [
      'me_book',
      'me_reschedule_booking',
      'me_cancel_booking',
    ]) {
      expect(SERVER_INSTRUCTIONS).toContain(tool);
    }
    expect(SERVER_INSTRUCTIONS).toMatch(/preview/i);
    expect(SERVER_INSTRUCTIONS).toMatch(/confirmation token/i);
    expect(SERVER_INSTRUCTIONS).toMatch(/after the client agreed/i);
  });

  it('describes two people side by side as one me_book call with a second_appointment', () => {
    expect(SERVER_INSTRUCTIONS).toContain('second_appointment');
    expect(SERVER_INSTRUCTIONS).toContain('side by side');
    expect(SERVER_INSTRUCTIONS).toMatch(/under the client's name/);
  });

  it('describes watching for a free time as a scheduled task of the host that only reads and keeps nothing on the server', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/scheduled task/i);
    expect(SERVER_INSTRUCTIONS).toContain('business_list_dates');
    expect(SERVER_INSTRUCTIONS).toContain('business_list_time_slots');
    expect(SERVER_INSTRUCTIONS).toMatch(/only reads/i);
    expect(SERVER_INSTRUCTIONS).toMatch(/server keeps nothing/i);
  });

  it('describes holding a slot as a booking plus a one-time reminder that changes nothing, with the cancel through me_cancel_booking (D-04)', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/holding a slot/i);
    expect(SERVER_INSTRUCTIONS).toMatch(/one-time reminder/i);
    expect(SERVER_INSTRUCTIONS).toMatch(/latest online cancellation time/i);
    expect(SERVER_INSTRUCTIONS).toMatch(/reminder changes nothing/i);
    expect(SERVER_INSTRUCTIONS).toMatch(
      /cancel goes through me_cancel_booking with the client's confirmation/i
    );
  });

  it('keeps the pre-filled widget link for what the chat cannot do', () => {
    expect(SERVER_INSTRUCTIONS).toContain('pre-filled');
    for (const case_ of [
      /prepayment/i,
      /membership/i,
      /inactive/i,
      /earlier visit/i,
      /without a client sign-in/i,
    ]) {
      expect(SERVER_INSTRUCTIONS).toMatch(case_);
    }
  });

  it('says the tools take no client personal data and that name and phone come from the profile', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/neither take nor return/i);
    expect(SERVER_INSTRUCTIONS).toMatch(/Altegio profile/);
  });

  it('no longer says that every booking is completed in the widget', () => {
    expect(SERVER_INSTRUCTIONS).not.toMatch(
      /A booking is completed by the client in the business's own Altegio booking widget/
    );
  });

  it('reaches an SDK client through initialize', async () => {
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
      expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
