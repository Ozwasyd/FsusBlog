#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const nativeP99TestId =
    'FsusBlog.Server.Tests.Unit.NativeGroth16ZkProofBackendTests.MclGroth16VerifierLibrary_VerifyP99StaysInsideNativeBudget';
export const nativeP99SampleCount = 32;
export const nativeP99BudgetMilliseconds = 50;

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const measurementSchema = 'fsusblog.native-groth16-p99-measurement.v1';
const preflightSchema = 'fsusblog.native-groth16-p99-preflight.v1';
const summarySchema = 'fsusblog.native-groth16-p99-producer.v1';

function sha256File(file)
{
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function writeJsonAtomic(file, document)
{
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.next-${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`);
    fs.renameSync(temporary, file);
}

function existingRegularFile(file, label)
{
    const metadata = fs.lstatSync(file);
    if (!metadata.isFile() || metadata.isSymbolicLink())
    {
        throw new Error(`${label} must be a regular non-symlink file: ${file}`);
    }
    return file;
}

function resolveOutputDirectory(root, env)
{
    const productionRoot = String(env.FSUSBLOG_PRODUCTION_BUILD_ROOT ?? '').trim();
    return productionRoot
        ? path.join(path.resolve(productionRoot), 'dotnet', 'FsusBlog.Server.Tests', 'bin', 'Release', 'net10.0')
        : path.join(root, 'tests/backend/bin/Release/net10.0');
}

function runtimeIdentifier()
{
    const platform = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'osx' : process.platform;
    const architecture = process.arch === 'ia32' ? 'x86' : process.arch;
    return `${platform}-${architecture}`;
}

function nativeLibraryName()
{
    if (process.platform === 'win32') return 'mcl.dll';
    if (process.platform === 'darwin') return 'libmcl.dylib';
    return 'libmcl.so';
}

export function nativeP99SourceContractErrors({ testSource, suiteSource, atomicSource, matrixSource, workflowSource })
{
    const errors = [];
    if (testSource.includes('FSUSBLOG_RUN_PERFORMANCE_TESTS'))
        errors.push('native P99 test still consumes FSUSBLOG_RUN_PERFORMANCE_TESTS');
    if (!testSource.includes('[Trait("Category", "Performance")]'))
        errors.push('native P99 test must retain Category=Performance');
    if (!testSource.includes('private const int NativeP99SampleCount = 32;'))
        errors.push('native P99 test must retain 32 samples');
    if (!testSource.includes('private const double NativeP99BudgetMilliseconds = 50;'))
        errors.push('native P99 test must retain the 50ms budget');
    if (!suiteSource.includes('Category!=Performance'))
        errors.push('ordinary backend filter must exclude Category=Performance');
    if ((suiteSource.match(new RegExp(nativeP99TestId.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'gu')) ?? []).length !== 1)
        errors.push('native P99 test ID must have exactly one suite member binding');
    if (suiteSource.includes('RunBackendPerfOnly()'))
        errors.push('legacy RunBackendPerfOnly sequential producer must not remain');
    if (!atomicSource.includes('RunBackendPerfNativeP99Only backend-perf'))
        errors.push('atomic native P99 script must delegate to its exact member owner');
    if (!atomicSource.includes('export FSUSBLOG_BACKEND_TEST_CONFIGURATION=Release'))
        errors.push('atomic native P99 script must select the Release test assembly');
    if ((workflowSource?.match(/\.\/tools\/test\.sh backend-perf --no-deps/gu) ?? []).length !== 1)
        errors.push('CI must invoke the same backend-perf matrix producer exactly once');
    const backendPerf = matrixSource.match(/\n    - id: backend-perf\n[\s\S]*?(?=\n    - id: )/u)?.[0] ?? '';
    if (!backendPerf.includes('command: tools/test/lanes/perf-regression.sh')
        || !backendPerf.includes('exclusiveResources: [benchmark-window]')
        || !backendPerf.includes('executionVariant: performance')
        || !backendPerf.includes('native-groth16-p99'))
    {
        errors.push('backend-perf matrix declaration must bind the atomic P99 coverage and benchmark window');
    }
    return errors;
}

export function validateNativeP99Evidence(document, expected = {})
{
    const errors = [];
    if (document?.schema !== measurementSchema) errors.push(`measurement schema must be ${measurementSchema}`);
    if (document?.status !== 'passed') errors.push('measurement status must be passed');
    if (document?.testId !== nativeP99TestId) errors.push('measurement test ID does not match the producer member');
    if (document?.warmupCount !== 1) errors.push('measurement must retain one warmup');
    if (document?.sampleCount !== nativeP99SampleCount
        || !Array.isArray(document?.samples)
        || document.samples.length !== nativeP99SampleCount)
    {
        errors.push(`measurement must contain exactly ${nativeP99SampleCount} samples`);
    }
    if (document?.thresholdMs !== nativeP99BudgetMilliseconds)
        errors.push(`measurement threshold must remain ${nativeP99BudgetMilliseconds}ms`);
    const samples = Array.isArray(document?.samples) ? document.samples : [];
    if (samples.some((sample, index) => sample?.index !== index
        || sample?.verified !== true
        || !Number.isFinite(sample?.elapsedMs)
        || sample.elapsedMs < 0))
    {
        errors.push('every native P99 sample must be indexed, finite, non-negative, and verified');
    }
    if (samples.length === nativeP99SampleCount)
    {
        const sorted = samples.map((sample) => sample.elapsedMs).sort((left, right) => left - right);
        const computedP99 = sorted[Math.ceil(sorted.length * 0.99) - 1];
        if (!Number.isFinite(document?.p99Ms) || Math.abs(document.p99Ms - computedP99) > 1e-9)
            errors.push('measurement p99 does not match the sorted samples');
        if (computedP99 > nativeP99BudgetMilliseconds)
            errors.push(`measurement p99 exceeds ${nativeP99BudgetMilliseconds}ms`);
    }
    if (expected.testAssemblySha256
        && document?.testAssembly?.sha256 !== expected.testAssemblySha256)
    {
        errors.push('measurement test assembly identity does not match preflight');
    }
    return errors;
}

export function validateNativeP99Bindings(preflight, {
    exists = fs.existsSync,
    digest = sha256File
} = {})
{
    const errors = [];
    if (preflight?.schema !== preflightSchema || preflight?.status !== 'ready')
        errors.push('native P99 preflight receipt is not ready');
    if (!/^[0-9a-f]{40}$/u.test(String(preflight?.source?.commit ?? ''))
        || !/^[0-9a-f]{64}$/u.test(String(preflight?.source?.digest ?? '')))
    {
        errors.push('native P99 source identity is missing');
    }
    if (!String(preflight?.isolation?.measurementEnvelopeOwner ?? '').trim()
        || preflight?.isolation?.exclusiveResource !== 'benchmark-window')
    {
        errors.push('native P99 measurement isolation identity is missing');
    }
    for (const [label, binding] of [
        ['Release test assembly', preflight?.build?.testAssembly],
        ['managed MCL library', preflight?.nativeMcl?.managed],
        ['native MCL library', preflight?.nativeMcl?.native]
    ])
    {
        if (!binding?.path || !binding?.sha256 || !exists(binding.path))
            errors.push(`${label} binding is missing`);
        else if (digest(binding.path) !== binding.sha256)
            errors.push(`${label} identity drifted`);
    }
    const fixture = preflight?.verifyingKeyFixture;
    if (!fixture?.sourcePath || !fixture?.sourceSha256 || !exists(fixture.sourcePath))
        errors.push('verifying-key fixture binding is missing');
    else if (digest(fixture.sourcePath) !== fixture.sourceSha256)
        errors.push('verifying-key fixture identity drifted');
    return errors;
}

function parseOptions(argumentsList)
{
    const command = argumentsList[0];
    const options = {};
    for (let index = 1; index < argumentsList.length; index += 2)
    {
        const key = argumentsList[index];
        const value = argumentsList[index + 1];
        if (!key?.startsWith('--') || value === undefined)
            throw new Error(`invalid native P99 producer option: ${key ?? '<missing>'}`);
        options[key.slice(2)] = value;
    }
    return { command, options };
}

function sourceInputs(root)
{
    return [
        'tests/backend/Unit/NativeGroth16ZkProofBackendTests.cs',
        'tools/test/lanes/_suite-support.sh',
        'tools/test/lanes/backend-perf-native-p99.sh',
        'tools/test/lanes/perf-regression.sh',
        'tools/test/native-p99-producer-contract.mjs',
        'tests/matrix.yml',
        'tests/backend/Fixtures/backend-test-requirements.json',
        'tests/coverage-registry.json',
        '.github/workflows/quality-gate.yml'
    ].map((relative) => ({ relative, file: existingRegularFile(path.join(root, relative), 'source input') }));
}

function prepare(root, options, env)
{
    const preflightFile = path.resolve(options.preflight);
    const evidenceFile = path.resolve(options.evidence);
    const summaryFile = path.resolve(options.summary);
    const trxFile = path.resolve(options.trx);
    for (const stale of [preflightFile, evidenceFile, summaryFile, trxFile]) fs.rmSync(stale, { force: true });

    const inputs = sourceInputs(root);
    const sourceByPath = Object.fromEntries(inputs.map(({ relative, file }) => [relative, fs.readFileSync(file, 'utf8')]));
    const sourceErrors = nativeP99SourceContractErrors({
        testSource: sourceByPath['tests/backend/Unit/NativeGroth16ZkProofBackendTests.cs'],
        suiteSource: sourceByPath['tools/test/lanes/_suite-support.sh'],
        atomicSource: sourceByPath['tools/test/lanes/backend-perf-native-p99.sh'],
        matrixSource: sourceByPath['tests/matrix.yml'],
        workflowSource: sourceByPath['.github/workflows/quality-gate.yml']
    });
    if (sourceErrors.length > 0) throw new Error(sourceErrors.join('; '));

    const measurementOwner = String(env.FSUSBLOG_MEASUREMENT_ENVELOPE_OWNER ?? '').trim();
    if (!measurementOwner) throw new Error('native P99 producer requires the admitted measurement envelope owner');

    const outputDirectory = resolveOutputDirectory(root, env);
    const testAssembly = existingRegularFile(path.join(outputDirectory, 'FsusBlog.Server.Tests.dll'), 'test assembly');
    const managedMcl = existingRegularFile(path.join(outputDirectory, 'Nethermind.MclBindings.dll'), 'managed MCL library');
    const nativeMcl = existingRegularFile(
        path.join(outputDirectory, 'runtimes', runtimeIdentifier(), 'native', nativeLibraryName()),
        'native MCL library'
    );
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const sourceFiles = Object.fromEntries(inputs.map(({ relative, file }) => [relative, sha256File(file)]));
    const sourceDigest = createHash('sha256').update(JSON.stringify(sourceFiles)).digest('hex');
    const document = {
        schema: preflightSchema,
        status: 'ready',
        producerId: 'backend-perf-native-p99',
        testId: nativeP99TestId,
        source: { commit, digest: sourceDigest, files: sourceFiles },
        build: {
            configuration: 'Release',
            outputDirectory,
            testAssembly: { path: testAssembly, sha256: sha256File(testAssembly) }
        },
        nativeMcl: {
            managed: { path: managedMcl, sha256: sha256File(managedMcl) },
            native: { path: nativeMcl, sha256: sha256File(nativeMcl) }
        },
        verifyingKeyFixture: {
            owner: 'NativeGroth16ZkProofBackendTests.MclGroth16PairingFixture.CreateVerifyingKey',
            sourcePath: inputs[0].file,
            sourceSha256: sourceFiles[inputs[0].relative]
        },
        isolation: {
            measurementEnvelopeOwner: measurementOwner,
            exclusiveResource: 'benchmark-window',
            matrixTier: 'backend-perf'
        }
    };
    writeJsonAtomic(preflightFile, document);
    process.stdout.write(`[native-p99] preflight ready assembly=${document.build.testAssembly.sha256}\n`);
}

function validateTrx(source)
{
    const errors = [];
    const results = [...source.matchAll(/<UnitTestResult\b[^>]*\btestName="([^"]+)"[^>]*\boutcome="([^"]+)"/gu)];
    const memberResults = results.filter((match) => match[1].includes('MclGroth16VerifierLibrary_VerifyP99StaysInsideNativeBudget'));
    if (results.length !== 1 || memberResults.length !== 1)
        errors.push('TRX must contain exactly one executed native P99 test result');
    if (memberResults[0]?.[2] !== 'Passed') errors.push('native P99 TRX outcome must be Passed');
    const counters = source.match(/<Counters\b([^>]*)\/>/u)?.[1] ?? '';
    for (const [name, expected] of [['total', '1'], ['executed', '1'], ['passed', '1'], ['failed', '0']])
    {
        if (!new RegExp(`\\b${name}="${expected}"`, 'u').test(counters))
            errors.push(`TRX counter ${name} must be ${expected}`);
    }
    return errors;
}

function verify(root, options)
{
    const preflightFile = path.resolve(options.preflight);
    const evidenceFile = path.resolve(options.evidence);
    const summaryFile = path.resolve(options.summary);
    const trxFile = path.resolve(options.trx);
    const errors = [];
    let preflight;
    let evidence;
    try { preflight = JSON.parse(fs.readFileSync(preflightFile, 'utf8')); }
    catch { errors.push('native P99 preflight receipt is missing or invalid'); }
    try { evidence = JSON.parse(fs.readFileSync(evidenceFile, 'utf8')); }
    catch { errors.push('native P99 measurement evidence is missing or invalid'); }
    if (preflight) errors.push(...validateNativeP99Bindings(preflight));
    if (evidence) errors.push(...validateNativeP99Evidence(evidence, {
        testAssemblySha256: preflight?.build?.testAssembly?.sha256
    }));
    let trxSource = '';
    try { trxSource = fs.readFileSync(trxFile, 'utf8'); }
    catch { errors.push('native P99 TRX is missing'); }
    if (trxSource) errors.push(...validateTrx(trxSource));
    if (Number(options['test-exit-code']) !== 0) errors.push(`dotnet test exited ${options['test-exit-code']}`);

    const summary = {
        schema: summarySchema,
        status: errors.length === 0 ? 'passed' : 'failed',
        producerId: 'backend-perf-native-p99',
        testId: nativeP99TestId,
        lifecycle: { planned: 1, executed: trxSource ? 1 : 0, passed: errors.length === 0 ? 1 : 0, failed: errors.length === 0 ? 0 : 1 },
        source: preflight?.source ?? null,
        build: preflight?.build ?? null,
        nativeMcl: preflight?.nativeMcl ?? null,
        verifyingKeyFixture: preflight?.verifyingKeyFixture ?? null,
        isolation: preflight?.isolation ?? null,
        measurement: evidence ?? null,
        errors
    };
    writeJsonAtomic(summaryFile, summary);
    if (errors.length > 0) throw new Error(errors.join('; '));
    process.stdout.write(`[native-p99] passed samples=${nativeP99SampleCount} p99=${evidence.p99Ms.toFixed(2)}ms\n`);
}

function main()
{
    const { command, options } = parseOptions(process.argv.slice(2));
    const root = path.resolve(options.root ?? defaultRoot);
    for (const required of ['preflight', 'evidence', 'summary', 'trx'])
    {
        if (!options[required]) throw new Error(`native P99 producer requires --${required}`);
    }
    if (command === 'prepare') prepare(root, options, process.env);
    else if (command === 'verify') verify(root, options);
    else throw new Error('usage: native-p99-producer-contract.mjs <prepare|verify> --preflight FILE --evidence FILE --summary FILE --trx FILE');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    try { main(); }
    catch (error)
    {
        console.error(`[native-p99] ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    }
}
