// Real-browser check of the booking widget deep link (BOOK-04). Local only:
// it is not part of the server, CI or the image.
//
//   npm --prefix scripts/browser-check run cases            list the cases
//   npm --prefix scripts/browser-check start -- --print-links  links only
//   npm --prefix scripts/browser-check start                run every case
//
// It finds free slots with the repo's own BookingClient, verifies each one
// with the book_check validation route, builds the link with the shipped
// buildBookingLink, then opens it headed in the installed Google Chrome and
// records what the widget shows, with one screenshot per case. It only reads
// pages: it never interacts with the widget, so no booking can result.
// Text matching only; the widget DOM is not a contract (02-RESEARCH A9).
//
// BROWSER_CHECK_MIN_LEAD_HOURS (default 0) makes discovery skip slots that
// start sooner than that many hours after it starts. After the cases, the
// single-named link is loaded BROWSER_CHECK_REPEAT_LOADS more times
// (default 3) to count how often the widget applies the pre-selection.

import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import {
  BookingClient,
  type BusinessCard,
  type TimeSlot,
} from '../../src/booking/client.js';
import {
  buildBookingLink,
  formatUtcOffset,
  parseSlotDatetime,
  plainBookingLink,
  type BookingLink,
  type BookingLinkInput,
} from '../../src/booking/deep-link.js';
import { UpstreamError } from '../../src/booking/errors.js';
import { RequestGate } from '../../src/booking/gate.js';

const API_BASE = 'https://api.alteg.io/api/v1';
const SETTLE_TIMEOUT_MS = 30_000;
const NAVIGATION_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 1_000;
const MAX_TEAM_MEMBERS = 5;
const MAX_SERVICE_GROUPS = 5;
const MAX_DATES = 3;
const MAX_CHECKS_PER_DATE = 3;
const DEFAULT_REPEAT_LOADS = 3;
const HOUR_MS = 3_600_000;
const PACKAGE_DIR = import.meta.dirname;

export const CASES = [
  {
    id: 'single-named',
    description:
      'One service and a named team member: service, team member and time pre-selected (BOOK-04 core)',
  },
  {
    id: 'multi-services',
    description:
      'Two services of one team member with a common free slot, both pre-selected',
  },
  {
    id: 'any-member',
    description: 'Any team member (m-1): service and time pre-selected',
  },
  {
    id: 'plain-fallback',
    description:
      'Plain booking-form link (BOOK-05): the form opens with nothing pre-selected',
  },
  {
    id: 'taken-slot',
    description:
      'A time one minute after a free slot (not a free slot): what the client sees; no time selected',
  },
  {
    id: 'menu-and-steps',
    description:
      'Time shown in the menu-style and the step-by-step form (other style needs BROWSER_CHECK_STEPS_LOCATION_ID)',
  },
  {
    id: 'personal-or-group',
    description:
      'Whether the form first asks to choose between a personal booking and a group event',
  },
  {
    id: 'half-hour-zone',
    description:
      'Half-hour time zone: does the widget keep the time (needs BROWSER_CHECK_HALF_HOUR_LOCATION_ID, Pitfall 4)',
  },
  {
    id: 'dst-boundary',
    description:
      'A slot after the next daylight-saving change, linked with its own offset: does the time survive (A6)',
  },
  {
    id: 'any-member-disabled',
    description:
      'm-1 where any team member is disabled (needs BROWSER_CHECK_ANY_DISABLED_LOCATION_ID, A7)',
  },
  {
    id: 'slug-host',
    description:
      'A booking form on a {slug}.altegio.me host, when the business has one',
  },
  {
    id: 'group-event-order',
    description:
      'Group-event token order (act before aid): not applicable in v1, group events are deferred (EXT-01)',
  },
] as const;

type CaseId = (typeof CASES)[number]['id'];
type Status = 'pass' | 'fail' | 'not-run' | 'blocked';
/** preselected and booking_form come from the shipped builder; probe bypasses one of its guards on purpose. */
type LinkKind = 'preselected' | 'booking_form' | 'probe';

interface PageView {
  text: string;
  url: string;
}

interface Expectation {
  label: string;
  holds: (view: PageView) => boolean;
}

interface PlannedCase {
  id: CaseId;
  link: string | null;
  linkKind: LinkKind | null;
  expectations: Expectation[];
  /** Facts from discovery, copied into `seen`. */
  notes: string[];
  /** Why the case is not run; null when it runs. */
  notRun: string | null;
}

interface CaseResult {
  id: CaseId;
  link: string | null;
  link_kind: LinkKind | null;
  expected: string[];
  seen: string[];
  status: Status;
  reason: string | null;
  screenshot: string | null;
}

/** One extra page load of the same link (repeated-load tally). */
interface RepeatLoad {
  load: number;
  at: string;
  final_url: string | null;
  /** Expectation label -> held on this load. */
  checks: Record<string, boolean>;
  time_range: string | null;
  all_held: boolean;
  screenshot: string | null;
  error: string | null;
}

interface RepeatResult {
  case: CaseId;
  link: string | null;
  loads: RepeatLoad[];
  /** Expectation label -> number of loads on which it held. */
  tally: Record<string, number>;
  all_held: number;
  /** Why the loads did not run; null when they ran. */
  reason: string | null;
}

interface Results {
  run_at: string;
  chrome_version: string;
  location_id: number;
  form_id: number | null;
  /** The business card's time zone and current offset, as the API reported them. */
  time_zone: string | null;
  utc_offset_hours: number | null;
  discovered_at: string;
  min_lead_hours: number;
  cases: CaseResult[];
  repeat_loads: RepeatResult;
}

interface ChosenService {
  id: number;
  title: string;
}

/** Discovery ignores slots that start before `earliest` (BROWSER_CHECK_MIN_LEAD_HOURS). */
interface LeadWindow {
  /** When discovery started, ms since the epoch. */
  startedAt: number;
  minLeadHours: number;
  /** startedAt plus the minimum lead, ms since the epoch. */
  earliest: number;
}

/** A verified free slot: book_check returned 201 for exactly this selection. */
interface Selection {
  card: BusinessCard;
  lead: LeadWindow;
  /** 0 = any team member. */
  teamMemberId: number;
  teamMemberName: string | null;
  services: readonly ChosenService[];
  /** Every date with free time for this selection on or after the lead window, sorted. */
  dates: readonly string[];
  /** The free slots of the chosen date that start inside the lead window. */
  slots: readonly TimeSlot[];
  slot: TimeSlot;
}

// ---------------------------------------------------------------- helpers

function describeError(error: unknown): string {
  if (error instanceof UpstreamError) {
    const codes =
      error.codes.length > 0 ? ` codes ${error.codes.join(',')}` : '';
    return `Altegio API ${error.kind} on ${error.route}${codes}`;
  }
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : 'unknown error';
}

function normalise(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function textExpectation(label: string, needle: string): Expectation {
  const wanted = normalise(needle);
  return { label, holds: (view) => normalise(view.text).includes(wanted) };
}

/** HH:MM in 24-hour form (leading zero optional) or h:MM AM/PM. */
function timePattern(hour: string, minute: string): RegExp {
  const h = Number(hour);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return new RegExp(
    `(?:^|\\D)(?:0?${h}:${minute}(?!\\d)|${h12}:${minute}\\s?[ap]\\.?m)`,
    'i'
  );
}

function timeExpectation(hour: string, minute: string): Expectation {
  const pattern = timePattern(hour, minute);
  return {
    label: `time ${hour}:${minute} visible`,
    holds: (view) => pattern.test(view.text),
  };
}

function noTimeExpectation(hour: string, minute: string): Expectation {
  const pattern = timePattern(hour, minute);
  return {
    label: `time ${hour}:${minute} not shown`,
    holds: (view) => !pattern.test(view.text),
  };
}

/** A weak signal: the day number standing alone (not part of a time). */
function dayExpectation(day: string): Expectation {
  const pattern = new RegExp(`(?:^|[^\\d:])${Number(day)}(?![\\d:])`);
  return {
    label: `day of month ${Number(day)} visible`,
    holds: (view) => pattern.test(view.text),
  };
}

/**
 * True when the URL carries a non-empty o= value. The widget writes its own
 * order state back into the URL, and an empty o= means nothing is selected.
 */
function hasOrderParameter(url: string): boolean {
  try {
    return (new URL(url).searchParams.get('o') ?? '') !== '';
  } catch {
    return false;
  }
}

const NO_ORDER_IN_URL: Expectation = {
  label: 'final URL carries no o= pre-selection (empty o= allowed)',
  holds: (view) => !hasOrderParameter(view.url),
};

const NO_RECORD_TYPE_CHOOSER: Expectation = {
  label: 'the form does not stop at the personal-or-group chooser',
  holds: (view) => !view.url.includes('/record-type'),
};

/** The form style from the landing path (docs/research/widget-deep-link.md, Landing behaviour). */
function formStyle(url: string): string {
  if (url.includes('/record-type')) return 'personal-or-group chooser';
  if (url.includes('/menu')) return 'menu';
  if (/\/select-(services|master|time|staff)/.test(url)) return 'step-by-step';
  return 'unknown';
}

function isChallenge(text: string): boolean {
  return /just a moment|checking your browser|verify you are human/i.test(text);
}

function slotParts(
  datetime: string
): NonNullable<ReturnType<typeof parseSlotDatetime>> {
  const parts = parseSlotDatetime(datetime);
  if (parts === null)
    throw new TypeError(`unexpected slot datetime ${datetime}`);
  return parts;
}

function linkInput(
  selection: Selection,
  overrides: Partial<BookingLinkInput> = {}
): BookingLinkInput {
  return {
    locationId: selection.card.locationId,
    formUrl: selection.card.bookingFormUrl,
    teamMemberId: selection.teamMemberId,
    serviceIds: selection.services.map((service) => service.id),
    slotDatetime: selection.slot.datetime,
    businessUtcOffsetHours: selection.card.utcOffsetHours,
    anyTeamMemberAllowed: selection.card.anyTeamMemberAllowed,
    ...overrides,
  };
}

function builderNote(link: BookingLink): string {
  return `shipped builder result: ${link.kind}${link.reason === null ? '' : ` (${link.reason})`}`;
}

function selectionNotes(selection: Selection): string[] {
  const member =
    selection.teamMemberId === 0
      ? 'any team member'
      : `team member ${selection.teamMemberId}`;
  const services = selection.services.map((service) => service.id).join(', ');
  return [
    `discovery: location ${selection.card.locationId}, ${member}, services ${services}, slot ${selection.slot.datetime}, verified by book_check (201)`,
    `discovery: ${leadText(selection.slot, selection.lead)}`,
  ];
}

/** How far after discovery the slot starts, and the minimum lead asked for. */
function leadText(slot: TimeSlot, lead: LeadWindow): string {
  const start = Date.parse(slot.datetime);
  if (!Number.isFinite(start)) return `slot start ${slot.datetime} not parsed`;
  const minutes = Math.round((start - lead.startedAt) / 60_000);
  const hours = Math.floor(minutes / 60);
  return `slot starts ${hours} h ${minutes - hours * 60} min after discovery (minimum lead ${lead.minLeadHours} h)`;
}

/** True when the slot starts no earlier than the lead window allows. */
function inLeadWindow(slot: TimeSlot, lead: LeadWindow): boolean {
  if (lead.minLeadHours === 0) return true;
  const start = Date.parse(slot.datetime);
  return Number.isFinite(start) && start >= lead.earliest;
}

/** The business's calendar date (YYYY-MM-DD) at an instant; null when its zone is unknown. */
function businessDate(instant: number, card: BusinessCard): string | null {
  if (card.timeZoneName !== null) {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: card.timeZoneName,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date(instant));
    } catch {
      // Unknown zone name: fall back to the fixed offset below.
    }
  }
  if (card.utcOffsetHours === null) return null;
  return new Date(instant + card.utcOffsetHours * HOUR_MS)
    .toISOString()
    .slice(0, 10);
}

/** The first "HH:MM — HH:MM" range on the page, as shown; null when none. */
function timeRange(text: string): string | null {
  const match = /(\d{1,2}:\d{2})\s*[—–-]\s*(\d{1,2}:\d{2})/.exec(text);
  return match === null ? null : `${match[1]} — ${match[2]}`;
}

/** Service titles, the team member's name, HH:MM and the day of the slot. */
function preselectionExpectations(
  selection: Selection,
  datetime: string = selection.slot.datetime
): Expectation[] {
  const parts = slotParts(datetime);
  const expectations = selection.services.map((service) =>
    textExpectation(`service "${service.title}" visible`, service.title)
  );
  if (selection.teamMemberName !== null) {
    expectations.push(
      textExpectation(
        `team member "${selection.teamMemberName}" visible`,
        selection.teamMemberName
      )
    );
  }
  expectations.push(timeExpectation(parts.hour, parts.minute));
  expectations.push(dayExpectation(parts.day));
  return expectations;
}

function notRun(id: CaseId, reason: string, notes: string[] = []): PlannedCase {
  return {
    id,
    link: null,
    linkKind: null,
    expectations: [],
    notes,
    notRun: reason,
  };
}

function planned(
  id: CaseId,
  link: string,
  linkKind: LinkKind,
  expectations: Expectation[],
  notes: string[]
): PlannedCase {
  return { id, link, linkKind, expectations, notes, notRun: null };
}

/** The UTC offset of a time zone at noon UTC of a date, in minutes; null when unknown. */
function zoneOffsetMinutes(timeZone: string, date: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      timeZoneName: 'longOffset',
    }).formatToParts(new Date(`${date}T12:00:00Z`));
    const name = parts.find((part) => part.type === 'timeZoneName')?.value;
    if (name === undefined) return null;
    if (name === 'GMT') return 0;
    const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(name);
    if (match === null) return null;
    const [, sign, hours, minutes] = match;
    const total = Number(hours) * 60 + Number(minutes);
    return sign === '-' ? -total : total;
  } catch {
    return null;
  }
}

function positiveIntFromEnv(name: string, what = 'location id'): number | null {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer ${what}`);
  }
  return value;
}

/** Like positiveIntFromEnv, but 0 is a valid value (for settings that default to 0). */
function nonNegativeIntFromEnv(name: string, what: string): number | null {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer ${what}`);
  }
  return value;
}

// -------------------------------------------------------------- discovery

/** null when book_check accepts the slot, otherwise the rejection codes. */
async function rejection(
  client: BookingClient,
  locationId: number,
  serviceIds: readonly number[],
  teamMemberId: number,
  datetime: string
): Promise<string | null> {
  try {
    await client.check(locationId, { serviceIds, teamMemberId, datetime });
    return null;
  } catch (error) {
    if (error instanceof UpstreamError && error.kind === 'rejected') {
      return error.codes.length > 0
        ? `rejected ${error.codes.join(',')}`
        : 'rejected';
    }
    throw error;
  }
}

async function isFree(
  client: BookingClient,
  locationId: number,
  serviceIds: readonly number[],
  teamMemberId: number,
  datetime: string
): Promise<boolean> {
  return (
    (await rejection(
      client,
      locationId,
      serviceIds,
      teamMemberId,
      datetime
    )) === null
  );
}

interface Candidate {
  teamMemberId: number;
  teamMemberName: string | null;
  services: ChosenService[];
}

async function candidates(
  client: BookingClient,
  card: BusinessCard,
  mode: 'named' | 'any',
  serviceCount: number,
  trace: string[]
): Promise<Candidate[]> {
  const locationId = card.locationId;
  const found: Candidate[] = [];
  if (mode === 'named') {
    const all = await client.teamMembers(locationId);
    const members = all
      .filter((member) => member.bookable)
      .slice(0, MAX_TEAM_MEMBERS);
    trace.push(
      `${all.length} team member(s), ${all.filter((member) => member.bookable).length} bookable`
    );
    for (const member of members) {
      const catalog = await client.services(locationId, {
        teamMemberId: member.id,
      });
      if (catalog.services.length < serviceCount) {
        trace.push(
          `m${member.id}: ${catalog.services.length} service(s), fewer than ${serviceCount}`
        );
        continue;
      }
      found.push({
        teamMemberId: member.id,
        teamMemberName: member.name,
        services: catalog.services.slice(0, serviceCount),
      });
    }
    return found;
  }
  const catalog = await client.services(locationId);
  trace.push(`${catalog.services.length} service(s) for any team member`);
  for (
    let start = 0;
    start + serviceCount <= catalog.services.length &&
    found.length < MAX_SERVICE_GROUPS;
    start += serviceCount
  ) {
    found.push({
      teamMemberId: 0,
      teamMemberName: null,
      services: catalog.services.slice(start, start + serviceCount),
    });
  }
  return found;
}

/**
 * The first verified free slot for the mode that starts inside the lead
 * window, or the reason there is none.
 */
async function findSelection(
  client: BookingClient,
  card: BusinessCard,
  mode: 'named' | 'any',
  serviceCount: number,
  lead: LeadWindow
): Promise<Selection | string> {
  // What discovery saw, so a "no verified free slot" reason says why.
  const trace: string[] = [];
  // Dates before the business's date at the end of the lead cannot hold a slot in the window.
  const firstDate =
    lead.minLeadHours === 0 ? null : businessDate(lead.earliest, card);
  try {
    const locationId = card.locationId;
    for (const candidate of await candidates(
      client,
      card,
      mode,
      serviceCount,
      trace
    )) {
      const ids = candidate.services.map((service) => service.id);
      const dates = [
        ...new Set(
          await client.dates(locationId, {
            serviceIds: ids,
            teamMemberId: candidate.teamMemberId,
          })
        ),
      ]
        .filter((date) => firstDate === null || date >= firstDate)
        .sort();
      const who = `m${candidate.teamMemberId === 0 ? '-1' : candidate.teamMemberId} s${ids.join('s')}`;
      trace.push(
        `${who}: ${dates.length} date(s)${firstDate === null ? '' : ` from ${firstDate}`}`
      );
      for (const date of dates.slice(0, MAX_DATES)) {
        const all = await client.timeSlots(
          locationId,
          candidate.teamMemberId,
          date,
          ids
        );
        const slots = all.filter((slot) => inLeadWindow(slot, lead));
        trace.push(
          `${who} ${date}: ${all.length} slot(s)${lead.minLeadHours === 0 ? '' : `, ${slots.length} at least ${lead.minLeadHours} h ahead`}`
        );
        for (const slot of slots.slice(0, MAX_CHECKS_PER_DATE)) {
          const refused = await rejection(
            client,
            locationId,
            ids,
            candidate.teamMemberId,
            slot.datetime
          );
          if (refused !== null) {
            trace.push(`${who} ${slot.datetime}: ${refused}`);
          } else {
            return {
              card,
              lead,
              teamMemberId: candidate.teamMemberId,
              teamMemberName: candidate.teamMemberName,
              services: candidate.services,
              dates,
              slots,
              slot,
            };
          }
        }
      }
    }
    const who = mode === 'named' ? 'a named team member' : 'any team member';
    const window =
      lead.minLeadHours === 0
        ? ''
        : ` starting at least ${lead.minLeadHours} h after discovery`;
    return `no verified free slot${window} for ${serviceCount} service(s) with ${who} at location ${card.locationId} (${trace.join('; ') || 'no candidate'})`;
  } catch (error) {
    return `discovery failed: ${describeError(error)}${trace.length > 0 ? ` (${trace.join('; ')})` : ''}`;
  }
}

async function loadCard(
  client: BookingClient,
  locationId: number
): Promise<BusinessCard | string> {
  try {
    return await client.company(locationId);
  } catch (error) {
    return `business card of location ${locationId} not read: ${describeError(error)}`;
  }
}

// ------------------------------------------------------------- case plans

function singleNamed(named: Selection | string): PlannedCase {
  if (typeof named === 'string') return notRun('single-named', named);
  const link = buildBookingLink(linkInput(named));
  const notes = [...selectionNotes(named), builderNote(link)];
  if (link.kind !== 'preselected') {
    return notRun(
      'single-named',
      `the builder fell back (${link.reason ?? 'unknown'})`,
      notes
    );
  }
  return planned(
    'single-named',
    link.url,
    'preselected',
    preselectionExpectations(named),
    notes
  );
}

function multiServices(multi: Selection | string): PlannedCase {
  if (typeof multi === 'string') return notRun('multi-services', multi);
  const link = buildBookingLink(linkInput(multi));
  const notes = [...selectionNotes(multi), builderNote(link)];
  if (link.kind !== 'preselected') {
    return notRun(
      'multi-services',
      `the builder fell back (${link.reason ?? 'unknown'})`,
      notes
    );
  }
  return planned(
    'multi-services',
    link.url,
    'preselected',
    preselectionExpectations(multi),
    notes
  );
}

function anyMember(card: BusinessCard, any: Selection | string): PlannedCase {
  if (!card.anyTeamMemberAllowed) {
    return notRun(
      'any-member',
      `location ${card.locationId} has "any team member" disabled; see any-member-disabled`
    );
  }
  if (typeof any === 'string') return notRun('any-member', any);
  const link = buildBookingLink(linkInput(any));
  const notes = [...selectionNotes(any), builderNote(link)];
  if (link.kind !== 'preselected') {
    return notRun(
      'any-member',
      `the builder fell back (${link.reason ?? 'unknown'})`,
      notes
    );
  }
  return planned(
    'any-member',
    link.url,
    'preselected',
    preselectionExpectations(any),
    notes
  );
}

function plainFallback(card: BusinessCard): PlannedCase {
  const link = plainBookingLink(card.locationId, card.bookingFormUrl);
  return planned(
    'plain-fallback',
    link.url,
    'booking_form',
    [NO_ORDER_IN_URL],
    [builderNote(link)]
  );
}

function takenSlot(named: Selection | string): PlannedCase {
  if (typeof named === 'string') return notRun('taken-slot', named);
  const free = new Set(named.slots.map((slot) => slot.datetime));
  for (const slot of named.slots) {
    const parts = slotParts(slot.datetime);
    if (parts.minute === '59') continue;
    const minute = String(Number(parts.minute) + 1).padStart(2, '0');
    // YYYY-MM-DDTHH:MM: the minute digits sit at offsets 14 and 15.
    const shifted = `${slot.datetime.slice(0, 14)}${minute}${slot.datetime.slice(16)}`;
    if (free.has(shifted)) continue;
    const link = buildBookingLink(linkInput(named, { slotDatetime: shifted }));
    if (link.kind !== 'preselected') continue;
    return planned(
      'taken-slot',
      link.url,
      'preselected',
      [noTimeExpectation(parts.hour, minute)],
      [
        ...selectionNotes(named),
        `linked time ${shifted} is not among the free slots of ${named.slots.length} on that date`,
      ]
    );
  }
  return notRun('taken-slot', 'no free slot left a non-free minute to link to');
}

function menuAndSteps(
  named: Selection | string,
  steps: Selection | string | null
): PlannedCase {
  if (steps !== null) {
    if (typeof steps === 'string') {
      return notRun(
        'menu-and-steps',
        `BROWSER_CHECK_STEPS_LOCATION_ID: ${steps}`
      );
    }
    const link = buildBookingLink(linkInput(steps));
    const notes = [
      ...selectionNotes(steps),
      builderNote(link),
      'main location form style: see single-named',
    ];
    if (link.kind !== 'preselected') {
      return notRun(
        'menu-and-steps',
        `the builder fell back (${link.reason ?? 'unknown'})`,
        notes
      );
    }
    return planned(
      'menu-and-steps',
      link.url,
      'preselected',
      preselectionExpectations(steps),
      notes
    );
  }
  if (typeof named === 'string') return notRun('menu-and-steps', named);
  const link = buildBookingLink(linkInput(named));
  if (link.kind !== 'preselected') {
    return notRun(
      'menu-and-steps',
      `the builder fell back (${link.reason ?? 'unknown'})`
    );
  }
  return planned(
    'menu-and-steps',
    link.url,
    'preselected',
    [
      timeExpectation(
        slotParts(named.slot.datetime).hour,
        slotParts(named.slot.datetime).minute
      ),
    ],
    [
      ...selectionNotes(named),
      'only the main location form style is checked; the other style is not run (set BROWSER_CHECK_STEPS_LOCATION_ID)',
    ]
  );
}

function personalOrGroup(named: Selection | string): PlannedCase {
  if (typeof named === 'string') return notRun('personal-or-group', named);
  const link = buildBookingLink(linkInput(named));
  if (link.kind !== 'preselected') {
    return notRun(
      'personal-or-group',
      `the builder fell back (${link.reason ?? 'unknown'})`
    );
  }
  return planned(
    'personal-or-group',
    link.url,
    'preselected',
    [NO_RECORD_TYPE_CHOOSER],
    [
      ...selectionNotes(named),
      'a chooser appears only when the form also offers group events',
    ]
  );
}

function halfHourZone(half: Selection | string | null): PlannedCase {
  if (half === null) {
    return notRun(
      'half-hour-zone',
      'BROWSER_CHECK_HALF_HOUR_LOCATION_ID is not set'
    );
  }
  if (typeof half === 'string') return notRun('half-hour-zone', half);
  const parts = slotParts(half.slot.datetime);
  if (parts.offsetMinutes % 60 === 0) {
    return notRun(
      'half-hour-zone',
      `slot offset ${formatUtcOffset(parts.offsetMinutes)} is a whole hour`,
      selectionNotes(half)
    );
  }
  const shipped = buildBookingLink(linkInput(half));
  // The d token never carries the offset, so linking the same wall-clock
  // digits with +00:00 gives the token the builder would write if it accepted
  // the half-hour zone.
  const offsetText =
    /(Z|[+-]\d{2}:?\d{2})$/.exec(half.slot.datetime)?.[0] ?? '';
  const probe = buildBookingLink(
    linkInput(half, {
      slotDatetime: `${half.slot.datetime.slice(0, -offsetText.length)}+00:00`,
      businessUtcOffsetHours: 0,
    })
  );
  if (probe.kind !== 'preselected') {
    return notRun(
      'half-hour-zone',
      `the probe link fell back (${probe.reason ?? 'unknown'})`
    );
  }
  return planned(
    'half-hour-zone',
    probe.url,
    'probe',
    preselectionExpectations(half),
    [
      ...selectionNotes(half),
      builderNote(shipped),
      `slot offset ${formatUtcOffset(parts.offsetMinutes)}`,
    ]
  );
}

async function dstBoundary(
  client: BookingClient,
  named: Selection | string
): Promise<PlannedCase> {
  if (typeof named === 'string') return notRun('dst-boundary', named);
  const card = named.card;
  if (card.timeZoneName === null || card.utcOffsetHours === null) {
    return notRun(
      'dst-boundary',
      'the business card has no time-zone name or offset'
    );
  }
  const current = Math.round(card.utcOffsetHours * 60);
  const timeZone = card.timeZoneName;
  const date = named.dates.find((day) => {
    const offset = zoneOffsetMinutes(timeZone, day);
    return offset !== null && offset !== current;
  });
  if (date === undefined) {
    return notRun(
      'dst-boundary',
      `no offset change in ${timeZone} inside the ${named.dates.length} bookable dates (${named.dates[0] ?? '-'} to ${named.dates.at(-1) ?? '-'})`
    );
  }
  try {
    const ids = named.services.map((service) => service.id);
    const slots = (
      await client.timeSlots(card.locationId, named.teamMemberId, date, ids)
    ).filter((slot) => inLeadWindow(slot, named.lead));
    for (const slot of slots.slice(0, MAX_CHECKS_PER_DATE)) {
      const parts = slotParts(slot.datetime);
      if (parts.offsetMinutes === current) continue;
      if (
        !(await isFree(
          client,
          card.locationId,
          ids,
          named.teamMemberId,
          slot.datetime
        ))
      ) {
        continue;
      }
      const after: Selection = { ...named, slots, slot };
      const shipped = buildBookingLink(linkInput(after));
      const link = buildBookingLink(
        linkInput(after, { businessUtcOffsetHours: parts.offsetMinutes / 60 })
      );
      if (link.kind !== 'preselected') {
        return notRun(
          'dst-boundary',
          `the link fell back (${link.reason ?? 'unknown'})`
        );
      }
      return planned(
        'dst-boundary',
        link.url,
        'probe',
        preselectionExpectations(after),
        [
          ...selectionNotes(after),
          builderNote(shipped),
          `business offset now ${formatUtcOffset(current)}, slot offset ${formatUtcOffset(parts.offsetMinutes)}`,
        ]
      );
    }
    return notRun(
      'dst-boundary',
      `no verified free slot with the new offset on ${date}`
    );
  } catch (error) {
    return notRun('dst-boundary', `discovery failed: ${describeError(error)}`);
  }
}

function anyMemberDisabled(
  card: BusinessCard | string | null,
  any: Selection | string | null
): PlannedCase {
  if (card === null) {
    return notRun(
      'any-member-disabled',
      'BROWSER_CHECK_ANY_DISABLED_LOCATION_ID is not set'
    );
  }
  if (typeof card === 'string') return notRun('any-member-disabled', card);
  if (card.anyTeamMemberAllowed) {
    return notRun(
      'any-member-disabled',
      `location ${card.locationId} allows any team member, so it cannot show this case`
    );
  }
  if (any === null || typeof any === 'string') {
    return notRun('any-member-disabled', any ?? 'no selection');
  }
  const shipped = buildBookingLink(linkInput(any));
  const probe = buildBookingLink(
    linkInput(any, { anyTeamMemberAllowed: true })
  );
  if (probe.kind !== 'preselected') {
    return notRun(
      'any-member-disabled',
      `the probe link fell back (${probe.reason ?? 'unknown'})`
    );
  }
  return planned(
    'any-member-disabled',
    probe.url,
    'probe',
    preselectionExpectations(any),
    [...selectionNotes(any), builderNote(shipped)]
  );
}

function slugHost(named: Selection | string): PlannedCase {
  if (typeof named === 'string') return notRun('slug-host', named);
  const slugOrigin = named.card.bookingForms
    .map((form) => {
      try {
        return new URL(form.url);
      } catch {
        return null;
      }
    })
    .find(
      (url) =>
        url !== null &&
        url.protocol === 'https:' &&
        (url.hostname === 'altegio.me' || url.hostname.endsWith('.altegio.me'))
    )?.origin;
  if (slugOrigin === undefined) {
    return notRun(
      'slug-host',
      `no booking form of location ${named.card.locationId} is on an altegio.me host`
    );
  }
  const link = buildBookingLink(linkInput(named));
  if (link.kind !== 'preselected') {
    return notRun(
      'slug-host',
      `the builder fell back (${link.reason ?? 'unknown'})`
    );
  }
  const shipped = new URL(link.url);
  return planned(
    'slug-host',
    `${slugOrigin}${shipped.pathname}${shipped.search}`,
    'probe',
    preselectionExpectations(named),
    [
      ...selectionNotes(named),
      'altegio.me is not on the builder allow-list, so book_check never links to this host',
    ]
  );
}

function groupEventOrder(): PlannedCase {
  return notRun(
    'group-event-order',
    'not applicable in v1: group events are deferred (EXT-01) and the builder never writes aid or act tokens'
  );
}

// ------------------------------------------------------------- the browser

async function readView(page: Page): Promise<PageView> {
  let text: string;
  try {
    text = await page.innerText('body', { timeout: POLL_INTERVAL_MS * 5 });
  } catch {
    text = '';
  }
  return { text, url: page.url() };
}

/** Waits up to 30 s until every expectation holds or the page stops changing. */
async function settle(
  page: Page,
  expectations: Expectation[]
): Promise<PageView> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  try {
    await page.waitForLoadState('networkidle', { timeout: SETTLE_TIMEOUT_MS });
  } catch {
    // A widget that keeps polling never goes idle; the loop below still runs.
  }
  let view = await readView(page);
  while (Date.now() < deadline) {
    if (
      !isChallenge(view.text) &&
      view.text.trim() !== '' &&
      expectations.every((expectation) => expectation.holds(view))
    ) {
      return view;
    }
    await page.waitForTimeout(POLL_INTERVAL_MS);
    view = await readView(page);
  }
  return view;
}

/**
 * Opens the link in a fresh context (booking write route refused), waits for
 * the widget to settle, saves a full-page screenshot and returns what it read.
 */
async function loadOnce(
  browser: Browser,
  link: string,
  expectations: Expectation[],
  shotPath: string
): Promise<PageView> {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  // Defence in depth: the check never interacts with the widget, and the
  // booking write route is refused outright as well.
  await context.route(/book_record/i, (route) => route.abort());
  try {
    const page = await context.newPage();
    await page.goto(link, {
      waitUntil: 'domcontentloaded',
      timeout: NAVIGATION_TIMEOUT_MS,
    });
    const view = await settle(page, expectations);
    await page.screenshot({ path: shotPath, fullPage: true });
    return view;
  } finally {
    await context.close();
  }
}

async function runCase(
  browser: Browser,
  plan: PlannedCase,
  outputDir: string
): Promise<CaseResult> {
  const result: CaseResult = {
    id: plan.id,
    link: plan.link,
    link_kind: plan.linkKind,
    expected: plan.expectations.map((expectation) => expectation.label),
    seen: [...plan.notes],
    status: 'not-run',
    reason: plan.notRun,
    screenshot: null,
  };
  if (plan.link === null) return result;

  try {
    const shot = join(outputDir, `${plan.id}.png`);
    const view = await loadOnce(browser, plan.link, plan.expectations, shot);
    result.screenshot = relative(PACKAGE_DIR, shot);
    result.seen.push(`final URL: ${view.url}`);
    result.seen.push(
      `final URL keeps o=: ${hasOrderParameter(view.url) ? 'yes' : 'no'}`
    );
    result.seen.push(`form style: ${formStyle(view.url)}`);
    result.seen.push(`time range shown: ${timeRange(view.text) ?? 'none'}`);
    if (isChallenge(view.text)) {
      result.status = 'blocked';
      result.reason =
        'Cloudflare challenge page; use the manual fallback (--print-links)';
      return result;
    }
    for (const expectation of plan.expectations) {
      result.seen.push(
        `${expectation.label}: ${expectation.holds(view) ? 'yes' : 'no'}`
      );
    }
    const failed = plan.expectations.filter(
      (expectation) => !expectation.holds(view)
    );
    result.status = failed.length === 0 ? 'pass' : 'fail';
    result.reason =
      failed.length === 0
        ? null
        : `not seen: ${failed.map((e) => e.label).join('; ')}`;
  } catch (error) {
    result.status = 'fail';
    result.reason = `browser error: ${describeError(error)}`;
  }
  return result;
}

/**
 * Loads the plan's link `count` more times, each in a fresh context with the
 * same wait as a case, and counts on how many loads each expectation held.
 */
async function repeatLoads(
  browser: Browser,
  plan: PlannedCase | undefined,
  count: number,
  outputDir: string
): Promise<RepeatResult> {
  const id: CaseId = plan?.id ?? 'single-named';
  const result: RepeatResult = {
    case: id,
    link: plan?.link ?? null,
    loads: [],
    tally: {},
    all_held: 0,
    reason: null,
  };
  if (plan === undefined || plan.link === null) {
    result.reason = plan?.notRun ?? `case ${id} has no link`;
    return result;
  }
  for (const expectation of plan.expectations) {
    result.tally[expectation.label] = 0;
  }
  for (let load = 1; load <= count; load += 1) {
    console.log(`Repeat load ${load}/${count} of ${id}...`);
    const entry: RepeatLoad = {
      load,
      at: new Date().toISOString(),
      final_url: null,
      checks: {},
      time_range: null,
      all_held: false,
      screenshot: null,
      error: null,
    };
    try {
      const shot = join(outputDir, `${id}-repeat-${load}.png`);
      const view = await loadOnce(browser, plan.link, plan.expectations, shot);
      entry.screenshot = relative(PACKAGE_DIR, shot);
      entry.final_url = view.url;
      entry.time_range = timeRange(view.text);
      if (isChallenge(view.text)) {
        entry.error = 'Cloudflare challenge page';
      } else {
        for (const expectation of plan.expectations) {
          const held = expectation.holds(view);
          entry.checks[expectation.label] = held;
          if (held) {
            result.tally[expectation.label] =
              (result.tally[expectation.label] ?? 0) + 1;
          }
        }
        entry.all_held = plan.expectations.every(
          (expectation) => entry.checks[expectation.label] === true
        );
        if (entry.all_held) result.all_held += 1;
      }
    } catch (error) {
      entry.error = `browser error: ${describeError(error)}`;
    }
    result.loads.push(entry);
  }
  return result;
}

// ----------------------------------------------------------------- output

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function markdownTable(results: CaseResult[]): string {
  const rows = results.map((result) => {
    const detail =
      result.reason ??
      result.seen
        .filter((line) => line.endsWith(': yes') || line.endsWith(': no'))
        .join('; ');
    return `| ${result.id} | ${result.status} | ${result.link_kind ?? '-'} | ${cell(detail)} | ${result.screenshot ?? '-'} |`;
  });
  return [
    '| Case | Status | Link kind | Seen or reason | Screenshot |',
    '|------|--------|-----------|----------------|------------|',
    ...rows,
  ].join('\n');
}

function repeatSummary(repeat: RepeatResult): string {
  if (repeat.reason !== null) {
    return `Repeated loads of ${repeat.case}: not run (${repeat.reason})`;
  }
  const total = repeat.loads.length;
  const lines = [
    `Repeated loads of ${repeat.case}: everything applied on ${repeat.all_held}/${total}`,
    ...Object.entries(repeat.tally).map(
      ([label, held]) => `  ${label}: ${held}/${total}`
    ),
    ...repeat.loads.map(
      (load) =>
        `  load ${load.load}: ${load.error ?? (load.all_held ? 'all held' : 'not all held')}, time range ${load.time_range ?? 'none'}`
    ),
  ];
  return lines.join('\n');
}

function printLinks(plans: PlannedCase[]): void {
  for (const plan of plans) {
    console.log(`## ${plan.id}`);
    if (plan.link === null) {
      console.log(`not run: ${plan.notRun ?? 'no link'}`);
    } else {
      console.log(`link (${plan.linkKind ?? '-'}): ${plan.link}`);
      for (const expectation of plan.expectations) {
        console.log(`expect: ${expectation.label}`);
      }
    }
    for (const note of plan.notes) console.log(note);
    console.log('');
  }
}

// ------------------------------------------------------------------- main

async function discover(
  client: BookingClient,
  locationId: number,
  lead: LeadWindow
): Promise<{
  card: BusinessCard;
  plans: PlannedCase[];
}> {
  const card = await loadCard(client, locationId);
  if (typeof card === 'string') throw new Error(card);

  const named = await findSelection(client, card, 'named', 1, lead);
  const multi = await findSelection(client, card, 'named', 2, lead);
  const any = card.anyTeamMemberAllowed
    ? await findSelection(client, card, 'any', 1, lead)
    : 'any team member is disabled';

  const stepsId = positiveIntFromEnv('BROWSER_CHECK_STEPS_LOCATION_ID');
  const halfId = positiveIntFromEnv('BROWSER_CHECK_HALF_HOUR_LOCATION_ID');
  const anyOffId = positiveIntFromEnv('BROWSER_CHECK_ANY_DISABLED_LOCATION_ID');

  const optionalSelection = async (
    id: number | null,
    mode: 'named' | 'any'
  ): Promise<Selection | string | null> => {
    if (id === null) return null;
    const other = await loadCard(client, id);
    return typeof other === 'string'
      ? other
      : findSelection(client, other, mode, 1, lead);
  };
  const steps = await optionalSelection(stepsId, 'named');
  const half = await optionalSelection(halfId, 'named');
  const anyOffCard =
    anyOffId === null ? null : await loadCard(client, anyOffId);
  const anyOff =
    anyOffCard === null ||
    typeof anyOffCard === 'string' ||
    anyOffCard.anyTeamMemberAllowed
      ? null
      : await findSelection(client, anyOffCard, 'any', 1, lead);

  const plans: PlannedCase[] = [
    singleNamed(named),
    multiServices(multi),
    anyMember(card, any),
    plainFallback(card),
    takenSlot(named),
    menuAndSteps(named, steps),
    personalOrGroup(named),
    halfHourZone(half),
    await dstBoundary(client, named),
    anyMemberDisabled(anyOffCard, anyOff),
    slugHost(named),
    groupEventOrder(),
  ];
  return { card, plans };
}

function defaultFormId(card: BusinessCard): number | null {
  return (
    card.bookingForms.find((form) => form.isDefault)?.id ??
    card.bookingForms[0]?.id ??
    null
  );
}

async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes('--list-cases')) {
    for (const entry of CASES) console.log(`${entry.id}\t${entry.description}`);
    return 0;
  }

  const token = process.env.ALTEGIO_API_TOKEN;
  if (token === undefined || token.trim() === '') {
    console.error(
      'ALTEGIO_API_TOKEN is not set. Put the partner token in the root .env (see docs/research/widget-deep-link.md).'
    );
    return 2;
  }
  const locationId = positiveIntFromEnv('ALTEGIO_E2E_LOCATION_ID');
  if (locationId === null) {
    console.error(
      'ALTEGIO_E2E_LOCATION_ID is not set. Put the test location id in the root .env.'
    );
    return 2;
  }

  const minLeadHours =
    nonNegativeIntFromEnv('BROWSER_CHECK_MIN_LEAD_HOURS', 'number of hours') ??
    0;
  const repeatCount =
    nonNegativeIntFromEnv('BROWSER_CHECK_REPEAT_LOADS', 'number of loads') ??
    DEFAULT_REPEAT_LOADS;

  const client = new BookingClient({
    base: API_BASE,
    token,
    gate: new RequestGate(),
  });
  const startedAt = Date.now();
  const lead: LeadWindow = {
    startedAt,
    minLeadHours,
    earliest: startedAt + minLeadHours * HOUR_MS,
  };
  console.log(
    `Discovering free slots at location ${locationId}${minLeadHours === 0 ? '' : ` starting at least ${minLeadHours} h from now`}...`
  );
  const { card, plans } = await discover(client, locationId, lead);

  if (argv.includes('--print-links')) {
    printLinks(plans);
    return 0;
  }

  const runAt = new Date().toISOString();
  const outputDir = join(PACKAGE_DIR, 'output', runAt.replace(/[:.]/g, '-'));
  await mkdir(outputDir, { recursive: true });

  let browser: Browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: false });
  } catch (error) {
    console.error(
      `Could not start the installed Google Chrome (${describeError(error)}). Use --print-links for the manual fallback.`
    );
    return 2;
  }
  const chromeVersion = browser.version();
  const results: CaseResult[] = [];
  let repeat: RepeatResult;
  try {
    for (const plan of plans) {
      console.log(`Case ${plan.id}...`);
      results.push(await runCase(browser, plan, outputDir));
    }
    repeat = await repeatLoads(
      browser,
      plans.find((plan) => plan.id === 'single-named'),
      repeatCount,
      outputDir
    );
  } finally {
    await browser.close();
  }

  const report: Results = {
    run_at: runAt,
    chrome_version: chromeVersion,
    location_id: locationId,
    form_id: defaultFormId(card),
    time_zone: card.timeZoneName,
    utc_offset_hours: card.utcOffsetHours,
    discovered_at: new Date(startedAt).toISOString(),
    min_lead_hours: minLeadHours,
    cases: results,
    repeat_loads: repeat,
  };
  const resultsPath = join(outputDir, 'results.json');
  await writeFile(resultsPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log('');
  console.log(markdownTable(results));
  console.log('');
  console.log(repeatSummary(repeat));
  console.log('');
  console.log(
    `Chrome ${report.chrome_version}. Time zone ${report.time_zone ?? 'unknown'} (UTC offset ${report.utc_offset_hours ?? 'unknown'} h). Results: ${relative(PACKAGE_DIR, resultsPath)}`
  );
  return results.some((result) => result.status === 'fail') ? 1 : 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(`Browser check stopped: ${describeError(error)}`);
    process.exitCode = 2;
  }
);
