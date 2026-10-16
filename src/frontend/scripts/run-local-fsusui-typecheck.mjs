import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { localFsusUiConsumptionDisabled, resolveLocalFsusUiRepositoryRoot } from './fsusui-root.mjs';

const defaultRepositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** The local alias producer serves focused contracts and the original complete projects. */
export function prepareLocalFsusUiTypecheckProject({ repositoryRoot, localRoot, fullApplication = false, fullTests = false })
{
    if (fullApplication && fullTests)
    {
        throw new Error('application and tests projects are mutually exclusive');
    }
    const frontendRoot = path.join(repositoryRoot, 'src/frontend');
    const completeProject = fullApplication || fullTests;
    const originalProject = fullTests ? 'tsconfig.playwright.json' : fullApplication
        ? 'tsconfig.app.json'
        : 'tsconfig.fsusui-published.json';
    const require = createRequire(path.join(frontendRoot, 'package.json'));
    const ts = require('typescript');
    const original = ts.getParsedCommandLineOfConfigFile(path.join(frontendRoot, originalProject), {}, {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic(diagnostic)
        {
            throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
        }
    });
    if (!original || original.errors.length > 0)
    {
        throw new Error(original?.errors.map((diagnostic) =>
            ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')).join('\n')
            || 'local FsusUI project configuration is unavailable');
    }
    const tempRoot = completeProject
        ? path.join(frontendRoot, '.tmp/typecheck')
        : path.join(frontendRoot, 'node_modules/.tmp');
    const configPath = path.join(tempRoot, fullTests ? 'tsconfig.fsusui-local.tests.generated.json' : fullApplication
        ? 'tsconfig.fsusui-local.app.generated.json'
        : 'tsconfig.fsusui-local.generated.json');
    const fromGeneratedConfigRoot = (file) => path.relative(tempRoot, file).replaceAll(path.sep, '/');
    const generatedPathsBase = original.options.baseUrl ?? tempRoot;
    const originalPathsBase = original.options.baseUrl ?? original.options.pathsBasePath ?? frontendRoot;
    const fromPathsBase = (file) => path.relative(generatedPathsBase, file).replaceAll(path.sep, '/');
    const fromLocal = (...segments) => fromPathsBase(path.join(localRoot, ...segments));
    const originalPaths = Object.fromEntries(Object.entries(original.options.paths ?? {}).map(([specifier, targets]) =>
        [specifier, targets.map((target) => fromPathsBase(path.resolve(originalPathsBase, target)))]));

    const paths = {
        '@/*': [fromPathsBase(path.join(frontendRoot, 'src', '*'))],
        '@wasm/*': [fromPathsBase(path.join(frontendRoot, 'wasm', 'web', '*'))],
        ...originalPaths,
        vue: [fromPathsBase(path.join(frontendRoot, 'node_modules', 'vue'))],
        '@vue/*': [fromPathsBase(path.join(frontendRoot, 'node_modules', '@vue', '*'))],
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
        '@ozwasyd/element-plus/es/*': [fromLocal('vue', 'packages', '*')],
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
    const originalFiles = (original.raw.files ?? []).map((file) =>
        fromGeneratedConfigRoot(path.resolve(frontendRoot, file)));
    const configuration = {
        compilerOptions: {
            ...(fullTests ? {} : {
                ...(fullApplication ? { composite: false } : {
                    erasableSyntaxOnly: false,
                    types: ['vite/client', 'node']
                }),
                jsx: 'preserve',
                jsxImportSource: 'vue',
                tsBuildInfoFile: fullApplication
                    ? './tsconfig.fsusui-local.app.generated.tsbuildinfo'
                    : './tsconfig.fsusui-local.generated.tsbuildinfo'
            }),
            paths
        },
        extends: fromGeneratedConfigRoot(path.join(frontendRoot, originalProject)),
        ...(completeProject ? { files: [...new Set([...originalFiles, ...localDeclarations])] } : {
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
    if (args.some((argument) => !['--application', '--tests'].includes(argument)) || args.length > 1)
    {
        throw new Error('usage: run-local-fsusui-typecheck.mjs [--application | --tests]');
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
        fullApplication: args.includes('--application'),
        fullTests: args.includes('--tests')
    });
    const frontendRoot = path.join(defaultRepositoryRoot, 'src/frontend');
    const compiler = args.includes('--tests') ? 'tsc' : 'vue-tsc';
    const compilerBin = process.platform === 'win32'
        ? compiler
        : path.join(frontendRoot, 'node_modules', '.bin', compiler);
    console.log(`[fsusui-typecheck] local root: ${localRoot}`);
    const result = spawnSync(compilerBin, ['--noEmit', '-p', configPath], {
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
