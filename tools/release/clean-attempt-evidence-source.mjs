import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const inputSchema = 'fsusblog.clean-attempt-evidence-input.v1';
const inputFields = Object.freeze([
    'schema',
    'consumerId',
    'membership',
    'expected',
    'evidenceRoot',
    'authorityRoot',
    'authorityReferences',
    'authorityVerificationReceipts',
    'aggregateReference',
    'domainReceiptReference',
    'expectedIdentity',
    'transport'
]);

function assert(condition, message, reasonCode = 'attempt.external-authority-unverified')
{
    if (!condition)
    {
        const error = new Error(message);
        error.reasonCode = reasonCode;
        throw error;
    }
}

function digestFile(file)
{
    return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function canonicalRoot(value, label)
{
    assert(typeof value === 'string' && value.trim(), `${label} is required`);
    const requested = path.resolve(value);
    assert(fs.existsSync(requested), `${label} is missing: ${requested}`,
        'attempt.evidence-source-invalid');
    const resolved = fs.realpathSync(requested);
    const stat = fs.lstatSync(resolved);
    assert(stat.isDirectory() && !stat.isSymbolicLink() && fs.realpathSync(resolved) === resolved,
        `${label} must be a real directory`, 'attempt.evidence-source-invalid');
    return resolved;
}

function safeRelative(value, label)
{
    const normalized = String(value ?? '').replaceAll('\\', '/');
    assert(normalized.length > 0
        && !path.posix.isAbsolute(normalized)
        && path.posix.normalize(normalized) === normalized
        && !normalized.split('/').some((segment) => segment === '.' || segment === '..'),
    `${label} must be a canonical relative path`, 'attempt.evidence-source-invalid');
    return normalized;
}

function regularFile(root, relative, label)
{
    const normalized = safeRelative(relative, label);
    const file = path.resolve(root, normalized);
    assert(file.startsWith(`${root}${path.sep}`), `${label} escapes its root`,
        'attempt.evidence-source-invalid');
    assert(fs.existsSync(file), `${label} is missing: ${normalized}`,
        'attempt.external-authority-unverified');
    const stat = fs.lstatSync(file);
    assert(stat.isFile() && !stat.isSymbolicLink() && fs.realpathSync(file) === file,
        `${label} must be one real regular file: ${normalized}`,
        'attempt.external-authority-unverified');
    return { file, relative: normalized, digest: digestFile(file) };
}

function exactKeys(value, expected, label)
{
    assert(value !== null && typeof value === 'object' && !Array.isArray(value),
        `${label} must be an object`, 'attempt.evidence-source-invalid');
    assert(JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort()),
        `${label} fields are not exact`, 'attempt.evidence-source-invalid');
}

function requiredDigest(value, label)
{
    assert(digestPattern.test(String(value ?? '')), `${label} must be a SHA-256 digest`,
        'attempt.evidence-source-invalid');
    return value;
}

function requiredText(value, label)
{
    assert(typeof value === 'string' && value.trim(), `${label} is required`,
        'attempt.evidence-source-invalid');
    return value.trim();
}

function validateIdentity(identity)
{
    exactKeys(identity, [
        'sourceCommit',
        'worktreeFingerprint',
        'schedulerRunId',
        'producerId'
    ], 'expectedIdentity');
    assert(/^[0-9a-f]{40}$/u.test(identity.sourceCommit),
        'expectedIdentity.sourceCommit is invalid', 'attempt.evidence-source-invalid');
    requiredDigest(identity.worktreeFingerprint, 'expectedIdentity.worktreeFingerprint');
    requiredText(identity.schedulerRunId, 'expectedIdentity.schedulerRunId');
    requiredText(identity.producerId, 'expectedIdentity.producerId');
    return Object.freeze({ ...identity });
}

function validateReference(reference, label)
{
    exactKeys(reference, ['path', 'digest', 'fileDigest'], label);
    return Object.freeze({
        path: safeRelative(reference.path, `${label}.path`),
        digest: requiredDigest(reference.digest, `${label}.digest`),
        fileDigest: requiredDigest(reference.fileDigest, `${label}.fileDigest`)
    });
}

function validateAuthorityVerification(document, reference, identity, label)
{
    exactKeys(document, [
        'schema',
        'kind',
        'authorityDigest',
        'verificationReceiptDigest',
        'artifactFileDigest',
        'identity',
        'verified'
    ], label);
    assert(document.schema === 'fsusblog.external-authority-verification.v1',
        `${label} schema is invalid`);
    assert(document.kind === reference.kind, `${label} kind crosses authority reference`);
    assert(document.authorityDigest === reference.artifactDigest,
        `${label} authority digest does not match the reference`);
    assert(document.verificationReceiptDigest === reference.verificationReceiptDigest,
        `${label} verification receipt digest does not match the reference`);
    assert(document.verified === true, `${label} is not verified`);
    assert(document.artifactFileDigest === reference.artifactFileDigest,
        `${label} artifact file digest does not match the reference`);
    const verifiedIdentity = validateIdentity(document.identity);
    for (const [field, expected] of Object.entries(identity))
    {
        assert(verifiedIdentity[field] === expected,
            `${label} crosses ${field}`, 'attempt.external-authority-cross-identity');
    }
    return Object.freeze({
        verified: true,
        authorityDigest: reference.artifactDigest,
        verificationReceiptDigest: reference.verificationReceiptDigest,
        identity: verifiedIdentity
    });
}

function validateAuthorityReferences(references, verificationReceipts, authorityRoot, identity)
{
    assert(Array.isArray(references) && references.length === 3,
        'exactly three authority references are required', 'attempt.external-authority-unverified');
    assert(verificationReceipts && typeof verificationReceipts === 'object'
        && !Array.isArray(verificationReceipts),
    'authorityVerificationReceipts must be an object', 'attempt.evidence-source-invalid');
    const normalized = references.map((reference, index) =>
    {
        exactKeys(reference, [
            'kind',
            'artifactPath',
            'artifactDigest',
            'artifactFileDigest',
            'verificationReceiptPath',
            'verificationReceiptDigest'
        ], `authorityReferences[${index}]`);
        requiredText(reference.kind, `authorityReferences[${index}].kind`);
        safeRelative(reference.artifactPath, `authorityReferences[${index}].artifactPath`);
        requiredDigest(reference.artifactDigest, `authorityReferences[${index}].artifactDigest`);
        requiredDigest(reference.artifactFileDigest, `authorityReferences[${index}].artifactFileDigest`);
        safeRelative(reference.verificationReceiptPath,
            `authorityReferences[${index}].verificationReceiptPath`);
        requiredDigest(reference.verificationReceiptDigest,
            `authorityReferences[${index}].verificationReceiptDigest`);
        const verificationReference = verificationReceipts[reference.kind];
        exactKeys(verificationReference, ['path', 'fileDigest'],
            `authorityVerificationReceipts.${reference.kind}`);
        assert(verificationReference.path === reference.verificationReceiptPath,
            `authorityVerificationReceipts.${reference.kind} does not bind its reference`,
            'attempt.evidence-source-invalid');
        requiredDigest(verificationReference.fileDigest,
            `authorityVerificationReceipts.${reference.kind}.fileDigest`);
        const artifact = regularFile(authorityRoot, reference.artifactPath,
            `authorityReferences[${index}].artifactPath`);
        assert(artifact.digest === reference.artifactFileDigest,
            `authority artifact bytes changed: ${reference.artifactPath}`,
            'attempt.external-authority-unverified');
        const receipt = regularFile(authorityRoot, verificationReference.path,
            `authorityReferences[${index}].verificationReceiptPath`);
        assert(receipt.digest === verificationReference.fileDigest,
            `authority verification receipt bytes changed: ${reference.verificationReceiptPath}`,
            'attempt.external-authority-unverified');
        let document;
        try
        {
            document = JSON.parse(fs.readFileSync(receipt.file, 'utf8'));
        }
        catch (error)
        {
            throw new Error(`authority verification receipt is not valid JSON: ${reference.verificationReceiptPath}`, { cause: error });
        }
        const verification = validateAuthorityVerification(
            document,
            reference,
            identity,
            `authority verification ${reference.kind}`
        );
        return Object.freeze({
            ...reference,
            artifactPath: safeRelative(reference.artifactPath, 'artifactPath'),
            verificationReceiptPath: safeRelative(reference.verificationReceiptPath, 'verificationReceiptPath'),
            verification
        });
    }).sort((left, right) => left.kind.localeCompare(right.kind));
    assert(JSON.stringify(normalized.map((reference) => reference.kind))
        === JSON.stringify(['execution-envelope', 'replay-plan', 'temporal-context']),
    'authority references must contain the exact three authority kinds',
    'attempt.external-authority-unverified');
    return Object.freeze(normalized);
}

function validateInput(document)
{
    exactKeys(document, inputFields, 'clean-attempt evidence input');
    assert(document.schema === inputSchema, `evidence input schema must be ${inputSchema}`,
        'attempt.evidence-source-invalid');
    requiredText(document.consumerId, 'consumerId');
    assert(document.membership && typeof document.membership === 'object'
        && !Array.isArray(document.membership),
    'membership must be an object', 'attempt.evidence-source-invalid');
    assert(document.expected && typeof document.expected === 'object'
        && !Array.isArray(document.expected),
    'expected must be an object', 'attempt.evidence-source-invalid');
    const identity = validateIdentity(document.expectedIdentity);
    return { identity, consumerId: document.consumerId };
}

export function readCleanAttemptEvidenceSource(file, { repositoryRoot = defaultRoot } = {})
{
    const root = canonicalRoot(repositoryRoot, 'repositoryRoot');
    const requestedFile = path.resolve(root, file);
    assert(requestedFile.startsWith(`${root}${path.sep}`),
        'clean-attempt evidence input escapes repository', 'attempt.evidence-source-invalid');
    const sourceFile = regularFile(
        root,
        path.relative(root, requestedFile),
        'clean-attempt evidence input'
    );
    let document;
    try
    {
        document = JSON.parse(fs.readFileSync(sourceFile.file, 'utf8'));
    }
    catch (error)
    {
        throw new Error(`clean-attempt evidence input is not valid JSON: ${sourceFile.relative}`, { cause: error });
    }
    const { identity, consumerId } = validateInput(document);
    const evidenceRoot = canonicalRoot(
        path.resolve(root, document.evidenceRoot),
        'evidenceRoot'
    );
    const authorityRoot = canonicalRoot(
        path.resolve(root, document.authorityRoot),
        'authorityRoot'
    );
    const authorityReferences = validateAuthorityReferences(
        document.authorityReferences,
        document.authorityVerificationReceipts,
        authorityRoot,
        identity
    );
    const aggregateReference = validateReference(document.aggregateReference, 'aggregateReference');
    const domainReceiptReference = validateReference(
        document.domainReceiptReference,
        'domainReceiptReference'
    );
    const transport = document.transport === null
        ? null
        : (() =>
        {
            exactKeys(document.transport, [
                'repositoryRoot',
                'transportManifestPath',
                'authorityId',
                'referencePath'
            ], 'transport');
            return Object.freeze({
                repositoryRoot: canonicalRoot(
                    path.resolve(root, document.transport.repositoryRoot),
                    'transport.repositoryRoot'
                ),
                transportManifestPath: safeRelative(
                    document.transport.transportManifestPath,
                    'transport.transportManifestPath'
                ),
                authorityId: requiredText(document.transport.authorityId, 'transport.authorityId'),
                referencePath: document.transport.referencePath === null
                    ? null
                : safeRelative(document.transport.referencePath, 'transport.referencePath')
            });
        })();
    if (!transport)
    {
        const aggregate = regularFile(evidenceRoot, aggregateReference.path, 'aggregateReference');
        assert(aggregate.digest === aggregateReference.fileDigest,
            'aggregate receipt bytes changed', 'attempt.evidence-source-invalid');
        let aggregateDocument;
        try
        {
            aggregateDocument = JSON.parse(fs.readFileSync(aggregate.file, 'utf8'));
        }
        catch (error)
        {
            throw new Error('aggregateReference is not valid JSON', { cause: error });
        }
        const firstAttemptPath = aggregateDocument?.attempts?.[0]?.path;
        assert(typeof firstAttemptPath === 'string' && firstAttemptPath,
            'aggregateReference does not expose its first attempt path',
            'attempt.evidence-source-invalid');
        const attemptRoot = path.dirname(path.resolve(path.dirname(aggregate.file), safeRelative(firstAttemptPath,
            'aggregate first attempt path')));
        assert(attemptRoot.startsWith(`${evidenceRoot}${path.sep}`),
            'aggregate first attempt path escapes evidenceRoot', 'attempt.evidence-source-invalid');
        const domainReceipt = regularFile(attemptRoot, domainReceiptReference.path,
            'domainReceiptReference');
        assert(domainReceipt.digest === domainReceiptReference.fileDigest,
            'domain receipt bytes changed', 'attempt.evidence-source-invalid');
    }
    const evidence = {
        consumerId,
        membership: Object.freeze(structuredClone(document.membership)),
        expected: Object.freeze(structuredClone(document.expected)),
        evidenceRoot,
        aggregateReference,
        domainReceiptReference,
        authorityReferences: authorityReferences.map(({
            verification: _verification,
            artifactFileDigest: _artifactFileDigest,
            ...reference
        }) => reference),
        expectedIdentity: identity,
        verifyAuthority: (reference) =>
        {
            const candidate = authorityReferences.find((item) => item.kind === reference.kind);
            assert(candidate && candidate.artifactDigest === reference.artifactDigest
                && candidate.verificationReceiptDigest === reference.verificationReceiptDigest,
            `authority ${reference.kind} does not match its source manifest`,
            'attempt.external-authority-unverified');
            return candidate.verification;
        }
    };
    if (transport)
    {
        evidence.transport = transport;
    }
    return Object.freeze(evidence);
}

export function loadConfiguredCleanAttemptEvidence({
    repositoryRoot = defaultRoot,
    environment = process.env
} = {})
{
    const configured = String(environment.FSUSBLOG_CLEAN_ATTEMPT_EVIDENCE ?? '').trim();
    if (!configured)
    {
        return null;
    }
    return readCleanAttemptEvidenceSource(configured, { repositoryRoot });
}

export const cleanAttemptEvidenceInputSchema = inputSchema;
