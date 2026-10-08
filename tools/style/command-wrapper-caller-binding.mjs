import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const commandWrapperCallerOwnerSchema =
    'fsusblog.command-wrapper-caller-owner-binding.v1';

// This is an executable-input closure, not a repository inventory. The registry
// must be supplied by the independently trusted checker, never reconstructed
// from candidate bytes. Reviewed hashes seal the complete existing call path;
// the runtime checks below separately establish what its input admission does.
export const commandWrapperCallerOwnerPaths = Object.freeze([
    'config/schemas/test-execution-envelope-applicability.schema.json',
    'config/schemas/test-execution-envelope-policy.schema.json',
    'config/schemas/test-execution-envelope-receipt.schema.json',
    'config/testing/correctness-budget-policy.json',
    'config/testing/physical-execution-process-policy.json',
    'config/testing/playwright-browser-identity-policy.json',
    'config/testing/resolved-temporal-roles.schema.json',
    'config/testing/temporal-callsite-dispositions.json',
    'config/testing/temporal-domain-producer-inventory.json',
    'config/testing/temporal-policy.json',
    'config/testing/temporal-shape-catalog.json',
    'config/testing/test-execution-envelope-applicability.json',
    'config/testing/test-execution-envelope-policy.json',
    'config/testing/test-execution-network-policy.json',
    'src/backend/Services/UserLoginWorkflowService.cs',
    'src/backend/Services/UserSessionCommandService.cs',
    'tools/test-fixtures/producers/temporal-child-handshake-emitter.cjs',
    'tools/test-fixtures/producers/temporal-child-handshake.bash',
    'tools/test-fixtures/producers/temporal-child-handshake.cjs',
    'tools/test-fixtures/producers/temporal-child-observer.mjs',
    'tools/test-matrix/execution-envelope-policy.mjs',
    'tools/test-matrix/windows-job-members.mjs',
    'tools/test/execution-envelope-directories.mjs',
    'tools/test/execution-envelope-environment.mjs',
    'tools/test/execution-envelope-network.mjs',
    'tools/test/execution-envelope-receipt.mjs',
    'tools/test/native/execution-envelope-landlock.c',
    'tools/test/physical-execution-linux-preexec.py',
    'tools/test/physical-execution-linux-systemd-adapter.mjs',
    'tools/test/physical-execution-linux-systemd-bootstrap.mjs',
    'tools/test/physical-execution-process-tree.mjs',
    'tools/test/physical-execution-private-dotnet-scratch.mjs',
    'tools/test/physical-execution-unix-bootstrap.mjs',
    'tools/test/physical-execution-windows-job-adapter.mjs',
    'tools/test/physical-execution-windows-job.ps1',
    'tools/test/playwright-browser-identity.mjs',
    'tools/test/process-identity.mjs',
    'tools/test/run-deterministic-command.mjs',
    'tools/test/run-once.mjs',
    'tools/test/temporal-context.mjs',
    'tools/test/temporal-role-resolver.mjs',
    'tools/test/temporal-shape-catalog.mjs'
].sort());

function fail(message)
{
    throw new Error(`command wrapper caller binding: ${message}`);
}

function exactKeys(value, keys, label)
{
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.getPrototypeOf(value) !== Object.prototype
        || Object.getOwnPropertySymbols(value).length !== 0
        || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')
        || Object.values(Object.getOwnPropertyDescriptors(value)).some(
            (descriptor) => !Object.hasOwn(descriptor, 'value')
        ))
    {
        fail(`${label} must have exactly the reviewed fields`);
    }
}

function sha256(bytes)
{
    return createHash('sha256').update(bytes).digest('hex');
}

function readBoundFile(root, entry)
{
    exactKeys(entry, ['path', 'sha256', 'mode'], 'file binding');
    if (!commandWrapperCallerOwnerPaths.includes(entry.path)
        || typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(entry.sha256)
        || !['100644', '100755'].includes(entry.mode))
    {
        fail('file binding has an unknown path, digest, or mode');
    }
    let current = root;
    const parts = entry.path.split('/');
    for (const [index, part] of parts.entries())
    {
        current = path.join(current, part);
        const metadata = fs.lstatSync(current);
        if (metadata.isSymbolicLink()
            || (index < parts.length - 1 ? !metadata.isDirectory() : !metadata.isFile()))
        {
            fail(`${entry.path} is not a physically owned regular file`);
        }
    }
    const metadata = fs.lstatSync(current);
    const gitMode = metadata.mode & 0o111 ? '100755' : '100644';
    if (gitMode !== entry.mode || (metadata.mode & 0o7002) !== 0
        || fs.realpathSync(current) !== current)
    {
        fail(`${entry.path} has mode or physical path drift`);
    }
    const bytes = fs.readFileSync(current);
    if (sha256(bytes) !== entry.sha256)
    {
        fail(`${entry.path} has source or policy digest drift`);
    }
    return bytes;
}

function readPolicyFacts(files)
{
    const policy = JSON.parse(files.get('config/testing/test-execution-envelope-policy.json'));
    const catalog = JSON.parse(files.get('config/testing/test-execution-envelope-applicability.json'));
    const network = JSON.parse(files.get('config/testing/test-execution-network-policy.json'));
    if (policy.schema !== 'fsusblog.test-execution-envelope-policy.v1'
        || policy.version !== 1 || !policy.policyId
        || policy.contract?.environment?.mode !== 'minimal-base-plus-producer-allowlist'
        || policy.contract.environment.ambientInheritance !== 'denied'
        || policy.contract.environment.producerAllowlistRequired !== true
        || policy.contract.environment.pathResolution !== 'absolute-realpath-version-sha256'
        || policy.contract.toolchain?.admission !== 'planned-actual-exact'
        || JSON.stringify(policy.contract.toolchain.identityFields)
            !== JSON.stringify(['absolutePath', 'realPath', 'version', 'sha256']))
    {
        fail('executable or environment policy is not the reviewed fail-closed contract');
    }
    if (catalog.schema !== 'fsusblog.test-execution-envelope-applicability.v1'
        || catalog.version !== 1 || !Array.isArray(catalog.producers)
        || catalog.producers.length === 0)
    {
        fail('producer environment applicability catalog is unavailable');
    }
    const ids = new Set();
    const environmentNames = new Set();
    for (const producer of catalog.producers)
    {
        if (typeof producer.producerId !== 'string' || !producer.producerId
            || ids.has(producer.producerId) || producer.policyId !== policy.policyId
            || !Array.isArray(producer.allowedEnvironment)
            || new Set(producer.allowedEnvironment).size !== producer.allowedEnvironment.length
            || producer.allowedEnvironment.some((name) =>
                typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)))
        {
            fail('producer identity or environment allowlist is missing, duplicate, or malformed');
        }
        ids.add(producer.producerId);
        producer.allowedEnvironment.forEach((name) => environmentNames.add(name));
    }
    if (network.schema !== 'fsusblog.test-execution-network-policy.v1'
        || network.correctnessDefault !== 'deny'
        || network.sandbox?.unavailable !== 'fail-closed'
        || !Array.isArray(network.externalEndpoints) || network.externalEndpoints.length !== 0)
    {
        fail('network policy is not reviewed default-deny and fail-closed');
    }
    return { policy, catalog, environmentNames };
}

function diagnostic(root, program, args = [])
{
    const result = spawnSync(fs.realpathSync(process.execPath), [
        '--input-type=module', '--eval', program, ...args
    ], {
        cwd: root,
        env: { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC' },
        encoding: 'utf8',
        shell: false,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true
    });
    if (result.error || result.signal || result.status !== 0)
    {
        fail(`actual owner behavior diagnostic failed: ${String(result.stderr).trim()}`);
    }
    return JSON.parse(result.stdout);
}

function observeRuntimeOwner(root)
{
    const environmentModule = JSON.stringify(pathToFileURL(path.join(
        root, 'tools/test/execution-envelope-environment.mjs'
    )).href);
    const policyModule = JSON.stringify(pathToFileURL(path.join(
        root, 'tools/test-matrix/execution-envelope-policy.mjs'
    )).href);
    const networkModule = JSON.stringify(pathToFileURL(path.join(
        root, 'tools/test/execution-envelope-network.mjs'
    )).href);
    // Static imports in a one-shot diagnostic process exercise the original
    // exports. This is not a new production parent-import loading mechanism.
    return diagnostic(root, `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createMinimalCorrectnessEnvironment, observeExecutableIdentity,
    prepareCorrectnessEnvironment, verifyExecutableIdentity } from ${environmentModule};
import { loadExecutionEnvelopePolicy, loadExecutionEnvelopeApplicability,
    resolveExecutionEnvelopeProducer } from ${policyModule};
import { loadExecutionNetworkPolicy, validateExecutionNetworkPolicy,
    prepareNetworkSandbox } from ${networkModule};
const policy = loadExecutionEnvelopePolicy();
const catalog = loadExecutionEnvelopeApplicability();
const original = observeExecutableIdentity(process.execPath);
assert.equal(original.realPath, fs.realpathSync(process.execPath));
assert.equal(original.sha256, 'sha256:' + createHash('sha256').update(
    fs.readFileSync(original.realPath)).digest('hex'));
assert.equal(original.version, process.version);
const opaque = [' space ', '$(not-a-shell)', ';', '"', '\\n', '--'];
const prepared = prepareCorrectnessEnvironment({
    command: [process.execPath, ...opaque], parentEnvironment: {
        PATH: '/usr/bin:/bin', FSUSBLOG_CALLER_UNDECLARED: 'must-not-inherit',
        HTTP_PROXY: 'must-not-inherit', NODE_OPTIONS: 'must-not-inherit'
    }, producerAllowlist: [], injectedEnvironment: { FSUSBLOG_TEST_RUN_ID: 'binding-probe' },
    policy, catalog
});
assert.equal(prepared.command[0], original.absolutePath);
assert.deepEqual(prepared.command.slice(1), opaque);
assert.deepEqual(Object.keys(prepared.environment).sort(),
    ['FSUSBLOG_TEST_RUN_ID', 'LANG', 'LC_ALL', 'PATH', 'TZ']);
assert.equal(prepared.fragment.environment.inheritedAmbientCount, 0);
assert.equal(prepared.fragment.admission, 'planned-actual-exact');
const allowed = createMinimalCorrectnessEnvironment({
    parentEnvironment: { PATH: '/usr/bin:/bin', DOTNET_ROOT: '/explicit-dotnet',
        UNDECLARED: 'must-not-inherit' }, producerAllowlist: ['DOTNET_ROOT'], policy
});
assert.equal(allowed.childEnvironment.DOTNET_ROOT, '/explicit-dotnet');
assert.equal(Object.hasOwn(allowed.childEnvironment, 'UNDECLARED'), false);
for (const key of ['absolutePath', 'realPath', 'version', 'sha256']) {
    assert.throws(() => verifyExecutableIdentity(original,
        { ...original, [key]: 'wrong-' + key }), /executable drift/);
    let calls = 0;
    assert.throws(() => prepareCorrectnessEnvironment({
        command: [process.execPath], parentEnvironment: {}, producerAllowlist: [],
        injectedEnvironment: {}, policy, catalog,
        observeExecutable: () => ++calls === 1 ? original : { ...original, [key]: 'wrong' }
    }), /executable drift/);
}
assert.throws(() => prepareCorrectnessEnvironment({command: [], policy, catalog}), /command is missing/);
assert.throws(() => createMinimalCorrectnessEnvironment({
    parentEnvironment: {}, producerAllowlist: ['NOT-AN-ENV-NAME'], policy
}), /environment name is invalid/);
assert.throws(() => createMinimalCorrectnessEnvironment({
    parentEnvironment: {}, producerAllowlist: [], injectedEnvironment: { MISSING: null }, policy
}), /injected environment is missing/);
assert.throws(() => createMinimalCorrectnessEnvironment({
    parentEnvironment: {}, producerAllowlist: [], policy: {}
}), /environment policy is unavailable/);
assert.throws(() => resolveExecutionEnvelopeProducer('caller-binding-unknown', catalog), /exactly one/);
assert.throws(() => resolveExecutionEnvelopeProducer(catalog.producers[0].producerId,
    { ...catalog, producers: [catalog.producers[0], catalog.producers[0]] }), /exactly one/);
const network = loadExecutionNetworkPolicy();
assert.deepEqual(validateExecutionNetworkPolicy(network), []);
assert.notEqual(validateExecutionNetworkPolicy({missing: true}).length, 0);
assert.notEqual(validateExecutionNetworkPolicy({...network, correctnessDefault: 'allow'}).length, 0);
assert.notEqual(validateExecutionNetworkPolicy({...network, externalEndpoints: [{}]}).length, 0);
assert.throws(() => prepareNetworkSandbox({
    command: [process.execPath], environment: {}, policy: network, platform: 'unsupported'
}), /unavailable/);
console.log(JSON.stringify({ executable: original, opaqueArgumentCount: opaque.length,
    identityDriftFields: ['absolutePath', 'realPath', 'version', 'sha256'],
    ambientInheritance: 'denied', catalogAmbiguity: 'refused',
    networkPolicy: 'default-deny-and-unavailable-refused', qualificationEligible: false }));
`);
}

function observeRunnerEnvironmentRefusal(root, facts)
{
    const producer = facts.catalog.producers[0];
    let undeclared = 'FSUSBLOG_CALLER_BINDING_UNDECLARED';
    while (facts.environmentNames.has(undeclared))
    {
        undeclared += '_X';
    }
    const result = spawnSync(fs.realpathSync(process.execPath), [
        path.join(root, 'tools/test/run-deterministic-command.mjs'),
        '--key', 'caller-binding-refusal',
        '--execution-class', 'correctness',
        '--producer-id', producer.producerId,
        '--env', undeclared,
        '--', process.execPath, '--version'
    ], {
        cwd: root,
        env: {
            LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC',
            FSUSBLOG_TEST_RUN_ID: 'caller-binding-refusal',
            FSUSBLOG_TEST_SOURCE_COMMIT: '0'.repeat(40),
            FSUSBLOG_TEST_SOURCE_FINGERPRINT: 'sha256:' + '0'.repeat(64)
        },
        encoding: 'utf8', shell: false, timeout: 30_000,
        maxBuffer: 1024 * 1024, windowsHide: true
    });
    const expected = `${producer.producerId}: environment input is not declared by the applicability catalog: ${undeclared}`;
    if (result.error || result.signal || result.status !== 1
        || !String(result.stderr).includes(expected)
        || String(result.stdout).trim() !== '')
    {
        fail(`actual correctness runner did not refuse undeclared environment: ${String(result.stderr).trim()}`);
    }
    return { producerId: producer.producerId, undeclaredEnvironment: 'refused-before-launch' };
}

export function validateCallerOwnerBinding(root, registry)
{
    if (typeof root !== 'string' || !path.isAbsolute(root)
        || path.resolve(root) !== root || fs.realpathSync(root) !== root)
    {
        fail('root must be a canonical physical absolute directory');
    }
    const binding = registry?.callerOwnerBinding;
    exactKeys(binding, ['schema', 'mode', 'files'], 'caller owner registry');
    if (binding.schema !== commandWrapperCallerOwnerSchema
        || binding.mode !== 'reviewed-correctness-runner-closure'
        || !Array.isArray(binding.files)
        || binding.files.length !== commandWrapperCallerOwnerPaths.length
        || binding.files.map((entry) => entry?.path).sort().join('\0')
            !== commandWrapperCallerOwnerPaths.join('\0'))
    {
        fail('registry closure is missing, widened, duplicated, or has an unknown mode');
    }
    const files = new Map(binding.files.map((entry) => [entry.path, readBoundFile(root, entry)]));
    const facts = readPolicyFacts(files);
    const runtime = observeRuntimeOwner(root);
    const runner = observeRunnerEnvironmentRefusal(root, facts);
    // Re-attest after executing the actual owners; a concurrent replacement is
    // not allowed to become a successful caller-input admission.
    binding.files.forEach((entry) => readBoundFile(root, entry));
    return Object.freeze({
        schema: commandWrapperCallerOwnerSchema,
        admission: 'reviewed-caller-closure-and-runtime-input-contract-exact',
        qualificationEligible: false,
        callerClosureDigest: sha256(JSON.stringify(binding.files)),
        fileCount: files.size,
        runtime: Object.freeze(runtime),
        runner: Object.freeze(runner)
    });
}
