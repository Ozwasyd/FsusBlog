#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { canonicalJson, sha256Value } from './runtime-publish-profile.mjs';

const SITE_PLAN_SCHEMA = 'fsusblog.runtime-publish-stage-site-plan.v1';
const RESULT_SCHEMA = 'fsusblog.runtime-publish-stage-result.v1';
const RECEIPT_SCHEMA = 'fsusblog.runtime-publish-stage-receipt.v1';
const ARTIFACT_SCHEMA = 'fsusblog.runtime-publish-stage-artifact.v1';
const REQUIRED_ROUTES = ['aot-ssr', 'db-miss', 'l0', 'l1', 'l2', 'notification'];
const STAGES = new Set([
    'cleanupBefore',
    'build',
    'correctness',
    'security',
    'release',
    'featureParity',
    'securityParity',
    'measure',
    'cleanupAfter'
]);
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const IMAGE_REF = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,511}@sha256:[0-9a-f]{64}$/u;

try
{
    const stage = process.env.FSUSBLOG_RUNTIME_EXECUTOR_STAGE;
    const request = readRequest();
    const receiptFile = requiredFilePath(process.env.FSUSBLOG_RUNTIME_STAGE_RECEIPT_OUTPUT, 'FSUSBLOG_RUNTIME_STAGE_RECEIPT_OUTPUT');
    const sitePlanFile = resolveSitePlan(process.argv.slice(2));
    const sitePlan = readJson(sitePlanFile, 'site plan');
    validateSitePlan(sitePlan, request.profile);
    if (!STAGES.has(stage))
    {
        throw new Error(`unsupported runtime stage: ${stage ?? '<missing>'}`);
    }

    const command = sitePlan.commands[stage];
    const executable = resolveExecutable(path.dirname(sitePlanFile), command.file);
    const stageRoot = fs.mkdtempSync(path.join(path.dirname(receiptFile), `.runtime-stage-${stage}-`));
    const artifactRoot = path.join(stageRoot, 'artifacts');
    fs.mkdirSync(artifactRoot, { mode: 0o700 });
    const artifactRootIdentity = captureDirectoryIdentity(artifactRoot);
    const resultFile = path.join(stageRoot, 'result.json');
    const startedAtUtc = new Date().toISOString();
    const startedAtMs = Date.parse(startedAtUtc);
    const started = process.hrtime.bigint();
    try
    {
        const child = spawnSync(executable, command.args, {
            cwd: path.dirname(sitePlanFile),
            encoding: 'utf8',
            maxBuffer: 16 * 1024 * 1024,
            timeout: command.timeoutMs,
            env: {
                ...process.env,
                FSUSBLOG_RUNTIME_STAGE_RESULT_OUTPUT: resultFile,
                FSUSBLOG_RUNTIME_STAGE_ARTIFACT_ROOT: artifactRoot
            }
        });
        const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
        if (child.status !== 0)
        {
            throw new Error(`${stage} site command failed with exit ${child.status ?? 'none'}: ${bounded(child.error?.message || child.stderr || child.stdout)}`);
        }
        assertDirectoryIdentity(artifactRoot, artifactRootIdentity, stage);
        const result = readFreshRegularJson(resultFile, `${stage} stage result`, startedAtMs);
        validateStageResult(result, stage, request);
        const evidence = materializeStageEvidence(result.evidence, stage, request, artifactRoot, startedAtMs);
        writeExclusive(receiptFile, {
            schema: RECEIPT_SCHEMA,
            status: 'pass',
            stage,
            identity: structuredClone(request.identity),
            startedAtUtc,
            completedAtUtc: new Date().toISOString(),
            command: {
                executableDigest: sha256File(executable),
                argsDigest: sha256Value(command.args),
                durationMs: Number(durationMs.toFixed(3)),
                exitCode: 0
            },
            resultDigest: sha256Value(result),
            evidence
        });
    }
    finally
    {
        fs.rmSync(stageRoot, { recursive: true, force: true });
    }
}
catch (error)
{
    console.error(`[runtime-profile-stage] ${messageOf(error)}`);
    process.exitCode = 1;
}

function resolveSitePlan(argv)
{
    const index = argv.indexOf('--site-plan');
    const value = index >= 0 ? argv[index + 1] : process.env.FSUSBLOG_RUNTIME_STAGE_SITE_PLAN;
    return requiredFilePath(value, '--site-plan or FSUSBLOG_RUNTIME_STAGE_SITE_PLAN');
}

function readRequest()
{
    const raw = process.env.FSUSBLOG_RUNTIME_PROFILE_REQUEST;
    if (!raw)
    {
        throw new Error('FSUSBLOG_RUNTIME_PROFILE_REQUEST is required');
    }
    try
    {
        const request = JSON.parse(raw);
        if (!plainObject(request) || !plainObject(request.identity) || !plainObject(request.profile))
        {
            throw new Error('request shape is invalid');
        }
        return request;
    }
    catch (error)
    {
        throw new Error(`runtime profile request is invalid: ${messageOf(error)}`);
    }
}

function validateSitePlan(plan, profile)
{
    if (!plainObject(plan) || plan.schema !== SITE_PLAN_SCHEMA)
    {
        throw new Error(`site plan schema must be ${SITE_PLAN_SCHEMA}`);
    }
    rejectUnknown(plan, new Set(['schema', 'commands']), 'site plan');
    if (!plainObject(plan.commands))
    {
        throw new Error('site plan commands are required');
    }
    const required = ['cleanupBefore', 'build', 'correctness', 'security', 'release', 'measure', 'cleanupAfter'];
    if (profile.publish?.nativeAot === true)
    {
        required.splice(5, 0, 'featureParity', 'securityParity');
    }
    for (const stage of required)
    {
        validateCommand(plan.commands[stage], stage);
    }
    for (const [stage, command] of Object.entries(plan.commands))
    {
        if (!STAGES.has(stage))
        {
            throw new Error(`unknown site plan command: ${stage}`);
        }
        validateCommand(command, stage);
    }
}

function validateCommand(command, stage)
{
    if (!plainObject(command))
    {
        throw new Error(`site plan command ${stage} is required`);
    }
    rejectUnknown(command, new Set(['file', 'args', 'timeoutMs']), `site plan command ${stage}`);
    if (typeof command.file !== 'string' || command.file.length === 0 || command.file.length > 512)
    {
        throw new Error(`site plan command ${stage}.file is invalid`);
    }
    if (!Array.isArray(command.args) || command.args.some((arg) => typeof arg !== 'string' || arg.length > 1024))
    {
        throw new Error(`site plan command ${stage}.args are invalid`);
    }
    if (!Number.isInteger(command.timeoutMs) || command.timeoutMs < 1000 || command.timeoutMs > 7_200_000)
    {
        throw new Error(`site plan command ${stage}.timeoutMs is invalid`);
    }
}

function validateStageResult(result, stage, request)
{
    if (!plainObject(result) || result.schema !== RESULT_SCHEMA)
    {
        throw new Error(`stage result schema must be ${RESULT_SCHEMA}`);
    }
    rejectUnknown(result, new Set(['schema', 'status', 'stage', 'identity', 'evidence']), 'stage result');
    if (result.status !== 'pass' || result.stage !== stage)
    {
        throw new Error('stage result status/stage does not match the invocation');
    }
    if (canonicalJson(result.identity) !== canonicalJson(request.identity))
    {
        throw new Error('stage result identity does not match the run request');
    }
    if (!plainObject(result.evidence))
    {
        throw new Error('stage result evidence is required');
    }
    const kind = expectedEvidenceKind(stage);
    if (result.evidence.kind !== kind)
    {
        throw new Error(`${stage} evidence.kind must be ${kind}`);
    }
    rejectUnknownEvidence(result.evidence, stage);

    if (kind === 'cleanup')
    {
        assertArtifactPath(result.evidence.artifactPath, `${stage} artifactPath`);
    }
    else if (kind === 'build')
    {
        if (!IMAGE_REF.test(String(result.evidence.imageRef ?? '')))
        {
            throw new Error('build evidence.imageRef must be immutable');
        }
        assertDigest(result.evidence.imageDigest, 'build imageDigest');
        if (!result.evidence.imageRef.endsWith(`@${result.evidence.imageDigest}`))
        {
            throw new Error('build imageRef and imageDigest must match');
        }
        assertArtifactPath(result.evidence.artifactManifestPath, 'build artifactManifestPath');
        assertArtifactPath(result.evidence.featureSetPath, 'build featureSetPath');
    }
    else if (kind === 'gate')
    {
        assertArtifactPath(result.evidence.artifactPath, `${stage} artifactPath`);
    }
    else if (kind === 'parity')
    {
        assertArtifactPath(result.evidence.artifactPath, `${stage} artifactPath`);
    }
    else if (kind === 'measurement')
    {
        assertArtifactPath(result.evidence.faultPlanPath, 'measurement faultPlanPath');
        assertArtifactPath(result.evidence.loadFixturePath, 'measurement loadFixturePath');
    }
}

function materializeStageEvidence(value, stage, request, artifactRoot, startedAtMs)
{
    const kind = expectedEvidenceKind(stage);
    if (kind === 'cleanup')
    {
        const artifact = readArtifact(artifactRoot, value.artifactPath, 'cleanup', stage, request, startedAtMs);
        return { kind, cleanupTargetsDigest: sha256Value(artifact) };
    }
    if (kind === 'build')
    {
        const manifest = readArtifact(artifactRoot, value.artifactManifestPath, 'build-manifest', stage, request, startedAtMs);
        const featureSet = readArtifact(artifactRoot, value.featureSetPath, 'feature-set', stage, request, startedAtMs);
        if (manifest.imageRef !== value.imageRef || manifest.imageDigest !== value.imageDigest)
        {
            throw new Error('build artifact manifest image identity does not match the stage result');
        }
        return {
            kind,
            imageRef: value.imageRef,
            imageDigest: value.imageDigest,
            artifactManifestDigest: sha256Value(manifest),
            featureSetDigest: sha256Value(featureSet)
        };
    }
    if (kind === 'gate')
    {
        const artifact = readArtifact(artifactRoot, value.artifactPath, 'gate', stage, request, startedAtMs);
        if (artifact.gate !== stage)
        {
            throw new Error(`${stage} artifact does not prove the named gate`);
        }
        return { kind, gate: stage, gateStatus: 'pass', evidenceDigest: sha256Value(artifact) };
    }
    if (kind === 'parity')
    {
        const artifact = readArtifact(artifactRoot, value.artifactPath, 'parity', stage, request, startedAtMs);
        const parity = stage === 'featureParity' ? 'feature' : 'security';
        if (artifact.parity !== parity || artifact.scope !== 'public-artifact-only')
        {
            throw new Error(`${stage} artifact does not prove narrow ${parity} parity`);
        }
        return { kind, parity, scope: artifact.scope, parityStatus: 'pass', evidenceDigest: sha256Value(artifact), featureSetDigest: artifact.featureSetDigest };
    }
    const faultPlan = readArtifact(artifactRoot, value.faultPlanPath, 'fault-plan', stage, request, startedAtMs);
    const loadFixture = readArtifact(artifactRoot, value.loadFixturePath, 'load-fixture', stage, request, startedAtMs);
    const measurementFile = requiredFilePath(process.env.FSUSBLOG_RUNTIME_MEASUREMENTS_OUTPUT, 'FSUSBLOG_RUNTIME_MEASUREMENTS_OUTPUT');
    const payload = readFreshRegularJson(measurementFile, 'measurement payload', startedAtMs);
    return { kind, payloadDigest: sha256Value(payload), faultPlanDigest: sha256Value(faultPlan), loadFixtureDigest: sha256Value(loadFixture) };
}

function readArtifact(root, relativePath, kind, stage, request, startedAtMs)
{
    assertArtifactPath(relativePath, `${stage} artifact path`);
    const rootReal = fs.realpathSync(root);
    const resolved = path.resolve(rootReal, relativePath);
    if (!resolved.startsWith(`${rootReal}${path.sep}`))
    {
        throw new Error(`${stage} artifact path escapes the stage artifact root`);
    }
    assertNoSymlinkSegments(rootReal, relativePath, stage);
    const linkStat = fs.lstatSync(resolved);
    if (!linkStat.isFile() || linkStat.isSymbolicLink())
    {
        throw new Error(`${stage} artifact must be a regular non-symlink file`);
    }
    const real = fs.realpathSync(resolved);
    if (!real.startsWith(`${rootReal}${path.sep}`))
    {
        throw new Error(`${stage} artifact resolves outside the stage artifact root`);
    }
    const stat = fs.statSync(real);
    if (stat.size <= 0 || stat.size > 1024 * 1024)
    {
        throw new Error(`${stage} artifact size is invalid`);
    }
    if (stat.mtimeMs + 1000 < startedAtMs)
    {
        throw new Error(`${stage} artifact predates the stage invocation`);
    }
    const artifact = readJson(real, `${stage} ${kind} artifact`);
    validateArtifact(artifact, kind, stage, request);
    return artifact;
}

function validateArtifact(artifact, kind, stage, request)
{
    if (!plainObject(artifact) || artifact.schema !== ARTIFACT_SCHEMA || artifact.kind !== kind || artifact.status !== 'pass' || artifact.stage !== stage)
    {
        throw new Error(`${stage} ${kind} artifact schema/status/stage is invalid`);
    }
    if (canonicalJson(artifact.identity) !== canonicalJson(request.identity))
    {
        throw new Error(`${stage} artifact identity is stale or does not match the run request`);
    }
    const common = ['schema', 'kind', 'status', 'stage', 'identity'];
    const fields = {
        cleanup: [...common, 'targets'],
        'build-manifest': [...common, 'imageRef', 'imageDigest', 'artifacts'],
        'feature-set': [...common, 'scope', 'features'],
        gate: [...common, 'gate', 'checks'],
        parity: [...common, 'parity', 'scope', 'featureSetDigest', 'checks'],
        'fault-plan': [...common, 'scenarios'],
        'load-fixture': [...common, 'fixtureId', 'routes']
    };
    rejectUnknown(artifact, new Set(fields[kind]), `${stage} ${kind} artifact`);
    if (kind === 'cleanup')
    {
        validateStringList(artifact.targets, `${stage} cleanup targets`);
    }
    if (kind === 'build-manifest')
    {
        if (!IMAGE_REF.test(String(artifact.imageRef ?? '')) || !artifact.imageRef.endsWith(`@${artifact.imageDigest ?? '<missing>'}`))
        {
            throw new Error('build manifest image identity is invalid');
        }
        assertDigest(artifact.imageDigest, 'build manifest imageDigest');
        validateStringList(artifact.artifacts, 'build manifest artifacts');
    }
    if (kind === 'feature-set')
    {
        if (artifact.scope !== 'public-artifact-only')
        {
            throw new Error('feature-set artifact scope is invalid');
        }
        validateStringList(artifact.features, 'feature-set features');
    }
    if (kind === 'gate')
    {
        if (artifact.gate !== stage)
        {
            throw new Error(`${stage} gate artifact name is invalid`);
        }
        validateChecks(artifact.checks, `${stage} gate checks`);
    }
    if (kind === 'parity')
    {
        const parity = stage === 'featureParity' ? 'feature' : 'security';
        if (artifact.parity !== parity || artifact.scope !== 'public-artifact-only')
        {
            throw new Error(`${stage} parity artifact scope is invalid`);
        }
        assertDigest(artifact.featureSetDigest, `${stage} featureSetDigest`);
        validateChecks(artifact.checks, `${stage} parity checks`);
    }
    if (kind === 'fault-plan')
    {
        validateStringList(artifact.scenarios, 'fault-plan scenarios');
        for (const required of ['allocation-burst', 'gc-pressure', 'oom', 'blue-green-overlap', 'recovery'])
        {
            if (!artifact.scenarios.includes(required))
            {
                throw new Error(`fault-plan artifact is missing ${required}`);
            }
        }
    }
    if (kind === 'load-fixture')
    {
        if (artifact.fixtureId !== request.identity.fixtureId)
        {
            throw new Error('load-fixture artifact fixtureId does not match the run request');
        }
        validateStringList(artifact.routes, 'load-fixture routes');
        if (canonicalJson([...artifact.routes].sort()) !== canonicalJson(REQUIRED_ROUTES))
        {
            throw new Error('load-fixture artifact must cover every required route');
        }
    }
}

function validateChecks(checks, label)
{
    if (!Array.isArray(checks) || checks.length === 0)
    {
        throw new Error(`${label} must be non-empty`);
    }
    const ids = new Set();
    for (const check of checks)
    {
        if (!plainObject(check))
        {
            throw new Error(`${label} entry is invalid`);
        }
        rejectUnknown(check, new Set(['id', 'status']), `${label} entry`);
        if (typeof check.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/u.test(check.id) || check.status !== 'pass' || ids.has(check.id))
        {
            throw new Error(`${label} entry is invalid`);
        }
        ids.add(check.id);
    }
}

function validateStringList(values, label)
{
    if (!Array.isArray(values) || values.length === 0 || values.some((value) => typeof value !== 'string' || value.length < 1 || value.length > 256) || new Set(values).size !== values.length)
    {
        throw new Error(`${label} must be a non-empty unique string list`);
    }
}

function assertArtifactPath(value, label)
{
    if (typeof value !== 'string' || value.length < 1 || value.length > 240 || path.isAbsolute(value) || value.includes('\0'))
    {
        throw new Error(`${label} is invalid`);
    }
    const segments = value.split('/');
    if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..'))
    {
        throw new Error(`${label} is invalid`);
    }
}

function assertNoSymlinkSegments(root, relativePath, stage)
{
    let current = root;
    for (const segment of relativePath.split('/'))
    {
        current = path.join(current, segment);
        if (fs.lstatSync(current).isSymbolicLink())
        {
            throw new Error(`${stage} artifact path cannot contain symlinks`);
        }
    }
}

function readFreshRegularJson(file, label, startedAtMs)
{
    const linkStat = fs.lstatSync(file);
    if (!linkStat.isFile() || linkStat.isSymbolicLink())
    {
        throw new Error(`${label} must be a regular non-symlink file`);
    }
    const stat = fs.statSync(file);
    if (stat.size <= 0 || stat.size > 16 * 1024 * 1024)
    {
        throw new Error(`${label} size is invalid`);
    }
    if (stat.mtimeMs + 1000 < startedAtMs)
    {
        throw new Error(`${label} predates the stage invocation`);
    }
    return readJson(file, label);
}

function captureDirectoryIdentity(directory)
{
    const linkStat = fs.lstatSync(directory);
    if (!linkStat.isDirectory() || linkStat.isSymbolicLink())
    {
        throw new Error('stage artifact root must be a real directory');
    }
    return { realPath: fs.realpathSync(directory), dev: linkStat.dev, ino: linkStat.ino };
}

function assertDirectoryIdentity(directory, expected, stage)
{
    const current = captureDirectoryIdentity(directory);
    if (current.realPath !== expected.realPath || current.dev !== expected.dev || current.ino !== expected.ino)
    {
        throw new Error(`${stage} stage artifact root was replaced during execution`);
    }
}

function rejectUnknownEvidence(evidence, stage)
{
    const fields = {
        cleanupBefore: ['kind', 'artifactPath'],
        cleanupAfter: ['kind', 'artifactPath'],
        build: ['kind', 'imageRef', 'imageDigest', 'artifactManifestPath', 'featureSetPath'],
        correctness: ['kind', 'artifactPath'],
        security: ['kind', 'artifactPath'],
        release: ['kind', 'artifactPath'],
        featureParity: ['kind', 'artifactPath'],
        securityParity: ['kind', 'artifactPath'],
        measure: ['kind', 'faultPlanPath', 'loadFixturePath']
    };
    rejectUnknown(evidence, new Set(fields[stage]), `${stage} evidence`);
}

function expectedEvidenceKind(stage)
{
    if (stage.startsWith('cleanup'))
    {
        return 'cleanup';
    }
    if (stage === 'build')
    {
        return 'build';
    }
    if (['correctness', 'security', 'release'].includes(stage))
    {
        return 'gate';
    }
    if (stage.endsWith('Parity'))
    {
        return 'parity';
    }
    return 'measurement';
}

function resolveExecutable(root, file)
{
    const resolved = path.resolve(root, file);
    const stat = fs.lstatSync(resolved);
    if (!stat.isFile() || stat.isSymbolicLink())
    {
        throw new Error('site command executable must be a regular non-symlink file');
    }
    return resolved;
}

function requiredFilePath(value, label)
{
    if (typeof value !== 'string' || value.trim().length === 0)
    {
        throw new Error(`${label} is required`);
    }
    return path.resolve(value);
}

function readJson(file, label)
{
    try
    {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    catch (error)
    {
        throw new Error(`unable to read ${label}: ${messageOf(error)}`);
    }
}

function sha256File(file)
{
    return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function assertDigest(value, label)
{
    if (!SHA256.test(String(value ?? '')))
    {
        throw new Error(`${label} must be sha256:<64 lowercase hex>`);
    }
}

function writeExclusive(file, value)
{
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

function rejectUnknown(value, allowed, label)
{
    if (!plainObject(value))
    {
        return;
    }
    for (const key of Object.keys(value))
    {
        if (!allowed.has(key))
        {
            throw new Error(`${label}.${key} is not allowed`);
        }
    }
}

function bounded(value)
{
    return String(value).replace(/[\r\n]+/gu, ' ').trim().slice(0, 2048) || 'command failed without diagnostics';
}

function messageOf(error)
{
    return error instanceof Error ? error.message : String(error);
}

function plainObject(value)
{
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
