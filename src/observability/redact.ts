// Exact-value secret scrubber. It runs on every tool result before the result
// leaves the process, so a secret that a tool echoes (for example inside an
// upstream error text) never reaches the client (SEC-03, threat T-1-09).
//
// Each secret is matched in the forms it is commonly echoed in: raw,
// URL-encoded (encodeURIComponent), JSON-escaped (the body of
// JSON.stringify, for a secret with a quote or backslash) and base64, padded
// and unpadded (an HTTP Basic header or a token blob).

export const MIN_SECRET_LENGTH = 8;
export const REDACTED = '[redacted]';

function buildNeedles(secrets: readonly string[]): string[] {
  const needles = new Set<string>();
  for (const secret of secrets) {
    // A short or empty secret would redact unrelated text, so it is ignored.
    if (secret.length < MIN_SECRET_LENGTH) continue;
    needles.add(secret);
    needles.add(encodeURIComponent(secret));
    needles.add(JSON.stringify(secret).slice(1, -1));
    const base64 = Buffer.from(secret, 'utf8').toString('base64');
    needles.add(base64);
    needles.add(base64.replace(/=+$/, ''));
  }
  // Longest first, so a needle that contains another is replaced as a whole.
  return [...needles].sort((a, b) => b.length - a.length);
}

function scrubString(text: string, needles: readonly string[]): string {
  let result = text;
  for (const needle of needles) {
    result = result.replaceAll(needle, REDACTED);
  }
  return result;
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function scrub(
  value: unknown,
  needles: readonly string[],
  seen: WeakMap<object, unknown>
): unknown {
  if (typeof value === 'string') return scrubString(value, needles);
  if (typeof value !== 'object' || value === null) return value;

  const known = seen.get(value);
  if (known !== undefined) return known;

  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value as unknown[]) {
      copy.push(scrub(item, needles, seen));
    }
    return copy;
  }

  if (isPlainObject(value)) {
    const copy: Record<string, unknown> = {};
    seen.set(value, copy);
    for (const [key, item] of Object.entries(value)) {
      // defineProperty keeps a key such as "__proto__" an ordinary own property.
      Object.defineProperty(copy, scrubString(key, needles), {
        value: scrub(item, needles, seen),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return copy;
  }

  return value;
}

export function scrubSecrets<T>(value: T, secrets: readonly string[]): T {
  const needles = buildNeedles(secrets);
  if (needles.length === 0) return value;
  return scrub(value, needles, new WeakMap()) as T;
}
