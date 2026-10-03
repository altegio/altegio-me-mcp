import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { PACKAGE_NAME, PACKAGE_VERSION } from '../package-metadata.js';

describe('package metadata', () => {
  it('exposes the name and version from package.json', () => {
    const raw = readFileSync(join(process.cwd(), 'package.json'), 'utf8');
    const { version } = JSON.parse(raw) as { version: string };

    expect(PACKAGE_NAME).toBe('altegio-me-mcp');
    expect(PACKAGE_VERSION).toBe(version);
  });

  it('runs with the environment from the Jest setup file', () => {
    expect(process.env.NODE_ENV).toBe('test');
    expect(process.env.ALTEGIO_API_TOKEN).toBe('test-partner-token');
  });
});
