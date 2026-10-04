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

const DATA_SCHEMAS: Record<Exclude<RecordedRoute, 'book_check'>, z.ZodType> = {
  company: companyDataSchema,
  book_services: servicesDataSchema,
  book_staff: teamMembersDataSchema,
  book_dates: datesDataSchema,
  book_times: timeSlotsDataSchema,
};

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
 * name. Walks the same key lists the sanitiser uses.
 */
function unsanitizedValues(
  route: RecordedRoute,
  value: unknown,
  path = 'data'
): string[] {
  if (Array.isArray(value)) {
    return (value as unknown[]).flatMap((item, index) =>
      unsanitizedValues(route, item, `${path}[${index}]`)
    );
  }
  if (!isRecord(value)) return [];
  const textKeys: readonly string[] =
    route === 'company'
      ? [...SANITIZED_KEYS.text, ...SANITIZED_KEYS.companyText]
      : SANITIZED_KEYS.text;
  const containers: readonly string[] = SANITIZED_KEYS.personContainers;
  return Object.entries(value).flatMap(([key, item]) => {
    const here = `${path}.${key}`;
    if (textKeys.includes(key)) return realTextLeaves(item) ? [here] : [];
    if ((SANITIZED_KEYS.coordinate as readonly string[]).includes(key)) {
      return isEmptyOr(item, SANITIZED_COORDINATE) ? [] : [here];
    }
    if (key.endsWith(SANITIZED_KEYS.idSuffix)) {
      return isEmptyOr(item, SANITIZED_ID) ? [] : [here];
    }
    const nested = unsanitizedValues(route, item, here);
    if (containers.includes(key)) {
      const objects = Array.isArray(item) ? (item as unknown[]) : [item];
      const names = objects.flatMap((object, index) =>
        isRecord(object) && realTextLeaves(object.name)
          ? [`${here}${Array.isArray(item) ? `[${index}]` : ''}.name`]
          : []
      );
      return [...nested, ...names];
    }
    return nested;
  });
}

/** Paths of a team member's own name when it is not the 'Team member <id>' form. */
function unnamedTeamMembers(data: unknown): string[] {
  if (!Array.isArray(data)) return [];
  return (data as unknown[]).flatMap((member, index) =>
    isRecord(member) &&
    'name' in member &&
    !/^Team member \d+$/.test(String(member.name))
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

describe('live recordings under fixtures/live (BAPI-03)', () => {
  it('parse with their route schemas and carry no e-mail address, phone number, name, address or coordinates', () => {
    const files = liveFiles();
    const problems: string[] = [];
    for (const name of files) {
      const text = readFileSync(join(LIVE_DIR, name), 'utf8');
      if (EMAIL_PATTERN.test(text)) problems.push(`${name}: e-mail address`);
      const parsed = recordingSchema.safeParse(JSON.parse(text));
      if (!parsed.success) {
        problems.push(`${name}: not a recording`);
        continue;
      }
      const { route, status, data } = parsed.data;
      if (name !== `${route}.json`) {
        problems.push(`${name}: holds route ${route}`);
      }
      if (route === 'book_check') {
        if (status !== 201) problems.push(`${name}: status ${status}`);
      } else if (!DATA_SCHEMAS[route].safeParse(data).success) {
        problems.push(`${name}: data does not parse with the ${route} schema`);
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
    }
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
      bookforms: companyData.bookforms,
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
