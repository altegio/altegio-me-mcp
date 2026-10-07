import { describe, expect, it } from '@jest/globals';
import type { PartnerTokenVerdict } from '../../booking/client.js';
import {
  PARTNER_TOKEN_INVALID_TTL_MS,
  PARTNER_TOKEN_VALID_TTL_MS,
  createPartnerTokenValidator,
  partnerIdOf,
} from '../partner-token.js';

// ADR 0004 D2: Altegio decides; verdicts are cached by hash, failures never.

const GOOD = 'good-partner-token-0001';
const BAD = 'bad-partner-token-0001';

function setup(
  verdicts: Record<string, PartnerTokenVerdict> = { [GOOD]: 'valid' },
  extra: { maxEntries?: number } = {}
) {
  let clock = 1_000_000;
  const probed: string[] = [];
  const validator = createPartnerTokenValidator({
    probe: (token) => {
      probed.push(token);
      return Promise.resolve(verdicts[token] ?? 'invalid');
    },
    now: () => clock,
    ...extra,
  });
  return {
    validator,
    probed,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('createPartnerTokenValidator', () => {
  it('probes once and serves a valid verdict from the cache until it expires', async () => {
    const { validator, probed, advance } = setup();
    expect(await validator.validate(GOOD)).toBe('valid');
    advance(PARTNER_TOKEN_VALID_TTL_MS - 1);
    expect(await validator.validate(GOOD)).toBe('valid');
    expect(probed).toEqual([GOOD]);
    advance(1);
    expect(await validator.validate(GOOD)).toBe('valid');
    expect(probed).toEqual([GOOD, GOOD]);
  });

  it('caches an invalid verdict for a shorter time', async () => {
    const { validator, probed, advance } = setup();
    expect(await validator.validate(BAD)).toBe('invalid');
    advance(PARTNER_TOKEN_INVALID_TTL_MS - 1);
    expect(await validator.validate(BAD)).toBe('invalid');
    expect(probed).toEqual([BAD]);
    advance(1);
    await validator.validate(BAD);
    expect(probed).toEqual([BAD, BAD]);
  });

  it('never caches unavailable', async () => {
    const { validator, probed } = setup({ [GOOD]: 'unavailable' });
    expect(await validator.validate(GOOD)).toBe('unavailable');
    expect(await validator.validate(GOOD)).toBe('unavailable');
    expect(probed).toEqual([GOOD, GOOD]);
  });

  it('turns a probe that throws into unavailable', async () => {
    const validator = createPartnerTokenValidator({
      probe: () => Promise.reject(new Error('network down')),
    });
    expect(await validator.validate(GOOD)).toBe('unavailable');
  });

  it('shares one probe between concurrent checks of a token', async () => {
    let release: (verdict: PartnerTokenVerdict) => void = () => undefined;
    let probes = 0;
    const validator = createPartnerTokenValidator({
      probe: () => {
        probes += 1;
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    });
    const first = validator.validate(GOOD);
    const second = validator.validate(GOOD);
    release('valid');
    expect(await Promise.all([first, second])).toEqual(['valid', 'valid']);
    expect(probes).toBe(1);
  });

  it.each([
    ['too short', 'short'],
    ['a space inside', 'partner token 0001'],
    ['a control character', 'partner-token\u00000001'],
    ['too long', 'x'.repeat(513)],
  ])('refuses %s without a probe', async (_label, token) => {
    const { validator, probed } = setup();
    expect(await validator.validate(token)).toBe('invalid');
    expect(probed).toEqual([]);
  });

  it('evicts the oldest entry beyond the cache bound', async () => {
    const { validator, probed } = setup(
      { 'token-one-0001': 'valid', 'token-two-0001': 'valid' },
      { maxEntries: 1 }
    );
    await validator.validate('token-one-0001');
    await validator.validate('token-two-0001');
    await validator.validate('token-one-0001');
    expect(probed).toEqual([
      'token-one-0001',
      'token-two-0001',
      'token-one-0001',
    ]);
  });
});

describe('partnerIdOf', () => {
  it('is the first 16 hex digits of the SHA-256, as the proxy token_hash', () => {
    // sha256("abc") = ba7816bf8f01cfea414140de5dae2223...
    expect(partnerIdOf('abc')).toBe('ba7816bf8f01cfea');
    expect(partnerIdOf(GOOD)).toMatch(/^[0-9a-f]{16}$/);
  });
});
