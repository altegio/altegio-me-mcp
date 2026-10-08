import { scrubSecrets } from '../../../observability/redact.js';

// Recording fetch wrapper and sanitiser for the live suite (plan 02-09, D-10).
// Real responses become committed fixtures, so everything that could identify
// a person or reach one is replaced with a fixed placeholder before a
// recording leaves memory: phones, e-mails, sites and social links, the names
// of team members and of the people nested in them, addresses, coordinates,
// business and booking-form titles, account ids, free-text bios and comments,
// and image URLs (T-02-31, T-03-05). The partner token is scrubbed last,
// anywhere in the payload (T-02-30). Ids (except account ids), service and
// category titles, prices, dates, slot datetimes, booking-form URLs and
// timezone fields stay as the API wrote them, because the route schemas and the
// deep link read exactly those.
//
// The two signed-in routes (plan 04-01, D-02) add record hashes (a hash lets
// its holder cancel the booking), person ids, the names of the client and of
// the team member, and the business titles inside a record; both the partner
// and the user token are scrubbed, and record ids become 1..n.

/** The six booking routes, named as their URL path segment. */
const BOOKING_ROUTES = [
  'company',
  'book_services',
  'book_staff',
  'book_dates',
  'book_times',
  'book_check',
] as const;

/**
 * The two signed-in routes, named for the file they are recorded to. They are
 * recognised by their exact path (`/user/companies/yplaces`, `/user/records`),
 * never by a segment followed by an id.
 */
export const USER_ROUTES = ['user_yplaces', 'user_records'] as const;

/** Every recorded route; one committed file per route. */
export const RECORDED_ROUTES = [...BOOKING_ROUTES, ...USER_ROUTES] as const;

export type RecordedRoute = (typeof RECORDED_ROUTES)[number];

export interface Recording {
  recorded_at: string;
  route: RecordedRoute;
  status: number;
  data: unknown;
}

export const SANITIZED_PHONE = '+10000000000';
export const SANITIZED_TEXT = '[removed]';
export const SANITIZED_URL = 'https://example.invalid/';
export const SANITIZED_IMAGE = 'https://example.invalid/image.png';
export const SANITIZED_COORDINATE = 0;
export const SANITIZED_ID = 0;

/**
 * The keys whose values the sanitiser replaces, by placeholder family. The CI
 * test over the committed recordings (live-fixtures.test.ts) walks the same
 * lists, so a key added here is enforced there.
 */
export const SANITIZED_KEYS = {
  /** Replaced with SANITIZED_TEXT wherever they occur. */
  text: ['address', 'zip', 'master_name', 'schedule'],
  /**
   * Replaced with SANITIZED_TEXT in a `company` recording only: there they name
   * the business (for a sole proprietor, the person) and its booking forms.
   * Elsewhere `title` is a service, category or position name that the route
   * schemas and the deep link read, so it stays.
   */
  companyText: ['title', 'public_title'],
  /** Replaced with SANITIZED_COORDINATE. */
  coordinate: ['coordinate_lat', 'coordinate_lon'],
  /** Every key ending in this is replaced with SANITIZED_ID. */
  idSuffix: '_account_id',
  /** Objects whose `name` is a person's name, replaced with SANITIZED_TEXT. */
  personContainers: ['user', 'position', 'client'],
  /**
   * Signed-in routes: record hashes and tokens (a hash or token lets its
   * holder reach or cancel the booking) and record api ids. Keys equal to these,
   * or ending in `hashSuffix` or `tokenSuffix`, are replaced with SANITIZED_TEXT.
   */
  hash: ['hash', 'token', 'api_id'],
  hashSuffix: '_hash',
  tokenSuffix: '_token',
  /** Signed-in routes: replaced with SANITIZED_ID. */
  personIds: ['client_id', 'user_id'],
  /** Signed-in routes: objects whose `id` is a person id. */
  personIdContainers: ['client'],
  /** Signed-in routes: the name keys of a person container. */
  nameKeys: [
    'name',
    'fullname',
    'surname',
    'patronymic',
    'first_name',
    'last_name',
  ],
  /** Signed-in routes: objects whose `name` becomes 'Team member <id>'. */
  teamMemberContainers: ['staff', 'master'],
} as const;

const EMAIL_PATTERN = /[\w.+-]+@[\w-]+\.[\w.]+/g;

/** Keys whose non-empty values are phone numbers. */
const PHONE_KEYS: ReadonlySet<string> = new Set(['phone', 'phones']);
/** Keys whose non-empty values are e-mail addresses. */
const EMAIL_KEYS: ReadonlySet<string> = new Set(['email']);
/** Keys whose string leaves are links to the business's own pages. */
const LINK_KEYS: ReadonlySet<string> = new Set(['site', 'social']);
/** Free text a business or team member writes (often HTML). */
const TEXT_KEYS: ReadonlySet<string> = new Set([
  'information',
  'description',
  'comment',
  ...SANITIZED_KEYS.text,
]);
/** Business and booking-form titles: replaced in a company recording only. */
const COMPANY_TEXT_KEYS: ReadonlySet<string> = new Set([
  ...TEXT_KEYS,
  ...SANITIZED_KEYS.companyText,
]);
/** Keys whose values are a position on the map. */
const COORDINATE_KEYS: ReadonlySet<string> = new Set(SANITIZED_KEYS.coordinate);
/** Keys whose objects carry the name of a person. */
const PERSON_CONTAINER_KEYS: ReadonlySet<string> = new Set(
  SANITIZED_KEYS.personContainers
);
/** Signed-in routes: keys that are a person's id. */
const PERSON_ID_KEYS: ReadonlySet<string> = new Set(SANITIZED_KEYS.personIds);
/** Signed-in routes: objects whose `id` is a person's id. */
const PERSON_ID_CONTAINER_KEYS: ReadonlySet<string> = new Set(
  SANITIZED_KEYS.personIdContainers
);
/** Signed-in routes: objects holding a team member, named by their own id. */
const TEAM_MEMBER_CONTAINER_KEYS: ReadonlySet<string> = new Set(
  SANITIZED_KEYS.teamMemberContainers
);
/** Keys whose string leaves are image URLs. */
const IMAGE_KEYS: ReadonlySet<string> = new Set([
  'avatar',
  'avatar_big',
  'logo',
  'image',
  'images',
  'photo',
  'photos',
  'company_photos',
  'image_group',
]);

/** Signed-in routes by exact path suffix; the per-record route has more after it. */
const USER_ROUTE_PATHS: ReadonlyMap<string, RecordedRoute> = new Map([
  ['/user/companies/yplaces', 'user_yplaces'],
  ['/user/records', 'user_records'],
]);

const ROUTE_PATTERN = new RegExp(`/(${BOOKING_ROUTES.join('|')})/\\d+(?:/|$)`);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

/** Every non-empty string leaf becomes `placeholder`; numbers, flags and keys stay. */
function replaceLeaves(value: unknown, placeholder: string): unknown {
  if (typeof value === 'string') return value === '' ? '' : placeholder;
  if (Array.isArray(value)) {
    return (value as unknown[]).map((item) => replaceLeaves(item, placeholder));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        replaceLeaves(item, placeholder),
      ])
    );
  }
  return value;
}

/** A phone value: each entry of a list, or the value itself, becomes the placeholder. */
function sanitizePhone(value: unknown): unknown {
  if (isEmpty(value)) return value;
  if (Array.isArray(value)) {
    return (value as unknown[]).map(() => SANITIZED_PHONE);
  }
  return SANITIZED_PHONE;
}

/** Applies `change` to an object, or to each object of a list. */
function mapObjects(
  value: unknown,
  change: (object: Record<string, unknown>) => Record<string, unknown>
): unknown {
  if (Array.isArray(value)) {
    return (value as unknown[]).map((item) => mapObjects(item, change));
  }
  return isRecord(value) ? change(value) : value;
}

/** Each non-empty name key of a person object becomes the text placeholder. */
function renameNested(value: unknown, nameKeys: readonly string[]): unknown {
  return mapObjects(value, (object) => {
    const renamed = { ...object };
    for (const nameKey of nameKeys) {
      if (!isEmpty(renamed[nameKey])) renamed[nameKey] = SANITIZED_TEXT;
    }
    return renamed;
  });
}

/** The name of a staff or master object becomes 'Team member <id>'. */
function nameTeamMember(value: unknown): unknown {
  return mapObjects(value, (object) => {
    if (isEmpty(object.name)) return object;
    const id = /^\d+$/.test(String(object.id)) ? String(object.id) : '0';
    return { ...object, name: `Team member ${id}` };
  });
}

/** The id of a client object is a person id. */
function clearPersonId(value: unknown): unknown {
  return mapObjects(value, (object) =>
    isEmpty(object.id) ? object : { ...object, id: SANITIZED_ID }
  );
}

/** What a recording of one route is sanitised with. */
interface Context {
  /** The keys whose values are replaced with the text placeholder. */
  textKeys: ReadonlySet<string>;
  /** The signed-in rules: hashes, person ids, client names, team members. */
  user: boolean;
  /** The keys applied inside a `company` object, when they differ. */
  companyKeys: ReadonlySet<string> | null;
}

function sanitizeValue(
  key: string | null,
  value: unknown,
  context: Context
): unknown {
  const { textKeys, user } = context;
  if (key !== null) {
    if (PHONE_KEYS.has(key)) return sanitizePhone(value);
    if (EMAIL_KEYS.has(key) || textKeys.has(key)) {
      return isEmpty(value) ? value : replaceLeaves(value, SANITIZED_TEXT);
    }
    if (LINK_KEYS.has(key)) return replaceLeaves(value, SANITIZED_URL);
    if (IMAGE_KEYS.has(key)) return replaceLeaves(value, SANITIZED_IMAGE);
    if (COORDINATE_KEYS.has(key)) {
      return isEmpty(value) ? value : SANITIZED_COORDINATE;
    }
    if (key.endsWith(SANITIZED_KEYS.idSuffix)) {
      return isEmpty(value) ? value : SANITIZED_ID;
    }
    if (user) {
      if (
        (SANITIZED_KEYS.hash as readonly string[]).includes(key) ||
        key.endsWith(SANITIZED_KEYS.hashSuffix) ||
        key.endsWith(SANITIZED_KEYS.tokenSuffix)
      ) {
        return isEmpty(value) ? value : replaceLeaves(value, SANITIZED_TEXT);
      }
      if (PERSON_ID_KEYS.has(key)) {
        return isEmpty(value) ? value : SANITIZED_ID;
      }
    }
  }
  if (typeof value === 'string') {
    // An address typed into any other text is removed as well.
    return value.replace(EMAIL_PATTERN, SANITIZED_TEXT);
  }
  if (Array.isArray(value)) {
    return (value as unknown[]).map((item) =>
      sanitizeValue(null, item, context)
    );
  }
  if (isRecord(value)) {
    const cleaned = Object.fromEntries(
      Object.entries(value).map(([childKey, item]) => [
        childKey,
        sanitizeValue(
          childKey,
          item,
          childKey === 'company' && context.companyKeys !== null
            ? { ...context, textKeys: context.companyKeys }
            : context
        ),
      ])
    );
    return key === null ? cleaned : sanitizeContainer(key, cleaned, user);
  }
  return value;
}

/** A person, client or team member object, once its children are sanitised. */
function sanitizeContainer(
  key: string,
  cleaned: Record<string, unknown>,
  user: boolean
): unknown {
  let result: unknown = cleaned;
  if (PERSON_CONTAINER_KEYS.has(key)) {
    result = renameNested(result, user ? SANITIZED_KEYS.nameKeys : ['name']);
  }
  if (user && PERSON_ID_CONTAINER_KEYS.has(key)) result = clearPersonId(result);
  if (user && TEAM_MEMBER_CONTAINER_KEYS.has(key)) {
    result = nameTeamMember(result);
  }
  return result;
}

/** book_staff entries: the name is a person's name, so it becomes 'Team member <id>'. */
function renameTeamMembers(data: unknown): unknown {
  if (!Array.isArray(data)) return data;
  return (data as unknown[]).map((member) =>
    isRecord(member) && 'name' in member
      ? { ...member, name: `Team member ${String(member.id)}` }
      : member
  );
}

/** user_records entries: the record ids become 1..n in recorded order, so no real id is kept. */
function renumberRecords(data: unknown): unknown {
  if (!Array.isArray(data)) return data;
  return (data as unknown[]).map((record, index) =>
    isRecord(record) && 'id' in record ? { ...record, id: index + 1 } : record
  );
}

/**
 * A copy of `data` safe to commit: contact data, names (also inside nested user
 * and position objects), addresses, coordinates, business titles, account ids,
 * free text and image URLs replaced with fixed placeholders, then every secret
 * scrubbed. The input is not changed.
 */
export function sanitizeRecording(
  route: RecordedRoute,
  data: unknown,
  secrets: readonly string[]
): unknown {
  const user = (USER_ROUTES as readonly string[]).includes(route);
  const titled = route === 'company' || route === 'user_yplaces';
  let result = sanitizeValue(null, data, {
    textKeys: titled ? COMPANY_TEXT_KEYS : TEXT_KEYS,
    user,
    // A business inside a booking is named by its title, a service is not.
    companyKeys: route === 'user_records' ? COMPANY_TEXT_KEYS : null,
  });
  if (route === 'book_staff') result = renameTeamMembers(result);
  if (route === 'user_records') result = renumberRecords(result);
  return scrubSecrets(result, secrets);
}

function urlOf(input: Parameters<typeof fetch>[0]): URL | null {
  try {
    if (input instanceof URL) return input;
    if (typeof input === 'string') return new URL(input);
    return new URL(input.url);
  } catch {
    return null;
  }
}

function routeOf(url: URL | null): RecordedRoute | null {
  if (url === null) return null;
  for (const [suffix, route] of USER_ROUTE_PATHS) {
    if (url.pathname.endsWith(suffix)) return route;
  }
  const match = ROUTE_PATTERN.exec(url.pathname);
  return match === null ? null : (match[1] as RecordedRoute);
}

/** envelope.data of a body; null for an empty or non-JSON body. */
function envelopeData(text: string): unknown {
  if (text === '') return null;
  try {
    const envelope: unknown = JSON.parse(text);
    return isRecord(envelope) ? (envelope.data ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * Wraps `inner`: the request goes through unchanged and the caller gets the
 * original response. For each response of one of the recorded routes, `sink`
 * receives the route, the status and the sanitised envelope data.
 */
export function createRecordingFetch(
  inner: typeof fetch,
  sink: (recording: Recording) => void,
  secrets: readonly string[]
): typeof fetch {
  return async (input, init) => {
    const response = await inner(input, init);
    const route = routeOf(urlOf(input));
    if (route !== null) {
      const text = await response.clone().text();
      sink({
        recorded_at: new Date().toISOString(),
        route,
        status: response.status,
        data: sanitizeRecording(route, envelopeData(text), secrets),
      });
    }
    return response;
  };
}
