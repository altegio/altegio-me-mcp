import { UpstreamError } from './errors.js';
import { BookingHttp, type BookingHttpOptions } from './http.js';
import { companyDataSchema, type CompanyData } from './schemas.js';

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

function assertLocationId(locationId: number): void {
  if (!Number.isSafeInteger(locationId) || locationId <= 0) {
    throw new TypeError('location id must be a positive safe integer');
  }
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

export class BookingClient {
  private readonly http: BookingHttp;

  constructor(options: BookingHttpOptions) {
    this.http = new BookingHttp(options);
  }

  /** The business card of one location (DISC-01). */
  async company(locationId: number): Promise<BusinessCard> {
    assertLocationId(locationId);
    const { route, method } = BOOKING_ROUTES.company;
    const reply = await this.http.send({
      method,
      route,
      path: `/company/${locationId}`,
      query: { forBooking: 1, showBookforms: 1 },
    });
    const parsed = companyDataSchema.safeParse(reply.data);
    if (!parsed.success) {
      throw new UpstreamError('contract_drift', route, {
        status: reply.status,
        cause: parsed.error,
      });
    }
    return toCard(parsed.data);
  }
}
