import { expect, it } from '@jest/globals';

it('probe: deliberately failing assertion', () => {
  expect(1).toBe(2);
});
