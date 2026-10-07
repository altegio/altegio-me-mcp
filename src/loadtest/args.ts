// Command-line parsing for `npm run loadtest` (OPS-07, D-03). It lives apart
// from run.ts so the guards on the live scenario can be tested without starting
// a container or sending a request.
//
// The live scenario spends partner-token budget that marketplace confirmations share, so
// the guards are here and are repeated where the requests are sent (live.ts):
// it refuses to start without --confirm-announced, caps its duration and rate,
// and no other scenario may name a remote target or carry the flag (T-03-38).

export const SCENARIOS = ['peak', 'edge', 'deadline', 'live', 'sim'] as const;
export type Scenario = (typeof SCENARIOS)[number];

/** Longest live run, in seconds (plan 03-16 runs a few minutes at most). */
export const LIVE_MAX_DURATION_SEC = 180;
/**
 * Fastest live run, in tool calls a second: 90% of the production gate's 1.5
 * upstream calls a second if every tool call were one upstream call. Four of
 * the five live tools are; business_list_services makes two, so a full cycle
 * is 1.2 upstream calls per tool call (see live.ts).
 */
export const LIVE_MAX_RATE_PER_SEC = 1.35;
/**
 * The one supported live target: the documented public route. The platform
 * proxy maps it to this service's /mcp and signs the request, so the load
 * script needs no proxy key (WR-59).
 */
export const LIVE_PUBLIC_TARGET = 'https://mcp.alteg.io/me';
export const LIVE_DEFAULT_DURATION_SEC = 120;
export const LIVE_DEFAULT_RATE_PER_SEC = 1;
/** The owner's location that the live run reads (read-only routes, no booking). */
export const DEFAULT_LIVE_LOCATION_ID = 726120;
export const PEAK_DEFAULT_DURATION_SEC = 180;

/**
 * The origin the health probe and the requests use for a local container
 * published on loopback port `port`. A target that names no port (IN-55:
 * `http://127.0.0.1`) takes the published port instead of defaulting to port
 * 80; a target that names its port keeps it.
 */
export function localTarget(target: string | null, port: number): string {
  if (target === null) return `http://127.0.0.1:${port}`;
  const url = new URL(target);
  if (url.port === '') url.port = String(port);
  return url.origin;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  '127.0.0.1',
  'localhost',
  '[::1]',
]);

/**
 * The live target rules (WR-59, T-03-56), applied by parseArgs and again by
 * runLive before any request: https only (plain http only for a loopback host,
 * which runLive allows for the end-to-end test and parseArgs does not), no
 * query and no fragment, and no run.app address, which answers 401 to the
 * unsigned requests of a load script. Returns the URL requests are posted to:
 * origin plus path, one trailing slash removed, nothing appended.
 */
export function checkLiveTarget(
  target: string,
  options: { allowLoopbackHttp: boolean }
): string {
  if (!URL.canParse(target)) throw new UsageError('--target is not a URL');
  const url = new URL(target);
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  const plainHttpOk =
    url.protocol === 'http:' && loopback && options.allowLoopbackHttp;
  if (url.protocol !== 'https:' && !plainHttpOk) {
    throw new UsageError(
      `the live target is the public route over https, for example ${LIVE_PUBLIC_TARGET}`
    );
  }
  if (/[?#]/.test(target)) {
    throw new UsageError('the live target takes no query or fragment');
  }
  if (url.hostname.endsWith('.run.app')) {
    throw new UsageError(
      'a run.app address answers 401 to unsigned requests; the live run goes through the public route, where the platform proxy signs'
    );
  }
  return `${url.origin}${url.pathname}`.replace(/\/$/, '');
}

export interface LoadtestArgs {
  scenario: Scenario;
  /** Base URL of the service (live), or the loopback port to publish the container on. */
  target: string | null;
  /** Image to start for the peak, edge and deadline scenarios. */
  startContainer: string | null;
  durationSec: number;
  /** Output directory; null means loadtest-output/<timestamp>/. */
  out: string | null;
  location: number;
  /** Tool calls a second (live only). */
  rate: number;
  confirmAnnounced: boolean;
  /** What was changed on the way in, for example a capped value. */
  notes: string[];
}

export const USAGE = [
  'Usage: npm run loadtest -- --scenario=sim|peak|edge|deadline|live [flags]',
  '  sim: tier 1 on this machine only, no container and no network; optional --out',
  '  peak, edge, deadline: --start-container=IMAGE (local container, mock upstream); optional --target=http://127.0.0.1:PORT, --duration-sec, --out',
  `  live: --target=URL --confirm-announced (the URL is posted to as given; the public route is ${LIVE_PUBLIC_TARGET}); --location (default ${DEFAULT_LIVE_LOCATION_ID}), --duration-sec (default ${LIVE_DEFAULT_DURATION_SEC}, at most ${LIVE_MAX_DURATION_SEC}), --rate (default ${LIVE_DEFAULT_RATE_PER_SEC}, at most ${LIVE_MAX_RATE_PER_SEC}), --out`,
].join('\n');

const VALUE_FLAGS = [
  'scenario',
  'target',
  'start-container',
  'duration-sec',
  'out',
  'location',
  'rate',
] as const;
type ValueFlag = (typeof VALUE_FLAGS)[number];

const IMAGE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/;
function readFlags(argv: readonly string[]): {
  values: Map<ValueFlag, string>;
  confirmAnnounced: boolean;
} {
  const values = new Map<ValueFlag, string>();
  let confirmAnnounced = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith('--')) {
      throw new UsageError(`Unexpected argument "${token}"`);
    }
    const eq = token.indexOf('=');
    const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
    if (name === 'confirm-announced') {
      if (eq !== -1) {
        throw new UsageError('--confirm-announced takes no value');
      }
      confirmAnnounced = true;
      continue;
    }
    if (!(VALUE_FLAGS as readonly string[]).includes(name)) {
      throw new UsageError(`Unknown flag --${name}`);
    }
    let value: string | undefined;
    if (eq === -1) {
      index += 1;
      value = argv[index];
    } else {
      value = token.slice(eq + 1);
    }
    if (value === undefined || value === '') {
      throw new UsageError(`--${name} needs a value`);
    }
    values.set(name as ValueFlag, value);
  }
  return { values, confirmAnnounced };
}

function parsedUrl(text: string, flag: string): URL {
  if (!URL.canParse(text)) throw new UsageError(`--${flag} is not a URL`);
  const url = new URL(text);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UsageError(`--${flag} must be an http or https URL`);
  }
  return url;
}

function positiveInteger(text: string, flag: string): number {
  if (!/^\d+$/.test(text) || Number(text) < 1) {
    throw new UsageError(`--${flag} must be a positive whole number`);
  }
  return Number(text);
}

function positiveNumber(text: string, flag: string): number {
  if (!/^\d+(\.\d+)?$/.test(text) || Number(text) <= 0) {
    throw new UsageError(`--${flag} must be a positive number`);
  }
  return Number(text);
}

/** Parses the flags after `npm run loadtest --`. Throws UsageError on anything wrong. */
export function parseArgs(argv: readonly string[]): LoadtestArgs {
  const { values, confirmAnnounced } = readFlags(argv);
  const scenarioText = values.get('scenario');
  if (scenarioText === undefined)
    throw new UsageError('--scenario is required');
  if (!(SCENARIOS as readonly string[]).includes(scenarioText)) {
    throw new UsageError(`Unknown scenario "${scenarioText}"`);
  }
  const scenario = scenarioText as Scenario;
  const notes: string[] = [];
  const out = values.get('out') ?? null;

  if (scenario === 'sim') {
    // Tier 1 as a report: it needs nothing but a seed and this machine.
    for (const name of values.keys()) {
      if (name !== 'scenario' && name !== 'out') {
        throw new UsageError(
          `--${name} is not for the sim scenario: sim runs on this machine only, with no container and no network`
        );
      }
    }
    if (confirmAnnounced) {
      throw new UsageError(
        '--confirm-announced is not for the sim scenario: sim runs on this machine only, with no container and no network'
      );
    }
    return {
      scenario,
      target: null,
      startContainer: null,
      durationSec: PEAK_DEFAULT_DURATION_SEC,
      out,
      location: DEFAULT_LIVE_LOCATION_ID,
      rate: LIVE_DEFAULT_RATE_PER_SEC,
      confirmAnnounced: false,
      notes,
    };
  }

  const targetText = values.get('target');
  const target =
    targetText === undefined ? null : parsedUrl(targetText, 'target');

  if (scenario === 'live') {
    // The guard of T-03-38: no flag, no run, no request.
    if (!confirmAnnounced) {
      throw new UsageError(
        'The live scenario spends partner-token budget shared with marketplace confirmations (developer 2630): it needs --confirm-announced, and the owner must have announced the run first'
      );
    }
    if (target === null) throw new UsageError('--target is required for live');
    const liveUrl = checkLiveTarget(targetText!, { allowLoopbackHttp: false });
    if (values.has('start-container')) {
      throw new UsageError('--start-container is not for the live scenario');
    }
    let durationSec = values.has('duration-sec')
      ? positiveInteger(values.get('duration-sec')!, 'duration-sec')
      : LIVE_DEFAULT_DURATION_SEC;
    if (durationSec > LIVE_MAX_DURATION_SEC) {
      notes.push(
        `--duration-sec capped from ${durationSec} to ${LIVE_MAX_DURATION_SEC}`
      );
      durationSec = LIVE_MAX_DURATION_SEC;
    }
    let rate = values.has('rate')
      ? positiveNumber(values.get('rate')!, 'rate')
      : LIVE_DEFAULT_RATE_PER_SEC;
    if (rate > LIVE_MAX_RATE_PER_SEC) {
      notes.push(`--rate capped from ${rate} to ${LIVE_MAX_RATE_PER_SEC}`);
      rate = LIVE_MAX_RATE_PER_SEC;
    }
    const location = values.has('location')
      ? positiveInteger(values.get('location')!, 'location')
      : DEFAULT_LIVE_LOCATION_ID;
    return {
      scenario,
      target: liveUrl,
      startContainer: null,
      durationSec,
      out,
      location,
      rate,
      confirmAnnounced: true,
      notes,
    };
  }

  // peak, edge and deadline run only against a local container and the mock.
  if (confirmAnnounced) {
    throw new UsageError(
      '--confirm-announced belongs to the live scenario only'
    );
  }
  if (values.has('location') || values.has('rate')) {
    throw new UsageError(
      '--location and --rate apply to the live scenario only'
    );
  }
  const image = values.get('start-container');
  if (image === undefined) {
    throw new UsageError(
      `--start-container=IMAGE is required for ${scenario}: it runs against a local container and a mock upstream, never a remote service`
    );
  }
  if (!IMAGE_REFERENCE.test(image)) {
    throw new UsageError('--start-container is not a valid image reference');
  }
  if (target !== null && !LOOPBACK_HOSTS.has(target.hostname)) {
    throw new UsageError(
      `--target for ${scenario} must be a loopback address; it names the port the local container is published on`
    );
  }
  return {
    scenario,
    target: target === null ? null : target.origin,
    startContainer: image,
    durationSec: values.has('duration-sec')
      ? positiveInteger(values.get('duration-sec')!, 'duration-sec')
      : PEAK_DEFAULT_DURATION_SEC,
    out,
    location: DEFAULT_LIVE_LOCATION_ID,
    rate: LIVE_DEFAULT_RATE_PER_SEC,
    confirmAnnounced: false,
    notes,
  };
}
