import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const {evidenceContentDigest, evidenceProducerReceiptDigest} = await import(new URL('../test/current-run-evidence-locator.mjs', import.meta.url));
const {validateEvidenceTransportManifest} = await import(new URL('../test/current-run-evidence-transport.mjs', import.meta.url));
const {aggregateAttemptReceiptSchema} = await import(new URL('../test/attempt-provenance.mjs', import.meta.url));
const referenceSchema = 'fsusblog.current-run-evidence-reference.v1';
const digestPattern = /^sha256:[0-9a-f]{64}$/u;

function canonicalize(value)
{
    if (Array.isArray(value))
    {
        return value.map(canonicalize);
    }
    if (!value || typeof value !== 'object')
    {
        return value;
    }
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function sameIdentity(left, right)
{
    return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function assert(condition, message, details = {}, reasonCode = 'attempt.transport-manifest-invalid')
{
    if (!condition)
    {
        const error = new Error(message);
        Object.assign(error, details, { reasonCode });
        throw error;
    }
}

function digestFile(file)
{
    return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function safeRelative(value, label)
{
    const normalized = String(value ?? '').replaceAll('\\', '/');
    assert(normalized.length > 0
        && !path.posix.isAbsolute(normalized)
        && path.posix.normalize(normalized) === normalized
        && !normalized.split('/').some((segment) => segment === '.' || segment === '..'),
    `${label} must be a safe repository-relative path`);
    return normalized;
}

function regularFile(repositoryRoot, relative, label)
{
    const normalized = safeRelative(relative, label);
    const file = path.resolve(repositoryRoot, normalized);
    assert(file === repositoryRoot || file.startsWith(`${repositoryRoot}${path.sep}`),
        `${label} escapes the repository`);
    assert(fs.existsSync(file), `${label} is missing: ${normalized}`);
    const stat = fs.lstatSync(file);
    assert(stat.isFile() && !stat.isSymbolicLink() && fs.realpathSync(file) === file,
        `${label} must be one real regular file: ${normalized}`);
    return { file, relative: normalized };
}

function readJson(repositoryRoot, relative, label)
{
    const resolved = regularFile(repositoryRoot, relative, label);
    const bytes = fs.readFileSync(resolved.file);
    let document;
    try
    {
        document = JSON.parse(bytes.toString('utf8'));
    }
    catch (error)
    {
        throw new Error(`${label} is not valid JSON: ${resolved.relative}`, { cause: error });
    }
    return { ...resolved, bytes, document, digest: digestFile(resolved.file) };
}

function assertReference(reference, expectedIdentity = {})
{
    assert(reference?.schema === referenceSchema, 'transport reference schema mismatch');
    assert(digestPattern.test(String(reference.contentDigest ?? ''))
        && reference.contentDigest === evidenceContentDigest(reference),
    'transport reference contentDigest mismatch');
    assert(digestPattern.test(String(reference.producerReceiptDigest ?? ''))
        && reference.producerReceiptDigest === evidenceProducerReceiptDigest(reference),
    'transport reference producerReceiptDigest mismatch');
    for (const field of ['schedulerRunId', 'attemptId', 'sourceCommit', 'worktreeFingerprint'])
    {
        if (expectedIdentity[field] !== undefined)
        {
            assert(reference[field] === expectedIdentity[field],
                `transport reference ${field} mismatch`);
        }
    }
    for (const field of ['candidateIdentity', 'buildIdentity'])
    {
        if (expectedIdentity[field] !== undefined)
        {
            assert(sameIdentity(reference[field], expectedIdentity[field]),
                `transport reference ${field} mismatch`);
        }
    }
    assert(typeof reference.payload?.path === 'string' && reference.payload.path.length > 0,
        'transport reference payload path is required');
    assert(digestPattern.test(String(reference.payload?.digest ?? '')),
        'transport reference payload digest is invalid');
}

function manifestFrom(options)
{
    if (options.transportManifest)
    {
        return validateEvidenceTransportManifest(options.transportManifest);
    }
    assert(typeof options.transportManifestPath === 'string'
        && options.transportManifestPath.length > 0,
    'transportManifestPath is required');
    const manifestFile = regularFile(
        options.repositoryRoot,
        options.transportManifestPath,
        'transport manifest'
    );
    return validateEvidenceTransportManifest(JSON.parse(fs.readFileSync(manifestFile.file, 'utf8')));
}

export function resolveTransportedCleanAttemptEvidence({
    repositoryRoot,
    transportManifestPath,
    transportManifest = null,
    authorityId,
    referencePath = null,
    expectedIdentity = {}
})
{
    const root = fs.realpathSync(path.resolve(repositoryRoot));
    const manifest = manifestFrom({
        repositoryRoot: root,
        transportManifestPath,
        transportManifest
    });
    assert(typeof authorityId === 'string' && authorityId.length > 0,
        'transport authorityId is required');
    const mapped = manifest.objects.filter((object) => object.authorityId === authorityId);
    assert(mapped.length === 1, mapped.length === 0
        ? `transport mapping is missing for ${authorityId}`
        : `duplicate transport mapping for ${authorityId}`);
    const object = mapped[0];
    const entries = object.archiveEntries.map((entry) => ({
        path: safeRelative(entry.path, 'transport archive entry'),
        extractedPath: safeRelative(entry.extractedPath, 'transport extracted entry'),
        digest: entry.digest
    }));
    const byOriginal = new Map(entries.map((entry) => [entry.path, entry]));
    const byExtracted = new Map(entries.map((entry) => [entry.extractedPath, entry]));
    for (const entry of entries)
    {
        const extracted = regularFile(root, entry.extractedPath, 'transport extracted entry');
        assert(digestFile(extracted.file) === entry.digest,
            `transport extracted entry digest mismatch: ${entry.extractedPath}`, {},
            'attempt.transport-content-tamper');
    }
    const selectedReferencePath = referencePath ?? object.extractedPath;
    const referenceEntry = byExtracted.get(safeRelative(selectedReferencePath, 'transport reference'))
        ?? byOriginal.get(safeRelative(selectedReferencePath, 'transport reference'));
    assert(referenceEntry, 'transport reference is not present in the mapped archive');
    const reference = readJson(root, referenceEntry.extractedPath, 'transport reference').document;
    assertReference(reference, expectedIdentity);
    assert(reference.authorityId === authorityId, 'transport reference authorityId mismatch');
    assert(referenceEntry.digest === object.objectDigest
        && referenceEntry.digest === object.originalRef.inputDigest,
    'transport reference digest does not match the manifest object');
    const payloadEntry = byOriginal.get(safeRelative(reference.payload.path, 'transport payload'))
        ?? byExtracted.get(safeRelative(reference.payload.path, 'transport payload'));
    assert(payloadEntry, `transport payload is not present in the mapped archive: ${reference.payload.path}`);
    const payload = readJson(root, payloadEntry.extractedPath, 'transport payload');
    assert(payload.digest === reference.payload.digest,
        'transport payload digest does not match the reference receipt', {},
        'attempt.transport-content-tamper');
    assert(payload.document?.schema === aggregateAttemptReceiptSchema,
        `transport payload schema must be ${aggregateAttemptReceiptSchema}`);
    for (const [field, expected] of Object.entries(expectedIdentity))
    {
        if (expected !== undefined && payload.document[field] !== expected)
        {
            throw new Error(`transport aggregate ${field} mismatch`);
        }
    }
    return Object.freeze({
        evidenceRoot: root,
        aggregateReference: Object.freeze({
            path: payloadEntry.extractedPath,
            digest: payload.document.contentDigest,
            fileDigest: payload.digest
        }),
        transportEntries: Object.freeze(entries.map((entry) => Object.freeze(entry))),
        transportManifest: manifest,
        transportObject: object,
        reference: Object.freeze(reference),
        aggregateReceipt: Object.freeze(payload.document)
    });
}
