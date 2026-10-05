import { z } from 'zod';
import { parseSlotDatetime } from './deep-link.js';

// Response schemas of the Altegio booking routes, one per route, with the
// real backend keys. Loose on purpose: unknown keys pass the parse, and the
// client maps field by field into its own types, so nothing unread reaches a
// tool result. PHP serialises an empty map as [], so object-valued keys
// accept an array too.

const flag = z.union([z.boolean(), z.number()]);
const text = z.string().nullish();

/** A decimal number written out: no hex, no exponent, no sign other than a leading minus. */
const DECIMAL_PATTERN = /^-?\d+(?:\.\d+)?$/;

/** The widest real UTC offsets, in hours. */
const MAX_UTC_OFFSET_HOURS = 14;

/**
 * UTC offset in hours, may be fractional. The backend sends a number, or a
 * decimal string such as "5.5"; anything else, or a value outside [-14, 14],
 * is unknown (null).
 */
const utcOffsetHours = z
  .union([z.number(), z.string()])
  .nullish()
  .transform((value): number | null => {
    let parsed: number | null = null;
    if (typeof value === 'number') {
      parsed = value;
    } else if (typeof value === 'string') {
      const trimmed = value.trim();
      if (DECIMAL_PATTERN.test(trimmed)) parsed = Number(trimmed);
    }
    return parsed !== null &&
      Number.isFinite(parsed) &&
      Math.abs(parsed) <= MAX_UTC_OFFSET_HOURS
      ? parsed
      : null;
  });

const bookformSchema = z.looseObject({
  id: z.number().int(),
  title: text,
  is_default: flag.nullish(),
  url: text,
});

/**
 * `data` of GET /company/{location_id}?forBooking=1&showBookforms=1. Keys the
 * client does not read (social, phones, position, image_group) stay untyped,
 * so a PHP empty array in any of them can never fail the parse.
 */
export const companyDataSchema = z.looseObject({
  id: z.number().int(),
  title: z.string(),
  public_title: text,
  short_descr: text,
  address: text,
  city: text,
  country: text,
  /** UTC offset in hours as a number or null (see utcOffsetHours). */
  timezone: utcOffsetHours,
  timezone_name: text,
  phone: text,
  site: text,
  /** Widget active, 0 or 1. */
  active: flag.nullish(),
  phone_confirmation: flag.nullish(),
  currency_short_title: text,
  show_any_master: flag.nullish(),
  /** An object, or [] when PHP serialises an empty map. */
  payment_policy: z
    .union([
      z.looseObject({ type: z.union([z.string(), z.number()]).nullish() }),
      z.array(z.unknown()),
    ])
    .nullish(),

  next_slot: text,
  bookforms: z.array(bookformSchema).nullish(),
  default_bookform_url: text,
});

export type CompanyData = z.infer<typeof companyDataSchema>;

/** A JSON number, or a string holding a decimal number ("1500", "4.5"). */
const numeric = z.union([
  z.number(),
  z.string().trim().regex(DECIMAL_PATTERN).transform(Number),
]);

const bookServiceSchema = z.looseObject({
  id: z.number().int(),
  title: z.string(),
  category_id: z.number().int().nullish(),
  /** 0 and 0 mean the business set no price. */
  price_min: numeric.nullish(),
  price_max: numeric.nullish(),
  /** Seconds; null unless the request filters by a team member. */
  seance_length: numeric.nullish(),
  /** forbidden, allowed or required; anything else is unknown. */
  prepaid: z.unknown(),
  /** Absent means active. */
  active: flag.nullish(),
});

const serviceCategorySchema = z.looseObject({
  id: z.number().int(),
  title: text,
});

/**
 * `data` of GET /book_services/{location_id}. Real keys only (seance_length,
 * sex), not the documented session_length and gender. The HTML `comment`
 * stays untyped and is never read.
 */
export const servicesDataSchema = z.looseObject({
  services: z.array(bookServiceSchema),
  category: z.array(serviceCategorySchema),
  /** Always [] for the booking flow; not read. */
  events: z.unknown().optional(),
});

export type ServicesData = z.infer<typeof servicesDataSchema>;

const bookStaffSchema = z.looseObject({
  id: z.number().int(),
  name: z.string(),
  specialization: text,
  /** An object, or [] when PHP serialises an empty map. */
  position: z
    .union([z.looseObject({ title: text }), z.array(z.unknown())])
    .nullish(),
  bookable: flag.nullish(),
  /** 0 when the business hides ratings in its widget. */
  show_rating: flag.nullish(),
  /** 0 both when nobody has rated the team member and when ratings are hidden. */
  rating: numeric.nullish(),
  /** How many clients rated the team member; absent in older payloads. */
  votes_count: numeric.nullish(),
  /** Next date with a free slot, Y-m-d. */
  seance_date: text,
});

/**
 * `data` of GET /book_staff/{location_id}: an array of team members. The HTML
 * `information` bio and the avatar stay untyped and are never read.
 */
export const teamMembersDataSchema = z.array(bookStaffSchema);

export type TeamMembersData = z.infer<typeof teamMembersDataSchema>;

/** A calendar date as the booking routes write it, Y-m-d. */
const bookingDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * `data` of GET /book_dates/{location_id}. Only `booking_dates` is read. The
 * month-keyed `booking_days` and the working days stay untyped, because PHP
 * sends an empty map as [] and the client never uses them.
 */
export const datesDataSchema = z.looseObject({
  booking_dates: z.array(bookingDate),
  booking_days: z.unknown().optional(),
  working_dates: z.unknown().optional(),
  working_days: z.unknown().optional(),
});

export type DatesData = z.infer<typeof datesDataSchema>;

const bookTimeSchema = z.looseObject({
  /** G:i, for example 9:30; kept, never used for display. */
  time: z.string(),
  /**
   * ISO 8601 with offset (PHP `c`), for example 2026-10-05T09:30:00+03:00.
   * It must split into in-range parts, because tools display its digits and
   * book_check and the deep link take it unchanged.
   */
  datetime: z.string().refine((value) => parseSlotDatetime(value) !== null, {
    message: 'datetime must be an ISO 8601 slot datetime',
  }),
  /** Seconds. */
  seance_length: numeric.nullish(),
  /** Seconds, including any extra time after the service. */
  sum_length: numeric.nullish(),
});

/** `data` of GET /book_times/{location_id}/{team_member_id}/{date}: an array of free slots. */
export const timeSlotsDataSchema = z.array(bookTimeSchema);

export type TimeSlotsData = z.infer<typeof timeSlotsDataSchema>;
