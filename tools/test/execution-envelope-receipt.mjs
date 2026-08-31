import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    createExecutionEnvelopePolicyIdentity,
    executionEnvelopeDigest,
    loadExecutionEnvelopeApplicability,
    loadExecutionEnvelopePolicy,
    resolveExecutionEnvelopeProducer,
    validateExecutionEnvelopeReceiptSchema
} from '../test-matrix/execution-envelope-policy.mjs';

import {
    assertBrowserPlanActualMatch,
    validateBrowserIdentityPlan
} from './playwright-browser-identity.mjs';

export const executionEnvelopeSchema = 'fsusblog.test-execution-envelope.v1';
export const executionEnvelopeReceiptSchema =
    'fsusblog.test-execution-envelope-receipt.v1';
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const fragmentDomains = Object.freeze([
    'browserRendering',
    'directories',
    'environment',
    'fontsLocale',
    'identity',
    'network',
    'platform',
    'resources',
    'services',
    'toolchain'
]);
const browserNullableFields = Object.freeze([
    'playwrightVersion', 'browserName', 'browserVersion', 'browserRevision',
    'browserExecutableDigest', 'deviceScaleFactor', 'renderingMode',
    'colorScheme', 'gpuMode', 'browserRenderingObservation'
]);
const serviceNullableFields = Object.freeze([
    'containerRuntime', 'postgresVersion', 'postgresImageDigest',
    'redisVersion', 'redisImageDigest', 'dockerVersion'
]);
const toolNullableFields = Object.freeze([
    'npmVersion', 'dotnetSdkVersion', 'dotnetRuntimeVersion',
    'msbuildVersion', 'cmakeVersion', 'ninjaVersion', 'compilerVersion'
]);

function canonicalize(value)
{
    if (Array.isArray(value))
    {
        return value.map(canonicalize);
    }
    if (value && typeof value === 'object')
    {
        return Object.fromEntries(Object.keys(value).sort()
            .map((key) => [key, canonicalize(value[key])]));
    }
    return value;
}

function digest(value)
{
    return executionEnvelopeDigest(value);
}

function digestBytes(value)
{
    return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function normalizedDigest(value, label)
{
    const normalized = String(value ?? '').trim();
    const result = normalized.startsWith('sha256:')
        ? normalized
        : `sha256:${normalized}`;
    if (!digestPattern.test(result))
    {
        throw new Error(`execution envelope ${label} is not a SHA-256 digest`);
    }
    return result;
}

function readText(file)
{
    try
    {
        return fs.readFileSync(file, 'utf8').trim();
    }
    catch
    {
        return null;
    }
}

function cgroupLimits()
{
    const root = '/sys/fs/cgroup';
    return Object.fromEntries([
        ['cpuMax', 'cpu.max'],
        ['cpuWeight', 'cpu.weight'],
        ['memoryMax', 'memory.max'],
        ['memoryHigh', 'memory.high'],
        ['pidsMax', 'pids.max']
    ].map(([name, file]) => [name, readText(path.join(root, file))]));
}

function memoryLimit(limits)
{
    const parsed = Number(limits.memoryMax);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : os.totalmem();
}

function hashDirectoryTree(roots)
{
    const entries = [];
    const visit = (current) =>
    {
        let children;
        try
        {
            children = fs.readdirSync(current, { withFileTypes: true });
        }
        catch
        {
            return;
        }
        for (const child of children.sort((left, right) =>
            left.name.localeCompare(right.name)))
        {
            const absolute = path.join(current, child.name);
            if (child.isDirectory())
            {
                visit(absolute);
            }
            else if (child.isFile())
            {
                entries.push({
                    path: absolute,
                    sha256: digestBytes(fs.readFileSync(absolute))
                });
            }
            else if (child.isSymbolicLink())
            {
                entries.push({ path: absolute, symlink: fs.readlinkSync(absolute) });
            }
        }
    };
    for (const root of roots)
    {
        visit(root);
    }
    return digest(entries);
}

function observeFilesystemCaseSensitivity(directory)
{
    const lower = path.join(directory, `.fsusblog-case-${process.pid}-a`);
    const upper = lower.toUpperCase();
    fs.writeFileSync(lower, 'case-probe', { mode: 0o600, flag: 'wx' });
    try
    {
        return fs.existsSync(upper) ? 'insensitive' : 'sensitive';
    }
    finally
    {
        fs.rmSync(lower, { force: true });
    }
}

export function observeExecutionEnvelopeHostFacts({ directory })
{
    const report = process.report?.getReport?.() ?? {};
    const limits = cgroupLimits();
    const cpus = os.cpus();
    const libc = report.header?.glibcVersionRuntime
        ? `glibc-${report.header.glibcVersionRuntime}`
        : report.header?.glibcVersionCompiler
            ? `glibc-${report.header.glibcVersionCompiler}`
            : null;
    return Object.freeze({
        platform: process.platform,
        architecture: process.arch,
        kernel: `${os.type()} ${os.release()}`,
        libc,
        cgroupLimits: limits,
        cpuModel: String(cpus[0]?.model ?? os.machine()),
        cpuCount: Math.max(1, cpus.length),
        memoryLimit: memoryLimit(limits),
        umask: process.umask().toString(8).padStart(4, '0'),
        filesystemCaseSensitivity: observeFilesystemCaseSensitivity(directory),
        fontSetDigest: hashDirectoryTree([
            '/usr/share/fonts',
            '/usr/local/share/fonts'
        ]),
        localeDataDigest: digest({
            icu: process.versions.icu ?? null,
            unicode: process.versions.unicode ?? null,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            supportedLocales: Intl.DateTimeFormat.supportedLocalesOf([
                'ar', 'de-DE', 'en-US', 'es-ES', 'fr-FR', 'ja-JP', 'ko-KR',
                'pt-BR', 'ru-RU', 'zh-CN', 'zh-TW'
            ])
        })
    });
}

function executable(identity)
{
    if (!identity)
    {
        return null;
    }
    return {
        requestedName: identity.requestedName,
        absolutePath: identity.absolutePath,
        realPath: identity.realPath,
        version: identity.version,
        sha256: identity.sha256
    };
}

function toolchain(environment, network, phase)
{
    const primary = executable(environment?.[`${phase}Executable`]);
    const extras = [
        executable(network?.sandbox?.observer),
        executable(network?.sandbox?.filesystem?.compiler),
        executable(network?.sandbox?.filesystem?.helper)
    ].filter(Boolean);
    const resolvedExecutables = [primary, ...extras]
        .filter(Boolean)
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    const versionFor = (pattern) => resolvedExecutables
        .find((entry) => pattern.test(entry.requestedName)
            || pattern.test(path.basename(entry.realPath ?? entry.absolutePath)))
        ?.version ?? null;
    return {
        resolvedExecutables,
        nodeVersion: versionFor(/^node(?:\.exe)?$/iu),
        npmVersion: versionFor(/^npm(?:\.cmd)?$/iu),
        dotnetSdkVersion: versionFor(/^dotnet(?:\.exe)?$/iu),
        dotnetRuntimeVersion: versionFor(/^dotnet(?:\.exe)?$/iu),
        msbuildVersion: versionFor(/^msbuild(?:\.exe)?$/iu),
        cmakeVersion: versionFor(/^cmake(?:\.exe)?$/iu),
        ninjaVersion: versionFor(/^ninja(?:\.exe)?$/iu),
        compilerVersion: versionFor(/^(?:cc|gcc|clang)(?:\.exe)?$/iu)
    };
}

function browserValues(fragment, phase)
{
    const value = fragment?.[phase === 'planned' ? 'plan' : 'actual'] ?? null;
    return {
        playwrightVersion: value?.playwright?.version ?? null,
        browserName: value?.browserName ?? null,
        browserVersion: value?.browserVersion ?? null,
        browserRevision: value?.revision ?? null,
        browserExecutableDigest: value?.executableSha256 ?? null,
        browserLaunchArgs: value?.launchOptions?.args ?? [],
        deviceScaleFactor: value?.rendering?.deviceScaleFactor ?? null,
        renderingMode: value?.rendering?.renderingMode ?? null,
        colorScheme: value?.rendering?.colorScheme ?? null,
        gpuMode: value?.rendering?.gpuMode ?? null,
        browserRenderingObservation: fragment?.actual?.renderingObservation ?? null
    };
}

function serviceValues(fragment, phase)
{
    const value = fragment?.[phase] ?? null;
    const services = new Map((value?.services ?? []).map((entry) => [entry.id, entry]));
    const postgres = services.get('postgres');
    const redis = services.get('redis');
    const imageDigest = (entry) => entry?.repositoryDigest?.split('@').at(-1) ?? null;
    return {
        containerRuntime: value?.runtime ?? null,
        serviceTopology: [...(value?.services ?? [])]
            .sort((left, right) => String(left.id).localeCompare(String(right.id))),
        postgresVersion: postgres?.serviceVersion ?? null,
        postgresImageDigest: imageDigest(postgres),
        redisVersion: redis?.serviceVersion ?? null,
        redisImageDigest: imageDigest(redis),
        dockerVersion: value?.runtime?.serverVersion ?? null
    };
}

function networkValues(fragment, phase)
{
    const source = phase === 'planned' ? fragment?.planned : fragment?.actual;
    const connections = phase === 'planned'
        ? source?.endpoints ?? []
        : (source?.connections ?? []).map(({ protocol, host, port }) => ({
            protocol,
            host,
            port
        }));
    return {
        networkPolicy: {
            defaultPolicy: fragment?.defaultPolicy,
            namespace: fragment?.sandbox?.networkNamespace,
            filesystemEnforcement: fragment?.sandbox?.filesystem?.enforcement,
            dns: source?.dns ?? [],
            proxy: source?.proxy ?? {},
            certificates: source?.certificates ?? {}
        },
        externalEndpoints: connections
    };
}

function directoryValues(fragment)
{
    return {
        homeDirectoryPolicy: {
            ownership: fragment?.ownership,
            permissions: fragment?.permissions,
            aliasAdmission: fragment?.aliasAdmission,
            home: fragment?.directories?.home,
            externalHome: fragment?.externalRoots?.userHome,
            writeEnforcement: fragment?.externalWriteObservation?.enforcement
        },
        temporaryDirectoryPolicy: {
            ownership: fragment?.ownership,
            permissions: fragment?.permissions,
            temp: fragment?.directories?.temp,
            externalTemp: fragment?.externalRoots?.systemTemp,
            writeEnforcement: fragment?.externalWriteObservation?.enforcement
        }
    };
}

function domainApplicability(applicability, domain)
{
    const contract = applicability?.fieldApplicability?.[domain];
    if (!['required', 'not-applicable'].includes(contract?.status))
    {
        throw new Error(`execution envelope applicability is unsupported: ${domain}`);
    }
    if (contract.status === 'not-applicable'
      && !String(contract.notApplicableReason ?? '').trim())
    {
        throw new Error(`execution envelope not-applicable reason is missing: ${domain}`);
    }
    return contract;
}

function notApplicableFields(envelope, applicability)
{
    const reasons = {};
    const browser = domainApplicability(applicability, 'browserRendering');
    if (browser.status === 'not-applicable')
    {
        for (const field of browserNullableFields)
        {
            if (envelope[field] !== null)
            {
                throw new Error(`execution envelope not-applicable field has a value: ${field}`);
            }
            reasons[field] = browser.notApplicableReason;
        }
    }
    else
    {
        for (const field of browserNullableFields)
        {
            if (envelope[field] === null)
            {
                throw new Error(`execution envelope required field is unobservable: ${field}`);
            }
        }
    }

    const services = domainApplicability(applicability, 'services');
    if (services.status === 'not-applicable')
    {
        if (envelope.serviceTopology.length !== 0)
        {
            throw new Error('execution envelope not-applicable service topology has a value');
        }
        for (const field of serviceNullableFields)
        {
            if (envelope[field] !== null)
            {
                throw new Error(`execution envelope not-applicable field has a value: ${field}`);
            }
            reasons[field] = services.notApplicableReason;
        }
    }
    else
    {
        for (const field of ['containerRuntime', 'dockerVersion'])
        {
            if (envelope[field] === null)
            {
                throw new Error(`execution envelope required field is unobservable: ${field}`);
            }
        }
        for (const service of ['postgres', 'redis'])
        {
            const fields = [`${service}Version`, `${service}ImageDigest`];
            if (applicability.requiredServices?.includes(service))
            {
                for (const field of fields)
                {
                    if (envelope[field] === null)
                    {
                        throw new Error(`execution envelope required field is unobservable: ${field}`);
                    }
                }
                continue;
            }
            for (const field of fields)
            {
                if (envelope[field] !== null)
                {
                    throw new Error(`execution envelope undeclared service field has a value: ${field}`);
                }
                reasons[field] = `${service}-not-required-by-producer`;
            }
        }
    }

    for (const field of toolNullableFields)
    {
        if (envelope[field] === null)
        {
            reasons[field] = 'executable-not-used-by-producer';
        }
    }
    if (envelope.libc === null)
    {
        reasons.libc = 'platform-does-not-expose-glibc-runtime';
    }
    return reasons;
}

function assertFragmentAdmission({ applicability, environment, directories, network, browser, services }, phase)
{
    if (environment?.admission !== 'planned-actual-exact')
    {
        throw new Error('execution envelope environment observer is unqualified');
    }
    if (phase === 'actual' && directories?.cleanup?.status !== 'complete')
    {
        throw new Error('execution envelope directory observer is incomplete');
    }
    if (phase === 'actual' && network?.admission !== 'planned-actual-exact')
    {
        throw new Error('execution envelope network observer is incomplete');
    }
    for (const [domain, fragment] of [
        ['browserRendering', browser],
        ['services', services]
    ])
    {
        const status = applicability?.fieldApplicability?.[domain]?.status;
        if (status === 'required' && !fragment)
        {
            throw new Error(`execution envelope required observer is missing: ${domain}`);
        }
        if (!['required', 'not-applicable'].includes(status))
        {
            throw new Error(`execution envelope applicability is unsupported: ${domain}`);
        }
        if (fragment?.qualificationEligible === false
          || fragment?.plan?.qualificationEligible === false
          || fragment?.actual?.qualificationEligible === false)
        {
            throw new Error(`execution envelope diagnostic fragment is forbidden: ${domain}`);
        }
        if (status === 'not-applicable' && fragment)
        {
            throw new Error(`execution envelope not-applicable observer is present: ${domain}`);
        }
        if (domain === 'browserRendering' && fragment)
        {
            validateBrowserIdentityPlan(fragment.plan);
            assertBrowserPlanActualMatch(fragment.plan, fragment.actual);
            const { contentDigest, ...actualPayload } = fragment.actual ?? {};
            if (!digestPattern.test(contentDigest ?? '')
              || digest(actualPayload) !== contentDigest
              || !fragment.actual?.renderingObservation)
            {
                throw new Error('execution envelope browser actual integrity failed');
            }
        }
        else if (phase === 'actual' && fragment
          && fragment.admission !== 'planned-actual-exact')
        {
            throw new Error(`execution envelope observer is unqualified: ${domain}`);
        }
    }
}

export function buildExecutionEnvelope({
    phase,
    identity,
    applicability,
    policy,
    catalog,
    environment,
    directories,
    network,
    browser = null,
    services = null,
    hostFacts
})
{
    if (!['planned', 'actual'].includes(phase))
    {
        throw new Error('execution envelope phase must be planned or actual');
    }
    if (applicability?.producerId !== identity?.producerId
      || applicability?.policyId !== policy?.policyId)
    {
        throw new Error('execution envelope producer applicability identity mismatch');
    }
    assertFragmentAdmission({ applicability, environment, directories, network, browser, services }, phase);
    const policyIdentity = createExecutionEnvelopePolicyIdentity({ policy, catalog });
    const tools = toolchain(environment, network, phase);
    const browserIdentity = browserValues(browser, phase);
    const serviceIdentity = serviceValues(services, phase);
    const networkIdentity = networkValues(network, phase);
    const directoryIdentity = directoryValues(directories);
    const environmentValues = environment.environment;
    const fragmentValues = {
        environment: {
            environment: environmentValues,
            executable: phase === 'planned'
                ? environment.plannedExecutable
                : environment.actualExecutable
        },
        toolchain: tools,
        browserRendering: browserIdentity,
        services: serviceIdentity,
        directories: directoryIdentity,
        network: networkIdentity,
        platform: {
            platform: hostFacts.platform,
            architecture: hostFacts.architecture,
            kernel: hostFacts.kernel,
            libc: hostFacts.libc
        },
        resources: {
            cgroupLimits: hostFacts.cgroupLimits,
            cpuModel: hostFacts.cpuModel,
            cpuCount: hostFacts.cpuCount,
            memoryLimit: hostFacts.memoryLimit
        },
        fontsLocale: {
            fontSetDigest: hostFacts.fontSetDigest,
            localeDataDigest: hostFacts.localeDataDigest
        },
        identity
    };
    const payload = {
        schema: executionEnvelopeSchema,
        policyVersion: policy.version,
        policyDigest: policyIdentity.policyDigest,
        catalogDigest: policyIdentity.catalogDigest,
        schemaIdentity: policyIdentity.schemaIdentity,
        producerId: identity.producerId,
        schedulerRunId: identity.schedulerRunId,
        attemptId: identity.attemptId,
        sourceCommit: identity.sourceCommit,
        sourceFingerprint: normalizedDigest(identity.sourceFingerprint, 'sourceFingerprint'),
        worktreeFingerprint: normalizedDigest(identity.worktreeFingerprint, 'worktreeFingerprint'),
        platform: hostFacts.platform,
        architecture: hostFacts.architecture,
        kernel: hostFacts.kernel,
        libc: hostFacts.libc,
        ...serviceIdentity,
        cgroupLimits: hostFacts.cgroupLimits,
        cpuModel: hostFacts.cpuModel,
        cpuCount: hostFacts.cpuCount,
        memoryLimit: hostFacts.memoryLimit,
        processEnvAllowlist: environmentValues.producerAllowlist,
        processEnvValuesDigest: digest(environmentValues.variables),
        pathEntries: environmentValues.pathEntries,
        ...tools,
        umask: hostFacts.umask,
        ...directoryIdentity,
        workingDirectory: identity.workingDirectory,
        filesystemCaseSensitivity: hostFacts.filesystemCaseSensitivity,
        ...browserIdentity,
        ...networkIdentity,
        fontSetDigest: hostFacts.fontSetDigest,
        localeDataDigest: hostFacts.localeDataDigest,
        notApplicableFields: {},
        fragmentDigests: Object.fromEntries(Object.entries(fragmentValues)
            .map(([domain, value]) => [domain, digest(value)]))
    };
    payload.notApplicableFields = notApplicableFields(payload, applicability);
    const envelopeDigest = digest(payload);
    return Object.freeze({ ...payload, envelopeDigest });
}

function mismatchPaths(left, right, location = '')
{
    if (JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right)))
    {
        return [];
    }
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object'
        || Array.isArray(left) || Array.isArray(right))
    {
        return [location || '/'];
    }
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    return keys.flatMap((key) => mismatchPaths(
        left[key],
        right[key],
        `${location}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`
    ));
}

function envelopePayload(envelope)
{
    const payload = { ...envelope };
    delete payload.envelopeDigest;
    return payload;
}

function receiptPayload(receipt)
{
    const payload = { ...receipt };
    delete payload.receiptDigest;
    return payload;
}

export function sealExecutionEnvelopeReceipt({ plan, actual })
{
    const paths = mismatchPaths(plan, actual);
    const payload = {
        schema: executionEnvelopeReceiptSchema,
        plan,
        actual,
        verdict: paths.length === 0 ? 'pass' : 'fail',
        mismatchPaths: paths,
        envelopeDigest: plan?.envelopeDigest ?? null
    };
    return Object.freeze({ ...payload, receiptDigest: digest(payload) });
}

export function verifyExecutionEnvelopeReceipt(
    receipt,
    {
        policy = loadExecutionEnvelopePolicy(),
        catalog = loadExecutionEnvelopeApplicability()
    } = {}
)
{
    const schemaErrors = validateExecutionEnvelopeReceiptSchema(receipt);
    if (schemaErrors.length > 0)
    {
        throw new Error(
            `execution envelope receipt schema validation failed: ${schemaErrors.join('; ')}`
        );
    }
    const policyIdentity = createExecutionEnvelopePolicyIdentity({ policy, catalog });
    const applicability = resolveExecutionEnvelopeProducer(receipt?.plan?.producerId, catalog);
    if (applicability.policyId !== policy.policyId)
    {
        throw new Error('execution envelope producer policy identity mismatch');
    }
    for (const [label, envelope] of [['plan', receipt?.plan], ['actual', receipt?.actual]])
    {
        if (envelope?.schema !== executionEnvelopeSchema
            || !digestPattern.test(envelope?.envelopeDigest ?? '')
            || envelope.envelopeDigest !== digest(envelopePayload(envelope)))
        {
            throw new Error(`execution envelope ${label} integrity failed`);
        }
        if (envelope.policyVersion !== policy.version
          || envelope.policyDigest !== policyIdentity.policyDigest
          || envelope.catalogDigest !== policyIdentity.catalogDigest
          || envelope.schemaIdentity !== policyIdentity.schemaIdentity)
        {
            throw new Error(`execution envelope ${label} current contract identity mismatch`);
        }
        if (envelope.producerId !== applicability.producerId
          || !String(envelope.schedulerRunId ?? '').trim()
          || !String(envelope.attemptId ?? '').trim()
          || !/^[a-f0-9]{40}$/u.test(envelope.sourceCommit ?? ''))
        {
            throw new Error(`execution envelope ${label} execution identity is invalid`);
        }
        if (JSON.stringify([...envelope.processEnvAllowlist].sort())
          !== JSON.stringify([...applicability.allowedEnvironment].sort()))
        {
            throw new Error(`execution envelope ${label} environment applicability mismatch`);
        }
        const actualFragmentDomains = Object.keys(envelope.fragmentDigests ?? {}).sort();
        if (JSON.stringify(actualFragmentDomains) !== JSON.stringify(fragmentDomains))
        {
            throw new Error(`execution envelope ${label} fragment set is incomplete`);
        }
        for (const value of Object.values(envelope.fragmentDigests))
        {
            if (!digestPattern.test(value))
            {
                throw new Error(`execution envelope ${label} fragment digest is invalid`);
            }
        }
        const expectedNotApplicable = notApplicableFields(envelope, applicability);
        if (JSON.stringify(canonicalize(envelope.notApplicableFields))
          !== JSON.stringify(canonicalize(expectedNotApplicable)))
        {
            throw new Error(`execution envelope ${label} applicability receipt mismatch`);
        }
    }
    const paths = mismatchPaths(receipt.plan, receipt.actual);
    if (receipt?.schema !== executionEnvelopeReceiptSchema
        || receipt.verdict !== 'pass'
        || paths.length !== 0
        || !Array.isArray(receipt.mismatchPaths)
        || receipt.mismatchPaths.length !== 0
        || receipt.envelopeDigest !== receipt.plan.envelopeDigest
        || receipt.receiptDigest !== digest(receiptPayload(receipt)))
    {
        const locations = paths.length > 0 ? paths.join(',') : '/receipt';
        throw new Error(`execution envelope verification failed at ${locations}`);
    }
    return Object.freeze({
        envelopeDigest: receipt.envelopeDigest,
        receiptDigest: receipt.receiptDigest,
        producerId: receipt.plan.producerId,
        schedulerRunId: receipt.plan.schedulerRunId,
        attemptId: receipt.plan.attemptId
    });
}

export function bindExecutionEnvelope(document, verifiedEnvelope)
{
    const binding = verifyExecutionEnvelopeReceipt(verifiedEnvelope);
    return Object.freeze({
        ...document,
        executionEnvelopeDigest: binding.envelopeDigest,
        executionEnvelopeReceiptDigest: binding.receiptDigest
    });
}

export function verifyExecutionEnvelopeConsumerBindings({
    receipt,
    producerReceipt,
    replayPlan,
    releaseEvidence
})
{
    const binding = verifyExecutionEnvelopeReceipt(receipt);
    for (const [label, document] of [
        ['producer receipt', producerReceipt],
        ['replay plan', replayPlan],
        ['release evidence', releaseEvidence]
    ])
    {
        if (document?.executionEnvelopeDigest !== binding.envelopeDigest
            || document?.executionEnvelopeReceiptDigest !== binding.receiptDigest)
        {
            throw new Error(`${label} execution envelope binding mismatch`);
        }
    }
    return true;
}

export function probeUndeclaredHostState(command, environment)
{
    return spawnSync(command[0], command.slice(1), {
        encoding: 'utf8',
        env: environment,
        shell: false,
        windowsHide: true
    });
}
