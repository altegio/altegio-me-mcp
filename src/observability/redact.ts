// STUB for the RED step; replaced by the real scrubber in the GREEN commit.
export const MIN_SECRET_LENGTH = 8;
export const REDACTED = '[redacted]';

export function scrubSecrets<T>(value: T, _secrets: readonly string[]): T {
  return value;
}
