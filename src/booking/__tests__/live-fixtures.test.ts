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
  SANITIZED_IMAGE,
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

function liveFiles(): string[] {
  if (!existsSync(LIVE_DIR)) return [];
  return readdirSync(LIVE_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort();
}

describe('live recordings under fixtures/live (BAPI-03)', () => {
  it('parse with their route schemas and carry no e-mail address or phone number', () => {
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

  it('keeps ids, titles, timezone fields and booking-form URLs of a company card', () => {
    const result = sanitizeRecording('company', companyData, [TOKEN]) as Record<
      string,
      unknown
    >;
    expect(result).toMatchObject({
      id: 722227,
      title: 'Demo Beauty Studio',
      public_title: 'Demo Beauty Studio',
      address: '12 Example Street',
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
      { ...companyData, title: `Studio ${TOKEN}`, extra: { [TOKEN]: TOKEN } },
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
