export default {
  preset: 'ts-jest/presets/default-esm',
  extensionsToTreatAsEsm: ['.ts'],
  // Agent worktrees live under .claude/worktrees/ inside this repository;
  // limiting roots to src keeps Jest from crawling their copies of the tests.
  roots: ['<rootDir>/src'],
  moduleNameMapper: {
    // Strip the .js extension from relative specifiers so ts-jest finds .ts files.
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: {
          module: 'ES2022',
          target: 'ES2023',
          // Transpile each file on its own. A type-checking transform builds a
          // whole TypeScript program in every worker; `npm run typecheck`
          // checks the sources and the tests once, and isolatedModules in
          // tsconfig.json makes it reject code that cannot be transpiled
          // file by file.
          isolatedModules: true,
        },
      },
    ],
  },
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts'],
  setupFilesAfterEnv: ['<rootDir>/src/__tests__/setup.ts'],
  // Every test file gets a fresh module graph, and V8 frees the old ones only
  // under heap pressure, so a long-lived worker keeps growing. Two workers,
  // each replaced once its heap passes 256 MB (a fresh one uses about 50 MB),
  // keep a full run near 1 GB whatever the machine's core count.
  maxWorkers: 2,
  workerIdleMemoryLimit: '256MB',
};
