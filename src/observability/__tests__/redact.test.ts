import { describe, expect, it } from '@jest/globals';
import { MIN_SECRET_LENGTH, REDACTED, scrubSecrets } from '../redact.js';

const SECRET = 'canary-secret-token-0001';

describe('scrubSecrets', () => {
  it('replaces a secret in a string', () => {
    expect(scrubSecrets(`x ${SECRET} y`, [SECRET])).toBe('x [redacted] y');
    expect(REDACTED).toBe('[redacted]');
  });

  it('replaces every occurrence', () => {
    expect(scrubSecrets(`${SECRET}/${SECRET}`, [SECRET])).toBe(
      '[redacted]/[redacted]'
    );
  });

  it('redacts the URL-encoded form of a secret containing / or +', () => {
    const secret = 'ab/cd+ef-ghij-1234';
    const encoded = encodeURIComponent(secret);
    expect(encoded).not.toBe(secret);
    expect(scrubSecrets(`GET ?token=${encoded}`, [secret])).toBe(
      'GET ?token=[redacted]'
    );
    expect(scrubSecrets(`raw ${secret}`, [secret])).toBe('raw [redacted]');
  });

  it('scrubs nested arrays, object values and object keys without mutating the input', () => {
    const input = {
      [`key-${SECRET}`]: 'value',
      list: ['a', `b ${SECRET}`, { deep: `${SECRET}!` }],
      text: SECRET,
    };
    const snapshot = JSON.stringify(input);
    const output = scrubSecrets(input, [SECRET]);
    expect(output).toEqual({
      'key-[redacted]': 'value',
      list: ['a', 'b [redacted]', { deep: '[redacted]!' }],
      text: '[redacted]',
    });
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(output).not.toBe(input);
  });

  it('ignores empty secrets and secrets shorter than the minimum length', () => {
    expect(MIN_SECRET_LENGTH).toBe(8);
    const text = 'abc abc  abcdefg';
    expect(scrubSecrets(text, ['', 'abc', 'abcdefg'])).toBe(text);
  });

  it('passes numbers, booleans and null through unchanged', () => {
    expect(scrubSecrets(42, [SECRET])).toBe(42);
    expect(scrubSecrets(true, [SECRET])).toBe(true);
    expect(scrubSecrets(null, [SECRET])).toBeNull();
  });

  it('survives cyclic structures', () => {
    const node: { name: string; self?: unknown } = { name: SECRET };
    node.self = node;
    const output = scrubSecrets(node, [SECRET]);
    expect(output.name).toBe('[redacted]');
    expect(output.self).toBe(output);
  });
});
