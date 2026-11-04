const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    // `inchat` is a separate Next.js application with its own eslint config,
    // toolchain and CI job; the Express app must not lint its sources or output.
    ignores: ['node_modules/**', 'coverage/**', 'public/vendor/**', 'inchat/**']
  },
  {
    ...js.configs.recommended,
    files: ['src/**/*.js', 'tests/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node }
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
      'no-var': 'error',
      'object-shorthand': 'error'
    }
  },
  {
    files: ['tests/**/*.js'],
    rules: { 'no-console': 'off' }
  },
  {
    files: ['public/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: { ...globals.browser }
    },
    rules: { 'no-console': 'off' }
  }
];
