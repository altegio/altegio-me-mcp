import type { z } from 'zod';
import { SLOT_DATETIME_PATTERN } from './deep-link.js';
import { UpstreamError } from './errors.js';
import {
  BookingHttp,
  type BookingHttpOptions,
  type UpstreamCallSpec,
} from './http.js';
import {
  companyDataSchema,
  datesDataSchema,
  servicesDataSchema,
  teamMembersDataSchema,
  timeSlotsDataSchema,
  type CompanyData,
  type ServicesData,
  type TeamMembersData,
} from './schemas.js';

// Typed client of the public Altegio booking API (D-01). The route table is
// the whole surface: six read routes, and never the write route or the
// sign-in route. Every path is built from integers and from dates checked as
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

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A YYYY-MM-DD date that exists in the calendar. It may become a URL path
 * segment, so nothing else passes (T-02-25).
 */
function checkedDate(value: string, label: string): string {
  const match = DATE_PATTERN.exec(value);
  const [, year, month, day] = match ?? [];
  if (year !== undefined && month !== undefined && day !== undefined) {
    const date = new Date(
      Date.UTC(Number(year), Number(month) - 1, Number(day))
    );
    if (
      date.getUTCFullYear() === Number(year) &&
      date.getUTCMonth() === Number(month) - 1 &&
      date.getUTCDate() === Number(day)
    ) {
      return value;
    }
  }
  throw new TypeError(`${label} must be a calendar date in YYYY-MM-DD form`);
}

function optionalDate(
  value: string | undefined,
  label: string
): string | undefined {
  return value === undefined ? undefined : checkedDate(value, label);
}

/** A datetime filter must be a slot datetime as book_times returns it. */
function checkedDatetime(datetime: string | undefined): string | undefined {
  if (datetime !== undefined && !SLOT_DATETIME_PATTERN.test(datetime)) {
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
  return {
    id: member.id,
    name: member.name,
    specialization: nonEmpty(member.specialization),
    positionTitle:
      position === null || position === undefined || Array.isArray(position)
        ? null
        : nonEmpty(position.title),
    bookable: truthy(member.bookable),
    // A rating the business hides in its widget is not passed on.
    rating: ratingShown ? (member.rating ?? null) : null,
    nextFreeDate: nonEmpty(member.seance_date),
  };
}

export class BookingClient {
  private readonly http: BookingHttp;

  constructor(options: BookingHttpOptions) {
    this.http = new BookingHttp(options);
  }

  /** The business card of one location (DISC-01). */
  async company(locationId: number): Promise<BusinessCard> {
    assertLocationId(locationId);
    const { route, method } = BOOKING_ROUTES.company;
    const data = await this.read(
      {
        method,
        route,
        path: `/company/${locationId}`,
        query: { forBooking: 1, showBookforms: 1 },
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
    filter: ServicesFilter = {}
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
    filter: TeamMembersFilter = {}
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
  async dates(locationId: number, filter: DatesFilter = {}): Promise<string[]> {
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
    serviceIds: readonly number[]
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

  /** Stub: replaced in the GREEN step. */
  check(locationId: number, selection: CheckSelection): Promise<void> {
    void selection;
    return Promise.reject(
      new UpstreamError('contract_drift', BOOKING_ROUTES.check.route, {
        status: locationId,
      })
    );
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
