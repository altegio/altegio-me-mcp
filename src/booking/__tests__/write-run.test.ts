import { describe, expect, it } from '@jest/globals';
import {
  commonSlots,
  createBody,
  createdRecordIds,
  createPairBody,
  describeError,
  emailOf,
  fullnameOf,
  normalizePhone,
} from './helpers/write-run.js';

// The helpers of the live write suite (plan 04.1-01). Every value is synthetic.

describe('normalizePhone', () => {
  it.each([
    ['15550000002', '+15550000002'],
    ['+15550000002', '+15550000002'],
    [' +1 555-000 0002 ', '+15550000002'],
    ['(1) 555 000 0002', '+15550000002'],
  ])('turns %j into %j', (raw, expected) => {
    expect(normalizePhone(raw)).toBe(expected);
  });

  it.each([[''], ['   '], ['n/a'], ['+']])(
    'gives an empty phone for %j, so no bare plus is ever sent',
    (raw) => {
      expect(normalizePhone(raw)).toBe('');
    }
  );
});

describe('fullnameOf', () => {
  it('prefers a non-empty fullname', () => {
    expect(
      fullnameOf({ fullname: 'Fixture Full', name: 'Fixture', surname: 'X' })
    ).toBe('Fixture Full');
  });

  it('takes the name alone when the surname is empty or absent', () => {
    expect(fullnameOf({ name: 'Fixture', surname: '' })).toBe('Fixture');
    expect(fullnameOf({ name: 'Fixture' })).toBe('Fixture');
  });

  it('joins name and surname with one space when both are present', () => {
    expect(fullnameOf({ name: ' Fixture ', surname: ' Client ' })).toBe(
      'Fixture Client'
    );
  });

  it('falls back to the surname when there is no name, and to empty', () => {
    expect(fullnameOf({ name: '', surname: 'Client' })).toBe('Client');
    expect(fullnameOf({ name: null, fullname: '' })).toBe('');
    expect(fullnameOf({})).toBe('');
  });

  it('ignores values that are not text', () => {
    expect(fullnameOf({ name: 5, surname: { a: 1 } })).toBe('');
  });
});

describe('describeError', () => {
  const body = (meta: unknown): string =>
    JSON.stringify({ success: false, data: null, meta });

  it('keeps the status, the message, the errors and the first error code', () => {
    const result = describeError(
      422,
      body({
        message: 'Invalid phone number format',
        errors: [{ code: 431, message: 'Invalid phone number format' }],
      }),
      []
    );
    expect(result).toEqual({
      status: 422,
      code: 431,
      message: 'Invalid phone number format',
      errors: [{ code: 431, message: 'Invalid phone number format' }],
      fields: {},
    });
  });

  it('reads a code from meta.code when meta.errors has none', () => {
    expect(describeError(403, body({ message: 'm', code: 434 }), []).code).toBe(
      434
    );
  });

  it('removes the phone, the name, its words, a hash and any e-mail from every text', () => {
    const secrets = [
      '+15550000002',
      '15550000002',
      'Fixture Client',
      'fixture-hash-0002',
    ];
    const result = describeError(
      422,
      body({
        message:
          'Client Fixture Client (+15550000002, call 15550000002 or fixture@example.invalid) hash fixture-hash-0002',
        errors: [{ code: 431, message: 'Fixture rejected +1 555 000 0002' }],
      }),
      secrets
    );
    const text = JSON.stringify(result);
    for (const bait of [
      'Fixture',
      'Client',
      '15550000002',
      '000 0002',
      'fixture-hash-0002',
      'fixture@example.invalid',
    ]) {
      expect(text).not.toContain(bait);
    }
    expect(result.code).toBe(431);
  });

  it('removes a short name wherever it occurs', () => {
    const result = describeError(
      422,
      body({ message: 'Al is blacklisted', errors: [] }),
      ['Al']
    );
    expect(result.message).not.toContain('Al ');
  });

  it('echoes nothing of a body that is not JSON', () => {
    const result = describeError(
      502,
      '<html>Bad gateway for Fixture Client</html>',
      ['Fixture Client']
    );
    expect(result).toEqual({
      status: 502,
      code: null,
      message: '',
      errors: [],
      fields: {},
    });
  });

  it('caps the length of a message', () => {
    const result = describeError(
      422,
      body({ message: 'x'.repeat(2000), errors: [] }),
      []
    );
    expect(result.message.length).toBeLessThanOrEqual(300);
  });

  it('survives a meta that is a list or missing', () => {
    expect(describeError(422, body([]), [])).toEqual({
      status: 422,
      code: null,
      message: '',
      errors: [],
      fields: {},
    });
    expect(describeError(422, '{"success":false}', [])).toEqual({
      status: 422,
      code: null,
      message: '',
      errors: [],
      fields: {},
    });
  });
});

describe('describeError of an errors object keyed by field', () => {
  // The shape the live sign-in answered with: bracketed field names, each with
  // a list of messages, and no error code.
  const body = (value: unknown): string => JSON.stringify(value);

  it('records each key with brackets stripped and its messages, and no code', () => {
    const result = describeError(
      422,
      body({
        success: false,
        data: null,
        meta: {
          message: 'An error occurred',
          errors: {
            '[phone]': ['The value is too short.', 'Invalid format.'],
            '[code]': ['The value is required.'],
          },
        },
      }),
      []
    );
    expect(result).toEqual({
      status: 422,
      code: null,
      message: 'An error occurred',
      errors: [],
      fields: {
        phone: ['The value is too short.', 'Invalid format.'],
        code: ['The value is required.'],
      },
      kind: 'required_field',
      required_fields: ['code'],
    });
  });

  it('accepts one message as a text instead of a list, and ignores other values', () => {
    const result = describeError(
      422,
      body({
        meta: {
          message: 'm',
          errors: { fullname: 'Required.', email: 5, '[x]': [1, 'ok', null] },
        },
      }),
      []
    );
    expect(result).toEqual({
      status: 422,
      code: null,
      message: 'm',
      errors: [],
      fields: { fullname: ['Required.'], email: [], x: ['ok'] },
      kind: 'required_field',
      required_fields: ['fullname'],
    });
  });

  it('removes the phone, the name and a hash from the messages of every field', () => {
    const secrets = [
      '+15550000002',
      '15550000002',
      'Fixture Client',
      'fixture-hash-0002',
    ];
    const result = describeError(
      422,
      body({
        meta: {
          message: 'An error occurred',
          errors: {
            '[phone]': [
              'The value +1 555 000 0002 is too short for Fixture Client',
            ],
            '[hash]': ['fixture-hash-0002 is unknown'],
          },
        },
      }),
      secrets
    );
    const text = JSON.stringify(result);
    for (const bait of [
      '000 0002',
      '15550000002',
      'Fixture',
      'Client',
      'fixture-hash-0002',
    ]) {
      expect(text).not.toContain(bait);
    }
    expect(Object.keys(result.fields)).toEqual(['phone', 'hash']);
  });

  it('keeps a bounded number of fields and messages', () => {
    const errors = Object.fromEntries(
      Array.from({ length: 50 }, (_, index) => [
        `[f${String(index)}]`,
        Array.from({ length: 50 }, () => 'm'),
      ])
    );
    const result = describeError(422, body({ meta: { errors } }), []);
    expect(Object.keys(result.fields).length).toBeLessThanOrEqual(20);
    for (const messages of Object.values(result.fields)) {
      expect(messages.length).toBeLessThanOrEqual(10);
    }
  });
});

describe('describeError code', () => {
  const body = (value: unknown): string => JSON.stringify(value);

  it('takes meta.code first, then the code of meta.errors, then a top-level code', () => {
    expect(
      describeError(
        422,
        body({
          code: 436,
          meta: { code: 432, errors: [{ code: 433, message: 'm' }] },
        }),
        []
      ).code
    ).toBe(432);
    expect(
      describeError(
        422,
        body({
          code: 436,
          meta: {
            errors: [{ message: 'no code' }, { code: 433, message: 'm' }],
          },
        }),
        []
      ).code
    ).toBe(433);
    expect(
      describeError(422, body({ success: false, code: 436, meta: {} }), []).code
    ).toBe(436);
  });

  it('reads a top-level code even when there is no meta at all', () => {
    expect(describeError(403, body({ success: false, code: 434 }), [])).toEqual(
      {
        status: 403,
        code: 434,
        message: '',
        errors: [],
        fields: {},
      }
    );
  });

  it('ignores a code that is not an integer', () => {
    expect(
      describeError(422, body({ code: '432', meta: { code: 4.5 } }), []).code
    ).toBeNull();
  });

  it('records an errors text as one message', () => {
    expect(
      describeError(
        422,
        body({ meta: { message: 'm', errors: 'Boom for Fixture' } }),
        ['Fixture']
      ).errors
    ).toEqual([{ code: null, message: 'Boom for [removed]' }]);
  });
});

describe('emailOf', () => {
  it('takes the e-mail of the profile when it is a non-empty text', () => {
    expect(emailOf({ email: 'fixture.client@example.invalid' })).toBe(
      'fixture.client@example.invalid'
    );
    expect(emailOf({ email: '  fixture.client@example.invalid ' })).toBe(
      'fixture.client@example.invalid'
    );
  });

  it.each([[''], ['   '], [null], [undefined], [5], [['a@b.c']], [{ a: 1 }]])(
    'gives nothing for %j, so the key is never sent empty',
    (value) => {
      expect(emailOf({ email: value })).toBe('');
    }
  );

  it('gives nothing when the profile has no email key', () => {
    expect(emailOf({})).toBe('');
  });
});

describe('createBody', () => {
  const input = {
    phone: '+15550000001',
    fullname: 'Fixture Client',
    email: 'fixture.client@example.invalid',
    serviceId: 10303530,
    staffId: 0,
    datetime: '2026-10-10T09:00:00+02:00',
  };

  it('sends exactly phone, fullname, email and one appointment', () => {
    expect(createBody(input)).toEqual({
      phone: '+15550000001',
      fullname: 'Fixture Client',
      email: 'fixture.client@example.invalid',
      appointments: [
        {
          id: 1,
          services: [10303530],
          staff_id: 0,
          datetime: '2026-10-10T09:00:00+02:00',
        },
      ],
    });
  });

  it('sends no email key when the profile has none', () => {
    const body = createBody({ ...input, email: '' });
    expect(Object.keys(body).sort()).toEqual([
      'appointments',
      'fullname',
      'phone',
    ]);
  });

  it('never sends a code, comment, notify or api_id key', () => {
    const keys = Object.keys(createBody(input));
    for (const forbidden of [
      'code',
      'comment',
      'notify_by_sms',
      'notify_by_email',
      'api_id',
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });
});

describe('describeError of a required field', () => {
  const body = (errors: unknown): string =>
    JSON.stringify({
      success: false,
      data: null,
      meta: { message: 'An error occurred', errors },
    });

  it('marks a 422 that names a required field and lists the field names', () => {
    const result = describeError(
      422,
      body({
        '[email]': ['The required parameter email was not passed.'],
        '[phone]': ['The value is too short.'],
      }),
      []
    );
    expect(result.kind).toBe('required_field');
    expect(result.required_fields).toEqual(['email']);
    expect(Object.keys(result.fields)).toEqual(['email', 'phone']);
  });

  it('lists every field with a required message', () => {
    const result = describeError(
      422,
      body({
        email: ['The email field is required.'],
        fullname: ['The required parameter fullname was not passed.'],
      }),
      []
    );
    expect(result.required_fields).toEqual(['email', 'fullname']);
  });

  it('adds no kind when no field message is about a required field', () => {
    const result = describeError(
      422,
      body({ '[phone]': ['The value is too short.'] }),
      []
    );
    expect(result).not.toHaveProperty('kind');
    expect(result).not.toHaveProperty('required_fields');
  });

  it('adds no kind to a status other than 422', () => {
    const result = describeError(
      403,
      body({ email: ['The required parameter email was not passed.'] }),
      []
    );
    expect(result).not.toHaveProperty('kind');
  });

  it('adds no kind to a list-shaped errors answer', () => {
    const result = describeError(
      422,
      body([{ code: 433, message: 'The required slot was taken.' }]),
      []
    );
    expect(result).not.toHaveProperty('kind');
  });
});

// The pair helpers of the two-appointment probe (plan 05-01).

describe('createPairBody', () => {
  const input = {
    phone: '+15550000001',
    fullname: 'Fixture Client',
    email: '',
    first: { serviceIds: [13884511], staffId: 101 },
    second: { serviceIds: [13884511], staffId: 102 },
    datetime: '2026-10-20T11:00:00+02:00',
  };

  it('builds the body of one client with two appointments at one start', () => {
    expect(createPairBody(input)).toEqual({
      phone: '+15550000001',
      fullname: 'Fixture Client',
      appointments: [
        {
          id: 1,
          services: [13884511],
          staff_id: 101,
          datetime: '2026-10-20T11:00:00+02:00',
        },
        {
          id: 2,
          services: [13884511],
          staff_id: 102,
          datetime: '2026-10-20T11:00:00+02:00',
        },
      ],
    });
  });

  it('sends the e-mail only when there is one', () => {
    expect(createPairBody(input)).not.toHaveProperty('email');
    expect(createPairBody({ ...input, email: 'a@b.invalid' })).toHaveProperty(
      'email',
      'a@b.invalid'
    );
  });

  it('carries nothing about a second person', () => {
    const body = createPairBody({ ...input, email: 'a@b.invalid' });
    for (const key of [
      'comment',
      'code',
      'notify_by_sms',
      'notify_by_email',
      'api_id',
      'custom_fields',
    ]) {
      expect(body).not.toHaveProperty(key);
      for (const appointment of body.appointments as Record<
        string,
        unknown
      >[]) {
        expect(appointment).not.toHaveProperty(key);
      }
    }
  });

  it.each([
    ['the first team member is 0', 0, 102],
    ['the second team member is 0', 101, 0],
    ['both are equal', 101, 101],
  ])('refuses a pair when %s, naming the rule and no value', (_, a, b) => {
    const attempt = (): unknown =>
      createPairBody({
        ...input,
        first: { serviceIds: [13884511], staffId: a },
        second: { serviceIds: [13884511], staffId: b },
      });
    expect(attempt).toThrow(TypeError);
    expect(attempt).toThrow('a pair needs two different team members above 0');
    expect(attempt).not.toThrow(/\+1555|Fixture/);
  });
});

describe('commonSlots', () => {
  it('keeps the datetimes present in both lists, in the order of the first', () => {
    expect(commonSlots(['T1', 'T2', 'T3'], ['T3', 'T1'])).toEqual(['T1', 'T3']);
  });

  it('compares the exact strings, offset included', () => {
    expect(
      commonSlots(['2026-10-20T11:00:00+02:00'], ['2026-10-20T10:00:00+01:00'])
    ).toEqual([]);
  });

  it('gives nothing when a list is empty', () => {
    expect(commonSlots([], ['T1'])).toEqual([]);
    expect(commonSlots(['T1'], [])).toEqual([]);
  });
});

describe('createdRecordIds', () => {
  it('maps appointment 1 and 2 to their record ids', () => {
    expect(
      createdRecordIds([
        { id: 1, record_id: 990001 },
        { id: 2, record_id: 990002 },
      ])
    ).toEqual({ first: 990001, second: 990002 });
  });

  it('gives null for an entry whose record id is 0, null or missing', () => {
    expect(
      createdRecordIds([
        { id: 1, record_id: 0 },
        { id: 2, record_id: null },
      ])
    ).toEqual({ first: null, second: null });
    expect(createdRecordIds([{ id: 1, record_id: 990001 }, { id: 2 }])).toEqual(
      { first: 990001, second: null }
    );
  });

  it('gives null for an appointment that has no entry, and for a non-list', () => {
    expect(createdRecordIds([{ id: 1, record_id: 990001 }])).toEqual({
      first: 990001,
      second: null,
    });
    expect(createdRecordIds(null)).toEqual({ first: null, second: null });
    expect(createdRecordIds({ id: 1 })).toEqual({ first: null, second: null });
  });

  it('refuses an id that is not a positive safe integer', () => {
    expect(
      createdRecordIds([
        { id: 1, record_id: -5 },
        { id: 2, record_id: 1.5 },
      ])
    ).toEqual({ first: null, second: null });
    expect(
      createdRecordIds([
        { id: 1, record_id: '990001' },
        { id: 2, record_id: 2 ** 60 },
      ])
    ).toEqual({ first: null, second: null });
  });
});
