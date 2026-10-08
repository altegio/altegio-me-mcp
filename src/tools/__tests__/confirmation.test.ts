import { describe, expect, it } from '@jest/globals';
import {
  CONFIRMATION_TOKEN_ARG,
  CONFIRMATION_TTL_MS,
  createConfirmations,
} from '../confirmation.js';
import {
  FAKE_CLOCK_START_MS,
  createFakeClock,
} from '../../booking/__tests__/helpers/fake-clock.js';

// Confirmation tokens of the write tools (ADR 0006, D-03): HMAC over the
// expiry, the tool, the sign-in and the canonical arguments, single use per
// instance, with an injected clock so no test waits.

const USER = 'client-user-token-0001-abcdef';
const OTHER_USER = 'client-user-token-0002-abcdef';
const TOOL = 'me_book';
const ARGS = {
  location_id: 722227,
  service_ids: [10303531, 10303532],
  team_member_id: 2098145,
  datetime: '2099-01-12T11:00:00+03:00',
};
const SECRET = 'confirmation-secret-0123456789abcdef0123';

function fresh(options: { secret?: string } = {}) {
  const clock = createFakeClock();
  const confirmations = createConfirmations({
    secret: options.secret,
    now: clock.now,
  });
  return { clock, confirmations };
}

describe('the token format', () => {
  it('is the expiry in milliseconds, a dot and 43 base64url characters, 10 minutes ahead', () => {
    const { confirmations } = fresh();
    const issued = confirmations.issue(TOOL, USER, ARGS);
    expect(issued.token).toMatch(/^\d+\.[A-Za-z0-9_-]{43}$/);
    expect(issued.expiresAt).toBe(FAKE_CLOCK_START_MS + CONFIRMATION_TTL_MS);
    expect(CONFIRMATION_TTL_MS).toBe(10 * 60 * 1000);
    expect(issued.token.startsWith(`${issued.expiresAt}.`)).toBe(true);
  });

  it('names the argument confirmation_token, as Altegio.Pro MCP does', () => {
    expect(CONFIRMATION_TOKEN_ARG).toBe('confirmation_token');
  });
});

describe('redeem', () => {
  it('accepts the identical arguments once, then reports the token used', () => {
    const { confirmations } = fresh();
    const { token } = confirmations.issue(TOOL, USER, ARGS);
    expect(confirmations.redeem(token, TOOL, USER, ARGS)).toBe('ok');
    expect(confirmations.redeem(token, TOOL, USER, ARGS)).toBe('used');
  });

  it('ignores a confirmation_token key in the arguments, and the order of the keys', () => {
    const { confirmations } = fresh();
    const { token } = confirmations.issue(TOOL, USER, ARGS);
    const shuffled = {
      datetime: ARGS.datetime,
      confirmation_token: token,
      team_member_id: ARGS.team_member_id,
      service_ids: ARGS.service_ids,
      location_id: ARGS.location_id,
    };
    expect(confirmations.redeem(token, TOOL, USER, shuffled)).toBe('ok');
  });

  it.each([
    [
      'a reordered service list',
      { ...ARGS, service_ids: [10303532, 10303531] },
    ],
    ['another service', { ...ARGS, service_ids: [10303531, 10303533] }],
    ['another team member', { ...ARGS, team_member_id: 2098146 }],
    ['another datetime', { ...ARGS, datetime: '2099-01-12T11:30:00+03:00' }],
    ['another location', { ...ARGS, location_id: 726120 }],
    ['an extra key', { ...ARGS, extra: 1 }],
  ])('refuses %s as invalid', (_label, changed) => {
    const { confirmations } = fresh();
    const { token } = confirmations.issue(TOOL, USER, ARGS);
    expect(confirmations.redeem(token, TOOL, USER, changed)).toBe('invalid');
    // A refused attempt does not use the token up.
    expect(confirmations.redeem(token, TOOL, USER, ARGS)).toBe('ok');
  });

  it('refuses another tool and another sign-in as invalid', () => {
    const { confirmations } = fresh();
    const { token } = confirmations.issue(TOOL, USER, ARGS);
    expect(confirmations.redeem(token, 'me_cancel_booking', USER, ARGS)).toBe(
      'invalid'
    );
    expect(confirmations.redeem(token, TOOL, OTHER_USER, ARGS)).toBe('invalid');
  });

  it('is valid at the expiry and expired one millisecond later', () => {
    const { confirmations } = fresh();
    const { token, expiresAt } = confirmations.issue(TOOL, USER, ARGS);
    expect(confirmations.redeem(token, TOOL, USER, ARGS, expiresAt)).toBe('ok');
    const second = confirmations.issue(TOOL, USER, ARGS);
    expect(
      confirmations.redeem(second.token, TOOL, USER, ARGS, second.expiresAt + 1)
    ).toBe('expired');
  });

  it('follows the injected clock', () => {
    const { clock, confirmations } = fresh();
    const { token } = confirmations.issue(TOOL, USER, ARGS);
    void clock.sleep(CONFIRMATION_TTL_MS + 1);
    expect(confirmations.redeem(token, TOOL, USER, ARGS)).toBe('expired');
  });

  it.each([
    ['an empty string', ''],
    ['text', 'abc'],
    ['an expiry with no signature', '1.'],
    ['two non-numeric parts', 'x.y'],
    ['a 300-character string', 'a'.repeat(300)],
  ])('refuses %s as invalid', (_label, token) => {
    const { confirmations } = fresh();
    expect(confirmations.redeem(token, TOOL, USER, ARGS)).toBe('invalid');
  });

  it('refuses a token whose last character is flipped', () => {
    const { confirmations } = fresh();
    const { token } = confirmations.issue(TOOL, USER, ARGS);
    const last = token.slice(-1);
    // Every other character of the base64url alphabet, the unused-bit ones included.
    const alphabet =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    for (const other of alphabet) {
      if (other === last) continue;
      expect(
        confirmations.redeem(`${token.slice(0, -1)}${other}`, TOOL, USER, ARGS)
      ).toBe('invalid');
    }
    expect(confirmations.redeem(token, TOOL, USER, ARGS)).toBe('ok');
  });

  it('refuses a token with an altered expiry', () => {
    const { confirmations } = fresh();
    const { token, expiresAt } = confirmations.issue(TOOL, USER, ARGS);
    const forged = token.replace(`${expiresAt}.`, `${expiresAt + 600_000}.`);
    expect(confirmations.redeem(forged, TOOL, USER, ARGS)).toBe('invalid');
  });
});

describe('the key', () => {
  it("lets two instances with the same secret accept each other's tokens", () => {
    const a = fresh({ secret: SECRET }).confirmations;
    const b = fresh({ secret: SECRET }).confirmations;
    const { token } = a.issue(TOOL, USER, ARGS);
    expect(b.redeem(token, TOOL, USER, ARGS)).toBe('ok');
  });

  it("does not let two instances with random keys accept each other's tokens", () => {
    const a = fresh().confirmations;
    const b = fresh().confirmations;
    const { token } = a.issue(TOOL, USER, ARGS);
    expect(b.redeem(token, TOOL, USER, ARGS)).toBe('invalid');
  });

  it('does not let a different secret accept a token', () => {
    const a = fresh({ secret: SECRET }).confirmations;
    const b = fresh({ secret: `${SECRET}x` }).confirmations;
    const { token } = a.issue(TOOL, USER, ARGS);
    expect(b.redeem(token, TOOL, USER, ARGS)).toBe('invalid');
  });

  it('keeps the used set per instance: the same token can be redeemed once on each instance (the documented window)', () => {
    const a = fresh({ secret: SECRET }).confirmations;
    const b = fresh({ secret: SECRET }).confirmations;
    const { token } = a.issue(TOOL, USER, ARGS);
    expect(a.redeem(token, TOOL, USER, ARGS)).toBe('ok');
    expect(a.redeem(token, TOOL, USER, ARGS)).toBe('used');
    expect(b.redeem(token, TOOL, USER, ARGS)).toBe('ok');
  });
});

describe('the used set', () => {
  it('forgets a token once it has expired, so the set does not grow without bound', () => {
    const { clock, confirmations } = fresh({ secret: SECRET });
    const first = confirmations.issue(TOOL, USER, ARGS);
    expect(confirmations.redeem(first.token, TOOL, USER, ARGS)).toBe('ok');
    void clock.sleep(CONFIRMATION_TTL_MS + 1);
    // The next issue prunes; the old token is expired, never 'ok' again.
    confirmations.issue(TOOL, USER, ARGS);
    expect(confirmations.redeem(first.token, TOOL, USER, ARGS)).toBe('expired');
    expect(confirmations.usedCount()).toBe(0);
  });

  it('counts a redeemed live token', () => {
    const { confirmations } = fresh();
    const { token } = confirmations.issue(TOOL, USER, ARGS);
    expect(confirmations.usedCount()).toBe(0);
    confirmations.redeem(token, TOOL, USER, ARGS);
    expect(confirmations.usedCount()).toBe(1);
  });
});
