#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateCommentPrivacyCredentialVault } from './check-comment-privacy-credential-vault.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_CONFIGS = [
    'src/backend/appsettings.json',
    'src/backend/appsettings.Production.json'
];
const DEFAULT_TRUSTED_SETUP = 'security/zk/provenance/comment-v5-trusted-setup.manifest.json';
const DEFAULT_SMOKE_EVIDENCE = '.tmp/security/privacy-zk-prod-smoke.json';
const DEFAULT_ROOT_BOOTSTRAP_EVIDENCE = '.tmp/security/anonymous-credential-root-bootstrap.json';
const DEFAULT_SUMMARY = '.tmp/security/privacy-zk-prod-release.json';
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
const configPaths = args.config.length > 0 ? args.config : DEFAULT_CONFIGS;
const summaryPath = resolveRepoPath(args.summary ?? DEFAULT_SUMMARY);
const errors = [];
const checks = [];

const configuration = configPaths
    .filter((file) => existsSync(resolveRepoPath(file)))
    .map((file) => readJsonc(resolveRepoPath(file)))
    .reduce((merged, current) => deepMerge(merged, current), {});

const zkCommentPolicy = readSection(configuration, ['AnonymousIdentity', 'ZkCommentPolicy']);
const zkVerifier = readSection(configuration, ['AnonymousIdentity', 'ZkVerifier']);
const credentialIssuer = readSection(configuration, ['AnonymousCredentialIssuer', 'BlindRsa']);

const enabled = readBoolEnv('FSUSBLOG_ZK_COMMENT_POLICY_ENABLED')
  ?? readBool(zkCommentPolicy.Enabled)
  ?? false;
const requireEnabled = Boolean(args.requireEnabled);

if (requireEnabled && !enabled)
{
    errors.push('ZkProd must be enabled for this release gate invocation.');
}

if (Object.hasOwn(configuration.AnonymousIdentity ?? {}, 'ZkProd'))
{
    errors.push('AnonymousIdentity:ZkProd is a retired configuration section.');
}
for (const key of Object.keys(zkCommentPolicy))
{
    if (!['Enabled', 'RequireCredential', 'RequireTrustedSetupVerified'].includes(key))
    {
        errors.push(`AnonymousIdentity:ZkCommentPolicy:${key} is unknown or forbidden.`);
    }
}
if (Object.hasOwn(zkVerifier.NativeGroth16 ?? {}, 'VerifyingKeyHash') ||
    Object.hasOwn(zkVerifier.NativeGroth16 ?? {}, 'VerifyingKeySha256'))
{
    errors.push('AnonymousIdentity:ZkVerifier:NativeGroth16 duplicate verifying-key hash is forbidden.');
}
checkRollbackDocument();
checkCommentPrivacyCredentialVault();

if (!enabled && !requireEnabled)
{
    checks.push({
        id: 'zk-prod-disabled-safe-baseline',
        status: 'ok',
        detail: 'ZkProd is disabled; production anonymous comment crypto remains fail-closed.'
    });
}
else
{
    checkEnabledProductionReadiness();
}

const status = errors.length === 0 ? 'ok' : 'failed';
const summary = {
    schema: 'fsusblog.privacy-zk-prod-release.v1',
    status,
    enabled,
    generatedAt: new Date().toISOString(),
    configs: configPaths,
    checks,
    errors
};
mkdirSync(path.dirname(summaryPath), { recursive: true });
writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);

if (errors.length > 0)
{
    for (const error of errors)
    {
        console.error(`[privacy-zk-prod-release] ${error}`);
    }
    console.error(`[privacy-zk-prod-release] failed summary=${toRepoRelative(summaryPath)}`);
    process.exit(1);
}

console.log(`[privacy-zk-prod-release] ok summary=${toRepoRelative(summaryPath)}`);

function checkEnabledProductionReadiness()
{
    checkTrue('AnonymousIdentity:ZkCommentPolicy:RequireTrustedSetupVerified', zkCommentPolicy.RequireTrustedSetupVerified);
    checkTrue('AnonymousIdentity:ZkCommentPolicy:RequireCredential', zkCommentPolicy.RequireCredential);

    const backend = normalizeString(zkVerifier.Backend);
    if (backend !== 'native_groth16')
    {
        errors.push('AnonymousIdentity:ZkVerifier:Backend must be native_groth16 when ZkProd is enabled.');
    }
    else
    {
        checks.push({ id: 'native-backend-name', status: 'ok', detail: backend });
    }

    const nativeLibraryPath = normalizeString(
        process.env.FSUSBLOG_ZK_NATIVE_VERIFIER_LIB
      ?? zkVerifier.NativeGroth16?.LibraryPath);
    checkNativeVerifierLibrary(nativeLibraryPath);

    const trustedSetupPath = normalizeString(
        args.trustedSetupManifest
      ?? process.env.FSUSBLOG_ZK_TRUSTED_SETUP_MANIFEST
      ?? zkVerifier.TrustedSetupManifestPath
      ?? DEFAULT_TRUSTED_SETUP);
    const setup = checkTrustedSetupManifest(trustedSetupPath);

    const expectedVkHash = normalizeString(
        process.env.FSUSBLOG_ZK_VERIFYING_KEY_HASH
      ?? zkVerifier.VerifyingKeyHash);
    if (!expectedVkHash)
    {
        errors.push('AnonymousIdentity:ZkVerifier:VerifyingKeyHash is required.');
    }
    else if (setup?.verifying_key_hash && setup.verifying_key_hash !== expectedVkHash)
    {
        errors.push('trusted setup verifying_key_hash does not match production configuration.');
    }
    else
    {
        checks.push({ id: 'verifying-key-hash-bound', status: 'ok', detail: expectedVkHash });
    }

    const verifyingKeyManifestPath = normalizeString(zkVerifier.VerifyingKeyManifestPath);
    if (!verifyingKeyManifestPath || !existsSync(resolveRepoPath(verifyingKeyManifestPath)))
    {
        errors.push('AnonymousIdentity:ZkVerifier:VerifyingKeyManifestPath must identify an existing production manifest.');
    }
    else
    {
        const manifest = readJsonc(resolveRepoPath(verifyingKeyManifestPath));
        if (manifest.production_usable !== true || manifest.verifying_key_hash !== expectedVkHash)
        {
            errors.push('verifying-key manifest must be production_usable and match the sole verifier hash.');
        }
    }

    const issuerPublicKeyHash = normalizeString(
        process.env.FSUSBLOG_ZK_ISSUER_PUBLIC_KEY_HASH
      ?? credentialIssuer.PublicKeyHash);
    if (!isSha256Hex(issuerPublicKeyHash))
    {
        errors.push('AnonymousCredentialIssuer:BlindRsa:PublicKeyHash must be a 64-char hex SHA-256 digest.');
    }

    const issuerPrivateKeyPath = normalizeString(
        process.env.FSUSBLOG_ZK_ISSUER_PRIVATE_KEY
      ?? credentialIssuer.PrivateKeyPath);
    checkExistingFile('credential-issuer-private-key', issuerPrivateKeyPath);

    const smokeEvidencePath = normalizeString(
        args.smokeEvidence
      ?? process.env.FSUSBLOG_ZK_PROD_SMOKE_EVIDENCE
      ?? DEFAULT_SMOKE_EVIDENCE);
    checkSmokeEvidence(smokeEvidencePath, expectedVkHash, setup);

    const rootBootstrapEvidencePath = normalizeString(
        args.rootBootstrapEvidence
      ?? process.env.FSUSBLOG_ZK_ROOT_BOOTSTRAP_EVIDENCE
      ?? DEFAULT_ROOT_BOOTSTRAP_EVIDENCE);
    checkRootBootstrapEvidence(rootBootstrapEvidencePath, expectedVkHash, setup);

}

function checkCommentPrivacyCredentialVault()
{
    const validation = validateCommentPrivacyCredentialVault(ROOT);
    for (const error of validation.errors)
    {
        errors.push(`comment privacy credential vault: ${error}`);
    }
    checks.push(...validation.checks);
}

function checkNativeVerifierLibrary(rawPath)
{
    if (rawPath === 'managed:mcl')
    {
        checks.push({
            id: 'native-verifier-library',
            status: 'ok',
            detail: 'managed:mcl'
        });
        return rawPath;
    }

    return checkExistingFile('native-verifier-library', rawPath);
}

function checkTrue(key, value)
{
    if (readBool(value) !== true)
    {
        errors.push(`${key} must be true when ZkProd is enabled.`);
        return;
    }

    checks.push({ id: key, status: 'ok', detail: 'true' });
}

function checkExistingFile(id, rawPath)
{
    if (!rawPath)
    {
        errors.push(`${id} path is required when ZkProd is enabled.`);
        return null;
    }

    const absolute = resolveRepoPath(rawPath);
    if (!existsSync(absolute))
    {
        errors.push(`${id} is missing: ${rawPath}`);
        return null;
    }

    checks.push({ id, status: 'ok', path: toRepoRelative(absolute), sha256: sha256File(absolute) });
    return absolute;
}

function checkTrustedSetupManifest(rawPath)
{
    const absolute = checkExistingFile('trusted-setup-manifest', rawPath);
    if (!absolute)
    {
        return null;
    }

    const manifest = JSON.parse(readFileSync(absolute, 'utf8'));
    Object.defineProperty(manifest, '__absolutePath', { value: absolute });
    if (manifest.circuit_id !== 'fsus.anonymous.comment.v5')
    {
        errors.push('trusted setup manifest circuit_id must be fsus.anonymous.comment.v5.');
    }
    if (Number(manifest.public_input_layout_version) !== 6)
    {
        errors.push('trusted setup manifest public_input_layout_version must be 6.');
    }
    if (manifest.production_usable !== true)
    {
        errors.push('trusted setup manifest must be production_usable=true when ZkProd is enabled.');
    }
    if (!normalizeString(manifest.verifying_key_hash))
    {
        errors.push('trusted setup manifest verifying_key_hash is required when ZkProd is enabled.');
    }
    if (['vk-sha256', 'placeholder', 'TODO', 'TBD'].includes(normalizeString(manifest.verifying_key_hash)))
    {
        errors.push('trusted setup manifest verifying_key_hash must not be a placeholder.');
    }

    checks.push({ id: 'trusted-setup-binding', status: errors.length === 0 ? 'ok' : 'checked' });
    return manifest;
}

function checkSmokeEvidence(rawPath, expectedVkHash, setup)
{
    const absolute = checkExistingFile('zk-prod-smoke-evidence', rawPath);
    if (!absolute)
    {
        return null;
    }

    const evidence = JSON.parse(readFileSync(absolute, 'utf8'));
    const evidenceStatus = normalizeString(evidence.status);
    if (!['ok', 'passed', 'success'].includes(evidenceStatus))
    {
        errors.push('ZK-Prod smoke evidence status must be ok/passed/success.');
    }

    for (const key of [
        'nativeVerifier',
        'wasmProver',
        'credential',
        'credentialRootActive',
        'ticketIssued',
        'anonymousSubmitPending',
        'identityHeadersOmitted',
        'sensitivePayloadRedacted'
    ])
    {
        if (evidence[key] !== true)
        {
            errors.push(`ZK-Prod smoke evidence requires ${key}=true.`);
        }
    }

    checkRealGroth16SmokeEvidence(evidence, expectedVkHash, setup);
    checkNoSensitiveEvidence(evidence);
    checks.push({ id: 'zk-prod-smoke-evidence', status: 'checked', path: toRepoRelative(absolute) });
    return evidence;
}

function checkRealGroth16SmokeEvidence(evidence, expectedVkHash, setup)
{
    if (normalizeString(evidence.evidenceKind) !== REAL_EVIDENCE_KIND)
    {
        errors.push(`ZK-Prod smoke evidence must declare evidenceKind=${REAL_EVIDENCE_KIND}.`);
    }
    if (normalizeString(evidence.circuitId) !== 'fsus.anonymous.comment.v5')
    {
        errors.push('ZK-Prod smoke evidence circuitId must be fsus.anonymous.comment.v5.');
    }
    if (Number(evidence.publicInputLayoutVersion) !== 6)
    {
        errors.push('ZK-Prod smoke evidence publicInputLayoutVersion must be 6.');
    }
    if (normalizeString(evidence.proofSystem) !== 'Groth16')
    {
        errors.push('ZK-Prod smoke evidence proofSystem must be Groth16.');
    }

    const evidenceVkHash = normalizeString(evidence.verifyingKeyHash).toLowerCase();
    if (!isSha256Hex(evidenceVkHash))
    {
        errors.push('ZK-Prod smoke evidence verifyingKeyHash must be a 64-char hex SHA-256 digest.');
    }
    if (expectedVkHash && evidenceVkHash && evidenceVkHash !== expectedVkHash.toLowerCase())
    {
        errors.push('ZK-Prod smoke evidence verifyingKeyHash does not match production configuration.');
    }

    const trustedVkHash = normalizeString(setup?.verifying_key_hash).toLowerCase();
    if (trustedVkHash && evidenceVkHash && evidenceVkHash !== trustedVkHash)
    {
        errors.push('ZK-Prod smoke evidence verifyingKeyHash does not match trusted setup manifest.');
    }

    const artifactHashes = evidence.artifactHashes && typeof evidence.artifactHashes === 'object' && !Array.isArray(evidence.artifactHashes)
        ? evidence.artifactHashes
        : {};
    for (const key of REQUIRED_ARTIFACT_HASHES)
    {
        const value = normalizeString(artifactHashes[key]).toLowerCase();
        if (!isSha256Hex(value))
        {
            errors.push(`ZK-Prod smoke evidence artifactHashes.${key} must be a 64-char hex SHA-256 digest.`);
        }
    }
    const artifactVkHash = normalizeString(artifactHashes.verifyingKeySha256).toLowerCase();
    if (isSha256Hex(evidenceVkHash) && isSha256Hex(artifactVkHash) && artifactVkHash !== evidenceVkHash)
    {
        errors.push('ZK-Prod smoke evidence artifactHashes.verifyingKeySha256 must match verifyingKeyHash.');
    }

    validateEvidenceArtifacts(evidence.artifacts, artifactHashes, 'ZK-Prod smoke evidence');

    const crossStack = evidence.crossStack && typeof evidence.crossStack === 'object' && !Array.isArray(evidence.crossStack)
        ? evidence.crossStack
        : {};
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
            errors.push(`ZK-Prod smoke evidence crossStack.${key}=true is required.`);
        }
    }
    if (evidence.hashingFixtureUsed === true || crossStack.hashingFixtureUsed === true)
    {
        errors.push('ZK-Prod smoke evidence must not use hashingFixtureUsed=true.');
    }
    if (!Number.isSafeInteger(Number(crossStack.sampledScopes)) || Number(crossStack.sampledScopes) < 100)
    {
        errors.push('ZK-Prod smoke evidence crossStack.sampledScopes must be at least 100.');
    }

    const performance = evidence.performance && typeof evidence.performance === 'object' && !Array.isArray(evidence.performance)
        ? evidence.performance
        : {};
    const wasmProverP95Ms = Number(performance.wasmProverP95Ms);
    if (!Number.isFinite(wasmProverP95Ms) || wasmProverP95Ms <= 0 || wasmProverP95Ms > WASM_PROVER_P95_MS_MAX)
    {
        errors.push(`ZK-Prod smoke evidence performance.wasmProverP95Ms must be in 1..${WASM_PROVER_P95_MS_MAX}.`);
    }
    const nativeVerifierP99Ms = Number(performance.nativeVerifierP99Ms);
    if (!Number.isFinite(nativeVerifierP99Ms) || nativeVerifierP99Ms <= 0 || nativeVerifierP99Ms > NATIVE_VERIFIER_P99_MS_MAX)
    {
        errors.push(`ZK-Prod smoke evidence performance.nativeVerifierP99Ms must be in 1..${NATIVE_VERIFIER_P99_MS_MAX}.`);
    }
}

function validateEvidenceArtifacts(artifacts, artifactHashes, label)
{
    const source = artifacts && typeof artifacts === 'object' && !Array.isArray(artifacts)
        ? artifacts
        : {};
    for (const [artifactName, hashKey] of REQUIRED_EVIDENCE_ARTIFACTS)
    {
        const entry = source[artifactName] && typeof source[artifactName] === 'object' && !Array.isArray(source[artifactName])
            ? source[artifactName]
            : {};
        const rawPath = normalizeString(entry.path);
        const declaredSha = normalizeString(entry.sha256).toLowerCase();

        if (!rawPath)
        {
            errors.push(`${label} artifacts.${artifactName}.path is required.`);
            continue;
        }
        if (!isSha256Hex(declaredSha))
        {
            errors.push(`${label} artifacts.${artifactName}.sha256 must be a 64-char hex SHA-256 digest.`);
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

function checkRootBootstrapEvidence(rawPath, expectedVkHash, setup)
{
    const absolute = checkExistingFile('root-bootstrap-evidence', rawPath);
    if (!absolute)
    {
        return;
    }

    const evidence = JSON.parse(readFileSync(absolute, 'utf8'));
    if (evidence.schema !== 'fsusblog.anonymous-credential-root-bootstrap-evidence.v1')
    {
        errors.push('root-bootstrap-evidence schema is invalid.');
    }
    const status = normalizeString(evidence.status);
    if (status !== 'rotated')
    {
        errors.push('root-bootstrap-evidence status must be rotated when ZkProd is enabled.');
    }
    if (evidence.stagingDbRotateSatisfied !== true)
    {
        errors.push('root-bootstrap-evidence requires stagingDbRotateSatisfied=true when ZkProd is enabled.');
    }
    const highValueAudit = evidence.highValueAudit && typeof evidence.highValueAudit === 'object'
        ? evidence.highValueAudit
        : {};
    if (highValueAudit.action !== 'security.anonymous_credential.root_rotated' || highValueAudit.isHighValue !== true)
    {
        errors.push('root-bootstrap-evidence must include high-value root_rotated audit evidence.');
    }

    const snapshot = evidence.rootSnapshot && typeof evidence.rootSnapshot === 'object'
        ? evidence.rootSnapshot
        : {};
    if (snapshot.circuitId !== 'fsus.anonymous.comment.v5')
    {
        errors.push('root-bootstrap-evidence circuitId must be fsus.anonymous.comment.v5.');
    }
    if (Number(snapshot.publicInputLayoutVersion) !== 6)
    {
        errors.push('root-bootstrap-evidence publicInputLayoutVersion must be 6.');
    }
    if (!Number.isSafeInteger(Number(snapshot.epoch)) || Number(snapshot.epoch) <= 0)
    {
        errors.push('root-bootstrap-evidence epoch must be a positive integer.');
    }
    if (!Number.isSafeInteger(Number(snapshot.circuitNumericId)) || Number(snapshot.circuitNumericId) <= 0)
    {
        errors.push('root-bootstrap-evidence circuitNumericId must be a positive integer.');
    }

    for (const key of ['credentialRootHash', 'revocationRootHash', 'issuerPublicKeyHash', 'verifyingKeyHash'])
    {
        const value = normalizeString(snapshot[key]).toLowerCase();
        if (!isSha256Hex(value))
        {
            errors.push(`root-bootstrap-evidence ${key} must be a 64-char hex SHA-256 digest.`);
        }
    }

    const evidenceVkHash = normalizeString(snapshot.verifyingKeyHash).toLowerCase();
    const trustedVkHash = normalizeString(setup?.verifying_key_hash).toLowerCase();
    if (expectedVkHash && evidenceVkHash && evidenceVkHash !== expectedVkHash.toLowerCase())
    {
        errors.push('root-bootstrap-evidence verifyingKeyHash does not match production configuration.');
    }
    if (trustedVkHash && evidenceVkHash && evidenceVkHash !== trustedVkHash)
    {
        errors.push('root-bootstrap-evidence verifyingKeyHash does not match trusted setup manifest.');
    }

    const expiresAt = parseTimestamp(snapshot.expiresAtUtc);
    const graceExpiresAt = parseTimestamp(snapshot.graceExpiresAtUtc);
    if (!expiresAt)
    {
        errors.push('root-bootstrap-evidence expiresAtUtc must be an ISO-8601 UTC timestamp.');
    }
    if (!graceExpiresAt)
    {
        errors.push('root-bootstrap-evidence graceExpiresAtUtc must be an ISO-8601 UTC timestamp.');
    }
    if (expiresAt && graceExpiresAt && expiresAt >= graceExpiresAt)
    {
        errors.push('root-bootstrap-evidence expiresAtUtc must be earlier than graceExpiresAtUtc.');
    }
    if (graceExpiresAt && graceExpiresAt <= new Date())
    {
        errors.push('root-bootstrap-evidence graceExpiresAtUtc must be in the future.');
    }

    checkNoSensitiveEvidence(evidence);
    checks.push({
        id: 'root-bootstrap-evidence',
        status: 'checked',
        path: toRepoRelative(absolute),
        stagingDbRotateSatisfied: evidence.stagingDbRotateSatisfied === true
    });
}

function checkNoSensitiveEvidence(value, pathSegments = [])
{
    if (Array.isArray(value))
    {
        value.forEach((item, index) => checkNoSensitiveEvidence(item, [...pathSegments, String(index)]));
        return;
    }

    if (!value || typeof value !== 'object')
    {
        return;
    }

    for (const [key, child] of Object.entries(value))
    {
        const fullPath = [...pathSegments, key].join('.');
        if (isSensitiveEvidenceKey(key))
        {
            errors.push(`ZK-Prod smoke evidence must not include sensitive field: ${fullPath}`);
        }

        checkNoSensitiveEvidence(child, [...pathSegments, key]);
    }
}

function isSensitiveEvidenceKey(key)
{
    return /(?:credentialSecret|credential_secret|issuerSignature|issuer_signature|credentialOpening|credential_opening|revocationWitness|revocation_witness|proofBytes|proof_bytes|rawProof|raw_proof|nullifierSecret|nullifier_secret|credentialLevel|credential_level|credentialEpoch|credential_epoch|reputationBucket|reputation_bucket|accountAgeBucket|account_age_bucket|memberIds|member_ids)/u.test(key);
}

function checkRollbackDocument()
{
    const candidates = [
        'docs/security.md',
        'docs/anonymous-identity-smoke-flow.md'
    ];
    const content = candidates
        .filter((file) => existsSync(resolveRepoPath(file)))
        .map((file) => readFileSync(resolveRepoPath(file), 'utf8'))
        .join('\n');
    const hasRollback = content.includes('check:privacy-zk-prod-release') &&
    content.includes('AnonymousIdentity:ZkCommentPolicy:Enabled=false') &&
    content.includes('不删除已写入的匿名评论');
    if (!hasRollback)
    {
        errors.push('ZK-Prod rollback documentation must include the release gate command, disable flag, and data-preserving rollback note.');
        return;
    }

    checks.push({ id: 'zk-prod-rollback-doc', status: 'ok' });
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
        else if (token === '--trusted-setup-manifest')
        {
            parsed.trustedSetupManifest = requireValue(argv, ++i, token);
        }
        else if (token === '--smoke-evidence')
        {
            parsed.smokeEvidence = requireValue(argv, ++i, token);
        }
        else if (token === '--root-bootstrap-evidence')
        {
            parsed.rootBootstrapEvidence = requireValue(argv, ++i, token);
        }
        else if (token === '--summary')
        {
            parsed.summary = requireValue(argv, ++i, token);
        }
        else if (token === '--require-enabled')
        {
            parsed.requireEnabled = true;
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
    return JSON.parse(stripJsonComments(readFileSync(file, 'utf8')));
}

function stripJsonComments(source)
{
    let output = '';
    let inString = false;
    let escaped = false;
    let lineComment = false;
    let blockComment = false;
    for (let i = 0; i < source.length; i += 1)
    {
        const ch = source[i];
        const next = source[i + 1];
        if (lineComment)
        {
            if (ch === '\n')
            {
                lineComment = false;
                output += ch;
            }
            continue;
        }
        if (blockComment)
        {
            if (ch === '*' && next === '/')
            {
                blockComment = false;
                i += 1;
            }
            continue;
        }
        if (!inString && ch === '/' && next === '/')
        {
            lineComment = true;
            i += 1;
            continue;
        }
        if (!inString && ch === '/' && next === '*')
        {
            blockComment = true;
            i += 1;
            continue;
        }
        output += ch;
        if (inString)
        {
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
        }
        else if (ch === '"')
        {
            inString = true;
        }
    }
    return output;
}

function deepMerge(target, source)
{
    if (!source || typeof source !== 'object' || Array.isArray(source))
    {
        return target;
    }
    const result = { ...target };
    for (const [key, value] of Object.entries(source))
    {
        if (value && typeof value === 'object' && !Array.isArray(value))
        {
            result[key] = deepMerge(result[key] ?? {}, value);
        }
        else
        {
            result[key] = value;
        }
    }
    return result;
}

function readSection(source, segments)
{
    let current = source;
    for (const segment of segments)
    {
        if (!current || typeof current !== 'object')
        {
            return {};
        }
        current = current[segment];
    }
    return current && typeof current === 'object' ? current : {};
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
        if (['true', '1', 'yes', 'enabled'].includes(normalized))
        {
            return true;
        }
        if (['false', '0', 'no', 'disabled', ''].includes(normalized))
        {
            return false;
        }
    }
    return null;
}

function readBoolEnv(key)
{
    return Object.hasOwn(process.env, key) ? readBool(process.env[key]) : null;
}

function normalizeString(value)
{
    return typeof value === 'string' ? value.trim() : '';
}

function isSha256Hex(value)
{
    return /^[0-9a-f]{64}$/u.test(value);
}

function parseTimestamp(value)
{
    const text = normalizeString(value);
    if (!text || !text.endsWith('Z'))
    {
        return null;
    }
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? null : date;
}

function resolveRepoPath(candidate)
{
    return path.isAbsolute(candidate) ? candidate : path.resolve(ROOT, candidate);
}

function toRepoRelative(candidate)
{
    return path.relative(ROOT, candidate).replaceAll(path.sep, '/');
}

function sha256File(file)
{
    return createHash('sha256').update(readFileSync(file)).digest('hex');
}
