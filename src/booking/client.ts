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
  servicesDataSchema,
  teamMembersDataSchema,
  type CompanyData,
  type ServicesData,
  type TeamMembersData,
} from './schemas.js';

// Typed client of the public Altegio booking API (D-01). The route table is
// the whole surface: six read routes, and never the write route or the
// sign-in route. Every path is built from integers only, so no model-supplied
// string reaches a URL path.

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

  dates(_locationId: number, _filter: DatesFilter = {}): Promise<string[]> {
    return Promise.reject(new Error('not implemented'));
  }

  timeSlots(
    _locationId: number,
    _teamMemberId: number,
    _date: string,
    _serviceIds: readonly number[]
  ): Promise<TimeSlot[]> {
    return Promise.reject(new Error('not implemented'));
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
