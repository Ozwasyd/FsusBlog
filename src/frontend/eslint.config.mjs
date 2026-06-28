export default [
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      'src/generated/**',
      'src/frontend/public/wasm/**'
    ]
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    rules: {
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-script-url': 'error',
      'no-new-func': 'error'
    }
  }
]
