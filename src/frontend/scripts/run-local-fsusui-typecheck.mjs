import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { localFsusUiConsumptionDisabled, resolveLocalFsusUiRepositoryRoot } from './fsusui-root.mjs';

const defaultRepositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** The existing local alias producer serves focused contracts and the complete application. */
export function prepareLocalFsusUiTypecheckProject({ repositoryRoot, localRoot, fullApplication = false })
{
    const frontendRoot = path.join(repositoryRoot, 'src/frontend');
    const tempRoot = fullApplication
        ? path.join(frontendRoot, '.tmp/typecheck')
        : path.join(frontendRoot, 'node_modules/.tmp');
    const configPath = path.join(tempRoot, fullApplication
        ? 'tsconfig.fsusui-local.app.generated.json'
        : 'tsconfig.fsusui-local.generated.json');
    const fromGeneratedConfigRoot = (file) => path.relative(tempRoot, file).replaceAll(path.sep, '/');
    const fromLocal = (...segments) => path.relative(frontendRoot, path.join(localRoot, ...segments)).replaceAll(path.sep, '/');

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

    const localDeclarations = [
        fromGeneratedConfigRoot(path.join(localRoot, 'vue', 'global.d.ts')),
        fromGeneratedConfigRoot(path.join(localRoot, 'vue', 'typings', 'components.d.ts')),
        fromGeneratedConfigRoot(path.join(localRoot, 'vue', 'typings', 'env.d.ts'))
    ];
    const configuration = {
        compilerOptions: {
            ...(fullApplication ? { composite: false } : {
                erasableSyntaxOnly: false,
                types: ['vite/client', 'node']
            }),
            jsx: 'preserve',
            jsxImportSource: 'vue',
            paths,
            tsBuildInfoFile: fullApplication
                ? './tsconfig.fsusui-local.app.generated.tsbuildinfo'
                : './tsconfig.fsusui-local.generated.tsbuildinfo'
        },
        extends: fromGeneratedConfigRoot(path.join(frontendRoot, fullApplication
            ? 'tsconfig.app.json'
            : 'tsconfig.fsusui-published.json')),
        ...(fullApplication ? { files: localDeclarations } : {
            include: [
                fromGeneratedConfigRoot(path.join(repositoryRoot, 'tests/frontend/typecheck/fsusui-export-contract.ts')),
                fromGeneratedConfigRoot(path.join(repositoryRoot, 'tests/frontend/typecheck/admin-segmented-control-consumer-contract.ts')),
                fromGeneratedConfigRoot(path.join(repositoryRoot, 'tests/frontend/typecheck/fsusui-local-export-contract.ts')),
                fromGeneratedConfigRoot(path.join(frontendRoot, 'src/vite-env.d.ts')),
                ...localDeclarations
            ]
        })
    };
    const content = `${JSON.stringify(configuration, null, 2)}\n`;
    mkdirSync(tempRoot, { recursive: true });
    if (!existsSync(configPath) || readFileSync(configPath, 'utf8') !== content)
    {
        writeFileSync(configPath, content);
    }
    return configPath;
}

/** Local-off keeps the original registry project; invalid configured source roots fail closed. */
export function resolveLocalFsusUiApplicationProject({ repositoryRoot, env = process.env })
{
    if (localFsusUiConsumptionDisabled(env))
    {
        return null;
    }
    const localRoot = resolveLocalFsusUiRepositoryRoot({
        override: env.FSUSBLOG_LOCAL_FSUSUI_ROOT,
        repositoryRoot
    });
    if (!localRoot)
    {
        if (env.FSUSBLOG_USE_LOCAL_FSUSUI === '1')
        {
            throw new Error('local FsusUI source was explicitly enabled but its source contract is unavailable');
        }
        return null;
    }
    return prepareLocalFsusUiTypecheckProject({ repositoryRoot, localRoot, fullApplication: true });
}

function main(args)
{
    if (args.some((argument) => argument !== '--application') || args.length > 1)
    {
        throw new Error('usage: run-local-fsusui-typecheck.mjs [--application]');
    }
    const localRoot = resolveLocalFsusUiRepositoryRoot({
        override: process.env.FSUSBLOG_LOCAL_FSUSUI_ROOT,
        repositoryRoot: defaultRepositoryRoot
    });
    if (!localRoot)
    {
        throw new Error('local FsusUI source was not found; set FSUSBLOG_LOCAL_FSUSUI_ROOT explicitly');
    }
    const configPath = prepareLocalFsusUiTypecheckProject({
        repositoryRoot: defaultRepositoryRoot,
        localRoot,
        fullApplication: args.includes('--application')
    });
    const frontendRoot = path.join(defaultRepositoryRoot, 'src/frontend');
    const vueTscBin = process.platform === 'win32'
        ? 'vue-tsc'
        : path.join(frontendRoot, 'node_modules', '.bin', 'vue-tsc');
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
    process.exitCode = result.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    main(process.argv.slice(2));
}
