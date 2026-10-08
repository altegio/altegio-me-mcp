import type { z } from 'zod';
import { calendarDayNumber } from './calendar.js';
import { parseSlotDatetime } from './deep-link.js';
import { UpstreamError } from './errors.js';
import {
  BookingHttp,
  type BookingHttpOptions,
  type UpstreamCallOptions,
  type UpstreamCallSpec,
} from './http.js';
import {
  bookRecordCreateDataSchema,
  bookRecordMoveDataSchema,
  bookingUserDataSchema,
  companyDataSchema,
  datesDataSchema,
  servicesDataSchema,
  teamMembersDataSchema,
  timeSlotsDataSchema,
  userPlacesDataSchema,
  userRecordCancelDataSchema,
  userRecordsDataSchema,
  type BookingUserData,
  type CompanyData,
  type ServicesData,
  type TeamMembersData,
  type UserPlacesData,
  type UserRecordsData,
} from './schemas.js';

// Typed client of the public Altegio booking API (D-01). The route table is
// the whole surface: five read routes and the validation route (book_check),
// and never the write route or the sign-in route. Every path is built from integers and from dates checked as
// YYYY-MM-DD calendar dates, so no free-form model-supplied string reaches a
// URL path.

/** The only upstream routes v1 calls (D-01). Tools declare these in `upstream`. */
export const BOOKING_ROUTES = Object.freeze({
  company: Object.freeze({
    method: 'GET',
    route: '/company/{location_id}',
  } as const),
  services: Object.freeze({
    method: 'GET',
    route: '/book_services/{location_id}',
  } as const),
  teamMembers: Object.freeze({
    method: 'GET',
    route: '/book_staff/{location_id}',
  } as const),
  dates: Object.freeze({
    method: 'GET',
    route: '/book_dates/{location_id}',
  } as const),
  timeSlots: Object.freeze({
    method: 'GET',
    route: '/book_times/{location_id}/{team_member_id}/{date}',
  } as const),
  check: Object.freeze({
    method: 'POST',
    route: '/book_check/{location_id}',
  } as const),
});

/**
 * The signed-in read routes (ADR 0005, ADR 0006): the routes that carry the
 * client's user token next to the partner token. Places and records are
 * undocumented, the profile is documented; the recorded contract is
 * docs/research/signed-in-routes.md.
 */
export const USER_ROUTES = Object.freeze({
  places: Object.freeze({
    method: 'GET',
    route: '/user/companies/yplaces',
  } as const),
  records: Object.freeze({
    method: 'GET',
    route: '/user/records',
  } as const),
  profile: Object.freeze({
    method: 'GET',
    route: '/booking/user/data',
  } as const),
});

/**
 * The client's writes (ADR 0006): the only non-read routes the server calls,
 * each made with the signed-in client's user token next to the partner token.
 * This file is the only source file that names the create and move routes.
 */
export const CLIENT_WRITE_ROUTES = Object.freeze({
  create: Object.freeze({
    method: 'POST',
    route: '/book_record/{location_id}',
  } as const),
  move: Object.freeze({
    method: 'PUT',
    route: '/book_record/{location_id}/{record_id}',
  } as const),
  cancel: Object.freeze({
    method: 'DELETE',
    route: '/user/records/{record_id}/{record_hash}',
  } as const),
});

/**
 * The hash segment of the cancel path. The recording of 2026-10-08 settled it
 * (docs/research/signed-in-routes.md, "## Writes", hash answer `placeholder`):
 * for a signed-in client the user token makes the record id enough, and the
 * placeholder 0 in the hash position is accepted with a 204. The creation hash
 * is not needed, so a booking found later can be cancelled too, and no record
 * token or hash is ever read or sent. A short alphanumeric text, as the path
 * segment must be.
 */
export const CANCEL_HASH_SEGMENT = '0';

export interface BookingForm {
  id: number;
  title: string | null;
  url: string;
  isDefault: boolean;
}

/** A business as the company route describes it. Strings are raw business text. */
export interface BusinessCard {
  locationId: number;
  name: string;
  category: string | null;
  address: string | null;
  city: string | null;
  country: string | null;
  phone: string | null;
  website: string | null;
  timeZoneName: string | null;
  utcOffsetHours: number | null;
  currency: string | null;
  widgetActive: boolean;
  phoneConfirmation: boolean | null;
  anyTeamMemberAllowed: boolean;
  paymentPolicyType: string | null;
  nextFreeSlot: string | null;
  bookingForms: BookingForm[];
  /** The default form's URL, else default_bookform_url, else the first form's URL, else null. */
  bookingFormUrl: string | null;
  /** What the business lets a client do to a booking online; null where the card says nothing. */
  rules: BusinessRules;
}

/** The business's online cancel and change rules, as the company card states them. */
export interface BusinessRules {
  cancelAllowed: boolean | null;
  /** How long before the start a cancel is still allowed, in seconds; 0 means no limit, null unknown. */
  cancelBeforeSeconds: number | null;
  moveAllowed: boolean | null;
  /** How long before the start a move is still allowed, in seconds; 0 means no limit, null unknown. */
  moveBeforeSeconds: number | null;
}

/**
 * One of the signed-in client's own places, as GET /user/companies/yplaces
 * describes it. Strings are raw business text.
 */
export interface OwnPlace {
  locationId: number;
  name: string | null;
  address: string | null;
  /** Null for the recorded shape, which carries only city_id. */
  city: string | null;
  /** An https URL, or null. */
  logoUrl: string | null;
  /** The place's active_status.is_active flag. */
  onlineBooking: boolean;
  /** YYYY-MM-DD; null while the route gives none (the recorded shape has no such key). */
  lastVisit: string | null;
}

/**
 * One of the signed-in client's own records, as GET /user/records describes
 * it, reduced to what a tool may show. The token, record token, api id and
 * comment are never read (ME-05).
 */
export interface OwnRecord {
  /**
   * The booking's own id (the records route's `id`), read since ADR 0006 so a
   * client can name a booking to move or cancel. The token, record token, api
   * id and comment are still never read.
   */
  id: number;
  locationId: number;
  businessName: string | null;
  /** The business's city text, from the record's company. */
  city: string | null;
  /** The business's currency sign, for the prices of this record. */
  currency: string | null;
  services: { id: number; title: string | null; price: number | null }[];
  /** Null when the record has no team member. */
  teamMember: { id: number; name: string | null } | null;
  /** Exactly as the records route wrote it, offset without a colon. */
  datetime: string;
  /** The record's `deleted` flag: the booking was cancelled. */
  cancelled: boolean;
  /** 1 and -1 are seen on past records; the meaning is inferred. */
  attendance: number | null;
  /** Sum of the service prices; null when any is unknown or none exist. */
  price: number | null;
  /** The record's allow_change_record flag; null when the record carries none. */
  moveAllowed: boolean | null;
  /** The record's allow_delete_record flag; null when the record carries none. */
  cancelAllowed: boolean | null;
}

/** The signed-in client's profile, reduced to what the create call sends. Never returned to a tool result. */
export interface ClientProfile {
  fullname: string;
  /** A plus and digits, as the create route wants it. */
  phone: string;
  /** The profile's e-mail when it has one; the create sends it only then. */
  email: string | null;
}

/** What a create returns: the id of the new booking. The creation hash is never read. */
export interface CreatedBooking {
  bookingId: number;
}

export interface ServiceCategory {
  id: number;
  title: string;
}

/** Online prepayment status of a service link (02-RESEARCH, PrepaidService slugs). */
export type PrepaidSlug = 'forbidden' | 'allowed' | 'required';

export interface BookableService {
  id: number;
  title: string;
  categoryId: number | null;
  priceMin: number;
  priceMax: number;
  durationSeconds: number | null;
  prepaid: PrepaidSlug | null;
}

export interface ServiceCatalog {
  services: BookableService[];
  categories: ServiceCategory[];
}

export interface TeamMember {
  id: number;
  name: string;
  specialization: string | null;
  positionTitle: string | null;
  bookable: boolean;
  rating: number | null;
  nextFreeDate: string | null;
}

export interface ServicesFilter {
  teamMemberId?: number;
  datetime?: string;
  serviceIds?: readonly number[];
}

export interface TeamMembersFilter {
  serviceIds?: readonly number[];
  datetime?: string;
}

export interface DatesFilter {
  serviceIds?: readonly number[];
  /** 0 or absent = any team member. */
  teamMemberId?: number;
  /** YYYY-MM-DD; with dateTo it overrides the business's booking window. */
  dateFrom?: string;
  /** YYYY-MM-DD, inclusive. */
  dateTo?: string;
}

/** One appointment to check through the validation route. */
export interface CheckSelection {
  /** In the client's order; at least one. */
  serviceIds: readonly number[];
  /** 0 = any team member. */
  teamMemberId: number;
  /** A slot datetime exactly as book_times returned it. */
  datetime: string;
}

/** One free slot as book_times returns it. */
export interface TimeSlot {
  /** Upstream `time` (G:i, for example 9:30); never used for display. */
  time: string;
  /** The slot datetime exactly as the API wrote it. */
  datetime: string;
  durationSeconds: number | null;
  totalSeconds: number | null;
}

function assertPositiveId(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function assertUserToken(token: string | undefined): void {
  if (token === undefined || token === '') {
    throw new TypeError('a user token is required for a signed-in route');
  }
}

function assertLocationId(locationId: number): void {
  assertPositiveId(locationId, 'location id');
}

/** Every id checked, in the caller's order; that order is the order sent. */
function checkedServiceIds(
  serviceIds: readonly number[] | undefined
): readonly number[] {
  const ids = serviceIds ?? [];
  for (const id of ids) assertPositiveId(id, 'service id');
  return ids;
}

/** 0 means any team member; anything else must be a positive safe integer. */
function assertTeamMemberOrAny(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('team member id must be a safe integer of at least 0');
  }
}

/**
 * A YYYY-MM-DD date that exists in the calendar. It may become a URL path
 * segment, so nothing else passes (T-02-25).
 */
function checkedDate(value: string, label: string): string {
  if (calendarDayNumber(value) === null) {
    throw new TypeError(`${label} must be a calendar date in YYYY-MM-DD form`);
  }
  return value;
}

function optionalDate(
  value: string | undefined,
  label: string
): string | undefined {
  return value === undefined ? undefined : checkedDate(value, label);
}

/** A datetime filter must be a slot datetime as book_times returns it, on a day that exists. */
function checkedDatetime(datetime: string | undefined): string | undefined {
  if (datetime !== undefined && parseSlotDatetime(datetime) === null) {
    throw new TypeError('datetime must be an ISO 8601 slot datetime');
  }
  return datetime;
}

const PREPAID_SLUGS: ReadonlySet<string> = new Set<PrepaidSlug>([
  'forbidden',
  'allowed',
  'required',
]);

function prepaidSlug(value: unknown): PrepaidSlug | null {
  return typeof value === 'string' && PREPAID_SLUGS.has(value)
    ? (value as PrepaidSlug)
    : null;
}

function positiveOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && value > 0 ? value : null;
}

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function truthy(value: boolean | number | null | undefined): boolean {
  return value === true || (typeof value === 'number' && value !== 0);
}

function flagOrNull(
  value: boolean | number | null | undefined
): boolean | null {
  return value === null || value === undefined ? null : truthy(value);
}

function secondsOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function toCard(data: CompanyData): BusinessCard {
  const bookingForms: BookingForm[] = [];
  for (const form of data.bookforms ?? []) {
    const url = nonEmpty(form.url);
    if (url === null) continue;
    bookingForms.push({
      id: form.id,
      title: nonEmpty(form.title),
      url,
      isDefault: truthy(form.is_default),
    });
  }
  const policy = data.payment_policy;
  const policyType =
    policy !== null && policy !== undefined && !Array.isArray(policy)
      ? policy.type
      : null;

  return {
    locationId: data.id,
    name: nonEmpty(data.public_title) ?? data.title,
    category: nonEmpty(data.short_descr),
    address: nonEmpty(data.address),
    city: nonEmpty(data.city),
    country: nonEmpty(data.country),
    phone: nonEmpty(data.phone),
    website: nonEmpty(data.site),
    timeZoneName: nonEmpty(data.timezone_name),
    utcOffsetHours: data.timezone ?? null,
    currency: nonEmpty(data.currency_short_title),
    widgetActive: truthy(data.active),
    phoneConfirmation:
      data.phone_confirmation === null || data.phone_confirmation === undefined
        ? null
        : truthy(data.phone_confirmation),
    anyTeamMemberAllowed: truthy(data.show_any_master),
    paymentPolicyType:
      policyType === null || policyType === undefined
        ? null
        : nonEmpty(String(policyType)),
    nextFreeSlot: nonEmpty(data.next_slot),
    bookingForms,
    bookingFormUrl:
      bookingForms.find((form) => form.isDefault)?.url ??
      nonEmpty(data.default_bookform_url) ??
      bookingForms[0]?.url ??
      null,
    rules: {
      cancelAllowed: flagOrNull(data.allow_delete_record),
      cancelBeforeSeconds: secondsOrNull(data.allow_delete_record_delay_step),
      moveAllowed: flagOrNull(data.allow_change_record),
      moveBeforeSeconds: secondsOrNull(data.allow_change_record_delay_step),
    },
  };
}

/** A logo address is kept only when it is an https URL. */
function httpsUrlOrNull(value: string | null | undefined): string | null {
  const text = nonEmpty(value);
  if (text === null) return null;
  try {
    return new URL(text).protocol === 'https:' ? text : null;
  } catch {
    return null;
  }
}

function toOwnPlace(place: UserPlacesData[number]): OwnPlace {
  const status = place.active_status;
  const flag =
    status !== null &&
    status !== undefined &&
    !Array.isArray(status) &&
    status.is_active !== null &&
    status.is_active !== undefined
      ? status.is_active
      : place.active;
  return {
    locationId: place.id,
    name: nonEmpty(place.public_title) ?? nonEmpty(place.title),
    address: nonEmpty(place.address),
    city: nonEmpty(place.city),
    logoUrl: httpsUrlOrNull(place.logo),
    onlineBooking: truthy(flag),
    // The recorded places route has no last-visit key (docs/research/signed-in-routes.md).
    lastVisit: null,
  };
}

/** The value when it is an object; null for [] (PHP's empty map), null or absent. */
function objectOrNull<T>(
  value: T
): Exclude<T, readonly unknown[] | null | undefined> | null {
  return value === null || value === undefined || Array.isArray(value)
    ? null
    : (value as Exclude<T, readonly unknown[] | null | undefined>);
}

type UserRecord = UserRecordsData[number];

/**
 * The price of one service line: cost times amount. The recorded `discount`
 * has no documented unit, so a discounted line has no price rather than a
 * guessed one.
 */
function lineItemPrice(
  service: NonNullable<UserRecord['services']>[number]
): number | null {
  const cost = service.cost;
  if (typeof cost !== 'number') return null;
  if (typeof service.discount === 'number' && service.discount !== 0) {
    return null;
  }
  const amount = typeof service.amount === 'number' ? service.amount : 1;
  return cost * amount;
}

function sumPrices(prices: readonly (number | null)[]): number | null {
  if (prices.length === 0) return null;
  let total = 0;
  for (const price of prices) {
    if (price === null) return null;
    total += price;
  }
  return total;
}

/**
 * A record as an OwnRecord, or null when it names no place or no moment: such
 * a record can be neither shown under a place nor ordered. Only the keys the
 * recorded contract names are read; the id, token and comment are not.
 */
function toOwnRecord(record: UserRecord): OwnRecord | null {
  const company = objectOrNull(record.company);
  const datetime = nonEmpty(record.datetime);
  if (company === null || datetime === null) return null;
  const locationId = company.id;
  if (typeof locationId !== 'number' || locationId <= 0) return null;

  const staff = objectOrNull(record.staff);
  const teamMemberId =
    staff !== null && typeof staff.id === 'number' && staff.id > 0
      ? staff.id
      : null;
  const prices = (record.services ?? []).map(lineItemPrice);
  return {
    id: record.id,
    locationId,
    businessName: nonEmpty(company.public_title) ?? nonEmpty(company.title),
    city: nonEmpty(company.city),
    currency: nonEmpty(company.currency_short_title),
    services: (record.services ?? []).map((service, index) => ({
      id: service.id,
      title: nonEmpty(service.title),
      price: prices[index] ?? null,
    })),
    teamMember:
      teamMemberId === null
        ? null
        : { id: teamMemberId, name: nonEmpty(staff?.name) },
    datetime,
    cancelled: truthy(record.deleted),
    attendance:
      typeof record.attendance === 'number' ? record.attendance : null,
    price: sumPrices(prices),
    moveAllowed: flagOrNull(record.allow_change_record),
    cancelAllowed: flagOrNull(record.allow_delete_record),
  };
}

function toCatalog(data: ServicesData): ServiceCatalog {
  const services: BookableService[] = [];
  for (const service of data.services) {
    // An absent flag means active; a present falsy one hides the service.
    if (service.active !== null && service.active !== undefined) {
      if (!truthy(service.active)) continue;
    }
    services.push({
      id: service.id,
      title: service.title,
      categoryId: service.category_id ?? null,
      priceMin: service.price_min ?? 0,
      priceMax: service.price_max ?? 0,
      durationSeconds: positiveOrNull(service.seance_length),
      prepaid: prepaidSlug(service.prepaid),
    });
  }
  return {
    services,
    categories: data.category.map((category) => ({
      id: category.id,
      title: category.title ?? '',
    })),
  };
}

function toTeamMember(member: TeamMembersData[number]): TeamMember {
  const position = member.position;
  const ratingShown =
    member.show_rating === null ||
    member.show_rating === undefined ||
    truthy(member.show_rating);
  // 0 also means nobody has rated the member: that is "no rating", not a bad
  // one, so an assistant must not steer a client away from them (CR-01).
  const rating = member.rating;
  const votes = member.votes_count;
  const shownRating =
    ratingShown &&
    typeof rating === 'number' &&
    rating > 0 &&
    (votes === null || votes === undefined || votes > 0)
      ? rating
      : null;
  return {
    id: member.id,
    name: member.name,
    specialization: nonEmpty(member.specialization),
    positionTitle:
      position === null || position === undefined || Array.isArray(position)
        ? null
        : nonEmpty(position.title),
    bookable: truthy(member.bookable),
    // A rating the business hides, or nobody has given, is not passed on.
    rating: shownRating,
    nextFreeDate: nonEmpty(member.seance_date),
  };
}

/** The phone as the create route wants it: a plus and digits only; null when there is no digit. */
function createPhone(raw: string | null | undefined): string | null {
  const digits = (raw ?? '').replace(/\D/g, '');
  return digits === '' ? null : `+${digits}`;
}

/** The name the create sends: `fullname`, else `name` and `surname` joined by one space. */
function createFullname(data: BookingUserData): string | null {
  const full = nonEmpty(data.fullname?.trim());
  if (full !== null) return full;
  const joined = [data.name, data.surname]
    .map((part) => (part ?? '').trim())
    .filter((part) => part !== '')
    .join(' ');
  return joined === '' ? null : joined;
}

export type BookingClientOptions = BookingHttpOptions;

/**
 * The call that tells whether a partner token is real (ADR 0004): the first
 * page of the public business list, one entry. It names no business, so no
 * location can disappear from under it, and it answers 401 for any token
 * Altegio does not know. Not a tool route: compliance rule R7 never sees it.
 */
export const PARTNER_PROBE = Object.freeze({
  method: 'GET',
  route: '/companies',
  query: Object.freeze({ count: 1, page: 1 }),
} as const);

/** What the probe says about a partner token. */
export type PartnerTokenVerdict = 'valid' | 'invalid' | 'unavailable';

export class BookingClient {
  private readonly http: BookingHttp;

  constructor(options: BookingClientOptions) {
    this.http = new BookingHttp(options);
  }

  /** The business card of one location (DISC-01). */
  async company(
    locationId: number,
    call?: UpstreamCallOptions
  ): Promise<BusinessCard> {
    assertLocationId(locationId);
    const { route, method } = BOOKING_ROUTES.company;
    const data = await this.read(
      {
        method,
        route,
        path: `/company/${locationId}`,
        query: { forBooking: 1, showBookforms: 1 },
        ...call,
      },
      companyDataSchema
    );
    return toCard(data);
  }

  /**
   * Services bookable online (DISC-02), in upstream order. Filters: only the
   * services one team member provides (staff_id), only those free at a slot
   * datetime, or only the given services.
   */
  async services(
    locationId: number,
    filter: ServicesFilter = {},
    call?: UpstreamCallOptions
  ): Promise<ServiceCatalog> {
    assertLocationId(locationId);
    if (filter.teamMemberId !== undefined) {
      assertPositiveId(filter.teamMemberId, 'team member id');
    }
    const datetime = checkedDatetime(filter.datetime);
    const serviceIds = checkedServiceIds(filter.serviceIds);
    const { route, method } = BOOKING_ROUTES.services;
    const data = await this.read(
      {
        method,
        route,
        path: `/book_services/${locationId}`,
        // Key order on the wire: staff_id, datetime, then service_ids[].
        query: { staff_id: filter.teamMemberId, datetime },
        serviceIds,
        ...call,
      },
      servicesDataSchema
    );
    return toCatalog(data);
  }

  /**
   * Team members of the business (DISC-03), in upstream order, bookable or
   * not. Filters: only those who provide the given services, or who are free
   * at a slot datetime.
   */
  async teamMembers(
    locationId: number,
    filter: TeamMembersFilter = {},
    call?: UpstreamCallOptions
  ): Promise<TeamMember[]> {
    assertLocationId(locationId);
    const datetime = checkedDatetime(filter.datetime);
    const serviceIds = checkedServiceIds(filter.serviceIds);
    const { route, method } = BOOKING_ROUTES.teamMembers;
    const data = await this.read(
      {
        method,
        route,
        path: `/book_staff/${locationId}`,
        query: { datetime },
        serviceIds,
        ...call,
      },
      teamMembersDataSchema
    );
    return data.map(toTeamMember);
  }

  /**
   * Dates with free time (DISC-04), as booking_dates lists them; sorting and
   * de-duplication are the tool's job. Without dates the business's own
   * booking window applies; date_to is inclusive. Team member 0 or none means
   * any team member, so no staff_id is sent.
   */
  async dates(
    locationId: number,
    filter: DatesFilter = {},
    call?: UpstreamCallOptions
  ): Promise<string[]> {
    assertLocationId(locationId);
    if (filter.teamMemberId !== undefined) {
      assertTeamMemberOrAny(filter.teamMemberId);
    }
    const dateFrom = optionalDate(filter.dateFrom, 'date_from');
    const dateTo = optionalDate(filter.dateTo, 'date_to');
    const serviceIds = checkedServiceIds(filter.serviceIds);
    const staffId =
      filter.teamMemberId !== undefined && filter.teamMemberId > 0
        ? filter.teamMemberId
        : undefined;
    const { route, method } = BOOKING_ROUTES.dates;
    const data = await this.read(
      {
        method,
        route,
        path: `/book_dates/${locationId}`,
        // Key order on the wire: staff_id, date_from, date_to, then service_ids[].
        query: { staff_id: staffId, date_from: dateFrom, date_to: dateTo },
        serviceIds,
        ...call,
      },
      datesDataSchema
    );
    return data.booking_dates;
  }

  /**
   * Free slots on one date (DISC-05), in upstream order. Team member 0 means
   * any team member and is sent as the path segment 0. Each slot keeps the
   * datetime string exactly as the API wrote it.
   */
  async timeSlots(
    locationId: number,
    teamMemberId: number,
    date: string,
    serviceIds: readonly number[],
    call?: UpstreamCallOptions
  ): Promise<TimeSlot[]> {
    assertLocationId(locationId);
    assertTeamMemberOrAny(teamMemberId);
    const day = checkedDate(date, 'date');
    const ids = checkedServiceIds(serviceIds);
    if (ids.length === 0) {
      throw new TypeError('at least one service id is required');
    }
    const { route, method } = BOOKING_ROUTES.timeSlots;
    const data = await this.read(
      {
        method,
        route,
        path: `/book_times/${locationId}/${teamMemberId}/${day}`,
        serviceIds: ids,
        ...call,
      },
      timeSlotsDataSchema
    );
    return data.map((slot) => ({
      time: slot.time,
      datetime: slot.datetime,
      durationSeconds: positiveOrNull(slot.seance_length),
      totalSeconds: positiveOrNull(slot.sum_length),
    }));
  }

  /**
   * Checks one appointment through the validation route (BOOK-01): POST
   * /book_check with exactly one appointment carrying all four keys the
   * controller requires. Resolves only on 201, which means bookable; any
   * other 2xx is contract_drift, and every error kind comes from BookingHttp
   * unchanged (rejected with the 422 codes, not_found, rate_limited after the
   * one inline retry, unavailable). The datetime is sent exactly as given.
   */
  async check(
    locationId: number,
    selection: CheckSelection,
    call?: UpstreamCallOptions
  ): Promise<void> {
    assertLocationId(locationId);
    const serviceIds = checkedServiceIds(selection.serviceIds);
    if (serviceIds.length === 0) {
      throw new TypeError('at least one service id is required');
    }
    assertTeamMemberOrAny(selection.teamMemberId);
    if (parseSlotDatetime(selection.datetime) === null) {
      throw new TypeError('datetime must be an ISO 8601 slot datetime');
    }
    const { route, method } = BOOKING_ROUTES.check;
    const reply = await this.http.send({
      method,
      route,
      path: `/book_check/${locationId}`,
      body: {
        appointments: [
          {
            id: 1,
            services: [...serviceIds],
            staff_id: selection.teamMemberId,
            datetime: selection.datetime,
          },
        ],
      },
      ...call,
    });
    if (reply.status !== 201) {
      throw new UpstreamError('contract_drift', route, {
        status: reply.status,
      });
    }
  }

  /**
   * The signed-in client's own places (ME-02), in upstream order: businesses
   * where they already have records. `call.userToken` is required and goes
   * next to the partner token in the Authorization header. Nothing is sent
   * without it.
   */
  async myPlaces(call: UpstreamCallOptions): Promise<OwnPlace[]> {
    assertUserToken(call.userToken);
    const { route, method } = USER_ROUTES.places;
    const data = await this.read(
      { method, route, path: route, ...call },
      userPlacesDataSchema
    );
    return data.map(toOwnPlace);
  }

  /**
   * The signed-in client's own records (ME-03, ME-04), in upstream order
   * (oldest first). `call.userToken` is required, as for myPlaces.
   */
  async myRecords(call: UpstreamCallOptions): Promise<OwnRecord[]> {
    assertUserToken(call.userToken);
    const { route, method } = USER_ROUTES.records;
    const data = await this.read(
      { method, route, path: route, ...call },
      userRecordsDataSchema
    );
    const records: OwnRecord[] = [];
    for (const entry of data) {
      const record = toOwnRecord(entry);
      if (record !== null) records.push(record);
    }
    return records;
  }

  /**
   * The signed-in client's profile for the create call (ADR 0006, D-02): the
   * name, the phone as a plus and digits, and the e-mail when there is one.
   * Null when the name or the phone is missing, because the create needs both.
   * `call.userToken` is required. The profile is never returned to a tool.
   */
  async myProfile(call: UpstreamCallOptions): Promise<ClientProfile | null> {
    assertUserToken(call.userToken);
    const { route, method } = USER_ROUTES.profile;
    const data = await this.read(
      { method, route, path: route, ...call },
      bookingUserDataSchema
    );
    const fullname = createFullname(data);
    const phone = createPhone(data.phone);
    if (fullname === null || phone === null) return null;
    return { fullname, phone, email: nonEmpty(data.email?.trim()) };
  }

  /**
   * Creates one booking for the signed-in client (ADR 0006, D-02): POST with
   * exactly phone, fullname, the profile's e-mail when it has one, and one
   * appointment. No code (the user token replaces it), comment, notify or api
   * id key. Resolves with the new booking's id; the creation hash is never
   * read. `call.userToken` is required. The datetime is sent exactly as given.
   */
  async createBooking(
    locationId: number,
    selection: CheckSelection,
    profile: ClientProfile,
    call: UpstreamCallOptions
  ): Promise<CreatedBooking> {
    assertUserToken(call.userToken);
    assertLocationId(locationId);
    const serviceIds = checkedServiceIds(selection.serviceIds);
    if (serviceIds.length === 0) {
      throw new TypeError('at least one service id is required');
    }
    assertTeamMemberOrAny(selection.teamMemberId);
    if (parseSlotDatetime(selection.datetime) === null) {
      throw new TypeError('datetime must be an ISO 8601 slot datetime');
    }
    const { route, method } = CLIENT_WRITE_ROUTES.create;
    const reply = await this.http.send({
      method,
      route,
      path: `/book_record/${locationId}`,
      body: {
        phone: profile.phone,
        fullname: profile.fullname,
        ...(profile.email === null ? {} : { email: profile.email }),
        appointments: [
          {
            id: 1,
            services: [...serviceIds],
            staff_id: selection.teamMemberId,
            datetime: selection.datetime,
          },
        ],
      },
      ...call,
    });
    const parsed = bookRecordCreateDataSchema.safeParse(reply.data);
    if (!parsed.success || (reply.status !== 201 && reply.status !== 200)) {
      // Not the documented answer, so whether a booking exists is not known.
      throw new UpstreamError('contract_drift', route, {
        status: reply.status,
        cause: parsed.success ? undefined : parsed.error,
      });
    }
    const entry =
      parsed.data.find((candidate) => candidate.id === 1) ?? parsed.data[0];
    const bookingId = entry?.record_id;
    if (
      typeof bookingId !== 'number' ||
      !Number.isSafeInteger(bookingId) ||
      bookingId <= 0
    ) {
      // A 201 that names no booking created nothing (the fake 201): the
      // anti-fraud path, handed off to the business's booking widget.
      throw new UpstreamError('anti_fraud', route, {
        status: reply.status,
      });
    }
    return { bookingId };
  }

  /**
   * Moves one of the signed-in client's own bookings to a new time (ADR 0006,
   * D-02): PUT on the location and the booking id with exactly `{ datetime }`
   * (no comment, ADR 0006). The answer is a records-list entry that carries
   * the record token, so it is parsed for its shape and never returned. Only a
   * 200 is a move; any other 2xx is contract_drift. `call.userToken` is
   * required. The datetime is sent exactly as given.
   */
  async moveBooking(
    locationId: number,
    bookingId: number,
    datetime: string,
    call: UpstreamCallOptions
  ): Promise<void> {
    assertUserToken(call.userToken);
    assertLocationId(locationId);
    assertPositiveId(bookingId, 'booking id');
    if (parseSlotDatetime(datetime) === null) {
      throw new TypeError('datetime must be an ISO 8601 slot datetime');
    }
    const { route, method } = CLIENT_WRITE_ROUTES.move;
    const reply = await this.http.send({
      method,
      route,
      path: `/book_record/${locationId}/${bookingId}`,
      body: { datetime },
      ...call,
    });
    const parsed = bookRecordMoveDataSchema.safeParse(reply.data);
    if (!parsed.success || reply.status !== 200) {
      // Not the documented answer, so whether the booking moved is not known.
      throw new UpstreamError('contract_drift', route, {
        status: reply.status,
        cause: parsed.success ? undefined : parsed.error,
      });
    }
  }

  /**
   * Cancels one of the signed-in client's own bookings (ADR 0006, D-02):
   * DELETE on the record id with the placeholder hash segment of
   * CANCEL_HASH_SEGMENT and no body. Resolves on a 204 (no body) or a 200;
   * any other 2xx is contract_drift, because whether the booking was cancelled
   * is then not known. `call.userToken` is required. Nothing is retried with a
   * different segment.
   */
  async cancelBooking(
    bookingId: number,
    call: UpstreamCallOptions
  ): Promise<void> {
    assertUserToken(call.userToken);
    assertPositiveId(bookingId, 'booking id');
    const { route, method } = CLIENT_WRITE_ROUTES.cancel;
    const reply = await this.http.send({
      method,
      route,
      path: `/user/records/${bookingId}/${CANCEL_HASH_SEGMENT}`,
      ...call,
    });
    const parsed = userRecordCancelDataSchema.safeParse(reply.data);
    if (!parsed.success || (reply.status !== 204 && reply.status !== 200)) {
      throw new UpstreamError('contract_drift', route, {
        status: reply.status,
        cause: parsed.success ? undefined : parsed.error,
      });
    }
  }

  /**
   * Whether Altegio accepts `partnerToken`: 'invalid' only for a 401 or 403,
   * 'unavailable' for anything that says nothing about the token (a timeout,
   * a 429 or 5xx, a gate that turned the call away, an unexpected status).
   */
  async probePartnerToken(
    partnerToken: string,
    call?: Omit<UpstreamCallOptions, 'partnerToken'>
  ): Promise<PartnerTokenVerdict> {
    try {
      await this.http.send({
        method: PARTNER_PROBE.method,
        route: PARTNER_PROBE.route,
        path: PARTNER_PROBE.route,
        query: PARTNER_PROBE.query,
        ...call,
        partnerToken,
      });
      return 'valid';
    } catch (error) {
      if (error instanceof UpstreamError && error.kind === 'unauthorized') {
        return 'invalid';
      }
      return 'unavailable';
    }
  }

  /** One call, its data parsed by `schema`; a parse failure is contract_drift. */
  private async read<S extends z.ZodType>(
    call: UpstreamCallSpec,
    schema: S
  ): Promise<z.output<S>> {
    const reply = await this.http.send(call);
    const parsed = schema.safeParse(reply.data);
    if (!parsed.success) {
      throw new UpstreamError('contract_drift', call.route, {
        status: reply.status,
        cause: parsed.error,
      });
    }
    return parsed.data;
  }
}
