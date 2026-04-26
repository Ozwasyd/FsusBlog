import js from '@eslint/js'
import vueParser from 'vue-eslint-parser'
import vue from 'eslint-plugin-vue'
import tsParser from '@typescript-eslint/parser'
import globals from 'globals'

const sourceFiles = ['src/**/*.{ts,tsx,vue}', 'wasm/web/**/*.ts', 'vite.config.ts']

export default [
  {
    ignores: [
      'dist/**',
      'obj/**',
      'node_modules/**',
      'public/wasm/**',
      'wasm/build/**',
      'wasm/dist/**',
      'auto-imports.d.ts',
      'components.d.ts'
    ]
  },
  {
    linterOptions: {
      reportUnusedDisableDirectives: 'error'
    }
  },
  {
    files: sourceFiles,
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parser: vueParser,
      parserOptions: {
        parser: tsParser,
        extraFileExtensions: ['.vue'],
        ecmaVersion: 'latest',
        sourceType: 'module'
      },
      globals: {
        ...globals.browser,
        ...globals.es2024,
        ...globals.node,
        ...globals.worker
      }
    },
    plugins: {
      vue
    },
    rules: {
      ...vue.configs['flat/base'].rules,
      'no-unused-vars': 'off',
      'no-undef': 'off'
    }
  }
]
