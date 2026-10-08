import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const { commandPath, commandVersion } = await import(new URL('../test/native-test-runtime-support.mjs', import.meta.url));

const policyFile = 'config/development/native-tooling-style-policy.json';
const compileFlags = new Set(['-g', '-g0', '-O0', '-O1', '-O2', '-O3', '-Os', '-Oz',
    '-std=c++23', '-Wall', '-Wextra', '-Wpedantic', '-Wconversion', '-Wsign-conversion',
    '-Wshadow', '-Wformat=2', '-Wundef', '-Werror', '-fno-exceptions', '-fno-rtti',
    '-fvisibility=hidden', '-fno-omit-frame-pointer', '-fsanitize=address,undefined']);
const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

export function isCppSource(file)
{
    return /\.(?:cc|cpp|cxx|h|hh|hpp|hxx)$/u.test(file);
}

function relative(root, absolute)
{
    const file = path.relative(root, absolute).split(path.sep).join('/');
    if (!file || file.startsWith('../') || path.isAbsolute(file) || !/^[A-Za-z0-9_./+-]+$/u.test(file))
    {
        throw new Error('C++ context requires a supported repository-relative path');
    }
    return file;
}

function bind(root, file)
{
    relative(root, path.resolve(root, file));
    const absolute = path.join(root, file);
    if (!fs.lstatSync(absolute).isFile() || !fs.realpathSync(absolute).startsWith(`${root}${path.sep}`))
    {
        throw new Error(`C++ input is not a regular repository file: ${file}`);
    }
    const bytes = fs.readFileSync(absolute);
    const git = args => execFileSync('git', ['-C', root, ...args]);
    const entry = git(['ls-files', '--stage', '-z', '--', `:(literal)${file}`]).toString('utf8');
    const match = entry.match(/^(100644|100755) ([a-f0-9]{40}) 0\t([^\0]+)\0$/u);
    if (!match || match[3] !== file || !git(['cat-file', 'blob', match[2]]).equals(bytes)
        || git(['rev-parse', `HEAD:${file}`]).toString('utf8').trim() !== match[2])
    {
        throw new Error(`C++ input requires current HEAD/index bytes: ${file}`);
    }
    return { file, blob: match[2], digest: digest(bytes) };
}

function run(compiler, args, directory)
{
    const result = spawnSync(compiler, args, { cwd: directory, encoding: 'utf8',
        timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    if (result.error || result.status !== 0)
    {
        throw new Error(`C++ compiler refused ${args[0]}: ${result.error?.message ?? result.stderr}`);
    }
    return { command: compiler, arguments: args, directory, exitCode: result.status,
        stdout: result.stdout, stderr: result.stderr };
}

// CMake's simple argv form only. Quoting, response files, plugins, wrappers,
// unknown flags and implicit include overrides are not SOURCE execution ports.
export function cppCompileContext(root, entry)
{
    const directory = path.resolve(entry.directory ?? '');
    relative(root, directory);
    const source = path.resolve(directory, entry.file ?? '');
    const file = relative(root, source);
    if (!/\.(?:cc|cpp|cxx)$/u.test(file))
    {
        throw new Error('C++ context requires an actual C++ translation unit');
    }
    const argv = Array.isArray(entry.arguments) ? entry.arguments : entry.command?.trim().split(/ +/u);
    if (!Array.isArray(argv) || !argv.length || argv.some(value => typeof value !== 'string'
        || !/^[A-Za-z0-9_./+=,:+-]+$/u.test(value)))
    {
        throw new Error('unsupported C++ compile argv');
    }
    const name = path.basename(argv[0]);
    if (!/^(?:c\+\+|g\+\+|clang\+\+)(?:-[0-9]+)?$/u.test(name))
    {
        throw new Error('unsupported C++ compiler');
    }
    const compiler = path.isAbsolute(argv[0]) ? argv[0] : commandPath(argv[0]);
    if (!compiler || !fs.existsSync(compiler))
    {
        throw new Error('C++ compiler unavailable');
    }
    const flags = [];
    let inputs = 0;
    let outputs = 0;
    let compileOnly = 0;
    for (let index = 1; index < argv.length; index += 1)
    {
        const argument = argv[index];
        if (argument === '-o')
        {
            const output = argv[++index];
            if (!output || !output.endsWith('.o'))
            {
                throw new Error('unsupported C++ compile output');
            }
            relative(root, path.resolve(directory, output));
            outputs += 1;
        }
        else if (argument === '-c')
        {
            compileOnly += 1;
        }
        else if (compileFlags.has(argument) || /^-D[A-Z_][A-Z0-9_]*(?:=[A-Za-z0-9_]+)?$/u.test(argument))
        {
            flags.push(argument);
        }
        else if (argument.startsWith('-I'))
        {
            const include = path.resolve(directory, argument.slice(2));
            relative(root, include);
            if (argument === '-I' || !fs.statSync(include).isDirectory())
            {
                throw new Error('C++ include directory unavailable');
            }
            flags.push(`-I${include}`);
        }
        else if (!argument.startsWith('-') && path.resolve(directory, argument) === source)
        {
            inputs += 1;
        }
        else
        {
            throw new Error(`unsupported C++ compile argument: ${argument}`);
        }
    }
    if (inputs !== 1 || outputs !== 1 || compileOnly !== 1 || flags.filter(value => value === '-std=c++23').length !== 1)
    {
        throw new Error('incomplete C++23 compile context');
    }
    return { compiler, directory, source, file, flags, originalArguments: argv };
}

function dependencies(observation)
{
    const text = observation.stdout.replace(/\\\r?\n/gu, ' ').trim();
    if (!text.startsWith('fsusblog_source:') || /[\\#$]/u.test(text))
    {
        throw new Error('unsupported C++ compiler dependency output');
    }
    return [...new Set(text.slice('fsusblog_source:'.length).trim().split(/\s+/u))];
}

export function inspectCppSource({ repositoryRoot, files })
{
    const root = fs.realpathSync(repositoryRoot);
    if (!files.length || new Set(files).size !== files.length || files.some(file => !isCppSource(file)))
    {
        throw new Error('C++ SOURCE requires the complete distinct applicable file set');
    }
    for (const name of ['CPATH', 'CPLUS_INCLUDE_PATH', 'C_INCLUDE_PATH', 'GCC_EXEC_PREFIX', 'COMPILER_PATH'])
    {
        if (process.env[name])
        {
            throw new Error(`unsupported implicit C++ compile context: ${name}`);
        }
    }
    const inputs = files.map(file => bind(root, file));
    const policyBinding = bind(root, policyFile);
    const policy = JSON.parse(fs.readFileSync(path.join(root, policyFile), 'utf8'));
    const contexts = [];
    const covered = new Set();
    for (const candidate of policy.standardTools.cppLint.compileDatabaseCandidates)
    {
        const directory = path.resolve(root, candidate);
        relative(root, directory);
        const database = path.join(directory, 'compile_commands.json');
        if (!fs.existsSync(database))
        {
            continue;
        }
        const bytes = fs.readFileSync(database);
        const cacheFile = path.join(directory, 'CMakeCache.txt');
        const cacheBytes = fs.readFileSync(cacheFile);
        const cache = cacheBytes.toString('utf8');
        if (!cache.includes(`CMAKE_HOME_DIRECTORY:INTERNAL=${root}\n`)
            || !cache.includes('CMAKE_PROJECT_NAME:STATIC=FsusBlogNativeTooling\n'))
        {
            throw new Error('unsupported C++ CMake project context');
        }
        const buildInputs = ['CMakeLists.txt', 'tests/native/CMakeLists.txt', 'cmake/FsusWarnings.cmake']
            .map(file => bind(root, file));
        const entries = JSON.parse(bytes);
        if (!Array.isArray(entries) || !entries.length || entries.length > 64)
        {
            throw new Error('unsupported or empty C++ compile database');
        }
        for (const entry of entries)
        {
            const context = cppCompileContext(root, entry);
            if (cache.match(/^CMAKE_CXX_COMPILER:(?:FILEPATH|STRING)=(.+)$/mu)?.[1] !== context.compiler)
            {
                throw new Error('C++ compiler differs from the actual CMake context');
            }
            const version = commandVersion(context.compiler);
            if (!version || !/(?:g\+\+|GCC|clang|Free Software Foundation)/u.test(version))
            {
                throw new Error('C++ compiler identity unavailable or unsupported');
            }
            const sourceBinding = bind(root, context.file);
            const local = run(context.compiler, [...context.flags, '-MM', '-MT', 'fsusblog_source', context.source], context.directory);
            const localInputs = dependencies(local).map(value => bind(root, relative(root, path.resolve(context.directory, value))));
            const applicable = files.filter(file => localInputs.some(input => input.file === file));
            if (!applicable.length)
            {
                continue;
            }
            const all = run(context.compiler, [...context.flags, '-M', '-MT', 'fsusblog_source', context.source], context.directory);
            const closure = dependencies(all).map(value =>
            {
                const absolute = path.resolve(context.directory, value);
                if (!fs.statSync(absolute).isFile())
                {
                    throw new Error('C++ compiler dependency unavailable');
                }
                return { path: absolute, digest: digest(fs.readFileSync(absolute)) };
            });
            const syntax = run(context.compiler, [...context.flags, '-fsyntax-only', context.source], context.directory);
            contexts.push({ files: applicable, compiler: { path: fs.realpathSync(context.compiler), version,
                digest: digest(fs.readFileSync(context.compiler)) }, compileContext: context,
            database: { file: relative(root, database), digest: digest(bytes),
                cacheFile: relative(root, cacheFile), cacheDigest: digest(cacheBytes) }, buildInputs, sourceBinding,
            localInputs, closure, observations: [local, all, syntax] });
            applicable.forEach(file => covered.add(file));
        }
    }
    const missing = files.filter(file => !covered.has(file));
    if (missing.length)
    {
        throw new Error(`C++ compile context missing for actual changed inputs: ${missing.join(', ')}`);
    }
    return { qualificationEligible: false, inputs, policyBinding, contexts };
}
