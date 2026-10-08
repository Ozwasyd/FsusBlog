import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const blog = process.argv[2], ui = process.argv[3], out = process.argv[4];
const req = createRequire(`${ui}/package.json`);
const { build } = await import(pathToFileURL(req.resolve('vite')));
const { default: vue } = await import(pathToFileURL(req.resolve('@vitejs/plugin-vue')));
const { createFsusUiAliases } = await import(`${blog}/src/frontend/scripts/fsusui-local.ts`);
await build({ configFile: false, root: `${blog}/tests/frontend/fixtures/localeMenuProbe`, plugins: [vue()], worker: { format: 'es' }, resolve: { dedupe: ['vue'], alias: [...createFsusUiAliases(ui), { find: '@', replacement: `${blog}/src/frontend/src` }, { find: /^vue$/, replacement: `${ui}/node_modules/vue/dist/vue.runtime.esm-bundler.js` }] }, build: { outDir: out, emptyOutDir: true, minify: false, sourcemap: false } });
