# Comment Guard TypeScript plugin

`plugin.ts` imports the repository-local `@fsusblog/plugin-sdk` through the
`tsconfig.json` path alias. The SDK is a private source/type asset and is not
published.

The server never compiles TypeScript. A plugin author runs a local TypeScript
compiler or bundler and packages the import-free ESM artifact as
`dist/main.js`. The checked-in `dist/main.js` is the fixture consumed by the
real Jint runtime tests.

Type-check the source fixture:

```bash
../FsusUI/node_modules/.bin/tsc \
  --project examples/plugins/comment-guard/tsconfig.json
```
