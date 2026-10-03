import { UpstreamError } from './errors.js';

// One HTTP exchange with the Altegio API: headers, URL building, timeout,
// envelope parsing and status mapping. Matches Altegio.Pro MCP (D-10): the
// v2 Accept header and the partner token as a Bearer credential. The token
// travels only in the Authorization header, never in the URL.

export const ALTEGIO_ACCEPT = 'application/vnd.api.v2+json';
export const UPSTREAM_TIMEOUT_MS = 10_000;

/** Admission control for upstream calls; the throttle implements it. */
export interface GateLike {
  run<T>(start: () => Promise<T>): Promise<T>;
  pauseUntil(untilMs: number): void;
}

/** Runs every call at once and ignores pauses. */
export const PASS_THROUGH_GATE: GateLike = Object.freeze({
  run<T>(start: () => Promise<T>): Promise<T> {
    return start();
  },
  pauseUntil(): void {
    // Nothing to pause.
  },
});

export interface BookingHttpOptions {
  base: string;
  token: string;
  fetch?: typeof fetch;
  gate?: GateLike;
  timeoutMs?: number;
}

export interface UpstreamCallSpec {
  method: 'GET' | 'POST';
  /** Route template, for example '/company/{location_id}'. */
  route: string;
  /** Concrete path built from integers, for example '/company/722227'. */
  path: string;
  query?: Readonly<Record<string, string | number | undefined>>;
  /** Sent as repeated service_ids[] entries, in this order. */
  serviceIds?: readonly number[];
  /** JSON body, POST only. */
  body?: unknown;
}

export interface UpstreamReply {
  status: number;
  /** envelope.data, or null for an empty 2xx body. */
  data: unknown;
}

export class BookingHttp {
  private readonly base: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly gate: GateLike;
  private readonly timeoutMs: number;

  constructor(options: BookingHttpOptions) {
    this.base = options.base.endsWith('/')
      ? options.base.slice(0, -1)
      : options.base;
    this.token = options.token;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.gate = options.gate ?? PASS_THROUGH_GATE;
    this.timeoutMs = options.timeoutMs ?? UPSTREAM_TIMEOUT_MS;
  }

  async send(call: UpstreamCallSpec): Promise<UpstreamReply> {
    const url = new URL(`${this.base}${call.path}`);
    for (const [key, value] of Object.entries(call.query ?? {})) {
      if (value !== undefined) url.searchParams.append(key, String(value));
    }
    for (const id of call.serviceIds ?? []) {
      url.searchParams.append('service_ids[]', String(id));
    }

    const hasBody = call.body !== undefined;
    const headers: Record<string, string> = {
      Accept: ALTEGIO_ACCEPT,
      Authorization: `Bearer ${this.token}`,
    };
    if (hasBody) headers['Content-Type'] = 'application/json';

    const response = await this.gate.run(() =>
      this.fetchImpl(url, {
        method: call.method,
        headers,
        body: hasBody ? JSON.stringify(call.body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    );

    const text = await response.text();
    if (response.status >= 200 && response.status < 300) {
      if (text === '') return { status: response.status, data: null };
      const envelope = JSON.parse(text) as { data?: unknown };
      return { status: response.status, data: envelope.data ?? null };
    }
    throw new UpstreamError(
      response.status === 404 ? 'not_found' : 'unavailable',
      call.route,
      { status: response.status }
    );
  }
}
