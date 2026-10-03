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
  })),
  {
    files: ['**/*.ts'],
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
                'Only src/mcp/** may import the MCP SDK; tools stay SDK-free so a later move to SDK v2 / protocol 2026-07-28 touches src/mcp only (D-04, ADR-0001-D6).',
            },
          ],
        },
      ],
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
    files: ['**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  }
);
