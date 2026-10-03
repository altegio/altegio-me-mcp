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
        },
        // 151002: ts-jest ESM interop notice.
        // 2823: raised because ts-jest compiles to CommonJS for the test run
        // while the JSON import needs the `with { type: 'json' }` attribute
        // that `npm run typecheck` checks.
        diagnostics: {
          ignoreCodes: [151002, 2823],
        },
      },
    ],
  },
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts'],
  setupFilesAfterEnv: ['<rootDir>/src/__tests__/setup.ts'],
};
