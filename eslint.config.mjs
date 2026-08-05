import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'

export default defineConfig(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/out/**',
      '**/build/**',
      '**/scripts/.tmp-*/**',
      '**/.eslintcache',
      '**/coverage/**'
    ]
  },
  tseslint.configs.recommended,
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules,
      // Icon/const export alongside components is intentional (icon maps,
      // Dialog sizes, toast variants); fast refresh still works for the
      // components themselves.
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // allowExpressions: React callbacks (JSX handlers, .map, useEffect) don't
      // need an explicit return type — the value is inferred at the call site.
      '@typescript-eslint/explicit-function-return-type': [
        'warn',
        { allowExpressions: true }
      ],
      '@typescript-eslint/explicit-module-boundary-types': [
        'warn',
        { allowTypedFunctionExpressions: true }
      ],
      // react-hooks/refs: the imperative graph canvas feeds rAF/gesture loops
      // via "latest-ref sync" (`ref.current = value` during render); ref values
      // never influence render output here, so the rule is net noise. Classic
      // rules (exhaustive-deps, rules-of-hooks) stay on everywhere.
      'react-hooks/refs': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-require-imports': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }
      ],
      '@typescript-eslint/ban-ts-comment': 'warn',
      'no-empty': 'warn',
      // React Compiler analysis stays ON outside the graph dir (see graph
      // override below) as warnings, so state-init-from-props bugs in ordinary
      // components are still surfaced without hard-failing the build.
      'react-hooks/immutability': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn'
    }
  },
  {
    // React Compiler analysis (immutability, set-state-in-effect,
    // preserve-manual-memoization) flags patterns that are deliberate in the
    // imperative canvas: rAF-driven mutation, ref-fed state, memoized closures
    // over gesture refs. Scoped to the graph dir only so ordinary components
    // elsewhere still get full compiler protection.
    files: ['src/renderer/src/components/graph/**'],
    rules: {
      'react-hooks/immutability': 'off',
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/preserve-manual-memoization': 'off'
    }
  },
  {
    // The preload bridge declaration maps the runtime `window.api` surface,
    // whose payloads cross the IPC boundary as opaque JSON. Every `any` there
    // is a deliberate boundary type (matching the preload implementation);
    // tightening them would misrepresent what main actually sends.
    files: ['src/preload/index.d.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off'
    }
  },
  eslintConfigPrettier
)
