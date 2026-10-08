import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { validateUnpromotedMetadataCliAst } from './command-wrapper-input-ast-v2.mjs';

export const commandWrapperCompileProbeV2Schema = 'fsusblog.command-wrapper-compile-probe.v2';
const sourceOwner = 'tools/test/native/execution-envelope-landlock.c';
const productionOwner = 'tools/test/execution-envelope-network.mjs';
const strictFlags = ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror'];
const semanticFlags = ['-std=c11', '-O2'];
const fixedEnvironment = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC' };
const sourceDirectives = [
    '#define _GNU_SOURCE', '#include <errno.h>', '#include <fcntl.h>', '#include <stdint.h>',
    '#include <stdio.h>', '#include <stdlib.h>', '#include <string.h>', '#include <unistd.h>',
    '#include <linux/landlock.h>', '#include <sys/prctl.h>', '#include <sys/stat.h>', '#include <sys/syscall.h>',
    '#ifndef LANDLOCK_ACCESS_FS_IOCTL_DEV', '#define LANDLOCK_ACCESS_FS_IOCTL_DEV (1ULL << 15)', '#endif'
];
const contamination = /^(?:CPATH|C_INCLUDE_PATH|CPLUS_INCLUDE_PATH|OBJC_INCLUDE_PATH|GCC_.*|COMPILER_PATH|LIBRARY_PATH|LD_.*|DYLD_.*|DEPENDENCIES_OUTPUT|SUNPRO_DEPENDENCIES|SOURCE_DATE_EPOCH|COLLECT_.*|CC|CXX|CPP|CFLAGS|CPPFLAGS|CXXFLAGS|LDFLAGS|SDKROOT|MACOSX_DEPLOYMENT_TARGET|CCC_.*|CLANG_.*|LLVM_.*|RC_DEBUG_OPTIONS|QA_OVERRIDE_GCC3_OPTIONS|EXPERIMENTAL_SARIF_SOCKET)$/u;

function digest(value)
{
    return crypto.createHash('sha256').update(value).digest('hex');
}

function sortedObject(value)
{
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function plainObject(value, name)
{
    assert.ok(value && Object.getPrototypeOf(value) === Object.prototype, `${name} must be a plain object`);
    assert.equal(Object.getOwnPropertySymbols(value).length, 0, `${name} has symbol fields`);
    assert.ok(Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor => Object.hasOwn(descriptor, 'value')),
        `${name} has accessor fields`);
}

function jsonData(value, ancestors = new Set())
{
    if (value === null || ['string', 'boolean'].includes(typeof value))
    {
        return;
    }
    if (typeof value === 'number')
    {
        assert.ok(Number.isFinite(value), 'non-finite binding input');
        return;
    }
    assert.ok(value && typeof value === 'object' && !ancestors.has(value), 'non-JSON or cyclic binding input');
    if (Array.isArray(value))
    {
        assert.equal(Object.getPrototypeOf(value), Array.prototype, 'unsupported array prototype');
        assert.deepEqual(Object.keys(value), Array.from({ length: value.length }, (_, index) => String(index)), 'sparse or extended binding array');
    }
    else
    {
        plainObject(value, 'binding input');
    }
    assert.equal(Object.getOwnPropertySymbols(value).length, 0, 'binding input has symbol fields');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    assert.ok(Object.values(descriptors).every(descriptor => Object.hasOwn(descriptor, 'value')), 'binding input has accessor fields');
    const nestedAncestors = new Set([...ancestors, value]);
    for (const [name, descriptor] of Object.entries(descriptors))
    {
        if (!Array.isArray(value) || name !== 'length')
        {
            assert.ok(descriptor.enumerable, 'non-enumerable binding field');
            jsonData(descriptor.value, nestedAncestors);
        }
    }
}

function exactKeys(value, keys, name)
{
    plainObject(value, name);
    assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${name} has unknown or missing fields`);
}

function boundedSourceBytes(file)
{
    const maximumBytes = 64 * 1024;
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try
    {
        const stat = fs.fstatSync(descriptor);
        assert.ok(stat.isFile() && stat.size <= maximumBytes, 'registered wrapper source exceeds the supported bounded query size');
        const bytes = Buffer.alloc(maximumBytes + 1);
        let length = 0;
        while (length < bytes.length)
        {
            const read = fs.readSync(descriptor, bytes, length, bytes.length - length, null);
            if (read === 0)
            {
                break;
            }
            length += read;
        }
        assert.ok(length <= maximumBytes, 'registered wrapper source grew beyond the bounded query size');
        assert.equal(fs.fstatSync(descriptor).size, length, 'source changed size during bounded read');
        return bytes.subarray(0, length);
    }
    finally
    {
        fs.closeSync(descriptor);
    }
}

function regularFile(file, boundedSource = false)
{
    assert.ok(path.isAbsolute(file) && safePath(file), 'unsupported absolute file path');
    const resolved = fs.realpathSync(file);
    const stat = fs.statSync(resolved);
    assert.ok(stat.isFile(), `not a regular file: ${file}`);
    const bytes = boundedSource ? boundedSourceBytes(resolved) : fs.readFileSync(resolved);
    assert.equal(bytes.length, stat.size, 'file changed size during identity observation');
    return { path: file, realPath: resolved, sha256: digest(bytes), bytes: stat.size };
}

function safePath(file)
{
    return !/[\s"\\]/u.test(file) && [...file].every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127);
}

function ownedOutput(file, root)
{
    let current = root;
    const parts = path.relative(root, file).split(path.sep);
    for (const [index, part] of parts.entries())
    {
        assert.ok(part && part !== '.' && part !== '..', 'unsupported output path segment');
        current = path.join(current, part);
        try
        {
            const stat = fs.lstatSync(current);
            assert.ok(!stat.isSymbolicLink(), 'compile output symlink refused');
            assert.ok(index === parts.length - 1 ? stat.isFile() : stat.isDirectory(), 'compile output ownership mismatch');
        }
        catch (error)
        {
            if (error.code !== 'ENOENT')
            {
                throw error;
            }
            // Once a parent does not exist, no descendant can currently resolve through a symlink.
            return;
        }
    }
}

function run(compiler, args, cwd, environment)
{
    const result = spawnSync(compiler, args, {
        cwd, env: environment, encoding: 'utf8', shell: false,
        timeout: 30_000, killSignal: 'SIGKILL', detached: true,
        maxBuffer: 32 * 1024 * 1024, windowsHide: true
    });
    if ((result.error || result.signal) && Number.isSafeInteger(result.pid) && result.pid > 0)
    {
        try
        {
            // The detached child owns this process group. Timeout cleanup includes driver children.
            process.kill(-result.pid, 'SIGKILL');
        }
        catch (error)
        {
            if (error.code !== 'ESRCH')
            {
                throw error;
            }
        }
    }
    assert.ok(!result.error && result.status === 0 && result.signal === null,
        `compile binding subprocess failed: ${path.basename(compiler)} ${args[0]}: ${String(result.stderr).slice(0, 1800)}`);
    return result;
}

function compilerIdentity(profile, cwd, environment)
{
    exactKeys(profile, ['path', 'realPath', 'sha256', 'version'], 'compiler profile');
    const observed = regularFile(profile.path);
    assert.equal(observed.realPath, profile.realPath, 'compiler realpath drift');
    assert.equal(observed.sha256, profile.sha256, 'compiler digest drift');
    const version = run(profile.path, ['--version'], cwd, environment).stdout.trim();
    assert.equal(version, profile.version, 'compiler version drift');
    return { ...observed, version };
}

/** Profile observation only; callers must obtain independent approval before it becomes policy. */
export function observeCurrentCompilerToolchain({ compiler, root, environment })
{
    const target = run(compiler, ['-dumpmachine'], root, environment).stdout.trim();
    assert.equal(target, 'x86_64-linux-gnu', 'unsupported canonical compiler target');
    const programs = ['cc1', 'collect2', 'as', 'ld'].map(name =>
    {
        const located = run(compiler, [`-print-prog-name=${name}`], root, environment).stdout.trim();
        const file = path.isAbsolute(located) ? located : ['/usr/bin', '/bin']
            .map(directory => path.join(directory, located)).find(candidate => fs.existsSync(candidate));
        assert.ok(file && file.startsWith('/usr/'), 'compiler subprogram is outside the approved system toolchain');
        const identity = regularFile(file);
        assert.ok(identity.realPath.startsWith('/usr/'), 'compiler subprogram resolves outside the system toolchain');
        return { name, ...identity, version: run(file, ['--version'], root, environment).stdout.trim() };
    });
    const plugin = run(compiler, ['-print-file-name=liblto_plugin.so'], root, environment).stdout.trim();
    const linkPlugin = regularFile(plugin);
    assert.ok(linkPlugin.path.startsWith('/usr/') && linkPlugin.realPath.startsWith('/usr/'), 'foreign link plugin');
    return {
        target,
        searchDirectoriesSha256: digest(run(compiler, ['-print-search-dirs'], root, environment).stdout),
        specsSha256: digest(run(compiler, ['-dumpspecs'], root, environment).stdout),
        programs, linkPlugin
    };
}

function directives(source)
{
    assert.ok(!source.includes('\\\n') && !source.includes('\\\r') && !source.includes('??') && !source.includes('%:'),
        'unsupported directive spelling or line splice');
    // Comment masking preserves strings and line positions; embedded directive text in comments is not authority.
    const masked = source.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu,
        match => match.startsWith('/') ? match.replace(/[^\n]/gu, ' ') : match);
    const actual = masked.split('\n').filter(line => /^\s*#/u.test(line))
        .map(line => line.trim().replace(/\s+/gu, ' '));
    assert.deepEqual(actual, sourceDirectives, 'unapproved preprocessing directives or include sequence');
}

function tokens(value)
{
    const expression = /(?:u8|u|U|L)?(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|[A-Za-z_]\w*|(?:\.?\d)(?:[\w.]|[eEpP][+-])*|>>=|<<=|\.\.\.|##|->|\+\+|--|&&|\|\||<=|>=|==|!=|\*=|\/=|%=|\+=|-=|<<|>>|&=|\^=|\|=|[^\s]/gu;
    return value.match(expression) ?? [];
}

function ownPreprocessedTokens(output, source)
{
    let current = null;
    const own = [];
    for (const line of output.split('\n'))
    {
        const marker = line.match(/^#\s+\d+\s+("(?:\\.|[^"\\])*")(?:\s+\d+)*\s*$/u);
        if (marker)
        {
            current = JSON.parse(marker[1]);
        }
        else if (current === source)
        {
            assert.ok(!/^\s*#/u.test(line), 'unsupported preprocessed directive');
            own.push(line);
        }
    }
    const result = tokens(own.join('\n'));
    assert.ok(result.length > 0, 'missing own preprocessed token stream');
    return result;
}

function macros(output)
{
    const result = {};
    for (const line of output.trim().split('\n'))
    {
        const match = line.match(/^#define ([A-Za-z_]\w*(?:\([^)]*\))?)(?: (.*))?$/u);
        assert.ok(match, 'unsupported macro observation');
        assert.ok(!Object.hasOwn(result, match[1]), 'duplicate macro observation');
        result[match[1]] = match[2] ?? '';
    }
    return sortedObject(result);
}

function criticalMacros(source, left, right)
{
    const code = source.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu,
        match => match.replace(/[^\n]/gu, ' '));
    const pending = [...new Set(code.match(/[A-Za-z_]\w*/gu))];
    const selected = {};
    for (let index = 0; index < pending.length; index += 1)
    {
        const name = pending[index];
        if (!Object.hasOwn(left, name) && !Object.hasOwn(right, name))
        {
            continue;
        }
        assert.ok(Object.hasOwn(left, name) && Object.hasOwn(right, name), `compiler-specific macro ${name}`);
        assert.deepEqual(tokens(left[name]), tokens(right[name]), `critical macro drift: ${name}`);
        if (!Object.hasOwn(selected, name))
        {
            selected[name] = left[name];
            pending.push(...tokens(left[name]).filter(token => /^[A-Za-z_]\w*$/u.test(token)));
        }
    }
    const expected = {
        __STDC_VERSION__: '201112L', __linux__: '1', __x86_64__: '1', __LP64__: '1',
        __SIZEOF_POINTER__: '8', __OPTIMIZE__: '1', __BYTE_ORDER__: '__ORDER_LITTLE_ENDIAN__',
        __ORDER_LITTLE_ENDIAN__: '1234', __NR_landlock_create_ruleset: '444',
        __NR_landlock_add_rule: '445', __NR_landlock_restrict_self: '446',
        __O_PATH: '010000000', __O_CLOEXEC: '02000000', PR_SET_NO_NEW_PRIVS: '38'
    };
    for (const [name, value] of Object.entries(expected))
    {
        assert.equal(left[name], value, `unsupported canonical target macro ${name}`);
        assert.equal(right[name], value, `unsupported semantic target macro ${name}`);
        selected[name] = value;
    }
    return sortedObject(selected);
}

function dependencyFiles(output, root, source, resourceDirectory = null)
{
    const normalized = output.replace(/\\\r?\n/gu, ' ');
    assert.ok(normalized.startsWith('binding: '), 'unsupported dependency rule');
    const paths = normalized.slice('binding: '.length).trim().split(/\s+/u);
    assert.ok(paths.length > 1 && paths.every(file => !/[\\:$#]/u.test(file)), 'unsupported dependency filename');
    const result = [...new Set(paths.map(file => path.resolve(root, file)))].sort().map(file => regularFile(file, file === source));
    assert.ok(result.some(file => file.path === source), 'dependency closure omits source');
    for (const file of result)
    {
        assert.ok(file.path === source || (file.path.startsWith('/usr/') && file.realPath.startsWith('/usr/'))
            || (resourceDirectory && file.path.startsWith(resourceDirectory + path.sep)
                && file.realPath.startsWith(resourceDirectory + path.sep)),
        `non-system input in header closure: ${file.path}`);
    }
    return result;
}

/** Header profile observation only, excluding the semantically admitted candidate source. */
export function observeCurrentCompilerHeaders({ compiler, root, file, environment, resourceDirectory = null })
{
    const source = path.resolve(root, file);
    return dependencyFiles(run(compiler, [...semanticFlags, '-M', '-MT', 'binding', source], root, environment).stdout, root, source, resourceDirectory)
        .filter(identity => identity.path !== source);
}

/** Macro profile observation only; observation is not authority approval. */
export function observeCurrentCompilerMacroDigest({ compiler, root, file, environment })
{
    const source = path.resolve(root, file);
    return digest(JSON.stringify(macros(run(compiler, [...semanticFlags, '-dM', '-E', source], root, environment).stdout)));
}

/**
 * Unpromoted current-source probe. Its input is a proposed observed profile, never trusted authority.
 * No registry/checker imports this method. It returns no analyzer options or qualification.
 * The separate resource-directory identity supports task-scoped official Clang installations;
 * every header still requires an exact complete profile and before/after byte identity.
 * Independent owner review is required before any separately versioned authority integration.
 * Only the current Linux x86_64 canonical owner entry is supported; unknown contexts refuse.
 */
export function observeUnpromotedMetadataCompileBinding({ root, file, entry, policy, environment = process.env })
{
    jsonData(policy);
    jsonData(entry);
    policy = structuredClone(policy);
    entry = structuredClone(entry);
    exactKeys(policy, ['schema', 'source', 'owner', 'platform', 'arch', 'environment', 'compiler', 'semanticCompiler', 'canonicalToolchain', 'canonicalHeaders', 'semanticHeaders', 'canonicalMacrosSha256', 'semanticMacrosSha256', 'semanticResourceDirectory'], 'compile policy');
    assert.equal(policy.schema, commandWrapperCompileProbeV2Schema, 'compile binding schema mismatch');
    assert.equal(policy.source, sourceOwner, 'unregistered source owner');
    assert.equal(policy.owner, productionOwner, 'unregistered compile owner');
    assert.equal(policy.platform, 'linux', 'unsupported platform policy');
    assert.equal(policy.arch, 'x64', 'unsupported architecture policy');
    assert.equal(process.platform, policy.platform, 'platform mismatch');
    assert.equal(process.arch, policy.arch, 'architecture mismatch');
    assert.deepEqual(policy.environment, fixedEnvironment, 'unapproved environment declaration');
    assert.ok(environment && typeof environment === 'object', 'missing compile environment');
    assert.equal(Object.getOwnPropertySymbols(environment).length, 0, 'environment symbol fields refused');
    assert.ok(Object.values(Object.getOwnPropertyDescriptors(environment)).every(descriptor => Object.hasOwn(descriptor, 'value')),
        'environment accessor fields refused');
    for (const [name, value] of Object.entries(environment))
    {
        assert.ok(typeof value === 'string' && !value.includes('\0'), `invalid environment value ${name}`);
        assert.ok(!contamination.test(name), `compile environment contamination: ${name}`);
    }
    for (const [name, value] of Object.entries(fixedEnvironment))
    {
        assert.equal(environment[name], value, `effective environment drift: ${name}`);
    }
    root = path.resolve(root);
    assert.equal(fs.realpathSync(root), root, 'root must be its realpath');
    const source = path.join(root, sourceOwner);
    assert.equal(path.resolve(root, file), source, 'file is not the registered source');
    const sourceIdentity = regularFile(source, true);
    assert.equal(sourceIdentity.realPath, source, 'source symlink refused');
    exactKeys(entry, ['directory', 'file', 'arguments'], 'compile database entry');
    assert.equal(entry.directory, root, 'compile working directory mismatch');
    assert.equal(entry.file, source, 'compile entry source mismatch');
    assert.ok(Array.isArray(entry.arguments) && entry.arguments.every(value => typeof value === 'string'), 'arguments array required');
    const output = entry.arguments[7];
    assert.ok(typeof output === 'string' && path.isAbsolute(output)
        && path.resolve(output) === output
        && output.startsWith(path.join(root, '.tmp') + path.sep) && safePath(output),
    'compile output must be an owned repository temporary path');
    assert.deepEqual(entry.arguments, [policy.compiler.path, ...strictFlags, '-o', output, source],
        'compile entry flags, ordering, compiler, or source mismatch');
    ownedOutput(output, root);
    const bytes = boundedSourceBytes(source);
    assert.ok(!bytes.includes(0), 'source contains NUL');
    const sourceText = bytes.toString('utf8');
    assert.ok(Buffer.from(sourceText).equals(bytes), 'source is not UTF-8');
    directives(sourceText);
    const temporaryRoot = path.join(root, '.tmp');
    fs.mkdirSync(temporaryRoot, { recursive: true });
    assert.equal(fs.realpathSync(temporaryRoot), temporaryRoot, 'temporary root symlink refused');
    const temporary = fs.mkdtempSync(path.join(temporaryRoot, 'command-wrapper-compile-binding-'));
    try
    {
        const compileEnvironment = { ...fixedEnvironment, TMPDIR: temporary, TMP: temporary, TEMP: temporary };
        const compiler = compilerIdentity(policy.compiler, root, compileEnvironment);
        const semanticCompiler = compilerIdentity(policy.semanticCompiler, root, compileEnvironment);
        exactKeys(policy.semanticResourceDirectory, ['path', 'realPath'], 'semantic resource directory');
        const resourceDirectory = run(semanticCompiler.path, ['-print-resource-dir'], root, compileEnvironment).stdout.trim();
        assert.equal(resourceDirectory, policy.semanticResourceDirectory.path, 'semantic resource directory drift');
        assert.equal(fs.realpathSync(resourceDirectory), resourceDirectory, 'semantic resource directory redirected');
        assert.equal(resourceDirectory, policy.semanticResourceDirectory.realPath, 'semantic resource realpath drift');
        assert.ok(fs.lstatSync(resourceDirectory).isDirectory(), 'semantic resource directory is not regular');
        const canonicalToolchain = observeCurrentCompilerToolchain({ compiler: compiler.path, root, environment: compileEnvironment });
        assert.deepEqual(canonicalToolchain, policy.canonicalToolchain, 'canonical compiler subprogram or specs drift');
        const before = [compiler, semanticCompiler].map((identity, index) => ({
            dependencies: dependencyFiles(run(identity.path, [...semanticFlags, '-M', '-MT', 'binding', source], root, compileEnvironment).stdout, root, source, index === 1 ? resourceDirectory : null),
            macros: macros(run(identity.path, [...semanticFlags, '-dM', '-E', source], root, compileEnvironment).stdout),
            ownTokens: ownPreprocessedTokens(run(identity.path, [...semanticFlags, '-E', source], root, compileEnvironment).stdout, source)
        }));
        assert.deepEqual(before[0].dependencies.filter(identity => identity.path !== source), policy.canonicalHeaders,
            'canonical header authority profile drift');
        assert.deepEqual(before[1].dependencies.filter(identity => identity.path !== source), policy.semanticHeaders,
            'semantic header authority profile drift');
        assert.equal(digest(JSON.stringify(before[0].macros)), policy.canonicalMacrosSha256, 'canonical macro authority profile drift');
        assert.equal(digest(JSON.stringify(before[1].macros)), policy.semanticMacrosSha256, 'semantic macro authority profile drift');
        assert.deepEqual(before[0].ownTokens, before[1].ownTokens, 'canonical and semantic own-token streams differ');
        const critical = criticalMacros(sourceText, before[0].macros, before[1].macros);
        const executedArguments = [...entry.arguments];
        executedArguments[7] = path.join(temporary, 'helper');
        const compiled = run(compiler.path, executedArguments.slice(1), root, compileEnvironment);
        const astArguments = [...semanticFlags, '-fsyntax-only', '-Xclang', '-ast-dump=json', source];
        const queried = run(semanticCompiler.path, astArguments, root, compileEnvironment);
        const ast = JSON.parse(queried.stdout);
        assert.equal(ast.kind, 'TranslationUnitDecl', 'missing semantic AST translation unit');
        const semantic = validateUnpromotedMetadataCliAst(ast, { sourceBytes: bytes, sourceFile: source });
        const revalidate = () =>
        {
            for (const [index, identity] of [compiler, semanticCompiler].entries())
            {
                const afterDependencies = dependencyFiles(run(identity.path, [...semanticFlags, '-M', '-MT', 'binding', source], root, compileEnvironment).stdout, root, source, index === 1 ? resourceDirectory : null);
                const afterMacros = macros(run(identity.path, [...semanticFlags, '-dM', '-E', source], root, compileEnvironment).stdout);
                const afterTokens = ownPreprocessedTokens(run(identity.path, [...semanticFlags, '-E', source], root, compileEnvironment).stdout, source);
                assert.deepEqual(afterDependencies, before[index].dependencies, 'header dependency drift during binding');
                assert.deepEqual(afterMacros, before[index].macros, 'macro drift during binding');
                assert.deepEqual(afterTokens, before[index].ownTokens, 'token drift during binding');
                assert.deepEqual(compilerIdentity(index === 0 ? policy.compiler : policy.semanticCompiler, root, compileEnvironment), identity,
                    'compiler drift during binding');
            }
            assert.deepEqual(observeCurrentCompilerToolchain({ compiler: compiler.path, root, environment: compileEnvironment }),
                canonicalToolchain, 'compiler subprogram or specs drift during binding');
            assert.deepEqual(regularFile(source, true), sourceIdentity, 'source drift during binding');
            assert.equal(fs.realpathSync(root), root, 'root physical path drift during binding');
            ownedOutput(output, root);
            assert.equal(run(semanticCompiler.path, ['-print-resource-dir'], root, compileEnvironment).stdout.trim(), resourceDirectory,
                'semantic resource directory changed during binding');
            assert.equal(fs.realpathSync(resourceDirectory), resourceDirectory, 'semantic resource directory redirected during binding');
        };
        revalidate();
        const binding = {
            schema: commandWrapperCompileProbeV2Schema, qualificationEligible: false, policyPromotion: false,
            callerInputAdmission: false, analyzerOptions: [], semantic, semanticResourceDirectory: policy.semanticResourceDirectory,
            source: sourceIdentity, owner: productionOwner, root, entry,
            compiler, semanticCompiler, canonicalToolchain, executedArguments, semanticArguments: astArguments,
            productionCompile: { exitCode: 0, stderrSha256: digest(compiled.stderr), output: regularFile(executedArguments[7]) },
            semanticQuery: { exitCode: 0, stderrSha256: digest(queried.stderr), astSha256: digest(queried.stdout),
                semantics: 'Independent Clang query, not a GCC AST or production compile substitute; warning flags are not semantic flags.' },
            effectiveEnvironment: compileEnvironment,
            observedEnvironmentSha256: digest(JSON.stringify(sortedObject(environment))),
            policySha256: digest(JSON.stringify(sortedObject(policy))),
            canonicalDependencies: before[0].dependencies, semanticDependencies: before[1].dependencies,
            canonicalMacrosSha256: digest(JSON.stringify(before[0].macros)),
            semanticMacrosSha256: digest(JSON.stringify(before[1].macros)),
            criticalMacros: critical, ownTokensSha256: digest(JSON.stringify(before[0].ownTokens))
        };
        // Public report objects must not let a consumer mutate the callback's captured expectations.
        return { binding: structuredClone(binding), ast: queried.stdout, revalidate };
    }
    finally
    {
        // Only this invocation's exact mkdtemp child is removed, never a caller-supplied output.
        fs.rmSync(temporary, { recursive: true, force: true });
    }
}
