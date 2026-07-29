import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveLocalFsusUiRepositoryRoot } from './fsusui-root.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(scriptDir, '..');
const repositoryRoot = path.resolve(frontendRoot, '../..');
const localRoot = resolveLocalFsusUiRepositoryRoot({
    override: process.env.FSUSBLOG_LOCAL_FSUSUI_ROOT,
    repositoryRoot
});
if (!localRoot)
{
    throw new Error(
        'local FsusUI source was not found beside the primary FsusBlog checkout; '
      + 'set FSUSBLOG_LOCAL_FSUSUI_ROOT explicitly'
    );
}
const tempRoot = path.join(frontendRoot, 'node_modules', '.tmp');
const configPath = path.join(tempRoot, 'tsconfig.fsusui-local.generated.json');
const vueTscBin = process.platform === 'win32'
    ? 'vue-tsc'
    : path.join(frontendRoot, 'node_modules', '.bin', 'vue-tsc');

function toTsconfigPath(value)
{
    return path.relative(frontendRoot, value).replaceAll(path.sep, '/');
}

function fromLocal(...segments)
{
    return toTsconfigPath(path.join(localRoot, ...segments));
}

function fromGeneratedConfigRoot(file)
{
    return path.relative(tempRoot, file).replaceAll(path.sep, '/');
}

const paths = {
    '@/*': ['./src/*'],
    '@wasm/*': ['./wasm/web/*'],
    vue: ['./node_modules/vue'],
    '@vue/*': ['./node_modules/@vue/*'],
    '@ozwasyd/element-plus': [fromLocal('vue', 'packages', 'element-plus', 'index.ts')],
    'element-plus': [fromLocal('vue', 'packages', 'element-plus', 'index.ts')],
    '@ozwasyd/element-plus/icons-vue': [fromLocal('vue', 'packages', 'element-plus', 'icons-vue.ts')],
    '@ozwasyd/element-plus/markdown-runtime': [fromLocal('vue', 'packages', 'element-plus', 'markdown-runtime.ts')],
    '@ozwasyd/element-plus/motion': [fromLocal('vue', 'packages', 'element-plus', 'motion.ts')],
    '@ozwasyd/element-plus/perception-challenge': [fromLocal('vue', 'packages', 'element-plus', 'perception-challenge.ts')],
    '@ozwasyd/element-plus/render-pipeline': [fromLocal('vue', 'packages', 'element-plus', 'render-pipeline.ts')],
    '@ozwasyd/element-plus/result': [fromLocal('vue', 'packages', 'element-plus', 'result.ts')],
    '@ozwasyd/element-plus/theme': [fromLocal('vue', 'packages', 'element-plus', 'theme.ts')],
    '@ozwasyd/element-plus/wasm': [fromLocal('vue', 'packages', 'element-plus', 'wasm.ts')],
    '@element-plus/icons-vue': [fromLocal('vue', 'packages', 'icons-vue', 'src', 'index.ts')],
    '@element-plus/icons-vue/*': [fromLocal('vue', 'packages', 'icons-vue', 'src', '*')],
    '@element-plus/theme-chalk/src': [fromLocal('vue', 'packages', 'theme-chalk', 'src')],
    '@element-plus/theme-chalk/src/*': [fromLocal('vue', 'packages', 'theme-chalk', 'src', '*')],
    '@element-plus/wasm': [fromLocal('vue', 'packages', 'wasm', 'index.ts')],
    '@element-plus/wasm/*': [fromLocal('vue', 'packages', 'wasm', '*')],
    '@element-plus/*': [fromLocal('vue', 'packages', '*')]
};

mkdirSync(tempRoot, { recursive: true });
writeFileSync(
    configPath,
    `${JSON.stringify({
        compilerOptions: {
            erasableSyntaxOnly: false,
            jsx: 'preserve',
            jsxImportSource: 'vue',
            paths,
            tsBuildInfoFile: './tsconfig.fsusui-local.generated.tsbuildinfo',
            types: ['vite/client', 'node']
        },
        extends: '../../tsconfig.fsusui-published.json',
        include: [
            fromGeneratedConfigRoot(path.join(frontendRoot, '..', '..', 'tests', 'frontend', 'typecheck', 'fsusui-export-contract.ts')),
            fromGeneratedConfigRoot(path.join(frontendRoot, '..', '..', 'tests', 'frontend', 'typecheck', 'fsusui-local-export-contract.ts')),
            fromGeneratedConfigRoot(path.join(frontendRoot, 'src', 'vite-env.d.ts')),
            fromGeneratedConfigRoot(path.join(localRoot, 'vue', 'global.d.ts')),
            fromGeneratedConfigRoot(path.join(localRoot, 'vue', 'typings', 'components.d.ts')),
            fromGeneratedConfigRoot(path.join(localRoot, 'vue', 'typings', 'env.d.ts'))
        ]
    }, null, 2)}\n`
);

console.log(`[fsusui-typecheck] local root: ${localRoot}`);
const result = spawnSync(vueTscBin, ['--noEmit', '-p', configPath], {
    cwd: frontendRoot,
    shell: process.platform === 'win32',
    stdio: 'inherit'
});

if (result.error)
{
    throw result.error;
}

process.exit(result.status ?? 1);
