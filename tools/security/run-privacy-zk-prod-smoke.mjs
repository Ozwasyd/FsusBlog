#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_CONFIGS = [
    'src/backend/appsettings.json',
    'src/backend/appsettings.Production.json'
];
const DEFAULT_SUMMARY = path.join(
    process.env.FSUSBLOG_SECURITY_OUTPUT_ROOT ?? '.tmp/security',
    'privacy-zk-prod-smoke.json');
const DEFAULT_PROVER_MANIFEST = process.env.FSUSBLOG_FRONTEND_WASM_ROOT
    ? path.join(process.env.FSUSBLOG_FRONTEND_WASM_ROOT, 'comment-privacy-prover.manifest.json')
    : 'src/frontend/public/wasm/comment-privacy-prover.manifest.json';
const DEFAULT_TRUSTED_SETUP = 'security/zk/provenance/comment-v5-trusted-setup.manifest.json';
const REAL_EVIDENCE_KIND = 'real-groth16-cross-stack';
const REQUIRED_ARTIFACT_HASHES = [
    'r1csSha256',
    'provingKeySha256',
    'verifyingKeySha256',
    'nativeVerifierSha256',
    'wasmProverSha256'
];
const REQUIRED_EVIDENCE_ARTIFACTS = [
    ['r1cs', 'r1csSha256'],
    ['provingKey', 'provingKeySha256'],
    ['verifyingKey', 'verifyingKeySha256'],
    ['nativeVerifier', 'nativeVerifierSha256'],
    ['wasmProver', 'wasmProverSha256'],
    ['proofFixture', null],
    ['publicInputs', null],
    ['tamperCases', null],
    ['unlinkabilityTranscripts', null]
];
const WASM_PROVER_P95_MS_MAX = 3000;
const NATIVE_VERIFIER_P99_MS_MAX = 50;

const args = parseArgs(process.argv.slice(2));
const summaryPath = resolveRepoPath(args.summary ?? DEFAULT_SUMMARY);
const configPaths = args.config.length > 0 ? args.config : DEFAULT_CONFIGS;
const errors = [];
const checks = [];

const configuration = configPaths
    .filter((file) => existsSync(resolveRepoPath(file)))
    .map((file) => readJsonc(resolveRepoPath(file)))
    .reduce((merged, current) => deepMerge(merged, current), {});

const zkCommentPolicy = readSection(configuration, ['AnonymousIdentity', 'ZkCommentPolicy']);
const zkVerifier = readSection(configuration, ['AnonymousIdentity', 'ZkVerifier']);
const credentialIssuer = readSection(configuration, ['AnonymousCredentialIssuer', 'BlindRsa']);
const enabled = readBoolEnv('FSUSBLOG_ZK_COMMENT_POLICY_ENABLED') ?? readBool(zkCommentPolicy.Enabled) ?? false;
const traceId = `zk-prod-smoke-${Date.now().toString(36)}`;
const realEvidence = args.realEvidence ? readRealEvidence(args.realEvidence) : null;

const artifactState = inspectArtifacts();
let status = 'expected_unavailable';
let businessState = enabled ? 'real_smoke_evidence_required' : 'feature_flag_off';

if (realEvidence)
{
    validateRealEvidence(realEvidence);
    if (errors.length === 0)
    {
        status = 'ok';
        businessState = 'real_smoke_evidence_validated';
    }
}
else if (!enabled)
{
    checks.push({
        id: 'feature-flag-off',
        status: 'expected_unavailable',
        detail: 'AnonymousIdentity:ZkCommentPolicy:Enabled=false'
    });
}
else
{
    businessState = artifactState.wasmProver
        ? 'real_smoke_evidence_missing'
        : 'browser_prover_artifact_unavailable';
    checks.push({
        id: 'real-evidence-required',
        status: 'expected_unavailable',
        detail: businessState
    });
}

if (args.requireReal && status !== 'ok')
{
    errors.push(`real ZK-Prod smoke evidence is required; current business state is ${businessState}.`);
}

if (errors.length > 0)
{
    status = 'failed';
}

const summary = {
    schema: 'fsusblog.privacy-zk-prod-smoke.v1',
    status,
    generatedAt: new Date().toISOString(),
    traceId,
    businessState,
    enabled,
    featureFlagOffExpectedUnavailable: !enabled,
    nativeVerifier: realEvidence?.nativeVerifier === true || artifactState.nativeVerifier,
    wasmProver: realEvidence?.wasmProver === true || artifactState.wasmProver,
    credential: realEvidence?.credential === true || artifactState.credential,
    ticketIssued: realEvidence?.ticketIssued === true,
    anonymousSubmitPending: realEvidence?.anonymousSubmitPending === true,
    identityHeadersOmitted: realEvidence?.identityHeadersOmitted === true || status === 'expected_unavailable',
    sensitivePayloadRedacted: true,
    realEvidenceKind: realEvidence ? normalizeString(realEvidence.evidenceKind) : null,
    circuitId: realEvidence ? normalizeString(realEvidence.circuitId) : null,
    publicInputLayoutVersion: realEvidence ? Number(realEvidence.publicInputLayoutVersion) : null,
    proofSystem: realEvidence ? normalizeString(realEvidence.proofSystem) : null,
    verifyingKeyHash: realEvidence ? normalizeString(realEvidence.verifyingKeyHash).toLowerCase() : null,
    artifactHashes: realEvidence ? sanitizeArtifactHashes(realEvidence.artifactHashes) : {},
    evidenceArtifacts: realEvidence ? sanitizeEvidenceArtifacts(realEvidence.artifacts) : {},
    performance: realEvidence ? sanitizePerformance(realEvidence.performance) : {},
    artifacts: artifactState.safeArtifacts,
    checks,
    errors
};

mkdirSync(path.dirname(summaryPath), { recursive: true });
writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);

if (errors.length > 0)
{
    for (const error of errors)
    {
        console.error(`[privacy-zk-prod-smoke] ${error}`);
    }
    console.error(`[privacy-zk-prod-smoke] failed summary=${toRepoRelative(summaryPath)}`);
    process.exit(1);
}

console.log(`[privacy-zk-prod-smoke] ${status} summary=${toRepoRelative(summaryPath)} trace=${traceId} state=${businessState}`);

function inspectArtifacts()
{
    const nativeLibraryPath = normalizeString(
        process.env.FSUSBLOG_ZK_NATIVE_VERIFIER_LIB
      ?? zkVerifier.NativeGroth16?.LibraryPath);
    const nativeVerifier = nativeLibraryPath.length > 0 && existsSync(resolveRepoPath(nativeLibraryPath));

    const trustedSetupPath = normalizeString(
        args.trustedSetupManifest
      ?? process.env.FSUSBLOG_ZK_TRUSTED_SETUP_MANIFEST
      ?? zkVerifier.TrustedSetupManifestPath
      ?? DEFAULT_TRUSTED_SETUP);
    const trustedSetup = readOptionalJson(trustedSetupPath);
    const trustedSetupReady = trustedSetup?.production_usable === true &&
    normalizeString(trustedSetup?.verifying_key_hash).length > 0;

    const proverManifestPath = normalizeString(args.proverManifest ?? DEFAULT_PROVER_MANIFEST);
    const proverManifest = readOptionalJson(proverManifestPath);
    const wasmProver = hasUsableBrowserProver(proverManifest);

    const credentialHash = normalizeString(
        process.env.FSUSBLOG_ZK_ISSUER_PUBLIC_KEY_HASH ?? credentialIssuer.PublicKeyHash).toLowerCase();
    const credential = isSha256Hex(credentialHash);

    const safeArtifacts = {
        nativeVerifierConfigured: nativeVerifier,
        trustedSetupProductionUsable: trustedSetupReady,
        browserProverArtifactAvailable: wasmProver,
        credentialReady: credential,
        proverManifest: existsSync(resolveRepoPath(proverManifestPath)) ? toRepoRelative(resolveRepoPath(proverManifestPath)) : null,
        trustedSetupManifest: existsSync(resolveRepoPath(trustedSetupPath)) ? toRepoRelative(resolveRepoPath(trustedSetupPath)) : null
    };

    return {
        nativeVerifier,
        wasmProver,
        credential,
        safeArtifacts
    };
}

function hasUsableBrowserProver(manifest)
{
    if (!manifest || typeof manifest !== 'object')
    {
        return false;
    }
    const moduleUrl = normalizeString(manifest.moduleUrl);
    const wasmUrl = normalizeString(manifest.wasmUrl);
    const provingKeyUrl = normalizeString(manifest.provingKeyUrl);
    if (!moduleUrl || !wasmUrl || !provingKeyUrl)
    {
        return false;
    }
    return [moduleUrl, wasmUrl, provingKeyUrl]
        .map(resolvePublicAssetUrl)
        .every((file) => existsSync(file));
}

function validateRealEvidence(evidence)
{
    const evidenceStatus = normalizeString(evidence.status);
    if (!['ok', 'passed', 'success'].includes(evidenceStatus))
    {
        errors.push('real smoke evidence status must be ok/passed/success.');
    }

    for (const key of [
        'nativeVerifier',
        'wasmProver',
        'credential',
        'ticketIssued',
        'anonymousSubmitPending',
        'identityHeadersOmitted',
        'sensitivePayloadRedacted'
    ])
    {
        if (evidence[key] !== true)
        {
            errors.push(`real smoke evidence requires ${key}=true.`);
        }
    }

    validateRealGroth16Evidence(evidence);
    checks.push({ id: 'real-smoke-evidence', status: 'checked' });
}

function validateRealGroth16Evidence(evidence)
{
    if (normalizeString(evidence.evidenceKind) !== REAL_EVIDENCE_KIND)
    {
        errors.push(`real smoke evidence must declare evidenceKind=${REAL_EVIDENCE_KIND}.`);
    }
    if (normalizeString(evidence.circuitId) !== 'fsus.anonymous.comment.v5')
    {
        errors.push('real smoke evidence circuitId must be fsus.anonymous.comment.v5.');
    }
    if (Number(evidence.publicInputLayoutVersion) !== 6)
    {
        errors.push('real smoke evidence publicInputLayoutVersion must be 6.');
    }
    if (normalizeString(evidence.proofSystem) !== 'Groth16')
    {
        errors.push('real smoke evidence proofSystem must be Groth16.');
    }
    if (!isSha256Hex(normalizeString(evidence.verifyingKeyHash).toLowerCase()))
    {
        errors.push('real smoke evidence verifyingKeyHash must be a 64-char SHA-256 hex digest.');
    }

    const artifactHashes = isObject(evidence.artifactHashes) ? evidence.artifactHashes : {};
    for (const key of REQUIRED_ARTIFACT_HASHES)
    {
        const value = normalizeString(artifactHashes[key]).toLowerCase();
        if (!isSha256Hex(value))
        {
            errors.push(`real smoke evidence artifactHashes.${key} must be a 64-char SHA-256 hex digest.`);
        }
    }

    const verifyingKeyHash = normalizeString(evidence.verifyingKeyHash).toLowerCase();
    const verifyingKeyArtifactHash = normalizeString(artifactHashes.verifyingKeySha256).toLowerCase();
    if (isSha256Hex(verifyingKeyHash) && isSha256Hex(verifyingKeyArtifactHash) && verifyingKeyHash !== verifyingKeyArtifactHash)
    {
        errors.push('real smoke evidence verifyingKeyHash must match artifactHashes.verifyingKeySha256.');
    }

    validateEvidenceArtifacts(evidence.artifacts, artifactHashes, 'real smoke evidence');

    const crossStack = isObject(evidence.crossStack) ? evidence.crossStack : {};
    for (const key of [
        'frontendProofGenerated',
        'backendProofVerified',
        'publicInputsMatch',
        'tamperCasesRejected',
        'completeTranscriptUnlinkableAcrossScopes',
        'sameScopeNullifierStable',
        'differentScopeNullifiersUnique',
        'legacyLayoutRejected'
    ])
    {
        if (crossStack[key] !== true)
        {
            errors.push(`real smoke evidence crossStack.${key}=true is required.`);
        }
    }
    if (evidence.hashingFixtureUsed === true || crossStack.hashingFixtureUsed === true)
    {
        errors.push('real smoke evidence must not use hashingFixtureUsed=true.');
    }
    if (!Number.isSafeInteger(Number(crossStack.sampledScopes)) || Number(crossStack.sampledScopes) < 100)
    {
        errors.push('real smoke evidence crossStack.sampledScopes must be at least 100.');
    }

    const performance = isObject(evidence.performance) ? evidence.performance : {};
    const wasmProverP95Ms = Number(performance.wasmProverP95Ms);
    if (!Number.isFinite(wasmProverP95Ms) || wasmProverP95Ms <= 0 || wasmProverP95Ms > WASM_PROVER_P95_MS_MAX)
    {
        errors.push(`real smoke evidence performance.wasmProverP95Ms must be in 1..${WASM_PROVER_P95_MS_MAX}.`);
    }
    const nativeVerifierP99Ms = Number(performance.nativeVerifierP99Ms);
    if (!Number.isFinite(nativeVerifierP99Ms) || nativeVerifierP99Ms <= 0 || nativeVerifierP99Ms > NATIVE_VERIFIER_P99_MS_MAX)
    {
        errors.push(`real smoke evidence performance.nativeVerifierP99Ms must be in 1..${NATIVE_VERIFIER_P99_MS_MAX}.`);
    }
}

function sanitizeArtifactHashes(value)
{
    const source = isObject(value) ? value : {};
    const output = {};
    for (const key of REQUIRED_ARTIFACT_HASHES)
    {
        const hash = normalizeString(source[key]).toLowerCase();
        if (isSha256Hex(hash))
        {
            output[key] = hash;
        }
    }
    return output;
}

function validateEvidenceArtifacts(artifacts, artifactHashes, label)
{
    const source = isObject(artifacts) ? artifacts : {};
    for (const [artifactName, hashKey] of REQUIRED_EVIDENCE_ARTIFACTS)
    {
        const entry = isObject(source[artifactName]) ? source[artifactName] : {};
        const rawPath = normalizeString(entry.path);
        const declaredSha = normalizeString(entry.sha256).toLowerCase();

        if (!rawPath)
        {
            errors.push(`${label} artifacts.${artifactName}.path is required.`);
            continue;
        }
        if (!isSha256Hex(declaredSha))
        {
            errors.push(`${label} artifacts.${artifactName}.sha256 must be a 64-char SHA-256 hex digest.`);
            continue;
        }

        const absolute = resolveRepoPath(rawPath);
        if (!existsSync(absolute))
        {
            errors.push(`${label} artifacts.${artifactName}.path must exist: ${rawPath}`);
            continue;
        }

        const actualSha = sha256File(absolute);
        if (actualSha !== declaredSha)
        {
            errors.push(`${label} artifacts.${artifactName}.sha256 does not match the local file.`);
        }

        if (hashKey)
        {
            const expectedSha = normalizeString(artifactHashes[hashKey]).toLowerCase();
            if (isSha256Hex(expectedSha) && declaredSha !== expectedSha)
            {
                errors.push(`${label} artifacts.${artifactName}.sha256 must match artifactHashes.${hashKey}.`);
            }
        }
    }
}

function sanitizeEvidenceArtifacts(value)
{
    const source = isObject(value) ? value : {};
    const output = {};
    for (const [artifactName] of REQUIRED_EVIDENCE_ARTIFACTS)
    {
        const entry = isObject(source[artifactName]) ? source[artifactName] : {};
        const rawPath = normalizeString(entry.path);
        const sha256 = normalizeString(entry.sha256).toLowerCase();
        if (rawPath && isSha256Hex(sha256))
        {
            output[artifactName] = {
                path: toRepoRelative(resolveRepoPath(rawPath)),
                sha256
            };
        }
    }
    return output;
}

function sanitizePerformance(value)
{
    const source = isObject(value) ? value : {};
    const output = {};
    const wasmProverP95Ms = Number(source.wasmProverP95Ms);
    if (Number.isFinite(wasmProverP95Ms) && wasmProverP95Ms > 0)
    {
        output.wasmProverP95Ms = wasmProverP95Ms;
    }
    const nativeVerifierP99Ms = Number(source.nativeVerifierP99Ms);
    if (Number.isFinite(nativeVerifierP99Ms) && nativeVerifierP99Ms > 0)
    {
        output.nativeVerifierP99Ms = nativeVerifierP99Ms;
    }
    return output;
}

function readRealEvidence(rawPath)
{
    const absolute = resolveRepoPath(rawPath);
    if (!existsSync(absolute))
    {
        errors.push(`real smoke evidence is missing: ${rawPath}`);
        return null;
    }

    return JSON.parse(readFileSync(absolute, 'utf8'));
}

function readOptionalJson(rawPath)
{
    const absolute = resolveRepoPath(rawPath);
    if (!existsSync(absolute))
    {
        return null;
    }
    return JSON.parse(readFileSync(absolute, 'utf8'));
}

function parseArgs(argv)
{
    const parsed = {
        config: []
    };
    for (let i = 0; i < argv.length; i += 1)
    {
        const token = argv[i];
        if (token === '--config')
        {
            parsed.config.push(requireValue(argv, ++i, token));
        }
        else if (token === '--summary')
        {
            parsed.summary = requireValue(argv, ++i, token);
        }
        else if (token === '--trusted-setup-manifest')
        {
            parsed.trustedSetupManifest = requireValue(argv, ++i, token);
        }
        else if (token === '--prover-manifest')
        {
            parsed.proverManifest = requireValue(argv, ++i, token);
        }
        else if (token === '--real-evidence')
        {
            parsed.realEvidence = requireValue(argv, ++i, token);
        }
        else if (token === '--require-real')
        {
            parsed.requireReal = true;
        }
        else
        {
            throw new Error(`Unknown argument: ${token}`);
        }
    }
    return parsed;
}

function requireValue(argv, index, flag)
{
    const value = argv[index];
    if (!value || value.startsWith('--'))
    {
        throw new Error(`${flag} requires a value`);
    }
    return value;
}

function readJsonc(file)
{
    const raw = readFileSync(file, 'utf8');
    return JSON.parse(stripJsonComments(raw));
}

function stripJsonComments(raw)
{
    let output = '';
    let inString = false;
    let escaped = false;
    for (let i = 0; i < raw.length; i += 1)
    {
        const ch = raw[i];
        const next = raw[i + 1];

        if (inString)
        {
            output += ch;
            if (escaped)
            {
                escaped = false;
            }
            else if (ch === '\\')
            {
                escaped = true;
            }
            else if (ch === '"')
            {
                inString = false;
            }
            continue;
        }

        if (ch === '"')
        {
            inString = true;
            output += ch;
            continue;
        }

        if (ch === '/' && next === '/')
        {
            while (i < raw.length && raw[i] !== '\n')
            {
                i += 1;
            }
            output += '\n';
            continue;
        }

        if (ch === '/' && next === '*')
        {
            i += 2;
            while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/'))
            {
                i += 1;
            }
            i += 1;
            continue;
        }

        output += ch;
    }
    return output;
}

function deepMerge(left, right)
{
    if (!isObject(left) || !isObject(right))
    {
        return right ?? left;
    }
    const output = { ...left };
    for (const [key, value] of Object.entries(right))
    {
        output[key] = isObject(value) && isObject(output[key])
            ? deepMerge(output[key], value)
            : value;
    }
    return output;
}

function readSection(source, keys)
{
    let current = source;
    for (const key of keys)
    {
        if (!isObject(current) || !Object.prototype.hasOwnProperty.call(current, key))
        {
            return {};
        }
        current = current[key];
    }
    return isObject(current) ? current : {};
}

function readBool(value)
{
    if (typeof value === 'boolean')
    {
        return value;
    }
    if (typeof value === 'string')
    {
        const normalized = value.trim().toLowerCase();
        if (normalized === 'true')
        {
            return true;
        }
        if (normalized === 'false')
        {
            return false;
        }
    }
    return null;
}

function readBoolEnv(name)
{
    return process.env[name] === undefined ? null : readBool(process.env[name]);
}

function normalizeString(value)
{
    return typeof value === 'string' ? value.trim() : '';
}

function isSha256Hex(value)
{
    return /^[0-9a-f]{64}$/u.test(value);
}

function isObject(value)
{
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function resolveRepoPath(rawPath)
{
    return path.isAbsolute(rawPath) ? rawPath : path.join(ROOT, rawPath);
}

function resolvePublicAssetUrl(rawUrl)
{
    if (/^https?:\/\//i.test(rawUrl))
    {
        return path.join(ROOT, '__remote_url_not_local__');
    }
    const urlPath = rawUrl.startsWith('/') ? rawUrl.slice(1) : rawUrl;
    if (process.env.FSUSBLOG_FRONTEND_WASM_ROOT && urlPath.startsWith('wasm/'))
    {
        return path.join(process.env.FSUSBLOG_FRONTEND_WASM_ROOT, urlPath.slice('wasm/'.length));
    }
    return path.join(ROOT, 'src/frontend/public', urlPath);
}

function toRepoRelative(file)
{
    return path.relative(ROOT, file).split(path.sep).join('/');
}

function sha256File(file)
{
    return createHash('sha256').update(readFileSync(file)).digest('hex');
}
