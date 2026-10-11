import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
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

/** Resolve imported SFCs with the same compiler and Vue language plugin as vue-tsc. */
export function createLocalFsusUiEslintParser({ repositoryRoot, project, parser })
{
    const require = createRequire(path.join(repositoryRoot, 'src/frontend/package.json'));
    const ts = require('typescript');
    const core = require('@vue/language-core');
    const { proxyCreateProgram } = require('@volar/typescript/lib/node/proxyCreateProgram');
    const { vueOptions } = core.createParsedCommandLine(ts, ts.sys, project.replaceAll(path.sep, '/'));
    const parsed = ts.parseJsonSourceFileConfigFileContent(
        ts.readJsonConfigFile(project, ts.sys.readFile), ts.sys, path.dirname(project), {}, project,
        undefined, core.getAllExtensions(vueOptions).map((extension) => ({
            extension, isMixedContent: true, scriptKind: ts.ScriptKind.Deferred
        }))
    );
    if (parsed.errors.length > 0)
    {
        throw new Error(ts.formatDiagnosticsWithColorAndContext(parsed.errors, {
            getCurrentDirectory: () => path.dirname(project),
            getCanonicalFileName: (file) => file,
            getNewLine: () => '\n'
        }));
    }
    // vue-tsc registers SFC extensions in tsc. Its compiler-host API instead needs
    // this flag so unimported SFC roots remain in the complete application program.
    parsed.options.allowNonTsExtensions = true;
    const host = ts.createCompilerHost(parsed.options, true);
    const readSourceFile = host.getSourceFile.bind(host);
    const sourceFiles = new Map();
    let lintFile = null;
    let lintCode = null;
    let program;
    host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) =>
    {
        if (file === lintFile)
        {
            return ts.createSourceFile(file, lintCode, languageVersion, true);
        }
        if (!sourceFiles.has(file) || shouldCreateNewSourceFile)
        {
            sourceFiles.set(file, readSourceFile(file, languageVersion, onError, shouldCreateNewSourceFile));
        }
        return sourceFiles.get(file);
    };
    const createProgram = proxyCreateProgram(ts, ts.createProgram, () =>
    {
        const plugin = core.createVueLanguagePlugin(ts, parsed.options, vueOptions, (id) => id);
        return [{
            ...plugin,
            getLanguageId: (id) => id === lintFile ? 'typescript' : plugin.getLanguageId(id)
        }];
    });
    return {
        ...parser,
        parseForESLint(code, options)
        {
            // vue-eslint-parser also requests syntax-only parses for setup/style fragments.
            if (!options.project)
            {
                return parser.parseForESLint(code, options);
            }
            // Keep its original script AST/locations for linting. Only this script text is
            // supplied by the parser; every imported SFC uses real Vue compiler output.
            lintFile = options.filePath;
            lintCode = code;
            // A fixer can supply newer source before ESLint writes it to disk.
            sourceFiles.delete(lintFile);
            program = createProgram({ rootNames: parsed.fileNames, options: parsed.options, host, oldProgram: program });
            return parser.parseForESLint(code, {
                ...options,
                project: false,
                projectService: false,
                programs: [program],
                disallowAutomaticSingleRunInference: true
            });
        }
    };
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
