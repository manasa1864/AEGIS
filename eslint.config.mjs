import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'src/app/components/ui/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Node scripts (MCP bridge server)
    files: ['server.js'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['src/**/*.{ts,tsx}', 'tests/**/*.ts', 'scripts/**/*.ts'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': 'off',
      // Fixer regexes intentionally match literal YAML indentation ("  jobs:") —
      // rewriting hundreds of them as {2}/{4} would hurt readability for no gain.
      'no-regex-spaces': 'off',
      'no-useless-escape': 'warn',
      'prefer-const': 'warn',
    },
  },
);
