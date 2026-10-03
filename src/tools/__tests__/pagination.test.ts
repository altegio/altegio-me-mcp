import { describe, expect, it } from '@jest/globals';
import { z } from 'zod';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  listOutputSchema,
  pageInputShape,
  pageMetadata,
  paginateArray,
  paginationSchema,
} from '../pagination.js';

const PAGINATION_KEYS = [
  'page',
  'page_size',
  'returned',
  'total',
  'has_more',
  'next_page',
];

function items(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index + 1);
}

describe('page input', () => {
  it('uses 20 by default and 50 at most', () => {
    expect(DEFAULT_PAGE_SIZE).toBe(20);
    expect(MAX_PAGE_SIZE).toBe(50);
  });

  it('defaults page to 1 and page_size to 20', () => {
    expect(z.strictObject(pageInputShape()).parse({})).toEqual({
      page: 1,
      page_size: 20,
    });
  });

  it('accepts page_size 50 and rejects 51 and 0', () => {
    const schema = z.strictObject(pageInputShape());
    expect(schema.parse({ page_size: 50 }).page_size).toBe(50);
    expect(schema.safeParse({ page_size: 51 }).success).toBe(false);
    expect(schema.safeParse({ page_size: 0 }).success).toBe(false);
  });

  it('rejects page 0 and a fractional page', () => {
    const schema = z.strictObject(pageInputShape());
    expect(schema.safeParse({ page: 0 }).success).toBe(false);
    expect(schema.safeParse({ page: 1.5 }).success).toBe(false);
  });

  it('lets a tool lower the ceiling and the default', () => {
    const schema = z.strictObject(pageInputShape(10, 5));
    expect(schema.parse({})).toEqual({ page: 1, page_size: 5 });
    expect(schema.parse({ page_size: 10 }).page_size).toBe(10);
    expect(schema.safeParse({ page_size: 11 }).success).toBe(false);
  });

  it('describes both parameters', () => {
    const json = z.toJSONSchema(z.strictObject(pageInputShape()), {
      io: 'input',
    }) as { properties: Record<string, { description?: string }> };
    expect(json.properties.page?.description).toBeTruthy();
    expect(json.properties.page_size?.description).toBeTruthy();
  });
});

describe('pageMetadata', () => {
  it('reports a following page while the total is not reached', () => {
    expect(pageMetadata({ page: 1, page_size: 20 }, 20, 40)).toEqual({
      page: 1,
      page_size: 20,
      returned: 20,
      total: 40,
      has_more: true,
      next_page: 2,
    });
  });

  it('reports no following page on the last full page', () => {
    const meta = pageMetadata({ page: 2, page_size: 20 }, 20, 40);
    expect(meta.has_more).toBe(false);
    expect(meta.next_page).toBeNull();
  });

  it('treats a full page as having more when the total is unknown', () => {
    const meta = pageMetadata({ page: 1, page_size: 20 }, 20);
    expect(meta.total).toBeNull();
    expect(meta.has_more).toBe(true);
    expect(meta.next_page).toBe(2);
  });

  it('treats a short page as the last one when the total is unknown', () => {
    const meta = pageMetadata({ page: 1, page_size: 20 }, 7);
    expect(meta.total).toBeNull();
    expect(meta.has_more).toBe(false);
    expect(meta.next_page).toBeNull();
  });
});

describe('paginateArray', () => {
  it('returns the empty shape for an empty collection', () => {
    expect(paginateArray([], { page: 1, page_size: 20 })).toEqual({
      items: [],
      pagination: {
        page: 1,
        page_size: 20,
        returned: 0,
        total: 0,
        has_more: false,
        next_page: null,
      },
    });
  });

  it('returns the remainder on the last page', () => {
    const result = paginateArray(items(45), { page: 3, page_size: 20 });
    expect(result.items).toEqual([41, 42, 43, 44, 45]);
    expect(result.pagination).toEqual({
      page: 3,
      page_size: 20,
      returned: 5,
      total: 45,
      has_more: false,
      next_page: null,
    });
  });

  it('returns no items past the end', () => {
    const result = paginateArray(items(45), { page: 4, page_size: 20 });
    expect(result.items).toEqual([]);
    expect(result.pagination.returned).toBe(0);
    expect(result.pagination.has_more).toBe(false);
    expect(result.pagination.next_page).toBeNull();
  });

  it('reports a following page in the middle', () => {
    const result = paginateArray(items(45), { page: 1, page_size: 20 });
    expect(result.items).toHaveLength(20);
    expect(result.pagination.has_more).toBe(true);
    expect(result.pagination.next_page).toBe(2);
  });

  it('reproduces the input exactly once, in order, across all pages', () => {
    const all = items(45);
    const joined = [1, 2, 3].flatMap(
      (page) => paginateArray(all, { page, page_size: 20 }).items
    );
    expect(joined).toEqual(all);
  });
});

describe('output schemas', () => {
  it('requires the six pagination keys and forbids extra ones', () => {
    const json = z.toJSONSchema(listOutputSchema(z.string()), {
      io: 'output',
    }) as unknown as {
      required: string[];
      additionalProperties: boolean;
      properties: {
        items: { type: string };
        pagination: { required: string[]; additionalProperties: boolean };
      };
    };
    expect(json.required).toEqual(['items', 'pagination']);
    expect(json.additionalProperties).toBe(false);
    expect(json.properties.items.type).toBe('array');
    expect([...json.properties.pagination.required].sort()).toEqual(
      [...PAGINATION_KEYS].sort()
    );
    expect(json.properties.pagination.additionalProperties).toBe(false);
  });

  it('accepts what paginateArray produces and rejects a bad next_page', () => {
    const schema = listOutputSchema(z.number());
    expect(
      schema.safeParse(paginateArray(items(45), { page: 1, page_size: 20 }))
        .success
    ).toBe(true);
    const bad = paginateArray(items(45), { page: 1, page_size: 20 });
    expect(
      schema.safeParse({
        ...bad,
        pagination: { ...bad.pagination, next_page: 1 },
      }).success
    ).toBe(false);
    expect(
      paginationSchema.safeParse({ ...bad.pagination, extra: true }).success
    ).toBe(false);
  });
});
