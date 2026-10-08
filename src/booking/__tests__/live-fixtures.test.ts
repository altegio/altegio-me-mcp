import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { z } from 'zod';
import {
  companyDataSchema,
  datesDataSchema,
  servicesDataSchema,
  teamMembersDataSchema,
  timeSlotsDataSchema,
  userPlacesDataSchema,
  userRecordsDataSchema,
} from '../schemas.js';
import {
  createRecordingFetch,
  RECORDED_ROUTES,
  sanitizeRecording,
  SANITIZED_COORDINATE,
  SANITIZED_ID,
  SANITIZED_IMAGE,
  SANITIZED_KEYS,
  SANITIZED_PHONE,
  SANITIZED_TEXT,
  SANITIZED_URL,
  USER_ROUTES,
  type RecordedRoute,
  type Recording,
} from './helpers/live-recorder.js';

// The recordings the live suite writes (ALTEGIO_E2E_RECORD=1 npm run
// test:live) are parsed here by the same route schemas the contract tests
// use, in the required CI job. An absent or empty directory is not an error:
// the recordings exist only after the owner's live run.

const LIVE_DIR = join(
  process.cwd(),
  'src',
  'booking',
  '__tests__',
  'fixtures',
  'live'
);

const TOKEN = 'live-partner-token-0123456789';
const EMAIL_PATTERN = /[\w.+-]+@[\w-]+\.[\w.]+/;

const recordingSchema = z.strictObject({
  recorded_at: z.iso.datetime({ offset: true }),
  route: z.enum(RECORDED_ROUTES),
  status: z.number().int(),
  data: z.unknown(),
});

/**
 * The route schemas the recordings are parsed with. A route that is not
 * listed is reported as having no schema, so a new recorded route cannot pass
 * the guard unparsed. book_check has no data; its status is checked instead.
 */
type DataSchemas = Partial<Record<RecordedRoute, z.ZodType>>;

const DATA_SCHEMAS: DataSchemas = {
  company: companyDataSchema,
  book_services: servicesDataSchema,
  book_staff: teamMembersDataSchema,
  book_dates: datesDataSchema,
  book_times: timeSlotsDataSchema,
  user_yplaces: userPlacesDataSchema,
  user_records: userRecordsDataSchema,
};

const TEAM_MEMBER_NAME = /^Team member \d+$/;

function isUserRoute(route: RecordedRoute): boolean {
  return (USER_ROUTES as readonly string[]).includes(route);
}

function isHashKey(key: string): boolean {
  return (
    (SANITIZED_KEYS.hash as readonly string[]).includes(key) ||
    key.endsWith(SANITIZED_KEYS.hashSuffix) ||
    key.endsWith(SANITIZED_KEYS.tokenSuffix)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A phone value the sanitiser left: empty, or only its placeholder. */
function isSanitizedContact(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return true;
  if (value === SANITIZED_PHONE) return true;
  return (
    Array.isArray(value) &&
    (value as unknown[]).every((item) => item === SANITIZED_PHONE)
  );
}

/** Paths of every phone or phones key whose value is not sanitised. */
function unsanitizedPhones(value: unknown, path = 'data'): string[] {
  if (Array.isArray(value)) {
    return (value as unknown[]).flatMap((item, index) =>
      unsanitizedPhones(item, `${path}[${index}]`)
    );
  }
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, item]) => {
    const here = `${path}.${key}`;
    if ((key === 'phone' || key === 'phones') && !isSanitizedContact(item)) {
      return [here];
    }
    return unsanitizedPhones(item, here);
  });
}

/** Every string leaf under `value` that is neither empty nor the text placeholder. */
function realTextLeaves(value: unknown): boolean {
  if (typeof value === 'string')
    return value !== '' && value !== SANITIZED_TEXT;
  if (Array.isArray(value)) return (value as unknown[]).some(realTextLeaves);
  if (isRecord(value)) return Object.values(value).some(realTextLeaves);
  return false;
}

function isEmptyOr(value: unknown, placeholder: unknown): boolean {
  return value === null || value === undefined || value === placeholder;
}

/**
 * Paths holding a real value under a key the sanitiser replaces (WR-06): the
 * text keys, the company-only title keys, coordinates, `*_account_id` keys and
 * the `name` of every `user` and `position` object, and a team member's own
 * name. On the signed-in routes also hash keys, person ids, every name key of
 * a client object and the name of a staff or master object. Walks the same key
 * lists the sanitiser uses.
 */
function unsanitizedValues(
  route: RecordedRoute,
  value: unknown,
  path = 'data',
  inCompany = false
): string[] {
  if (Array.isArray(value)) {
    return (value as unknown[]).flatMap((item, index) =>
      unsanitizedValues(route, item, `${path}[${index}]`, inCompany)
    );
  }
  if (!isRecord(value)) return [];
  const user = isUserRoute(route);
  const titles = route === 'company' || route === 'user_yplaces' || inCompany;
  const textKeys: readonly string[] = titles
    ? [...SANITIZED_KEYS.text, ...SANITIZED_KEYS.companyText]
    : SANITIZED_KEYS.text;
  const containers: readonly string[] = SANITIZED_KEYS.personContainers;
  const nameKeys: readonly string[] = user ? SANITIZED_KEYS.nameKeys : ['name'];
  return Object.entries(value).flatMap(([key, item]) => {
    const here = `${path}.${key}`;
    if (textKeys.includes(key)) return realTextLeaves(item) ? [here] : [];
    if ((SANITIZED_KEYS.coordinate as readonly string[]).includes(key)) {
      return isEmptyOr(item, SANITIZED_COORDINATE) ? [] : [here];
    }
    if (key.endsWith(SANITIZED_KEYS.idSuffix)) {
      return isEmptyOr(item, SANITIZED_ID) ? [] : [here];
    }
    if (user && isHashKey(key)) {
      return item === '' || isEmptyOr(item, SANITIZED_TEXT) ? [] : [here];
    }
    if (user && (SANITIZED_KEYS.personIds as readonly string[]).includes(key)) {
      return isEmptyOr(item, SANITIZED_ID) ? [] : [here];
    }
    const nested = unsanitizedValues(
      route,
      item,
      here,
      inCompany || (route === 'user_records' && key === 'company')
    );
    const objects = Array.isArray(item) ? (item as unknown[]) : [item];
    const at = (index: number): string =>
      `${here}${Array.isArray(item) ? `[${index}]` : ''}`;
    const found: string[] = [];
    if (containers.includes(key)) {
      objects.forEach((object, index) => {
        if (!isRecord(object)) return;
        for (const nameKey of nameKeys) {
          if (realTextLeaves(object[nameKey])) {
            found.push(`${at(index)}.${nameKey}`);
          }
        }
        if (
          user &&
          (SANITIZED_KEYS.personIdContainers as readonly string[]).includes(
            key
          ) &&
          !isEmptyOr(object.id, SANITIZED_ID)
        ) {
          found.push(`${at(index)}.id`);
        }
      });
    }
    if (
      user &&
      (SANITIZED_KEYS.teamMemberContainers as readonly string[]).includes(key)
    ) {
      objects.forEach((object, index) => {
        if (
          isRecord(object) &&
          !isEmptyOr(object.name, undefined) &&
          !TEAM_MEMBER_NAME.test(String(object.name))
        ) {
          found.push(`${at(index)}.name`);
        }
      });
    }
    return [...nested, ...found];
  });
}

/** Paths of a user_records recording's record ids that are not within 1..n. */
function unrenumberedRecordIds(data: unknown): string[] {
  if (!Array.isArray(data)) return [];
  const count = (data as unknown[]).length;
  return (data as unknown[]).flatMap((record, index) => {
    if (!isRecord(record) || !('id' in record)) return [];
    const id = record.id;
    return typeof id === 'number' &&
      Number.isInteger(id) &&
      id >= 1 &&
      id <= count
      ? []
      : [`data[${index}].id is outside 1..${count}`];
  });
}

/** Paths of a team member's own name when it is not the 'Team member <id>' form. */
function unnamedTeamMembers(data: unknown): string[] {
  if (!Array.isArray(data)) return [];
  return (data as unknown[]).flatMap((member, index) =>
    isRecord(member) &&
    'name' in member &&
    !TEAM_MEMBER_NAME.test(String(member.name))
      ? [`data[${index}].name`]
      : []
  );
}

function liveFiles(): string[] {
  if (!existsSync(LIVE_DIR)) return [];
  return readdirSync(LIVE_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort();
}

/** Every reason one recording file must not be committed. */
function recordingProblems(
  name: string,
  text: string,
  schemas: DataSchemas = DATA_SCHEMAS
): string[] {
  const problems: string[] = [];
  if (EMAIL_PATTERN.test(text)) problems.push(`${name}: e-mail address`);
  const parsed = recordingSchema.safeParse(JSON.parse(text));
  if (!parsed.success) return [...problems, `${name}: not a recording`];
  const { route, status, data } = parsed.data;
  if (name !== `${route}.json`) problems.push(`${name}: holds route ${route}`);
  if (route === 'book_check') {
    if (status !== 201) problems.push(`${name}: status ${status}`);
  } else {
    const schema = schemas[route];
    if (schema === undefined) {
      problems.push(`${name}: no schema registered for ${route}`);
    } else if (!schema.safeParse(data).success) {
      problems.push(`${name}: data does not parse with the ${route} schema`);
    }
  }
  for (const path of unsanitizedPhones(data)) {
    problems.push(`${name}: ${path} is not sanitised`);
  }
  for (const path of unsanitizedValues(route, data)) {
    problems.push(`${name}: ${path} is not a placeholder`);
  }
  if (route === 'book_staff') {
    for (const path of unnamedTeamMembers(data)) {
      problems.push(`${name}: ${path} is not a placeholder`);
    }
  }
  if (route === 'user_records') {
    for (const path of unrenumberedRecordIds(data)) {
      problems.push(`${name}: ${path}`);
    }
  }
  return problems;
}

describe('live recordings under fixtures/live (BAPI-03)', () => {
  it('parse with their route schemas and carry no e-mail address, phone number, name, address, hash or coordinates', () => {
    const files = liveFiles();
    const problems = files.flatMap((name) =>
      recordingProblems(name, readFileSync(join(LIVE_DIR, name), 'utf8'))
    );
    expect(problems).toEqual([]);
    expect(files.length).toBeLessThanOrEqual(RECORDED_ROUTES.length);
  });
});

const companyData = {
  id: 722227,
  title: 'Demo Beauty Studio',
  public_title: 'Demo Beauty Studio',
  short_descr: 'Beauty salon, write to owner@demo-beauty.example',
  address: '12 Example Street',
  timezone: 3,
  timezone_name: 'Asia/Nicosia',
  phone: '+357 99 123456',
  phones: ['+357 99 123456', '+357 99 654321'],
  email: 'owner@demo-beauty.example',
  site: 'https://demo-beauty.example',
  social: { facebook: 'https://facebook.com/demo', instagram: 'demo_ig' },
  description: '<p>Call Anna on +357 99 123456.</p>',
  logo: 'https://assets.alteg.io/company/logo.png',
  company_photos: ['https://assets.alteg.io/company/1.jpg'],
  active: 1,
  show_any_master: true,
  next_slot: '2026-10-05T09:30:00+03:00',
  bookforms: [
    {
      id: 1463903,
      title: 'Online booking',
      is_default: 1,
      url: 'https://n1463903.alteg.io/',
    },
  ],
  default_bookform_url: 'https://n1463903.alteg.io/',
};

const staffData = [
  {
    id: 2098145,
    name: 'Anna Smith',
    specialization: 'Senior stylist',
    position: { id: 11, title: 'Stylist' },
    bookable: true,
    show_rating: 1,
    rating: 4.8,
    avatar: 'https://assets.alteg.io/masters/sm/a/ab/ab12cd.jpg',
    avatar_big: 'https://assets.alteg.io/masters/origin/a/ab/ab12cd.jpg',
    information: '<p>Ten years of colour work. Mobile +357 99 000000.</p>',
    seance_date: '2026-10-05',
  },
  {
    id: 2098146,
    name: 'Maria Lopez',
    specialization: 'Nail artist',
    position: [],
    bookable: false,
    avatar: '',
    information: '',
    seance_date: null,
  },
];

const servicesData = {
  services: [
    {
      id: 10303530,
      title: "Women's haircut",
      category_id: 7,
      price_min: 1500,
      price_max: 2500,
      comment: '<p>Ask Anna at anna@demo-beauty.example.</p>',
      image: 'https://assets.alteg.io/services/1.jpg',
      images: [{ id: 1, path: 'https://assets.alteg.io/services/2.jpg' }],
      prepaid: 'forbidden',
      seance_length: 3600,
      active: 1,
    },
  ],
  category: [{ id: 7, title: 'Hair' }],
  events: [],
};

const datesData = {
  booking_dates: ['2026-10-05', '2026-10-06'],
  booking_days: { '10': [5, 6] },
  working_dates: ['2026-10-05'],
};

const timesData = [
  {
    time: '9:30',
    datetime: '2026-10-05T09:30:00+03:00',
    seance_length: 3600,
    sum_length: 3600,
  },
];

describe('sanitizeRecording', () => {
  it('replaces the contact data of a company card with fixed placeholders', () => {
    const result = sanitizeRecording('company', companyData, [TOKEN]) as Record<
      string,
      unknown
    >;
    expect(result.phone).toBe(SANITIZED_PHONE);
    expect(result.phones).toEqual([SANITIZED_PHONE, SANITIZED_PHONE]);
    expect(result.email).toBe(SANITIZED_TEXT);
    expect(result.site).toBe(SANITIZED_URL);
    expect(result.social).toEqual({
      facebook: SANITIZED_URL,
      instagram: SANITIZED_URL,
    });
    expect(result.description).toBe(SANITIZED_TEXT);
    expect(result.logo).toBe(SANITIZED_IMAGE);
    expect(result.company_photos).toEqual([SANITIZED_IMAGE]);
  });

  it('keeps ids, timezone fields and booking-form URLs of a company card', () => {
    const result = sanitizeRecording('company', companyData, [TOKEN]) as Record<
      string,
      unknown
    >;
    expect(result).toMatchObject({
      id: 722227,
      timezone: 3,
      timezone_name: 'Asia/Nicosia',
      next_slot: '2026-10-05T09:30:00+03:00',
      // A booking form keeps its id and URL; its title may name a person.
      bookforms: [{ ...companyData.bookforms[0], title: SANITIZED_TEXT }],
      default_bookform_url: 'https://n1463903.alteg.io/',
    });
    expect(companyDataSchema.safeParse(result).success).toBe(true);
  });

  it('keeps an empty phone or e-mail empty', () => {
    const result = sanitizeRecording(
      'company',
      { ...companyData, phone: '', phones: [], email: '' },
      [TOKEN]
    ) as Record<string, unknown>;
    expect(result.phone).toBe('');
    expect(result.phones).toEqual([]);
    expect(result.email).toBe('');
  });

  it('removes an e-mail address written into any other text', () => {
    const result = sanitizeRecording('company', companyData, [TOKEN]);
    expect(EMAIL_PATTERN.test(JSON.stringify(result))).toBe(false);
  });

  it('names each team member by id and removes bios and avatars', () => {
    const result = sanitizeRecording('book_staff', staffData, [
      TOKEN,
    ]) as Record<string, unknown>[];
    expect(result.map((member) => member.name)).toEqual([
      'Team member 2098145',
      'Team member 2098146',
    ]);
    expect(result[0]).toMatchObject({
      id: 2098145,
      specialization: 'Senior stylist',
      position: { id: 11, title: 'Stylist' },
      rating: 4.8,
      seance_date: '2026-10-05',
      information: SANITIZED_TEXT,
      avatar: SANITIZED_IMAGE,
      avatar_big: SANITIZED_IMAGE,
    });
    expect(result[1]).toMatchObject({ avatar: '', information: '' });
    expect(teamMembersDataSchema.safeParse(result).success).toBe(true);
  });

  it('removes service comments and images and keeps titles and prices', () => {
    const result = sanitizeRecording('book_services', servicesData, [
      TOKEN,
    ]) as typeof servicesData;
    const [service] = result.services;
    expect(service).toMatchObject({
      id: 10303530,
      title: "Women's haircut",
      price_min: 1500,
      price_max: 2500,
      prepaid: 'forbidden',
      seance_length: 3600,
      comment: SANITIZED_TEXT,
      image: SANITIZED_IMAGE,
      images: [{ id: 1, path: SANITIZED_IMAGE }],
    });
    expect(result.category).toEqual([{ id: 7, title: 'Hair' }]);
    expect(servicesDataSchema.safeParse(result).success).toBe(true);
  });

  it('leaves dates and slot datetimes unchanged', () => {
    expect(sanitizeRecording('book_dates', datesData, [TOKEN])).toEqual(
      datesData
    );
    expect(sanitizeRecording('book_times', timesData, [TOKEN])).toEqual(
      timesData
    );
    expect(sanitizeRecording('book_check', null, [TOKEN])).toBeNull();
  });

  it('replaces the partner token anywhere in the payload with [redacted]', () => {
    const result = sanitizeRecording(
      'company',
      {
        ...companyData,
        short_descr: `Studio ${TOKEN}`,
        extra: { [TOKEN]: TOKEN },
      },
      [TOKEN]
    );
    const text = JSON.stringify(result);
    expect(text).not.toContain(TOKEN);
    expect(text).toContain('Studio [redacted]');
  });

  it('does not change the payload it was given', () => {
    const before = JSON.stringify(staffData);
    sanitizeRecording('book_staff', staffData, [TOKEN]);
    expect(JSON.stringify(staffData)).toBe(before);
  });

  it('removes every name, phone and e-mail of a staff entry, including nested ones (WR-06)', () => {
    const probe = [
      {
        id: 5,
        name: 'Jane Roe',
        user: {
          id: 9,
          name: 'Jane Roe',
          phone: '+1555',
          email: 'a@b.co',
        },
        position: { id: 1, title: 'Senior', name: 'Jane Roe' },
      },
    ];
    const text = JSON.stringify(
      sanitizeRecording('book_staff', probe, [TOKEN])
    );
    expect(text).not.toContain('Jane Roe');
    expect(text).not.toContain('+1555');
    expect(text).not.toContain('a@b.co');
    const [member] = sanitizeRecording('book_staff', probe, [TOKEN]) as Record<
      string,
      Record<string, unknown>
    >[];
    expect(member).toMatchObject({
      name: 'Team member 5',
      user: { id: 9, name: SANITIZED_TEXT, phone: SANITIZED_PHONE },
      position: { id: 1, title: 'Senior', name: SANITIZED_TEXT },
    });
  });

  it('replaces the address, coordinates, owner name, title, schedule and account ids of a company (WR-06)', () => {
    const result = sanitizeRecording(
      'company',
      {
        id: 7,
        address: 'Main St 1',
        zip: '12345',
        coordinate_lat: 52.5,
        coordinate_lon: 13.4,
        master_name: 'Jane Roe',
        title: 'Jane Roe Studio',
        public_title: 'Jane Roe Studio',
        schedule: 'Mon-Fri',
        auto_pay_account_id: 77,
        auto_pay_bank_account_id: 78,
        main_group: { id: 3, title: 'Jane Roe Group' },
        bookforms: [{ id: 1, title: 'Book Jane', url: 'https://n1.alteg.io/' }],
      },
      [TOKEN]
    );
    expect(result).toEqual({
      id: 7,
      address: SANITIZED_TEXT,
      zip: SANITIZED_TEXT,
      coordinate_lat: SANITIZED_COORDINATE,
      coordinate_lon: SANITIZED_COORDINATE,
      master_name: SANITIZED_TEXT,
      title: SANITIZED_TEXT,
      public_title: SANITIZED_TEXT,
      schedule: SANITIZED_TEXT,
      auto_pay_account_id: SANITIZED_ID,
      auto_pay_bank_account_id: SANITIZED_ID,
      main_group: { id: 3, title: SANITIZED_TEXT },
      bookforms: [
        { id: 1, title: SANITIZED_TEXT, url: 'https://n1.alteg.io/' },
      ],
    });
  });

  it('keeps empty address and null account ids empty, and service titles as written', () => {
    const company = sanitizeRecording(
      'company',
      { address: '', zip: '', master_name: '', auto_pay_account_id: null },
      [TOKEN]
    );
    expect(company).toEqual({
      address: '',
      zip: '',
      master_name: '',
      auto_pay_account_id: null,
    });
    const services = sanitizeRecording('book_services', servicesData, [
      TOKEN,
    ]) as typeof servicesData;
    expect(services.services[0]?.title).toBe("Women's haircut");
    expect(services.category).toEqual([{ id: 7, title: 'Hair' }]);
  });
});

describe('the recordings check', () => {
  const real = {
    address: 'Main St 1',
    coordinate_lat: 52.5,
    coordinate_lon: 13.4,
    master_name: 'Jane Roe',
    title: 'Jane Roe Studio',
    public_title: 'Jane Roe Studio',
    schedule: 'Mon-Fri',
    zip: '12345',
    auto_pay_account_id: 77,
    main_group: { id: 3, title: 'Jane Roe Group' },
  };

  it('flags a company recording that still holds a real value for a sanitised key', () => {
    expect(unsanitizedValues('company', real).sort()).toEqual(
      [
        'data.address',
        'data.auto_pay_account_id',
        'data.coordinate_lat',
        'data.coordinate_lon',
        'data.main_group.title',
        'data.master_name',
        'data.public_title',
        'data.schedule',
        'data.title',
        'data.zip',
      ].sort()
    );
  });

  it('flags the name inside user and position of a staff recording', () => {
    const data = [
      {
        id: 5,
        name: 'Team member 5',
        user: { id: 9, name: 'Jane Roe' },
        position: { id: 1, name: 'Jane Roe' },
      },
    ];
    expect(unsanitizedValues('book_staff', data)).toEqual([
      'data[0].user.name',
      'data[0].position.name',
    ]);
    expect(unnamedTeamMembers([{ id: 5, name: 'Jane Roe' }])).toEqual([
      'data[0].name',
    ]);
  });

  it('passes what the sanitiser produced from the same input', () => {
    const company = sanitizeRecording('company', real, [TOKEN]);
    expect(unsanitizedValues('company', company)).toEqual([]);
  });

  it('does not treat a service or category title as a sanitised key', () => {
    expect(unsanitizedValues('book_services', servicesData)).toEqual([]);
  });
});

interface InnerCall {
  input: Parameters<typeof fetch>[0];
  init: Parameters<typeof fetch>[1];
}

function innerFetch(
  status: number,
  body: string,
  calls: InnerCall[]
): typeof fetch {
  return (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ input, init });
    return Promise.resolve(
      new Response(body, {
        status,
        headers: { 'content-type': 'application/json' },
      })
    );
  };
}

const BASE = 'https://api.alteg.io/api/v1';

describe('createRecordingFetch', () => {
  it('passes the request through unchanged and returns the original body', async () => {
    const calls: InnerCall[] = [];
    const body = JSON.stringify({ success: true, data: staffData, meta: [] });
    const recorded: Recording[] = [];
    const wrapped = createRecordingFetch(
      innerFetch(200, body, calls),
      (recording) => recorded.push(recording),
      [TOKEN]
    );
    const url = new URL(`${BASE}/book_staff/722227?service_ids[]=10303530`);
    const init: RequestInit = {
      method: 'GET',
      headers: { Authorization: `Bearer ${TOKEN}` },
    };

    const response = await wrapped(url, init);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe(url);
    expect(calls[0]?.init).toBe(init);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(body);
  });

  it.each([
    ['company', `${BASE}/company/722227?forBooking=1&showBookforms=1`],
    ['book_services', `${BASE}/book_services/722227`],
    ['book_staff', `${BASE}/book_staff/722227?service_ids[]=1`],
    ['book_dates', `${BASE}/book_dates/722227?staff_id=5`],
    ['book_times', `${BASE}/book_times/722227/0/2026-10-05?service_ids[]=1`],
    ['book_check', `${BASE}/book_check/722227`],
  ] as const)(
    'records one %s response with the route taken from the URL path',
    async (route, href) => {
      const recorded: Recording[] = [];
      const wrapped = createRecordingFetch(
        innerFetch(
          200,
          JSON.stringify({ success: true, data: datesData, meta: [] }),
          []
        ),
        (recording) => recorded.push(recording),
        [TOKEN]
      );

      await wrapped(new URL(href));

      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({
        route,
        status: 200,
        data: datesData,
      });
      expect(z.iso.datetime().safeParse(recorded[0]?.recorded_at).success).toBe(
        true
      );
    }
  );

  it('records an empty 201 body of book_check as data null', async () => {
    const recorded: Recording[] = [];
    const wrapped = createRecordingFetch(
      innerFetch(201, '', []),
      (recording) => recorded.push(recording),
      [TOKEN]
    );

    const response = await wrapped(`${BASE}/book_check/722227`, {
      method: 'POST',
    });

    expect(response.status).toBe(201);
    expect(recorded).toEqual([
      {
        recorded_at: expect.any(String) as unknown as string,
        route: 'book_check',
        status: 201,
        data: null,
      },
    ]);
  });

  it('hands the sink sanitised data without the token', async () => {
    const recorded: Recording[] = [];
    const data = [{ ...staffData[0], specialization: `Stylist ${TOKEN}` }];
    const wrapped = createRecordingFetch(
      innerFetch(200, JSON.stringify({ success: true, data, meta: [] }), []),
      (recording) => recorded.push(recording),
      [TOKEN]
    );

    await wrapped(`${BASE}/book_staff/722227`);

    const text = JSON.stringify(recorded);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('Anna Smith');
    expect(text).toContain('Team member 2098145');
  });

  it('records nothing for a path outside the six routes', async () => {
    const recorded: Recording[] = [];
    const wrapped = createRecordingFetch(
      innerFetch(200, '{"data":[]}', []),
      (recording) => recorded.push(recording),
      [TOKEN]
    );

    await wrapped(`${BASE}/book_record/722227`);

    expect(recorded).toEqual([]);
  });
});

// Signed-in routes (plan 04-01, D-02). Every value below is synthetic.

const USER_TOKEN = 'live-user-token-9876543210';

function userRecord(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    hash: 'a1b2c3d4e5f6',
    company: {
      id: 726120,
      title: 'Real Barber',
      public_title: 'Real Barber',
      phone: '+66811111111',
      address: '1 Real Road',
    },
    staff: { id: 11, name: 'Real Person' },
    services: [{ id: 5, title: 'Haircut', cost: 500 }],
    client: {
      name: 'Test Client',
      phone: '+66812345678',
      email: 'client@example.com',
    },
    client_id: 9001,
    comment: 'call me',
    datetime: '2026-10-10T15:00:00+07:00',
    ...overrides,
  };
}

const userRecordsData = [userRecord(41), userRecord(57)];

const userPlacesData = [
  {
    id: 726120,
    title: 'Real Barber',
    public_title: 'Real Barber Phuket',
    address: '1 Real Road',
    city: 'Phuket',
    phone: '+66811111111',
    logo: 'https://assets.alteg.io/real/logo.png',
    coordinate_lat: 7.88,
    coordinate_lon: 98.39,
    active: 1,
  },
];

describe('sanitizeRecording of the signed-in routes', () => {
  it('renumbers record ids to 1..n and replaces hashes, names, contacts and person ids of a record list', () => {
    const result = sanitizeRecording('user_records', userRecordsData, [
      TOKEN,
    ]) as Record<string, unknown>[];
    expect(result).toHaveLength(2);
    expect(result.map((record) => record.id)).toEqual([1, 2]);
    expect(result[0]).toEqual({
      id: 1,
      hash: SANITIZED_TEXT,
      company: {
        id: 726120,
        title: SANITIZED_TEXT,
        public_title: SANITIZED_TEXT,
        phone: SANITIZED_PHONE,
        address: SANITIZED_TEXT,
      },
      staff: { id: 11, name: 'Team member 11' },
      services: [{ id: 5, title: 'Haircut', cost: 500 }],
      client: {
        name: SANITIZED_TEXT,
        phone: SANITIZED_PHONE,
        email: SANITIZED_TEXT,
      },
      client_id: SANITIZED_ID,
      comment: SANITIZED_TEXT,
      datetime: '2026-10-10T15:00:00+07:00',
    });
  });

  it('replaces every hash key, user id and client name key, and the id of a client object', () => {
    const [record] = sanitizeRecording(
      'user_records',
      [
        {
          id: 9,
          hash: 'abc',
          record_hash: 'def',
          user_id: 4,
          customer_account_id: 5,
          client: {
            id: 6,
            fullname: 'A B',
            surname: 'B',
            patronymic: 'C',
            first_name: 'A',
            last_name: 'B',
          },
        },
      ],
      [TOKEN]
    ) as Record<string, unknown>[];
    expect(record).toEqual({
      id: 1,
      hash: SANITIZED_TEXT,
      record_hash: SANITIZED_TEXT,
      user_id: SANITIZED_ID,
      customer_account_id: SANITIZED_ID,
      client: {
        id: SANITIZED_ID,
        fullname: SANITIZED_TEXT,
        surname: SANITIZED_TEXT,
        patronymic: SANITIZED_TEXT,
        first_name: SANITIZED_TEXT,
        last_name: SANITIZED_TEXT,
      },
    });
  });

  it('replaces the record token, the token and the api id of a record, and keeps an empty one empty (recorded shape)', () => {
    const [record, second] = sanitizeRecording(
      'user_records',
      [
        {
          id: 8,
          api_id: '7da483d6-404b-4cd5-8d27-8bc7f1634ca4',
          record_token: 'JeVwT',
          token: 'QfGEL',
          services: [{ id: 5, api_id: '' }],
        },
        { id: 9, api_id: '', token: null },
      ],
      [TOKEN]
    ) as Record<string, unknown>[];
    expect(record).toEqual({
      id: 1,
      api_id: SANITIZED_TEXT,
      record_token: SANITIZED_TEXT,
      token: SANITIZED_TEXT,
      services: [{ id: 5, api_id: '' }],
    });
    expect(second).toEqual({ id: 2, api_id: '', token: null });
  });

  it('names the team member of a master container from its own id and tolerates a PHP empty array', () => {
    const [record] = sanitizeRecording(
      'user_records',
      [
        {
          id: 3,
          master: { id: 12, name: 'Real Person' },
          staff: [],
          client: [],
        },
      ],
      [TOKEN]
    ) as Record<string, unknown>[];
    expect(record).toMatchObject({
      master: { id: 12, name: 'Team member 12' },
      staff: [],
      client: [],
    });
  });

  it('keeps an empty hash, comment and phone empty', () => {
    const [record] = sanitizeRecording(
      'user_records',
      [{ id: 3, hash: '', comment: '', client: { name: '', phone: '' } }],
      [TOKEN]
    ) as Record<string, unknown>[];
    expect(record).toMatchObject({
      hash: '',
      comment: '',
      client: { name: '', phone: '' },
    });
  });

  it('replaces the business, address, phone, logo and coordinates of a place and keeps id, city and active', () => {
    const [place] = sanitizeRecording('user_yplaces', userPlacesData, [
      TOKEN,
    ]) as Record<string, unknown>[];
    expect(place).toEqual({
      id: 726120,
      title: SANITIZED_TEXT,
      public_title: SANITIZED_TEXT,
      address: SANITIZED_TEXT,
      city: 'Phuket',
      phone: SANITIZED_PHONE,
      logo: SANITIZED_IMAGE,
      coordinate_lat: SANITIZED_COORDINATE,
      coordinate_lon: SANITIZED_COORDINATE,
      active: 1,
    });
  });

  it('scrubs the partner token and the user token from every string leaf', () => {
    const result = sanitizeRecording(
      'user_records',
      [userRecord(1, { note: `a ${TOKEN} b ${USER_TOKEN}`, [USER_TOKEN]: 1 })],
      [TOKEN, USER_TOKEN]
    );
    const text = JSON.stringify(result);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(USER_TOKEN);
    expect(text).toContain('a [redacted] b [redacted]');
  });

  it('does not change the payload it was given', () => {
    const before = JSON.stringify(userRecordsData);
    sanitizeRecording('user_records', userRecordsData, [TOKEN]);
    expect(JSON.stringify(userRecordsData)).toBe(before);
  });

  it('leaves the record ids of the six existing routes alone', () => {
    expect(
      sanitizeRecording('book_services', { services: [{ id: 99 }] }, [TOKEN])
    ).toEqual({ services: [{ id: 99 }] });
  });
});

describe('the recordings check of the signed-in routes', () => {
  const anyData = { user_records: z.array(z.looseObject({})) };
  const file = (route: RecordedRoute, data: unknown): string =>
    JSON.stringify({
      recorded_at: '2026-10-08T00:00:00.000Z',
      route,
      status: 200,
      data,
    });

  it('reports the hash, names, phones, e-mail, person ids and real record ids of an unsanitised record list', () => {
    const problems = recordingProblems(
      'user_records.json',
      file('user_records', userRecordsData),
      anyData
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        'user_records.json: e-mail address',
        'user_records.json: data[0].hash is not a placeholder',
        'user_records.json: data[0].client.name is not a placeholder',
        'user_records.json: data[0].client.phone is not sanitised',
        'user_records.json: data[0].company.phone is not sanitised',
        'user_records.json: data[0].company.title is not a placeholder',
        'user_records.json: data[0].client_id is not a placeholder',
        'user_records.json: data[0].staff.name is not a placeholder',
        'user_records.json: data[0].id is outside 1..2',
        'user_records.json: data[1].id is outside 1..2',
      ])
    );
  });

  it('reports a client id, a client name key other than name and a master name', () => {
    const problems = recordingProblems(
      'user_records.json',
      file('user_records', [
        {
          id: 1,
          client: { id: 6, fullname: 'A B' },
          master: { id: 2, name: 'Real Person' },
          record_hash: 'x',
          user_id: 4,
        },
      ]),
      anyData
    );
    expect(problems.sort()).toEqual(
      [
        'user_records.json: data[0].client.fullname is not a placeholder',
        'user_records.json: data[0].client.id is not a placeholder',
        'user_records.json: data[0].master.name is not a placeholder',
        'user_records.json: data[0].record_hash is not a placeholder',
        'user_records.json: data[0].user_id is not a placeholder',
      ].sort()
    );
  });

  it('passes what the sanitiser produced from the same record list and place list', () => {
    expect(
      recordingProblems(
        'user_records.json',
        file(
          'user_records',
          sanitizeRecording('user_records', userRecordsData, [TOKEN])
        ),
        anyData
      )
    ).toEqual([]);
    expect(
      recordingProblems(
        'user_yplaces.json',
        file(
          'user_yplaces',
          sanitizeRecording('user_yplaces', userPlacesData, [TOKEN])
        ),
        { user_yplaces: z.array(z.looseObject({})) }
      )
    ).toEqual([]);
  });

  it('reports a record token, a token and an api id that are not placeholders', () => {
    expect(
      recordingProblems(
        'user_records.json',
        file('user_records', [
          { id: 1, record_token: 'JeVwT', token: 'QfGEL', api_id: 'a-b' },
        ]),
        anyData
      ).sort()
    ).toEqual(
      [
        'user_records.json: data[0].api_id is not a placeholder',
        'user_records.json: data[0].record_token is not a placeholder',
        'user_records.json: data[0].token is not a placeholder',
      ].sort()
    );
  });

  it('reports a place that still holds a real title, address and coordinates', () => {
    expect(unsanitizedValues('user_yplaces', userPlacesData).sort()).toEqual(
      [
        'data[0].address',
        'data[0].coordinate_lat',
        'data[0].coordinate_lon',
        'data[0].public_title',
        'data[0].title',
      ].sort()
    );
  });

  it('keeps a service title of a record list as a legal value', () => {
    expect(
      unsanitizedValues(
        'user_records',
        sanitizeRecording('user_records', userRecordsData, [TOKEN])
      )
    ).toEqual([]);
  });

  it('reports a recording whose route has no registered schema', () => {
    expect(
      recordingProblems(
        'user_records.json',
        file('user_records', [{ id: 1 }]),
        {}
      )
    ).toEqual(['user_records.json: no schema registered for user_records']);
  });
});

describe('createRecordingFetch on the signed-in routes', () => {
  const answer = JSON.stringify({ success: true, data: [], meta: [] });

  it.each([
    ['user_yplaces', `${BASE}/user/companies/yplaces`],
    ['user_records', `${BASE}/user/records`],
    ['user_records', `${BASE}/user/records?page=1`],
    ['company', `${BASE}/company/722227`],
  ] as const)('records %s from %s', async (route, href) => {
    const recorded: Recording[] = [];
    const wrapped = createRecordingFetch(
      innerFetch(200, answer, []),
      (recording) => recorded.push(recording),
      [TOKEN, USER_TOKEN]
    );

    await wrapped(new URL(href));

    expect(recorded.map((recording) => recording.route)).toEqual([route]);
  });

  it.each([
    `${BASE}/user/records/77/abc123`,
    `${BASE}/user/records/`,
    `${BASE}/user/roles`,
    `${BASE}/user/companies/yplaces/5`,
    `${BASE}/user/auth`,
  ])('records nothing for %s', async (href) => {
    const recorded: Recording[] = [];
    const wrapped = createRecordingFetch(
      innerFetch(200, answer, []),
      (recording) => recorded.push(recording),
      [TOKEN, USER_TOKEN]
    );

    await wrapped(new URL(href));

    expect(recorded).toEqual([]);
  });

  it('hands the sink a sanitised, renumbered record list without either token', async () => {
    const recorded: Recording[] = [];
    const data = [userRecord(41, { note: `x ${USER_TOKEN}` })];
    const wrapped = createRecordingFetch(
      innerFetch(200, JSON.stringify({ success: true, data, meta: [] }), []),
      (recording) => recorded.push(recording),
      [TOKEN, USER_TOKEN]
    );

    await wrapped(`${BASE}/user/records`);

    const text = JSON.stringify(recorded);
    expect(text).not.toContain(USER_TOKEN);
    expect(text).not.toContain('Real Person');
    expect(text).not.toContain('a1b2c3d4e5f6');
    expect(recorded[0]?.data).toMatchObject([{ id: 1 }]);
  });
});

describe('contract fixtures of the signed-in routes', () => {
  const read = (route: string): Record<string, { body: { data: unknown } }> =>
    JSON.parse(
      readFileSync(
        join(process.cwd(), 'src', 'booking', '__tests__', 'fixtures', route),
        'utf8'
      )
    ) as Record<string, { body: { data: unknown } }>;

  it('parse with the route schemas in every scenario', () => {
    const places = read('user_yplaces.json');
    const records = read('user_records.json');
    expect(Object.keys(places)).toEqual(['default', 'empty']);
    expect(Object.keys(records)).toEqual(['default', 'empty']);
    for (const scenario of Object.values(places)) {
      expect(userPlacesDataSchema.safeParse(scenario.body.data).success).toBe(
        true
      );
    }
    for (const scenario of Object.values(records)) {
      expect(userRecordsDataSchema.safeParse(scenario.body.data).success).toBe(
        true
      );
    }
  });

  it('use the location, service and team member ids of the default book_* fixtures and carry the bait values', () => {
    const places = userPlacesDataSchema.parse(
      read('user_yplaces.json').default?.body.data
    );
    expect(places.map((place) => place.id)).toEqual([722227, 726120]);
    const records = userRecordsDataSchema.parse(
      read('user_records.json').default?.body.data
    );
    expect(records.map((record) => record.id)).toEqual([1, 2, 3, 4, 5]);
    const text = readFileSync(
      join(
        process.cwd(),
        'src',
        'booking',
        '__tests__',
        'fixtures',
        'user_records.json'
      ),
      'utf8'
    );
    for (const bait of [
      '+15550000001',
      'Fixture Client',
      'fixture.client@example.invalid',
      'fixture-hash-0001',
    ]) {
      expect(text).toContain(bait);
    }
  });
});
