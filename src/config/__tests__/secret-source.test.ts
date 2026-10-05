import { describe, expect, it } from '@jest/globals';
import pino from 'pino';
import { createFakeClock } from '../../booking/__tests__/helpers/fake-clock.js';
import { signProxyRequest } from '../../__tests__/helpers/sign-request.js';
import { scrubSecrets } from '../../observability/redact.js';
import {
  PROXY_AUTH_HEADER,
  parseProxyKeys,
  verifyProxyRequest,
} from '../../security/proxy-auth.js';
import {
  SECRET_TTL_MS,
  createFileSecretSource,
  createStaticSecretSource,
  knownValues,
  type SecretSource,
} from '../secret-source.js';

// All time comes from the fake clock and all file reads from an injected
// readFile: no Jest fake timers, no real file, no real waiting (OPS-04).

const OLD_KEY = 'old-proxy-key-0123456789abcdef0123456789';
const NEW_KEY = 'new-proxy-key-fedcba9876543210fedcba9876';
const PATH = '/secrets/proxy-key/key';
const SETTING = 'MCP_PROXY_BACKEND_KEY_FILE';

// Lets a started background re-read finish: it resolves on microtasks only.
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

interface Harness {
  clock: ReturnType<typeof createFakeClock>;
  /** What the "file" holds; a throw simulates a failed read. */
  file: { payload: string; failing: boolean };
  reads: () => number;
  logs: Record<string, unknown>[];
  source: SecretSource;
  /** Moves time forward, makes one request-path call and lets its re-read finish. */
  advance: (ms: number) => Promise<void>;
}

async function harness(initial: string): Promise<Harness> {
  const clock = createFakeClock();
  const file = { payload: initial, failing: false };
  let reads = 0;
  const logs: Record<string, unknown>[] = [];
  const logger = pino(
    { base: null, timestamp: false, messageKey: 'message', level: 'info' },
    {
      write(chunk: string): void {
        logs.push(JSON.parse(chunk) as Record<string, unknown>);
      },
    }
  );
  const source = await createFileSecretSource({
    path: PATH,
    setting: SETTING,
    now: clock.now,
    logger,
    readFile: (path: string): Promise<string> => {
      expect(path).toBe(PATH);
      reads += 1;
      return file.failing
        ? Promise.reject(new Error('EIO'))
        : Promise.resolve(file.payload);
    },
  });
  return {
    clock,
    file,
    reads: () => reads,
    logs,
    source,
    advance: async (ms: number): Promise<void> => {
      await clock.sleep(ms);
      source.current();
      await flush();
    },
  };
}

function accepts(source: SecretSource, key: string, nowMs: number): boolean {
  const path = '/mcp';
  const signature = signProxyRequest({ key, method: 'POST', path, nowMs });
  return verifyProxyRequest({
    keys: parseProxyKeys(source.current()),
    method: 'POST',
    path,
    headers: { [PROXY_AUTH_HEADER]: signature },
    nowMs,
  }).ok;
}

describe('createFileSecretSource: the initial read', () => {
  it('returns the file content without its trailing newline and whitespace', async () => {
    const h = await harness(`  ${OLD_KEY}\r\n`);
    expect(h.source.current()).toBe(OLD_KEY);
    expect(h.reads()).toBe(1);
  });

  it('refuses an empty file and names the setting, not a value', async () => {
    await expect(
      createFileSecretSource({
        path: PATH,
        setting: SETTING,
        readFile: () => Promise.resolve('\n'),
      })
    ).rejects.toThrow(`${SETTING} points to an empty file`);
  });

  it('lets a failing first read reach the caller', async () => {
    await expect(
      createFileSecretSource({
        path: PATH,
        setting: SETTING,
        readFile: () => Promise.reject(new Error('ENOENT')),
      })
    ).rejects.toThrow('ENOENT');
  });
});

describe('createFileSecretSource: the 60 s lazy re-read', () => {
  it('uses a 60 second TTL', () => {
    expect(SECRET_TTL_MS).toBe(60_000);
  });

  it('keeps the old value for 59.999 s and reads the file again only on the call after 60 s', async () => {
    const h = await harness(OLD_KEY);
    h.file.payload = NEW_KEY;

    await h.advance(SECRET_TTL_MS - 1);
    expect(h.source.current()).toBe(OLD_KEY);
    expect(h.reads()).toBe(1);

    // The call that notices the age still answers with the cached value and
    // starts the re-read; the value is visible to the call after it.
    await h.clock.sleep(1);
    expect(h.source.current()).toBe(OLD_KEY);
    await flush();
    expect(h.reads()).toBe(2);
    expect(h.source.current()).toBe(NEW_KEY);
  });

  it('starts nothing by itself: without a call no read happens however long it takes', async () => {
    const h = await harness(OLD_KEY);
    h.file.payload = NEW_KEY;
    await h.clock.sleep(10 * SECRET_TTL_MS);
    await flush();
    expect(h.reads()).toBe(1);
  });

  it('runs one re-read for any number of calls while it is in flight', async () => {
    const h = await harness(OLD_KEY);
    await h.clock.sleep(SECRET_TTL_MS);
    for (let call = 0; call < 20; call += 1) h.source.current();
    await flush();
    expect(h.reads()).toBe(2);
  });

  it('waits another full TTL after a re-read before the next one', async () => {
    const h = await harness(OLD_KEY);
    await h.advance(SECRET_TTL_MS);
    expect(h.reads()).toBe(2);
    await h.advance(SECRET_TTL_MS - 1);
    expect(h.reads()).toBe(2);
    await h.advance(1);
    expect(h.reads()).toBe(3);
  });

  it('keeps the last good value when the re-read fails, and recovers on the next TTL', async () => {
    const h = await harness(OLD_KEY);
    h.file.failing = true;
    await h.advance(SECRET_TTL_MS);
    expect(h.reads()).toBe(2);
    expect(h.source.current()).toBe(OLD_KEY);

    h.file.failing = false;
    h.file.payload = NEW_KEY;
    await h.advance(SECRET_TTL_MS);
    expect(h.source.current()).toBe(NEW_KEY);
  });

  it('keeps the last good value when the re-read finds an empty file', async () => {
    const h = await harness(OLD_KEY);
    h.file.payload = '\n';
    await h.advance(SECRET_TTL_MS);
    expect(h.source.current()).toBe(OLD_KEY);
    expect(h.source.known()).toEqual([OLD_KEY]);
  });

  it('logs a failed re-read at most once a minute, naming the setting and no value', async () => {
    const h = await harness(OLD_KEY);
    h.file.failing = true;
    await h.advance(SECRET_TTL_MS);
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toMatchObject({
      event: 'secret_refresh_failed',
      setting: SETTING,
    });
    expect(JSON.stringify(h.logs)).not.toContain(OLD_KEY);
    expect(JSON.stringify(h.logs)).not.toContain('EIO');

    await h.advance(SECRET_TTL_MS);
    expect(h.logs).toHaveLength(2);
  });
});

describe('createFileSecretSource: known() and refresh()', () => {
  it('holds one value before a rotation and the current plus the previous one after it', async () => {
    const h = await harness(OLD_KEY);
    expect(h.source.known()).toEqual([OLD_KEY]);
    h.file.payload = NEW_KEY;
    await h.advance(SECRET_TTL_MS);
    expect(h.source.known()).toEqual([NEW_KEY, OLD_KEY]);
  });

  it('re-reads on demand even before the lazy TTL, and resolves true when the value changed (OPS-04)', async () => {
    const h = await harness(OLD_KEY);
    h.file.payload = NEW_KEY;
    await h.clock.sleep(SECRET_TTL_MS - 1);
    await expect(h.source.refresh()).resolves.toBe(true);
    expect(h.reads()).toBe(2);
    expect(h.source.current()).toBe(NEW_KEY);
  });

  it('is not used up by a lazy re-read: a forced one still runs right after it', async () => {
    const h = await harness(OLD_KEY);
    await h.advance(SECRET_TTL_MS);
    expect(h.reads()).toBe(2);
    h.file.payload = NEW_KEY;
    await expect(h.source.refresh()).resolves.toBe(true);
    expect(h.reads()).toBe(3);
  });

  it('forces at most one re-read per TTL, counted from the last forced one', async () => {
    const h = await harness(OLD_KEY);
    await expect(h.source.refresh()).resolves.toBe(false);
    expect(h.reads()).toBe(2);
    h.file.payload = NEW_KEY;
    await h.clock.sleep(SECRET_TTL_MS - 1);
    await expect(h.source.refresh()).resolves.toBe(false);
    expect(h.reads()).toBe(2);
    await h.clock.sleep(1);
    await expect(h.source.refresh()).resolves.toBe(true);
    expect(h.reads()).toBe(3);
  });

  it('reads once after the TTL, resolves true when the value changed and false when not', async () => {
    const h = await harness(OLD_KEY);
    h.file.payload = NEW_KEY;
    await h.clock.sleep(SECRET_TTL_MS);
    await expect(h.source.refresh()).resolves.toBe(true);
    expect(h.source.current()).toBe(NEW_KEY);

    await h.clock.sleep(SECRET_TTL_MS);
    await expect(h.source.refresh()).resolves.toBe(false);
    expect(h.reads()).toBe(3);
  });

  it('re-reads at most once per TTL however often it is called', async () => {
    const h = await harness(OLD_KEY);
    await h.clock.sleep(SECRET_TTL_MS);
    const results = await Promise.all([
      h.source.refresh(),
      h.source.refresh(),
      h.source.refresh(),
    ]);
    expect(results).toEqual([false, false, false]);
    expect(h.reads()).toBe(2);
    await h.source.refresh();
    expect(h.reads()).toBe(2);
  });
});

describe('createStaticSecretSource', () => {
  it('serves the value and never changes', async () => {
    const source = createStaticSecretSource(OLD_KEY);
    expect(source.current()).toBe(OLD_KEY);
    expect(source.known()).toEqual([OLD_KEY]);
    await expect(source.refresh()).resolves.toBe(false);
  });
});

// OPS-03 edge: a key rotation while requests keep arriving. The platform adds
// the new key next to the old one, then drops the old one; every request signed
// with a key that is in the file must verify, with no restart in between.
describe('key rotation through the file (edge OPS-03, concurrency)', () => {
  it('verifies requests signed with either key during old,new and new,old, and refuses the old key 60 s after it is dropped', async () => {
    const h = await harness(OLD_KEY);
    const at = (): number => h.clock.now();

    expect(accepts(h.source, OLD_KEY, at())).toBe(true);
    expect(accepts(h.source, NEW_KEY, at())).toBe(false);

    h.file.payload = `${OLD_KEY},${NEW_KEY}`;
    await h.advance(SECRET_TTL_MS);
    expect(accepts(h.source, OLD_KEY, at())).toBe(true);
    expect(accepts(h.source, NEW_KEY, at())).toBe(true);

    h.file.payload = `${NEW_KEY},${OLD_KEY}`;
    await h.advance(SECRET_TTL_MS);
    expect(accepts(h.source, OLD_KEY, at())).toBe(true);
    expect(accepts(h.source, NEW_KEY, at())).toBe(true);

    h.file.payload = NEW_KEY;
    // Until 60 s have passed the previous payload still applies.
    await h.advance(SECRET_TTL_MS - 1);
    expect(accepts(h.source, OLD_KEY, at())).toBe(true);
    await h.advance(1);
    expect(accepts(h.source, NEW_KEY, at())).toBe(true);
    expect(accepts(h.source, OLD_KEY, at())).toBe(false);
  });

  it('keeps verifying with the last good keys while the file cannot be read', async () => {
    const h = await harness(`${OLD_KEY},${NEW_KEY}`);
    h.file.failing = true;
    await h.advance(SECRET_TTL_MS);
    await h.advance(SECRET_TTL_MS);
    expect(accepts(h.source, OLD_KEY, h.clock.now())).toBe(true);
    expect(accepts(h.source, NEW_KEY, h.clock.now())).toBe(true);
  });
});

// Plan 03-18 left known() as whole payloads: for a proxy key list 'old,new' the
// scrub list would hold the comma string, never the single keys, so a rotated
// out key quoted on its own was not redacted. knownValues splits them.
describe('knownValues: individual values for the scrub list (SEC-03)', () => {
  it('splits the current and the previous payload into single keys', async () => {
    const h = await harness(`${OLD_KEY},${NEW_KEY}`);
    h.file.payload = NEW_KEY;
    await h.advance(SECRET_TTL_MS);

    const values = knownValues(h.source, parseProxyKeys);

    expect([...values].sort()).toEqual([NEW_KEY, OLD_KEY].sort());
    expect(h.source.known()).toEqual([NEW_KEY, `${OLD_KEY},${NEW_KEY}`]);
  });

  it('lets the scrubber redact a rotated-out key that is quoted on its own', async () => {
    const h = await harness(`${OLD_KEY},${NEW_KEY}`);
    h.file.payload = NEW_KEY;
    await h.advance(SECRET_TTL_MS);

    const text = `seen ${OLD_KEY} and ${NEW_KEY}`;
    expect(scrubSecrets(text, h.source.known())).toContain(OLD_KEY);
    expect(scrubSecrets(text, knownValues(h.source, parseProxyKeys))).toBe(
      'seen [redacted] and [redacted]'
    );
  });

  it('returns each value once and treats a payload as one value without a splitter', async () => {
    const source = createStaticSecretSource(OLD_KEY);
    expect(knownValues(source)).toEqual([OLD_KEY]);
    const h = await harness(OLD_KEY);
    h.file.payload = `${OLD_KEY}\n`;
    await h.advance(SECRET_TTL_MS);
    expect(knownValues(h.source, parseProxyKeys)).toEqual([OLD_KEY]);
  });
});
