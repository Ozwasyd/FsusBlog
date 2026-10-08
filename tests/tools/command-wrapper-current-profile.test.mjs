import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const { observeUnpromotedCurrentCallerClosure, observeUnpromotedCurrentCommandProfile } =
    await import(new URL('../../tools/style/command-wrapper-caller-probe-v2.mjs', import.meta.url));
const { observeCommandWrapperCompileBinding } =
    await import(new URL('../../tools/style/command-wrapper-compile-binding.mjs', import.meta.url));
const {
    commandWrapperCompileProbeV2Schema,
    observeCurrentCompilerHeaders,
    observeCurrentCompilerMacroDigest,
    observeCurrentCompilerToolchain,
    observeUnpromotedMetadataCompileBinding
} = await import(new URL('../../tools/style/command-wrapper-compile-probe-v2.mjs', import.meta.url));

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const file = 'tools/test/native/execution-envelope-landlock.c';
const environment = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC' };

function query(command, args)
{
    const result = spawnSync(command, args, { cwd: root, env: environment, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
}

function identity(command)
{
    return {
        path: command,
        realPath: fs.realpathSync(command),
        sha256: createHash('sha256').update(fs.readFileSync(command)).digest('hex'),
        version: query(command, ['--version'])
    };
}

test('current compiler profile binds actual strict compilation and metadata AST without promoting v1', async (context) =>
{
    const compiler = identity('/usr/bin/cc');
    const clang = execFileSync('/bin/sh', ['-c', 'command -v clang'], { encoding: 'utf8' }).trim();
    const semanticCompiler = identity(clang);
    const resourceDirectory = query(clang, ['-print-resource-dir']);
    const profile = {
        schema: commandWrapperCompileProbeV2Schema,
        source: file,
        owner: 'tools/test/execution-envelope-network.mjs',
        platform: 'linux',
        arch: 'x64',
        environment,
        compiler,
        semanticCompiler,
        canonicalToolchain: observeCurrentCompilerToolchain({ compiler: compiler.path, root, environment }),
        canonicalHeaders: observeCurrentCompilerHeaders({ compiler: compiler.path, root, file, environment }),
        semanticHeaders: observeCurrentCompilerHeaders({ compiler: clang, root, file, environment, resourceDirectory }),
        canonicalMacrosSha256: observeCurrentCompilerMacroDigest({ compiler: compiler.path, root, file, environment }),
        semanticMacrosSha256: observeCurrentCompilerMacroDigest({ compiler: clang, root, file, environment }),
        semanticResourceDirectory: { path: resourceDirectory, realPath: fs.realpathSync(resourceDirectory) }
    };
    // Observe the unchanged production owner, rather than hand-writing a database command.
    fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
    const scratch = fs.mkdtempSync(path.join(root, '.tmp/current-compile-profile-test-'));
    try
    {
        const trace = path.join(scratch, 'production.trace');
        const program = `import fs from 'node:fs';
import path from 'node:path';
import { prepareNetworkSandbox, loadExecutionNetworkPolicy } from './tools/test/execution-envelope-network.mjs';
const directories = Object.fromEntries(['home','temp','npmCache','nugetPackages','dotnetHome','toolCache'].map(name => {
 const directory = path.join(${JSON.stringify(scratch)},name);fs.mkdirSync(directory,{mode:0o700});return [name,directory];
}));
prepareNetworkSandbox({command:[process.execPath,'--version'],cwd:process.cwd(),directories,writableRoots:[],plannedEndpoints:[],environment:${JSON.stringify(environment)},policy:loadExecutionNetworkPolicy()});`;
        query('/usr/bin/strace', ['-f', '-s', '65535', '-e', 'trace=execve', '-o', trace,
            process.execPath, '--input-type=module', '--eval', program]);
        const commands = [...fs.readFileSync(trace, 'utf8').matchAll(/execve\("\/usr\/bin\/cc", (\[.*?\]), .*?\) = 0/gu)]
            .map(match => JSON.parse(match[1])).filter(args => args.includes('-std=c11'));
        assert.equal(commands.length, 1, 'production compile observation must be exact and unique');
        const entry = { directory: root, file: path.join(root, file), arguments: commands[0] };
        const invoke = (policy = profile, input = entry, env = environment) =>
            observeUnpromotedMetadataCompileBinding({ root, file, entry: input, policy, environment: env });
        await context.test('current sys/stat and glibc conversion source pass real compiler and AST parity', () =>
        {
            const result = invoke();
            assert.equal(result.binding.productionCompile.exitCode, 0);
            assert.equal(result.binding.semanticQuery.exitCode, 0);
            assert.deepEqual(result.binding.semantic.ownedInputClasses, ['main.argc', 'main.argv']);
            assert.equal(result.binding.qualificationEligible, false);
            assert.equal(result.binding.callerInputAdmission, false);
            assert.equal(result.binding.policyPromotion, false);
            assert.deepEqual(result.binding.analyzerOptions, []);
            assert.equal(fs.existsSync(result.binding.productionCompile.output.path), false, 'private compilation must be cleaned');
            result.binding.semantic.ownedInputClasses.push('descriptor.identity');
            result.binding.semanticResourceDirectory.path = '/foreign';
            assert.doesNotThrow(result.revalidate, 'mutable reports must not change captured revalidation');
        });
        await context.test('the original v1 directive refusal remains unchanged', () =>
        {
            const original = structuredClone(profile);
            original.schema = 'fsusblog.command-wrapper-compile-binding.v1';
            delete original.semanticResourceDirectory;
            assert.throws(() => observeCommandWrapperCompileBinding({ root, file, entry, policy: original, environment }),
                /unapproved preprocessing directives/u);
        });
        await context.test('one candidate binds caller closure and compiled TU while refusing admission', () =>
        {
            const joined = observeUnpromotedCurrentCommandProfile({ root, file, entry, policy: profile, environment });
            const bound = joined.proposal.caller.files.find(value => value.path === file);
            assert.equal(bound.contentDigest, `sha256:${joined.proposal.compile.source.sha256}`);
            assert.equal(joined.proposal.sourceCommit, execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim());
            assert.equal(joined.proposal.independentProfileReviewRequired, true);
            assert.equal(joined.proposal.callerInputAdmission, false);
            assert.equal(joined.proposal.qualificationEligible, false);
            assert.deepEqual(joined.proposal.analyzerOptions, []);
            assert.doesNotThrow(joined.revalidate);
        });
        await context.test('a supplied caller result cannot replace actual inspection', () =>
            assert.throws(() => observeUnpromotedCurrentCommandProfile({ root, file, entry, policy: profile,
                environment, caller: { admission: 'approved' } }), /options widened/u));
        for (const [name, mutate, expected] of [
            ['missing resource identity', value => delete value.semanticResourceDirectory, /unknown or missing fields/u],
            ['foreign resource identity', value => value.semanticResourceDirectory.path = '/foreign', /resource directory drift/u],
            ['wrong compiler bytes', value => value.compiler.sha256 = '0'.repeat(64), /compiler digest drift/u],
            ['omitted canonical header', value => value.canonicalHeaders.pop(), /canonical header authority profile drift/u],
            ['substituted semantic header', value => value.semanticHeaders[0].sha256 = '0'.repeat(64), /semantic header authority profile drift/u],
            ['canonical macro drift', value => value.canonicalMacrosSha256 = '0'.repeat(64), /canonical macro authority profile drift/u],
            ['semantic macro drift', value => value.semanticMacrosSha256 = '0'.repeat(64), /semantic macro authority profile drift/u],
            ['analyzer option injection', value => value.analyzerOptions = ['controlled-environment'], /unknown or missing fields/u]
        ])
        {
            await context.test(name, () =>
            {
                const changed = structuredClone(profile);
                mutate(changed);
                assert.throws(() => invoke(changed), expected);
            });
        }
        await context.test('ambient include paths remain refused', () =>
            assert.throws(() => invoke(profile, entry, { ...environment, CPATH: '/foreign' }), /environment contamination/u));
        await context.test('arbitrary database flags remain refused', () =>
            assert.throws(() => invoke(profile, { ...entry, arguments: [...entry.arguments, '-DCHANGED=1'] }), /flags, ordering/u));
    }
    finally
    {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
});

test('current caller probe binds the complete finite closure and refuses drift without minting admission', async (context) =>
{
    const baseline = observeUnpromotedCurrentCallerClosure({ root }).proposal;
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-current-caller-profile-'));
    try
    {
        for (const bound of baseline.files)
        {
            const target = path.join(fixture, bound.path);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.copyFileSync(path.join(root, bound.path), target);
            fs.chmodSync(target, fs.statSync(path.join(root, bound.path)).mode & 0o777);
        }
        execFileSync('git', ['init', '--quiet', fixture]);
        execFileSync('git', ['add', '.'], { cwd: fixture });
        execFileSync('git', ['-c', 'user.name=profile-fixture', '-c', 'user.email=profile-fixture@example.invalid',
            'commit', '--quiet', '-m', 'profile fixture'], { cwd: fixture });
        const current = observeUnpromotedCurrentCallerClosure({ root: fixture });
        await context.test('all original anchors and actual transitive files are included', () =>
        {
            assert.equal(current.proposal.originalAnchorCount, 42);
            assert.ok(current.proposal.files.length > 42);
            assert.ok(current.proposal.files.some(value => value.path === 'tools/test/physical-execution-nested-channel.mjs'));
            assert.equal(current.proposal.callerInputAdmission, false);
            assert.equal(current.proposal.qualificationEligible, false);
            assert.equal(current.proposal.policyPromotion, false);
            assert.deepEqual(current.proposal.analyzerOptions, []);
            current.proposal.files.pop();
            assert.doesNotThrow(current.revalidate);
        });
        const source = path.join(fixture, 'tools/test/physical-execution-nested-channel.mjs');
        const original = fs.readFileSync(source);
        await context.test('post-observation caller replacement is refused', () =>
        {
            fs.appendFileSync(source, '\n// changed after observation\n');
            assert.throws(current.revalidate, /closure changed/u);
            assert.throws(() => observeUnpromotedCurrentCallerClosure({ root: fixture }), /source inspection refused/u);
            fs.writeFileSync(source, original);
        });
        await context.test('missing caller input fails before a proposal', () =>
        {
            fs.unlinkSync(source);
            assert.throws(() => observeUnpromotedCurrentCallerClosure({ root: fixture }), /source inspection refused/u);
            fs.writeFileSync(source, original);
        });
        await context.test('borrowed caller symlink is refused', () =>
        {
            fs.unlinkSync(source);
            fs.symlinkSync(path.join(root, 'tools/test/physical-execution-nested-channel.mjs'), source);
            assert.throws(() => observeUnpromotedCurrentCallerClosure({ root: fixture }), /source inspection refused/u);
            fs.unlinkSync(source);
            fs.writeFileSync(source, original);
        });
        await context.test('extra source roots cannot widen the probe', () =>
            assert.throws(() => observeUnpromotedCurrentCallerClosure({ root: fixture, additionalTargets: ['foreign'] }), /options widened/u));
        await context.test('accessor inputs are refused before their code executes', () =>
        {
            let calls = 0;
            const options = Object.defineProperty({}, 'root', { enumerable: true, get: () => ++calls });
            assert.throws(() => observeUnpromotedCurrentCallerClosure(options), /accessors/u);
            assert.equal(calls, 0);
        });
        await context.test('symbol inputs cannot silently widen the declaration', () =>
            assert.throws(() => observeUnpromotedCurrentCallerClosure({ root: fixture, [Symbol('approval')]: true }), /symbols/u));
        await context.test('a different candidate cannot reuse the observed closure', () =>
        {
            execFileSync('git', ['-c', 'user.name=profile-fixture', '-c', 'user.email=profile-fixture@example.invalid',
                'commit', '--quiet', '--allow-empty', '-m', 'different candidate'], { cwd: fixture });
            assert.throws(current.revalidate, /candidate changed/u);
        });
    }
    finally
    {
        fs.rmSync(fixture, { recursive: true, force: true });
    }
});
