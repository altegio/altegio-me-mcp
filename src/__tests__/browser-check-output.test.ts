import { expect, it } from '@jest/globals';
import { markdownCell } from '../../scripts/browser-check/markdown.js';

it('keeps a backslash before a pipe from creating another Markdown table cell', () => {
  expect(markdownCell(String.raw`left\|right`)).toBe(String.raw`left\\\|right`);
});

it('keeps multiline diagnostic text on one table row', () => {
  expect(markdownCell('first\r\nsecond\nthird')).toBe('first second third');
});
