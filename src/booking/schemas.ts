import { z } from 'zod';

// Response schemas of the Altegio booking routes, one per route, with the
// real backend keys. Loose on purpose: unknown keys pass the parse, and the
// client maps field by field into its own types, so nothing unread reaches a
// tool result. PHP serialises an empty map as [], so object-valued keys
// accept an array too.

const flag = z.union([z.boolean(), z.number()]);
const text = z.string().nullish();

/**
 * UTC offset in hours, may be fractional. The backend sends a number, or a
 * numeric string such as "5.5"; anything else is unknown (null).
 */
const utcOffsetHours = z
  .union([z.number(), z.string()])
  .nullish()
  .transform((value): number | null => {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
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
