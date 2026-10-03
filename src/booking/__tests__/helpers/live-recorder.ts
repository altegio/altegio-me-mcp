// Recording fetch wrapper and sanitiser for live payloads (plan 02-09).
// RED stub: the final types and constants, behaviour still missing.

/** The six upstream routes, named as their URL path segment. */
export const RECORDED_ROUTES = [
  'company',
  'book_services',
  'book_staff',
  'book_dates',
  'book_times',
  'book_check',
] as const;

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

/** RED stub: returns the payload as given. */
export function sanitizeRecording(
  _route: RecordedRoute,
  data: unknown,
  _secrets: readonly string[]
): unknown {
  return data;
}

/** RED stub: passes through and records nothing. */
export function createRecordingFetch(
  inner: typeof fetch,
  _sink: (recording: Recording) => void,
  _secrets: readonly string[]
): typeof fetch {
  return inner;
}
