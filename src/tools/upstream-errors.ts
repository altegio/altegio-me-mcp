import type { UpstreamError, UpstreamErrorKind } from '../booking/errors.js';

// RED stub: the contract names only. The mapping lands in the GREEN commit.

export interface UpstreamErrorText {
  message: string;
  nextAction: string;
}

export type UpstreamErrorOverrides = Partial<
  Record<
    UpstreamErrorKind,
    UpstreamErrorText | ((error: UpstreamError) => UpstreamErrorText)
  >
>;

export function toToolError(
  error: unknown,
  overrides: UpstreamErrorOverrides = {}
): Error {
  void overrides;
  return error instanceof Error ? error : new Error('Non-error value thrown');
}
