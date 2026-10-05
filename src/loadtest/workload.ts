import { TOOL_MIX, type LoadToolName } from './profile.js';

// What the simulated and the local-container clients send: a seeded random
// source, Poisson arrivals, a tool picked by the mix, and arguments that the
// synthetic fixtures behind the mock upstream answer.

/** Mulberry32: small, seeded, and good enough to spread arrivals. */
export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Gap to the next arrival of a Poisson process with `ratePerSec` events a second. */
export function exponentialGapMs(
  rng: () => number,
  ratePerSec: number
): number {
  return (-Math.log(1 - rng()) / ratePerSec) * 1000;
}

const TOOL_NAMES = Object.keys(TOOL_MIX) as LoadToolName[];

/** A tool picked with the probabilities of TOOL_MIX. */
export function pickTool(rng: () => number): LoadToolName {
  let draw = rng();
  for (const name of TOOL_NAMES) {
    draw -= TOOL_MIX[name];
    if (draw < 0) return name;
  }
  return TOOL_NAMES[TOOL_NAMES.length - 1]!;
}

// The synthetic business behind src/booking/__tests__/fixtures.
export const FIXTURE_LOCATION_ID = 722227;
export const FIXTURE_SERVICE_ID = 10303530;
export const FIXTURE_TEAM_MEMBER_ID = 2098145;
export const FIXTURE_DATE = '2026-10-05';
export const FIXTURE_SLOT_DATETIME = '2026-10-05T14:00:00+03:00';

/** Arguments for one tool call against the fixture business; book_check names a team member (worst case). */
export function fixtureArguments(tool: LoadToolName): Record<string, unknown> {
  const location_id = FIXTURE_LOCATION_ID;
  const service_ids = [FIXTURE_SERVICE_ID];
  const team_member_id = FIXTURE_TEAM_MEMBER_ID;
  switch (tool) {
    case 'business_get':
    case 'business_list_services':
    case 'business_list_team_members':
      return { location_id };
    case 'business_list_dates':
      return { location_id, service_ids, team_member_id };
    case 'business_list_time_slots':
      return { location_id, service_ids, team_member_id, date: FIXTURE_DATE };
    case 'book_check':
      return {
        location_id,
        service_ids,
        team_member_id,
        datetime: FIXTURE_SLOT_DATETIME,
      };
  }
}

/** Addresses of the shared claude.ai egress pool (160.79.104.0/21). */
export const POOL_ADDRESS_COUNT = 30;

export function poolAddress(index: number): string {
  // 160.79.104.1 to 160.79.104.30, all inside 160.79.104.0/21.
  return `160.79.104.${(index % POOL_ADDRESS_COUNT) + 1}`;
}

/** Three callers outside the pool (documentation range TEST-NET-3). */
export const SINGLE_ADDRESSES: readonly string[] = Object.freeze([
  '203.0.113.11',
  '203.0.113.12',
  '203.0.113.13',
]);

/** One of the 33 client addresses: 30 in the pool, 3 single. */
export function pickClientAddress(rng: () => number): string {
  const index = Math.floor(
    rng() * (POOL_ADDRESS_COUNT + SINGLE_ADDRESSES.length)
  );
  return index < POOL_ADDRESS_COUNT
    ? poolAddress(index)
    : SINGLE_ADDRESSES[index - POOL_ADDRESS_COUNT]!;
}
