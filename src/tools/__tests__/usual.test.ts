import { describe, expect, it } from '@jest/globals';
import { BookingClient, type OwnRecord } from '../../booking/client.js';
import {
  fakeFetch,
  loadFixture,
} from '../../booking/__tests__/helpers/fake-fetch.js';
import {
  bookingStatus,
  orderBookings,
  recordTimeMs,
  usualByLocation,
} from '../usual.js';

// The pure logic over the client's own records (ME-03, ME-04, D-02, D-03):
// status, order and the usual service and team member of a place. Records come
// from the contract fixture through the real client, so the tests follow the
// recorded shape.

const NOW = Date.parse('2026-10-08T00:00:00Z');

async function fixtureRecords(scenario: string): Promise<OwnRecord[]> {
  const upstream = fakeFetch([
    {
      method: 'GET',
      path: '/user/records',
      reply: loadFixture('user_records', scenario),
    },
  ]);
  const booking = new BookingClient({
    base: 'https://api.alteg.io/api/v1',
    token: 'partner-token-0123456789abcdef',
    fetch: upstream.fetch,
  });
  return booking.myRecords({ userToken: 'client-user-token-0001-abcdef' });
}

function record(overrides: Partial<OwnRecord> = {}): OwnRecord {
  return {
    id: 1,
    locationId: 1,
    businessName: 'Business',
    city: null,
    currency: null,
    services: [{ id: 5, title: 'Service', price: null }],
    teamMember: { id: 9, name: 'Member' },
    datetime: '2025-01-01T10:00:00+0300',
    cancelled: false,
    attendance: null,
    price: null,
    moveAllowed: null,
    cancelAllowed: null,
    ...overrides,
  };
}

describe('recordTimeMs', () => {
  it('reads an offset without a colon, as the records route writes it', () => {
    expect(recordTimeMs('2025-03-10T10:00:00+0300')).toBe(
      Date.parse('2025-03-10T07:00:00Z')
    );
    expect(recordTimeMs('2025-12-07T17:45:00+0700')).toBe(
      Date.parse('2025-12-07T10:45:00Z')
    );
  });

  it('also reads an offset with a colon and Z', () => {
    expect(recordTimeMs('2025-03-10T10:00:00+03:00')).toBe(
      Date.parse('2025-03-10T07:00:00Z')
    );
    expect(recordTimeMs('2025-03-10T10:00:00Z')).toBe(
      Date.parse('2025-03-10T10:00:00Z')
    );
  });

  it.each(['', 'yesterday', '2025-13-40T10:00:00+0300', '2025-03-10 10:00:00'])(
    'gives null for %p',
    (value) => {
      expect(recordTimeMs(value)).toBeNull();
    }
  );
});

describe('bookingStatus', () => {
  it('is cancelled for a cancelled record whatever its date', () => {
    expect(bookingStatus(record({ cancelled: true }), NOW)).toBe('cancelled');
    expect(
      bookingStatus(
        record({ cancelled: true, datetime: '2099-01-12T10:00:00+0300' }),
        NOW
      )
    ).toBe('cancelled');
  });

  it('is upcoming for a record in the future', () => {
    expect(
      bookingStatus(record({ datetime: '2099-01-12T10:00:00+0300' }), NOW)
    ).toBe('upcoming');
  });

  it('is visited for attendance 1, no_show for -1 and past for any other value', () => {
    expect(bookingStatus(record({ attendance: 1 }), NOW)).toBe('visited');
    expect(bookingStatus(record({ attendance: -1 }), NOW)).toBe('no_show');
    expect(bookingStatus(record({ attendance: 0 }), NOW)).toBe('past');
    expect(bookingStatus(record({ attendance: 2 }), NOW)).toBe('past');
    expect(bookingStatus(record({ attendance: null }), NOW)).toBe('past');
  });

  it('counts a record exactly at now as past', () => {
    expect(
      bookingStatus(record({ datetime: '2026-10-08T00:00:00+0000' }), NOW)
    ).toBe('past');
  });
});

describe('orderBookings', () => {
  it('puts upcoming first, soonest first, then the others latest first', () => {
    const records = [
      record({ datetime: '2025-01-01T10:00:00+0300', services: [] }),
      record({ datetime: '2099-03-01T10:00:00+0300', services: [] }),
      record({ datetime: '2025-06-01T10:00:00+0300', services: [] }),
      record({ datetime: '2099-02-01T10:00:00+0300', services: [] }),
    ];
    expect(orderBookings(records, NOW).map((entry) => entry.datetime)).toEqual([
      '2099-02-01T10:00:00+0300',
      '2099-03-01T10:00:00+0300',
      '2025-06-01T10:00:00+0300',
      '2025-01-01T10:00:00+0300',
    ]);
  });

  it('files a cancelled future record with the others', () => {
    const records = [
      record({ datetime: '2099-01-01T10:00:00+0300', cancelled: true }),
      record({ datetime: '2099-02-01T10:00:00+0300' }),
    ];
    expect(orderBookings(records, NOW).map((entry) => entry.cancelled)).toEqual(
      [false, true]
    );
  });

  it('keeps the input order for equal datetimes and does not change the input', () => {
    const a = record({ businessName: 'A' });
    const b = record({ businessName: 'B' });
    const c = record({ businessName: 'C', datetime: '2099-01-01T10:00:00Z' });
    const d = record({ businessName: 'D', datetime: '2099-01-01T10:00:00Z' });
    const input = [a, b, c, d];
    expect(
      orderBookings(input, NOW).map((entry) => entry.businessName)
    ).toEqual(['C', 'D', 'A', 'B']);
    expect(input.map((entry) => entry.businessName)).toEqual([
      'A',
      'B',
      'C',
      'D',
    ]);
  });

  it('puts a record with an unreadable datetime last', () => {
    const records = [
      record({ datetime: 'unreadable', businessName: 'odd' }),
      record({ datetime: '2025-01-01T10:00:00+0300', businessName: 'old' }),
    ];
    expect(
      orderBookings(records, NOW).map((entry) => entry.businessName)
    ).toEqual(['old', 'odd']);
  });

  it('orders the fixture: the 2099 record, then the others latest first', async () => {
    const records = await fixtureRecords('default');
    expect(orderBookings(records, NOW).map((entry) => entry.datetime)).toEqual([
      '2099-01-12T10:00:00+0300',
      '2025-09-01T11:00:00+0300',
      '2025-06-16T14:30:00+0300',
      '2025-05-05T16:00:00+0300',
      '2025-03-10T10:00:00+0300',
    ]);
  });
});

describe('usualByLocation', () => {
  it('takes the newer past record at 722227 and ignores the 2099 and the cancelled ones', async () => {
    const usual = usualByLocation(await fixtureRecords('default'), NOW);
    expect(usual.get(722227)).toEqual({
      businessName: 'Fixture Barber',
      serviceIds: [10303531],
      serviceTitles: ['Manicure'],
      teamMemberId: 2098145,
      teamMemberName: 'Anna Smith',
      date: '2025-06-16',
    });
  });

  it('gives the one past record of 726120', async () => {
    const usual = usualByLocation(await fixtureRecords('default'), NOW);
    expect(usual.get(726120)).toMatchObject({
      serviceIds: [10303532],
      serviceTitles: ['Hair colouring'],
      teamMemberId: 2098146,
      date: '2025-05-05',
    });
    expect([...usual.keys()].sort()).toEqual([722227, 726120]);
  });

  it('gives nothing for an empty list', async () => {
    expect(usualByLocation(await fixtureRecords('empty'), NOW).size).toBe(0);
  });

  it('gives no entry for a place with only upcoming or cancelled records', () => {
    const usual = usualByLocation(
      [
        record({ locationId: 1, datetime: '2099-01-01T10:00:00+0300' }),
        record({ locationId: 1, cancelled: true }),
        record({ locationId: 2, cancelled: true }),
      ],
      NOW
    );
    expect(usual.size).toBe(0);
  });

  it('counts a record exactly at now as past', () => {
    const usual = usualByLocation(
      [record({ datetime: '2026-10-08T00:00:00+0000' })],
      NOW
    );
    expect(usual.get(1)?.date).toBe('2026-10-08');
  });

  it('gives team member 0 and no name for a record without a team member', () => {
    const usual = usualByLocation([record({ teamMember: null })], NOW);
    expect(usual.get(1)).toMatchObject({
      teamMemberId: 0,
      teamMemberName: null,
    });
  });

  it('passes over a past record that has no service', () => {
    const usual = usualByLocation(
      [
        record({ datetime: '2025-01-01T10:00:00+0300' }),
        record({ datetime: '2025-02-01T10:00:00+0300', services: [] }),
      ],
      NOW
    );
    expect(usual.get(1)?.date).toBe('2025-01-01');
  });

  it('takes the later record of two with the same datetime', () => {
    const usual = usualByLocation(
      [
        record({ teamMember: { id: 1, name: 'First' } }),
        record({ teamMember: { id: 2, name: 'Second' } }),
      ],
      NOW
    );
    expect(usual.get(1)?.teamMemberId).toBe(2);
  });
});
