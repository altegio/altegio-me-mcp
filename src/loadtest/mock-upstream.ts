import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

// STUB for the RED commit of plan 03-12; replaced in the GREEN commit.
export interface UpstreamStats {
  max1s: number;
  max60s: number;
  served429: number;
  starts: number;
  aborted: number;
}

export function slidingMax(
  _times: readonly number[],
  _windowMs: number
): number {
  return 0;
}

export interface MockUpstream {
  url: string;
  port: number;
  stats(): UpstreamStats;
  close(): Promise<void>;
}

export async function startMockUpstream(opts: {
  port: number;
  host?: string;
  now?: () => number;
  stallMs?: Partial<Record<string, number>>;
}): Promise<MockUpstream> {
  const server = createServer((_req, res) => {
    res.statusCode = 501;
    res.end();
  });
  await new Promise<void>((resolve) => {
    server.listen(opts.port, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/api/v1`,
    port,
    stats: () => ({ max1s: 0, max60s: 0, served429: 0, starts: 0, aborted: 0 }),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
