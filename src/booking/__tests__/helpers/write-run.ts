import { scrubSecrets } from '../../../observability/redact.js';

// Helpers of the live write suite (plan 04.1-01): the phone and the name sent
// to the create route, and the sanitised record of a refused call. They keep
// the suite's own file about the steps, and they are unit-tested in
// write-run.test.ts because the suite itself runs only on the owner's machine.

/** What a refused call leaves in the run record: no body, no personal data. */
export interface ErrorRecord {
  status: number;
  /** The API error code (431-437 on the create route), when the body has one. */
  code: number | null;
  message: string;
  errors: { code: number | null; message: string }[];
  /** The messages by field, when `meta.errors` is an object keyed by field. */
  fields: Record<string, string[]>;
  /** Set for a 422 that names a required field; `required_fields` lists them. */
  kind?: 'required_field';
  required_fields?: string[];
}

/** The body of the create call. */
export interface CreateInput {
  phone: string;
  fullname: string;
  email: string;
  serviceId: number;
  staffId: number;
  datetime: string;
}

/**
 * The profile's e-mail when it is a non-empty text, else ''. Nothing else is
 * ever sent as `email`: some businesses' booking forms require one even for a
 * signed-in client (error "The required parameter email was not passed"), so
 * the create call sends the profile's when it has one.
 */
export function emailOf(profile: Record<string, unknown>): string {
  return textOf(profile.email);
}

/**
 * The exact body of the create call: phone, fullname, `email` only when there
 * is one, and one appointment. No code (the user token replaces it), comment,
 * notify or api_id key.
 */
export function createBody(input: CreateInput): Record<string, unknown> {
  return {
    phone: input.phone,
    fullname: input.fullname,
    ...(input.email === '' ? {} : { email: input.email }),
    appointments: [
      {
        id: 1,
        services: [input.serviceId],
        staff_id: input.staffId,
        datetime: input.datetime,
      },
    ],
  };
}

// Pair helpers of plan 05-01 (RED stubs; the implementation follows).

/** One appointment of a pair: the services and the explicit team member. */
export interface PairAppointment {
  serviceIds: number[];
  staffId: number;
}

/** The body of the pair create call. */
export interface PairCreateInput {
  phone: string;
  fullname: string;
  email: string;
  first: PairAppointment;
  second: PairAppointment;
  datetime: string;
}

export function createPairBody(
  _input: PairCreateInput
): Record<string, unknown> {
  throw new Error('not implemented');
}

export function commonSlots(
  _first: readonly string[],
  _second: readonly string[]
): string[] {
  return ['not implemented'];
}

export function createdRecordIds(_data: unknown): {
  first: number | null;
  second: number | null;
} {
  return { first: 0, second: 0 };
}

const REMOVED = '[removed]';
const MAX_MESSAGE_LENGTH = 300;
const EMAIL_PATTERN = /[\w.+-]+@[\w-]+\.[\w.]+/g;
/** Seven or more digits, with the separators a phone is written with. */
const PHONE_PATTERN = /\+?\d[\d\s().-]{6,}\d/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * The phone as the create route wants it: a plus and digits only, whatever
 * separators the profile used (the profile answers with bare digits, the
 * contract wants +<digits>; a missing plus is error 431). An empty result
 * means there is no usable phone.
 */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  return digits === '' ? '' : `+${digits}`;
}

/**
 * The name sent to the create route: the profile's `fullname` when it has one,
 * else its `name` and `surname` joined by one space (either may be missing).
 */
export function fullnameOf(profile: Record<string, unknown>): string {
  const full = textOf(profile.fullname);
  if (full !== '') return full;
  return [textOf(profile.name), textOf(profile.surname)]
    .filter((part) => part !== '')
    .join(' ');
}

function escapeForPattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Removes every secret from a text: the tokens in their encoded forms, then
 * any e-mail address and phone-like number, then each given value (and each
 * word of three letters or more of a multi-word value), case-insensitively and
 * only as a whole word, so a short name does not damage other words.
 */
function redact(text: string, secrets: readonly string[]): string {
  let result = scrubSecrets(text, secrets)
    .replace(EMAIL_PATTERN, REMOVED)
    .replace(PHONE_PATTERN, REMOVED);
  const needles = new Set<string>();
  for (const secret of secrets) {
    const value = secret.trim();
    if (value.length < 2) continue;
    needles.add(value);
    for (const word of value.split(/\s+/)) {
      if (word.length >= 3) needles.add(word);
    }
  }
  for (const needle of [...needles].sort((a, b) => b.length - a.length)) {
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}])${escapeForPattern(needle)}(?![\\p{L}\\p{N}])`,
      'giu'
    );
    result = result.replace(pattern, REMOVED);
  }
  return result;
}

function codeOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

/** A field message that says the field is required, as in "The required parameter email was not passed." */
const REQUIRED_PATTERN = /\brequired\b|was not passed/i;
const MAX_FIELDS = 20;
const MAX_FIELD_MESSAGES = 10;
const MAX_FIELD_NAME_LENGTH = 60;

function cleanMessage(value: unknown, secrets: readonly string[]): string {
  return redact(textOf(value), secrets).slice(0, MAX_MESSAGE_LENGTH);
}

/** A field name without the brackets the backend writes around it, as in `[phone]`. */
function fieldName(key: string, secrets: readonly string[]): string {
  return redact(key.replace(/[[\]]/g, '').trim(), secrets).slice(
    0,
    MAX_FIELD_NAME_LENGTH
  );
}

/** The messages of one field: a list of texts, or one text; anything else is dropped. */
function fieldMessages(value: unknown, secrets: readonly string[]): string[] {
  const items = Array.isArray(value) ? (value as unknown[]) : [value];
  return items
    .filter((item): item is string => typeof item === 'string')
    .slice(0, MAX_FIELD_MESSAGES)
    .map((item) => cleanMessage(item, secrets));
}

/**
 * The record of a refused call: its status, the API error code, the envelope's
 * `meta.message` and `meta.errors`, with `secrets` (tokens, hash, phone, name)
 * and any e-mail or phone-like number removed. `meta.errors` is kept in either
 * of the shapes the backend uses: a list of `{code, message}` (or of texts), or
 * an object keyed by field (`{"[phone]": ["..."]}`), which is recorded per field
 * with the brackets stripped. A 422 with a required-field message in `fields` also
 * gets `kind: 'required_field'` and the `required_fields` names (plan 04.1-02
 * keys its in-band fallback on it). The code is `meta.code`, else the first code of
 * `meta.errors`, else a numeric `code` at the top level, else null. A body that
 * is not a JSON envelope leaves nothing but the status.
 */
export function describeError(
  status: number,
  body: string,
  secrets: readonly string[]
): ErrorRecord {
  const empty: ErrorRecord = {
    status,
    code: null,
    message: '',
    errors: [],
    fields: {},
  };
  let envelope: unknown;
  try {
    envelope = JSON.parse(body);
  } catch {
    return empty;
  }
  if (!isRecord(envelope)) return empty;
  const meta = isRecord(envelope.meta) ? envelope.meta : {};
  const raw = meta.errors;
  const errors: ErrorRecord['errors'] = [];
  const fields: Record<string, string[]> = {};
  if (Array.isArray(raw)) {
    for (const entry of raw as unknown[]) {
      if (isRecord(entry)) {
        errors.push({
          code: codeOf(entry.code),
          message: cleanMessage(entry.message, secrets),
        });
      } else if (typeof entry === 'string') {
        errors.push({ code: null, message: cleanMessage(entry, secrets) });
      }
    }
  } else if (typeof raw === 'string') {
    errors.push({ code: null, message: cleanMessage(raw, secrets) });
  } else if (isRecord(raw)) {
    for (const [key, value] of Object.entries(raw).slice(0, MAX_FIELDS)) {
      fields[fieldName(key, secrets)] = fieldMessages(value, secrets);
    }
  }
  const required =
    status === 422
      ? Object.entries(fields)
          .filter(([, messages]) =>
            messages.some((message) => REQUIRED_PATTERN.test(message))
          )
          .map(([name]) => name)
      : [];
  return {
    status,
    code:
      codeOf(meta.code) ??
      errors.find((entry) => entry.code !== null)?.code ??
      codeOf(envelope.code),
    message: cleanMessage(meta.message, secrets),
    errors,
    fields,
    ...(required.length === 0
      ? {}
      : { kind: 'required_field' as const, required_fields: required }),
  };
}
