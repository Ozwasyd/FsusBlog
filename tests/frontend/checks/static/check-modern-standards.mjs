import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const repoRoot = resolve(process.cwd(), '..', '..');
const execFileAsync = promisify(execFile);
const frontendRequire = createRequire(resolve(repoRoot, 'src/frontend/package.json'));
const typescript = frontendRequire('typescript');
const typescriptCli = frontendRequire.resolve('typescript/lib/tsc.js');
const browserTarget = 'ES2022';
const browserLibs = ['ES2022', 'DOM', 'DOM.Iterable', 'WebWorker'];

async function read(relativePath)
{
    return await readFile(resolve(repoRoot, relativePath), 'utf8');
}

function assertIncludes(haystack, needle, message)
{
    if (!haystack.includes(needle))
    {
        throw new Error(message);
    }
}

function assert(condition, message)
{
    if (!condition)
    {
        throw new Error(message);
    }
}

function assertStringArrayEquals(actual, expected, message)
{
    assert(Array.isArray(actual), message);
    assert(actual.length === expected.length, message);
    assert(actual.every((value, index) => value === expected[index]), message);
}

function parseTsconfig(source, fileName)
{
    const parsed = typescript.parseConfigFileTextToJson(fileName, source);
    assert(parsed.error === undefined, `unable to parse ${fileName} as JSONC`);
    return parsed.config;
}

async function assertEs2023FixtureIsRejected()
{
    const fixture = resolve(repoRoot, 'tests/frontend/fixtures/modern-standards/es2023-array-api.ts');

    try
    {
        await execFileAsync(process.execPath, [
            typescriptCli,
            '--ignoreConfig',
            '--noEmit',
            '--strict',
            '--target',
            browserTarget,
            '--lib',
            'ES2022',
            '--module',
            'ESNext',
            '--moduleResolution',
            'Bundler',
            fixture
        ]);
    }
    catch (error)
    {
        const diagnostics = `${error.stdout ?? ''}\n${error.stderr ?? ''}`;
        assert(
            diagnostics.includes("Property 'toSorted' does not exist") && diagnostics.includes('es2023'),
            `ES2023 negative fixture failed for an unexpected reason:\n${diagnostics.trim()}`
        );
        return;
    }

    throw new Error('ES2023 Array.prototype.toSorted fixture unexpectedly passed the ES2022 browser baseline');
}

const directoryBuildProps = await read('Directory.Build.props');
assertIncludes(directoryBuildProps, '<LangVersion>14.0</LangVersion>', 'C# LangVersion 14.0 is not locked in Directory.Build.props');
assertIncludes(directoryBuildProps, '<Nullable>enable</Nullable>', 'C# Nullable must stay enabled in Directory.Build.props');
assertIncludes(directoryBuildProps, '<AnalysisLevel>latest</AnalysisLevel>', 'C# AnalysisLevel latest must stay enabled in Directory.Build.props');

const powCmake = await read('src/frontend/wasm/pow/CMakeLists.txt');
assertIncludes(powCmake, 'set(CMAKE_CXX_STANDARD 23)', 'pow wasm target must use C++23');
assertIncludes(powCmake, '"-fno-exceptions"', 'pow wasm target must disable exceptions');

const appTsconfig = parseTsconfig(
    await read('src/frontend/tsconfig.app.json'),
    'src/frontend/tsconfig.app.json'
);
assert(appTsconfig.compilerOptions?.target === browserTarget, `browser TypeScript target must be ${browserTarget}`);
assertStringArrayEquals(
    appTsconfig.compilerOptions?.lib,
    browserLibs,
    `browser TypeScript libs must be exactly ${browserLibs.join(', ')}`
);
assertStringArrayEquals(
    appTsconfig.include,
    [
        'src/**/*.ts',
        'src/**/*.tsx',
        'src/**/*.vue',
        'src/vite-env.d.ts',
        'wasm/security/**/*.ts',
        'wasm/web/**/*.ts',
        'auto-imports.d.ts',
        'components.d.ts'
    ],
    'browser TypeScript scope must cover the SPA, hydration, Worker, and Wasm bridge sources without Node build tools'
);

const nodeTsconfig = parseTsconfig(
    await read('src/frontend/tsconfig.node.json'),
    'src/frontend/tsconfig.node.json'
);
assert(nodeTsconfig.compilerOptions?.target === 'ES2023', 'Node/Vite tool target must remain explicitly ES2023');
assertStringArrayEquals(nodeTsconfig.compilerOptions?.lib, ['ES2023'], 'Node/Vite tool libs must remain exactly ES2023');
assertStringArrayEquals(nodeTsconfig.include, ['vite.config.ts'], 'Node/Vite tool scope must remain isolated to vite.config.ts');

const viteConfig = await read('src/frontend/vite.config.ts');
assert(
    /build:\s*\{\s*target:\s*['"]es2022['"],/.test(viteConfig),
    'Vite build.target must be explicitly locked to es2022 at the shared browser build boundary'
);
assertIncludes(viteConfig, 'worker: {', 'Vite worker bundle configuration is missing');
assertIncludes(viteConfig, 'format: "es"', 'Vite worker bundle must remain an ES module built by the shared Vite baseline');

await assertEs2023FixtureIsRejected();

console.log('ok: modern language standards are locked');
