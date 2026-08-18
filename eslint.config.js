import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules', 'dist'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2024,
      globals: globals.node,
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Invariant 2: the core has no knowledge of audio, and no knowledge of adapters.
    // Adapters depend on the core through the protocol; the dependency never inverts.
    // `tests/invariants/core-independence.spec.ts` asserts the same thing at runtime.
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/adapters/**', '../../adapters/*'],
              message:
                'The core must not import from an adapter (spec §2.1). Adapters attach to the core over the protocol.',
            },
          ],
        },
      ],
    },
  },
);
