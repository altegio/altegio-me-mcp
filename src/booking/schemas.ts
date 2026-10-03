import { z } from 'zod';

// Response schemas of the Altegio booking routes, one per route, with the
// real backend keys. Loose on purpose: unknown keys pass the parse, and the
// client maps field by field into its own types, so nothing unread reaches a
// tool result. PHP serialises an empty map as [], so object-valued keys
// accept an array too.

const flag = z.union([z.boolean(), z.number()]);
const text = z.string().nullish();

const bookformSchema = z.looseObject({
  id: z.number().int(),
  title: text,
  is_default: flag.nullish(),
  url: text,
});

/** `data` of GET /company/{location_id}?forBooking=1&showBookforms=1. */
export const companyDataSchema = z.looseObject({
  id: z.number().int(),
  title: z.string(),
  public_title: text,
  short_descr: text,
  address: text,
  city: text,
  country: text,
  /** UTC offset in hours, may be fractional. */
  timezone: z.union([z.number(), z.string()]).nullish(),
  timezone_name: text,
  phone: text,
  site: text,
  /** Widget active, 0 or 1. */
  active: flag.nullish(),
  phone_confirmation: flag.nullish(),
  currency_short_title: text,
  show_any_master: flag.nullish(),
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
