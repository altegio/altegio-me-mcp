import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      '.planning/**',
      '.claude/**',
      '.cursor/**',
      '.codex/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ['**/*.ts'],
    ignores: ['scripts/browser-check/**'],
  })),
  {
    files: ['**/*.ts'],
    ignores: ['scripts/browser-check/**'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'no-console': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      // Express error middleware must keep its 4-argument signature.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@modelcontextprotocol/*'],
              message:
                'Only src/mcp/** may import the MCP SDK; tools stay SDK-free and protocol upgrades stay isolated (ADR-0001-D6).',
            },
          ],
        },
      ],
    },
  },
  // The local browser check (not part of the server) gets the plain
  // typescript-eslint recommended set: not type-aware (its Playwright types are
  // only a CI stub) and console output is its interface.
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ['scripts/browser-check/**/*.ts'],
  })),
  {
    files: ['scripts/browser-check/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    // The SDK lives in src/mcp; tests drive the server through the SDK Client.
    files: ['src/mcp/**/*.ts', 'src/**/__tests__/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
  {
    // JS config files (eslint, jest, commitlint) are not part of the TS project.
    files: ['**/*.js', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  }
);
