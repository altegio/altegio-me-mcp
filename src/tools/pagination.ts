import { z } from 'zod';

// The one pagination shape of every list tool (FND-06, ADR-0001-D6). Input is
// page and page_size; output is items plus a six-key pagination object. The
// shape follows Altegio.Pro MCP; the sizes are smaller because results land in
// a chat context (research A6). SDK-free.

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 50;

export interface PageInput {
  page: number;
  page_size: number;
}

export interface Pagination {
  page: number;
  page_size: number;
  returned: number;
  /** null when the upstream does not report a total. */
  total: number | null;
  has_more: boolean;
  /** The page number to request next, or null on the last page. */
  next_page: number | null;
}

/** Input fields for a list tool: `z.strictObject(pageInputShape())`. */
export function pageInputShape(
  max: number = MAX_PAGE_SIZE,
  fallback: number = DEFAULT_PAGE_SIZE
): {
  page: z.ZodDefault<z.ZodNumber>;
  page_size: z.ZodDefault<z.ZodNumber>;
} {
  return {
    page: z
      .number()
      .int()
      .min(1)
      .default(1)
      .describe('Page number, starting at 1.'),
    page_size: z
      .number()
      .int()
      .min(1)
      .max(max)
      .default(fallback)
      .describe(`Items per page, from 1 to ${max}. Default ${fallback}.`),
  };
}

export const paginationSchema = z.strictObject({
  page: z.number().int().min(1).describe('The page returned.'),
  page_size: z.number().int().min(1).describe('Items per page requested.'),
  returned: z.number().int().min(0).describe('Number of items on this page.'),
  total: z
    .number()
    .int()
    .min(0)
    .nullable()
    .describe('Total number of items, or null when it is not known.'),
  has_more: z.boolean().describe('Whether a following page exists.'),
  next_page: z
    .number()
    .int()
    .min(2)
    .nullable()
    .describe('Page number to request next, or null on the last page.'),
});

/** Output schema of a list tool: `{ items, pagination }`. */
export function listOutputSchema<T extends z.ZodType>(
  item: T
): z.ZodObject<{
  items: z.ZodArray<T>;
  pagination: typeof paginationSchema;
}> {
  return z.strictObject({
    items: z.array(item),
    pagination: paginationSchema,
  });
}

export function pageMetadata(
  input: PageInput,
  returned: number,
  total?: number
): Pagination {
  const hasMore =
    total === undefined
      ? returned >= input.page_size
      : input.page * input.page_size < total;
  return {
    page: input.page,
    page_size: input.page_size,
    returned,
    total: total ?? null,
    has_more: hasMore,
    next_page: hasMore ? input.page + 1 : null,
  };
}

/** Pages an in-memory collection; the total is its length. */
export function paginateArray<T>(
  all: readonly T[],
  input: PageInput
): { items: T[]; pagination: Pagination } {
  const start = (input.page - 1) * input.page_size;
  const items = all.slice(start, input.page * input.page_size);
  return {
    items,
    pagination: pageMetadata(input, items.length, all.length),
  };
}
