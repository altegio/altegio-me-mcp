import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it } from '@jest/globals';
import {
  DEFAULT_LIVE_LOCATION_ID,
  LIVE_DEFAULT_DURATION_SEC,
  LIVE_DEFAULT_RATE_PER_SEC,
  LIVE_MAX_DURATION_SEC,
  LIVE_MAX_RATE_PER_SEC,
  LIVE_PUBLIC_TARGET,
  UsageError,
  localTarget,
  parseArgs,
} from '../args.js';

// Argument parsing and the guards of the live scenario (T-03-38): no flag, no
// run, no request; a capped duration and rate; no other scenario may name a
// remote target. Nothing here touches the network except the process test,
// which proves that a refused start sends nothing to the target.

function refused(argv: string[]): string {
  try {
    parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) return error.message;
    throw error;
  }
  throw new Error(`expected ${argv.join(' ')} to be refused`);
}

describe('the live scenario guard', () => {
  it('refuses to start without --confirm-announced', () => {
    expect(
      refused(['--scenario=live', '--target=https://svc.example'])
    ).toContain('--confirm-announced');
  });

  it('needs a target', () => {
    expect(refused(['--scenario=live', '--confirm-announced'])).toContain(
      '--target'
    );
  });

  it('accepts a confirmed run and applies the defaults', () => {
    const args = parseArgs([
      '--scenario=live',
      '--target=https://svc.example/me/',
      '--confirm-announced',
    ]);
    expect(args).toMatchObject({
      scenario: 'live',
      target: 'https://svc.example/me',
      durationSec: LIVE_DEFAULT_DURATION_SEC,
      rate: LIVE_DEFAULT_RATE_PER_SEC,
      location: DEFAULT_LIVE_LOCATION_ID,
      confirmAnnounced: true,
      startContainer: null,
    });
    expect(args.notes).toEqual([]);
  });

  it('caps the duration at 180 s and the rate at 1.35 calls a second, and says so', () => {
    const args = parseArgs([
      '--scenario=live',
      '--target=https://svc.example',
      '--confirm-announced',
      '--duration-sec=900',
      '--rate=10',
    ]);
    expect(args.durationSec).toBe(LIVE_MAX_DURATION_SEC);
    expect(args.durationSec).toBe(180);
    expect(args.rate).toBe(LIVE_MAX_RATE_PER_SEC);
    expect(args.rate).toBe(1.35);
    expect(args.notes).toHaveLength(2);
  });

  it('keeps values below the caps as given and takes the location', () => {
    const args = parseArgs([
      '--scenario=live',
      '--target=https://svc.example',
      '--confirm-announced',
      '--duration-sec=60',
      '--rate=0.5',
      '--location=722227',
    ]);
    expect(args).toMatchObject({
      durationSec: 60,
      rate: 0.5,
      location: 722227,
    });
  });

  it('names the documented public route as the live target', () => {
    expect(LIVE_PUBLIC_TARGET).toBe('https://mcp.alteg.io/me');
  });

  it('removes one trailing slash and keeps the path as given', () => {
    const target = (url: string): string | null =>
      parseArgs(['--scenario=live', `--target=${url}`, '--confirm-announced'])
        .target;
    expect(target('https://svc.example/me/')).toBe('https://svc.example/me');
    expect(target('https://mcp.alteg.io/me')).toBe('https://mcp.alteg.io/me');
    expect(target('https://svc.example')).toBe('https://svc.example');
  });

  it.each([
    ['plain http', 'http://svc.example/me', 'https'],
    ['a query', 'https://svc.example/me?x=1', 'query'],
    ['a fragment', 'https://svc.example/me#a', 'fragment'],
    ['a run.app host', 'https://svc-abc.a.run.app', 'run.app'],
  ])('refuses a live target with %s', (_label, url, text) => {
    expect(
      refused(['--scenario=live', `--target=${url}`, '--confirm-announced'])
    ).toContain(text);
  });

  it.each([
    'http://svc.example/me',
    'https://svc.example/me?x=1',
    'https://svc-abc.a.run.app',
  ])('asks for --confirm-announced first, whatever the target (%s)', (url) => {
    expect(refused(['--scenario=live', `--target=${url}`])).toContain(
      '--confirm-announced'
    );
  });

  it('does not start a container', () => {
    expect(
      refused([
        '--scenario=live',
        '--target=https://svc.example',
        '--confirm-announced',
        '--start-container=img:1',
      ])
    ).toContain('--start-container');
  });
});

describe('the local scenarios', () => {
  it.each(['peak', 'edge', 'deadline'])(
    '%s needs a container image',
    (scenario) => {
      expect(refused([`--scenario=${scenario}`])).toContain(
        '--start-container'
      );
    }
  );

  it('accepts a container image and defaults the peak to 180 s', () => {
    expect(
      parseArgs([
        '--scenario=peak',
        '--start-container=altegio-me-mcp:loadtest',
      ])
    ).toMatchObject({
      scenario: 'peak',
      startContainer: 'altegio-me-mcp:loadtest',
      durationSec: 180,
      target: null,
      confirmAnnounced: false,
    });
  });

  it('takes the space-separated flag form', () => {
    expect(
      parseArgs(['--scenario', 'edge', '--start-container', 'img:1']).scenario
    ).toBe('edge');
  });

  it('refuses a remote target', () => {
    expect(
      refused([
        '--scenario=peak',
        '--start-container=img:1',
        '--target=https://svc-abc.a.run.app',
      ])
    ).toContain('loopback');
  });

  it('accepts a loopback target as the published port', () => {
    expect(
      parseArgs([
        '--scenario=peak',
        '--start-container=img:1',
        '--target=http://127.0.0.1:18080',
      ]).target
    ).toBe('http://127.0.0.1:18080');
  });

  it('refuses --confirm-announced, --rate and --location outside live', () => {
    const base = ['--scenario=peak', '--start-container=img:1'];
    expect(refused([...base, '--confirm-announced'])).toContain('live');
    expect(refused([...base, '--rate=2'])).toContain('live');
    expect(refused([...base, '--location=1'])).toContain('live');
  });
});

describe('the sim scenario (tier 1 as a report)', () => {
  it('needs no container and no target', () => {
    expect(parseArgs(['--scenario=sim'])).toMatchObject({
      scenario: 'sim',
      startContainer: null,
      target: null,
      confirmAnnounced: false,
    });
  });

  it('accepts --out', () => {
    expect(parseArgs(['--scenario=sim', '--out=some/dir']).out).toBe(
      'some/dir'
    );
  });

  it.each([
    ['--start-container=img:1'],
    ['--target=http://127.0.0.1:18080'],
    ['--duration-sec=60'],
    ['--location=1'],
    ['--rate=1'],
    ['--confirm-announced'],
  ])('refuses %s and says that sim runs on this machine only', (flag) => {
    expect(refused(['--scenario=sim', flag])).toContain('this machine only');
  });
});

describe('localTarget (IN-55)', () => {
  it('publishes on the given port when no target is named', () => {
    expect(localTarget(null, 4321)).toBe('http://127.0.0.1:4321');
  });

  it('adds the published port to a target that names none', () => {
    expect(localTarget('http://127.0.0.1', 4321)).toBe('http://127.0.0.1:4321');
  });

  it('keeps a target that names its port', () => {
    expect(localTarget('http://localhost:5000', 5000)).toBe(
      'http://localhost:5000'
    );
  });
});

describe('malformed arguments', () => {
  it.each([
    [[], '--scenario is required'],
    [['--scenario=nothing'], 'Unknown scenario'],
    [['--scenario=peak', '--bogus=1'], 'Unknown flag'],
    [['peak'], 'Unexpected argument'],
    [['--scenario'], 'needs a value'],
    [
      ['--scenario=peak', '--start-container=img:1', '--duration-sec=0'],
      'positive',
    ],
    [
      ['--scenario=peak', '--start-container=img:1', '--duration-sec=abc'],
      'positive',
    ],
    [['--scenario=peak', '--start-container=bad image'], 'image reference'],
    [
      ['--scenario=peak', '--start-container=img', '--confirm-announced=yes'],
      'no value',
    ],
  ])('refuses %j', (argv, text) => {
    expect(refused(argv)).toContain(text);
  });
});

describe('npm run loadtest -- --scenario=live without --confirm-announced', () => {
  it('exits non-zero and sends no request to the target', async () => {
    let hits = 0;
    const server = createServer((_req, res) => {
      hits += 1;
      res.end('{}');
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;
    try {
      const run = spawnSync(
        join(process.cwd(), 'node_modules/.bin/tsx'),
        [
          'src/loadtest/run.ts',
          '--scenario=live',
          `--target=http://127.0.0.1:${port}`,
        ],
        { cwd: process.cwd(), encoding: 'utf8', timeout: 60_000 }
      );
      expect(run.status).not.toBe(0);
      expect(run.status).not.toBeNull();
      expect(run.stderr).toContain('--confirm-announced');
      expect(hits).toBe(0);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  }, 90_000);
});
