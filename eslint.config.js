const { FlatCompat } = require('@eslint/eslintrc');
const js = require('@eslint/js');

const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
});

module.exports = [
  {
    ignores: [
      '**/*.d.ts',
      'node_modules/',
      'dist/',
      'coverage/',
      '.nyc_output/',
      'resource/',
      'resource-init/',
    ],
  },
  ...compat.extends('eslint-config-egg/typescript'),
  {
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'module',
      globals: {
        ...require('globals').browser,
        ...require('globals').es2021,
      },
    },
    rules: {
      // Disable rules from original config
      // Disable egg config restrictions on node built-in modules (CLI tool needs them)
      'no-restricted-imports': 'off',
      'no-restricted-modules': 'off',
      'indent': 'off',
      'quotes': 'off',
      'valid-jsdoc': 'off',
      'no-script-url': 'off',
      'no-multi-spaces': 'off',
      'default-case': 'off',
      'jsdoc/require-returns-type': 'off',
      'no-case-declarations': 'off',
      'one-var-declaration-per-line': 'off',
      'no-restricted-syntax': 'off',
      'jsdoc/require-param': 'off',
      'jsdoc/check-param-names': 'off',
      'jsdoc/require-param-description': 'off',
      'jsdoc/check-tag-names': 'off',
      'arrow-parens': 'off',
      'prefer-promise-reject-errors': 'off',
      'no-control-regex': 'off',
      'no-use-before-define': 'off',
      'array-callback-return': 'off',
      'no-bitwise': 'off',
      'no-self-compare': 'off',
      'one-var': 'off',
      'quote-props': 'off',
      'no-sparse-arrays': 'off',
      'no-useless-concat': 'off',
      // TypeScript specific rules
      '@typescript-eslint/class-name-casing': 'off',
      '@typescript-eslint/no-var-requires': 'off',
      '@typescript-eslint/ban-ts-ignore': 'off',
      '@typescript-eslint/no-use-before-define': 'off',
      '@typescript-eslint/no-unused-vars': [ 'error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Disable rules that cause issues with ESLint 9
      'no-undef': 'off', // TypeScript handles this
      // eslint-plugin-node rules incompatible with ESLint 9
      'node/prefer-global/buffer': 'off',
      'node/prefer-global/console': 'off',
      'node/prefer-global/process': 'off',
      'node/prefer-global/text-decoder': 'off',
      'node/prefer-global/text-encoder': 'off',
      'node/prefer-global/url': 'off',
      'node/prefer-global/url-search-params': 'off',
      'node/prefer-promises/dns': 'off',
      'node/prefer-promises/fs': 'off',
      'node/no-unsupported-features/es-builtins': 'off',
      'node/no-unsupported-features/es-syntax': 'off',
      'node/no-unsupported-features/node-builtins': 'off',
      'node/no-deprecated-api': 'off',
      'node/exports-style': 'off',
      'node/file-extension-in-import': 'off',
      'node/no-missing-import': 'off',
      'node/no-missing-require': 'off',
      'node/no-unpublished-bin': 'off',
      'node/no-unpublished-import': 'off',
      'node/no-unpublished-require': 'off',
      'node/prefer-node-protocol': 'off',
    },
  },
];
