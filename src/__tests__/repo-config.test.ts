import { accessSync, constants, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from '@jest/globals';

// Structural tests for the delivery files. They read the repository files
// through process.cwd() (D-07) and check what a reviewer would otherwise have
// to check by eye: the image is non-root and secret-free, the smoke script is
// strict, and the files that CI and the ruleset depend on keep their shape.

const ROOT = process.cwd();

function read(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), 'utf8');
}

function lines(text: string): string[] {
  return text.split('\n').map((line) => line.trim());
}

describe('Dockerfile', () => {
  const dockerfile = read('Dockerfile');
  const dockerLines = lines(dockerfile);
  const instructions = dockerLines.filter(
    (line) => line !== '' && !line.startsWith('#')
  );

  it('has exactly two stages, both node:22-alpine (D-08)', () => {
    const from = instructions.filter((line) => line.startsWith('FROM '));
    expect(from).toEqual([
      'FROM node:22-alpine AS build',
      'FROM node:22-alpine AS runtime',
    ]);
  });

  it('configures the runtime stage as a non-root production server', () => {
    const lastFrom = instructions.findLastIndex((line) =>
      line.startsWith('FROM ')
    );
    const runtime = instructions.slice(lastFrom);
    expect(runtime).toContain('ENV NODE_ENV=production');
    expect(runtime).toContain('USER node');
    expect(runtime).toContain('EXPOSE 8080');
    expect(runtime).toContain('CMD ["node", "dist/server.js"]');
  });

  it('runs every npm ci without lifecycle scripts, and the runtime one without dev dependencies', () => {
    const installs = instructions.filter((line) => line.includes('npm ci'));
    expect(installs).toHaveLength(2);
    for (const install of installs) {
      expect(install).toContain('--ignore-scripts');
    }
    const runtimeInstall = installs.find((line) => line.includes('--omit=dev'));
    expect(runtimeInstall).toBeDefined();
  });

  it('builds with the repository build script', () => {
    expect(instructions).toContain('RUN npm run build');
  });

  it('declares no ARG and no ENV whose name suggests a secret (SEC-03)', () => {
    const declarations = instructions.filter(
      (line) => line.startsWith('ARG ') || line.startsWith('ENV ')
    );
    expect(declarations.length).toBeGreaterThan(0);
    for (const declaration of declarations) {
      expect(declaration).not.toMatch(/TOKEN|SECRET|KEY|PASSWORD/i);
    }
  });

  it('never copies a .env file into the image', () => {
    const copies = instructions.filter(
      (line) => line.startsWith('COPY ') || line.startsWith('ADD ')
    );
    for (const copy of copies) {
      expect(copy).not.toMatch(/\.env/);
    }
  });
});

describe('.dockerignore', () => {
  const entries = lines(read('.dockerignore'));

  it.each([
    '.env',
    '.env.*',
    '.git',
    '.planning',
    '.claude',
    'node_modules',
    '**/__tests__',
  ])('lists %s', (entry) => {
    expect(entries).toContain(entry);
  });
});

describe('scripts/smoke.sh', () => {
  const smoke = read('scripts/smoke.sh');

  it('starts with the env-based bash shebang', () => {
    expect(smoke.startsWith('#!/usr/bin/env bash\n')).toBe(true);
  });

  it.each([
    'set -euo pipefail',
    'mcp-session-id',
    'docker stop -t 10',
    'CANARY_TOKEN',
    'ALTEGIO_API_TOKEN=',
  ])('contains %s', (fragment) => {
    expect(smoke).toContain(fragment);
  });

  it('passes the canary token as ALTEGIO_API_TOKEN (D-01)', () => {
    expect(smoke).toContain('-e ALTEGIO_API_TOKEN="$CANARY_TOKEN"');
  });

  it('has its executable bit set', () => {
    expect(() =>
      accessSync(join(ROOT, 'scripts/smoke.sh'), constants.X_OK)
    ).not.toThrow();
  });
});
