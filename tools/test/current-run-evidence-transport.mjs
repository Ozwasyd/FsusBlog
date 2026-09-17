import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
    locateCurrentRunEvidence,
    verifyCurrentRunEvidenceBinding
} from './current-run-evidence-locator.mjs';
import {
    governanceContentDigest,
    validateCurrentRunEvidenceContext,
    validateEvidenceLocatorRegistry
} from './evidence-location-contract.mjs';

export const EVIDENCE_TRANSPORT_MANIFEST_SCHEMA = 'fsusblog.current-run-evidence-transport-manifest.v1';
export const EVIDENCE_TRANSPORT_ARCHIVE_SCHEMA = 'fsusblog.current-run-evidence-transport-archive.v1';
export const EVIDENCE_CONSUMER_RECEIPT_SCHEMA = 'fsusblog.current-run-evidence-consumer-receipt.v1';
export const EVIDENCE_TRANSPORT_MANIFEST_ENV = 'FSUSBLOG_EVIDENCE_TRANSPORT_MANIFEST';
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const unsafePath = /(?:^|\/)(?:\.\.?)(?:\/|$)|^[\\/]|[*?[\]{}!\0]/u;

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

function digestBytes(bytes)
{
    return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function digestFile(file)
{
    return digestBytes(fs.readFileSync(file));
}

function digestValue(value)
{
    return `sha256:${crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')}`;
}

function sealed(document)
{
    return { ...document, contentDigest: governanceContentDigest(document) };
}

function assert(condition, message)
{
    if (!condition)
    {
        throw new Error(message);
    }
}

function assertDigest(value, field)
{
    assert(digestPattern.test(value ?? ''), `${field} must be a sha256 digest`);
}

function sameIdentity(left, right)
{
    return digestValue({ value: left }) === digestValue({ value: right });
}

function assertSafeRelativePath(relative, label)
{
    const normalized = String(relative ?? '').replaceAll('\\', '/');
    assert(normalized.length > 0, `${label} is required`);
    assert(!path.isAbsolute(normalized) && !unsafePath.test(normalized),
        `${label} is not a safe repository-relative path`);
    return normalized;
}

function assertNotSymlink(file, label)
{
    assert(fs.existsSync(file), `${label} is missing`);
    assert(!fs.lstatSync(file).isSymbolicLink(), `${label} must not be a symlink`);
    assert(fs.statSync(file).isFile(), `${label} is not a file`);
}

function downloadedPath(relative)
{
    return relative.replaceAll('\\', '/').split('/').includes('downloaded-artifacts')
        || relative.replaceAll('\\', '/').includes('.tmp/downloaded-artifacts');
}

function assertOriginIdentity(object, context)
{
    for (const field of ['schedulerRunId', 'attemptId', 'sourceCommit', 'worktreeFingerprint'])
    {
        const expected = field === 'schedulerRunId' ? context.schedulerRunId : context[field];
        const actual = field === 'schedulerRunId' ? object.originRunId : object[field];
        assert(actual === expected, `transport origin ${field} mismatch`);
    }
    for (const field of ['candidateIdentity', 'buildIdentity'])
    {
        assert(sameIdentity(object[field], context[field]), `transport origin ${field} mismatch`);
    }
}

function canonicalObject(object)
{
    return {
        originRunId: object.originRunId,
        attemptId: object.attemptId,
        authorityId: object.authorityId,
        producerId: object.producerId,
        sourceCommit: object.sourceCommit,
        worktreeFingerprint: object.worktreeFingerprint,
        candidateIdentity: object.candidateIdentity,
        buildIdentity: object.buildIdentity,
        receiptSchema: object.receiptSchema,
        originalRef: object.originalRef,
        contentDigest: object.contentDigest,
        producerDigest: object.producerDigest,
        objectDigest: object.objectDigest,
        extractedPath: object.extractedPath,
        archiveEntries: object.archiveEntries
    };
}

export function validateEvidenceTransportManifest(manifest)
{
    assert(manifest?.schema === EVIDENCE_TRANSPORT_MANIFEST_SCHEMA, 'transport manifest schema mismatch');
    assert(typeof manifest.transportRunId === 'string' && manifest.transportRunId.length > 0,
        'transportRunId is required');
    assert(typeof manifest.downloadRunId === 'string' && manifest.downloadRunId.length > 0,
        'downloadRunId is required');
    assertDigest(manifest.archive?.digest, 'archive.digest');
    assert(typeof manifest.archive?.path === 'string' && manifest.archive.path.length > 0,
        'archive.path is required');
    assert(Array.isArray(manifest.archive?.entries) && manifest.archive.entries.length > 0,
        'archive entry list is required');
    assert(Array.isArray(manifest.objects) && manifest.objects.length > 0, 'transport objects are required');
    const authorities = new Set();
    const entryPaths = new Set();
    for (const entry of manifest.archive.entries)
    {
        const relative = assertSafeRelativePath(entry.path, 'archive entry path');
        assert(!entryPaths.has(relative), `duplicate archive entry: ${relative}`);
        entryPaths.add(relative);
        assertDigest(entry.digest, 'archive entry digest');
    }
    for (const object of manifest.objects)
    {
        assert(typeof object.authorityId === 'string' && object.authorityId.length > 0,
            'transport object authorityId is required');
        assert(!authorities.has(object.authorityId),
            `duplicate transport mapping for authority ${object.authorityId}`);
        authorities.add(object.authorityId);
        assert(typeof object.originRunId === 'string' && object.originRunId.length > 0,
            'transport originRunId is required');
        for (const field of ['attemptId', 'producerId', 'sourceCommit', 'worktreeFingerprint', 'receiptSchema',
            'extractedPath'])
        {
            assert(typeof object[field] === 'string' && object[field].length > 0,
                `transport object ${field} is required`);
        }
        assertSafeRelativePath(object.extractedPath, 'extractedPath');
        assert(object.originalRef && typeof object.originalRef.path === 'string',
            'transport original ref is required');
        assertSafeRelativePath(object.originalRef.path, 'originalRef.path');
        for (const field of ['inputDigest', 'contentDigest', 'producerReceiptDigest'])
        {
            assertDigest(object.originalRef[field], `originalRef.${field}`);
        }
        assertDigest(object.contentDigest, 'contentDigest');
        assertDigest(object.producerDigest, 'producerDigest');
        assertDigest(object.objectDigest, 'objectDigest');
        assert(Array.isArray(object.archiveEntries) && object.archiveEntries.length > 0,
            'transport object archiveEntries are required');
        for (const entry of object.archiveEntries)
        {
            const relative = assertSafeRelativePath(entry.path, 'object archive entry path');
            assert(entryPaths.has(relative), `object archive entry is not in the archive: ${relative}`);
            assertDigest(entry.digest, 'object archive entry digest');
            assertSafeRelativePath(entry.extractedPath, 'object extractedPath');
        }
    }
    assert(manifest.contentDigest === governanceContentDigest(manifest),
        'transport manifest contentDigest mismatch');
    return manifest;
}

export function packCurrentRunEvidenceTransport({
    context, objects, repositoryRoot, archivePath, manifestPath, transportRunId, downloadRunId
})
{
    validateCurrentRunEvidenceContext(context);
    assert(Array.isArray(objects) && objects.length > 0, 'transport objects are required');
    const archiveEntries = [];
    const packedObjects = [];
    const authorities = new Set();
    for (const object of objects)
    {
        assert(!authorities.has(object.authorityId),
            `duplicate transport mapping for authority ${object.authorityId}`);
        authorities.add(object.authorityId);
        assertOriginIdentity({
            originRunId: object.originRunId ?? context.schedulerRunId,
            attemptId: object.attemptId ?? context.attemptId,
            sourceCommit: object.sourceCommit ?? context.sourceCommit,
            worktreeFingerprint: object.worktreeFingerprint ?? context.worktreeFingerprint,
            candidateIdentity: object.candidateIdentity ?? context.candidateIdentity,
            buildIdentity: object.buildIdentity ?? context.buildIdentity
        }, context);
        const sourceFiles = object.files ?? [{ path: object.originalRef.path, role: 'receipt' }];
        const objectEntries = [];
        for (const file of sourceFiles)
        {
            const relative = assertSafeRelativePath(file.path, 'transport source path');
            const absolute = path.resolve(repositoryRoot, relative);
            assertNotSymlink(absolute, relative);
            const digest = digestFile(absolute);
            archiveEntries.push({
                path: relative,
                digest,
                bytes: fs.readFileSync(absolute).toString('base64')
            });
            objectEntries.push({ path: relative, digest, extractedPath: relative });
        }
        const receiptPath = object.originalRef.path;
        const receiptAbsolute = path.resolve(repositoryRoot, receiptPath);
        const receiptBytes = fs.readFileSync(receiptAbsolute);
        packedObjects.push(canonicalObject({
            originRunId: context.schedulerRunId,
            attemptId: context.attemptId,
            authorityId: object.authorityId,
            producerId: object.producerId,
            sourceCommit: context.sourceCommit,
            worktreeFingerprint: context.worktreeFingerprint,
            candidateIdentity: context.candidateIdentity,
            buildIdentity: context.buildIdentity,
            receiptSchema: object.receiptSchema,
            originalRef: {
                path: receiptPath,
                inputDigest: digestBytes(receiptBytes),
                contentDigest: object.originalRef.contentDigest,
                producerReceiptDigest: object.originalRef.producerReceiptDigest
            },
            contentDigest: object.originalRef.contentDigest,
            producerDigest: object.originalRef.producerReceiptDigest,
            objectDigest: digestBytes(receiptBytes),
            extractedPath: receiptPath,
            archiveEntries: objectEntries
        }));
    }
    const archiveBody = { schema: EVIDENCE_TRANSPORT_ARCHIVE_SCHEMA, entries: archiveEntries };
    const archiveDocument = sealed(archiveBody);
    const archiveBytes = Buffer.from(`${JSON.stringify(archiveDocument, null, 2)}\n`);
    const archiveRelative = assertSafeRelativePath(archivePath, 'archivePath');
    const archiveAbsolute = path.resolve(repositoryRoot, archiveRelative);
    fs.mkdirSync(path.dirname(archiveAbsolute), { recursive: true });
    fs.writeFileSync(archiveAbsolute, archiveBytes, { flag: 'wx' });
    const manifest = sealed({
        schema: EVIDENCE_TRANSPORT_MANIFEST_SCHEMA,
        transportRunId,
        downloadRunId,
        archive: {
            path: archiveRelative,
            digest: digestBytes(archiveBytes),
            entries: archiveEntries.map((entry) => ({ path: entry.path, digest: entry.digest }))
        },
        objects: packedObjects
    });
    const manifestRelative = assertSafeRelativePath(manifestPath, 'manifestPath');
    const manifestAbsolute = path.resolve(repositoryRoot, manifestRelative);
    fs.mkdirSync(path.dirname(manifestAbsolute), { recursive: true });
    fs.writeFileSync(manifestAbsolute, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    return { archive: archiveDocument, manifest };
}

export function extractCurrentRunEvidenceTransport({
    repositoryRoot, archivePath, manifestPath, extractRoot
})
{
    const manifest = validateEvidenceTransportManifest(JSON.parse(fs.readFileSync(
        path.resolve(repositoryRoot, manifestPath), 'utf8')));
    const archiveAbsolute = path.resolve(repositoryRoot, archivePath || manifest.archive.path);
    assertNotSymlink(archiveAbsolute, 'transport archive');
    const archiveBytes = fs.readFileSync(archiveAbsolute);
    assert(digestBytes(archiveBytes) === manifest.archive.digest, 'transport archive digest mismatch');
    const archive = JSON.parse(archiveBytes.toString('utf8'));
    assert(archive?.schema === EVIDENCE_TRANSPORT_ARCHIVE_SCHEMA, 'transport archive schema mismatch');
    assert(archive.contentDigest === governanceContentDigest(archive),
        'transport archive contentDigest mismatch');
    const expectedEntries = manifest.archive.entries.map((entry) => entry.path).sort();
    const actualEntries = archive.entries.map((entry) => entry.path).sort();
    assert(JSON.stringify(actualEntries) === JSON.stringify(expectedEntries),
        'transport archive entry list mismatch');
    assert(archive.entries.length === expectedEntries.length, 'transport archive cardinality mismatch');
    const destinationRoot = path.resolve(repositoryRoot, extractRoot ?? '.');
    const extractedObjects = [];
    for (const object of manifest.objects)
    {
        const extractedEntries = [];
        for (const entry of object.archiveEntries)
        {
            const packed = archive.entries.find((candidate) => candidate.path === entry.path);
            assert(packed, `transport archive is missing ${entry.path}`);
            const relative = assertSafeRelativePath(entry.extractedPath, 'extractedPath');
            const destination = path.resolve(destinationRoot, relative);
            assert(destination === destinationRoot || destination.startsWith(`${destinationRoot}${path.sep}`),
                'transport extract path escapes extract root');
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            const bytes = Buffer.from(packed.bytes, 'base64');
            assert(digestBytes(bytes) === packed.digest, `transport entry digest mismatch: ${entry.path}`);
            fs.writeFileSync(destination, bytes);
            assert(!fs.lstatSync(destination).isSymbolicLink(), 'extracted transport entry must not be a symlink');
            assert(digestFile(destination) === packed.digest,
                `extracted transport content digest mismatch: ${relative}`);
            extractedEntries.push({ path: entry.path, digest: packed.digest,
                extractedPath: path.relative(repositoryRoot, destination).replaceAll(path.sep, '/') });
        }
        const extractedPath = extractedEntries.find((entry) => entry.path === object.originalRef.path)
            ?.extractedPath ?? extractedEntries[0].extractedPath;
        extractedObjects.push({
            ...object,
            extractedPath,
            archiveEntries: extractedEntries
        });
    }
    const extracted = sealed({
        schema: EVIDENCE_TRANSPORT_MANIFEST_SCHEMA,
        transportRunId: manifest.transportRunId,
        downloadRunId: manifest.downloadRunId,
        archive: manifest.archive,
        objects: extractedObjects
    });
    fs.writeFileSync(path.resolve(repositoryRoot, manifestPath), `${JSON.stringify(extracted, null, 2)}\n`);
    return extracted;
}

export function browseDiagnosticTransportEntries(manifest)
{
    validateEvidenceTransportManifest(manifest);
    return {
        schema: 'fsusblog.current-run-evidence-diagnostic-browse.v1',
        archivePath: manifest.archive.path,
        entries: manifest.archive.entries.map((entry) => ({ path: entry.path, digest: entry.digest }))
    };
}

export function locateTransportedCurrentRunEvidence({
    context, registry, registryEntry, repositoryRoot, transportManifestPath, explicitInputs, reference
})
{
    validateCurrentRunEvidenceContext(context);
    validateEvidenceLocatorRegistry(registry);
    const manifest = validateEvidenceTransportManifest(JSON.parse(fs.readFileSync(
        path.resolve(repositoryRoot, transportManifestPath), 'utf8')));
    const mapped = manifest.objects.filter((object) => object.authorityId === registryEntry.authorityId);
    assert(mapped.length > 0, `transport mapping is missing for ${registryEntry.authorityId}`);
    assert(mapped.length === 1, `duplicate transport mapping for ${registryEntry.authorityId}`);
    const object = mapped[0];
    assertOriginIdentity(object, context);
    assert(object.producerId === registryEntry.producerId, 'transport producerId mismatch');
    assert(object.receiptSchema === registryEntry.receiptSchema, 'transport receiptSchema mismatch');
    const inputPath = explicitInputs?.[0] ?? reference?.path ?? object.extractedPath;
    assert(inputPath === object.extractedPath || inputPath === object.originalRef.path,
        'explicit evidence path does not match transport mapping');
    const absolute = path.resolve(repositoryRoot, object.extractedPath);
    assertNotSymlink(absolute, object.extractedPath);
    assert(digestFile(absolute) === object.objectDigest, 'transport object digest mismatch');
    assert(digestFile(absolute) === object.originalRef.inputDigest, 'transport original ref digest mismatch');
    const localPath = path.resolve(repositoryRoot, object.originalRef.path);
    if (fs.existsSync(localPath) && path.resolve(localPath) !== path.resolve(absolute)
        && digestFile(localPath) !== object.objectDigest)
    {
        throw new Error('local and downloaded evidence for one authority is ambiguous');
    }
    const located = locateCurrentRunEvidence({
        context,
        registry,
        registryEntry,
        repositoryRoot,
        ...(reference
            ? { reference: { path: object.extractedPath, objectDigest: object.objectDigest } }
            : { explicitInputs: [object.extractedPath] })
    });
    verifyCurrentRunEvidenceBinding(located.bindingReceipt,
        { context, registry, registryEntry, repositoryRoot });
    const consumerPayload = {
        schema: EVIDENCE_CONSUMER_RECEIPT_SCHEMA,
        consumerId: registryEntry.consumerId,
        authorityId: registryEntry.authorityId,
        producerId: registryEntry.producerId,
        transportManifestDigest: manifest.contentDigest,
        transportRef: {
            path: transportManifestPath,
            authorityId: object.authorityId,
            extractedPath: object.extractedPath,
            objectDigest: object.objectDigest
        },
        locatorBindingDigest: located.bindingReceipt.bindingDigest
    };
    return {
        ...located,
        transportManifest: manifest,
        consumerReceipt: { ...consumerPayload, contentDigest: governanceContentDigest(consumerPayload) }
    };
}

export function assertUnboundDownloadedEvidenceRejected(file)
{
    const relative = String(file ?? '').replaceAll('\\', '/');
    assert(!downloadedPath(relative),
        'downloaded evidence requires an exact transport manifest mapping');
}

export function resolveCorrectnessEvidencePath({
    repositoryRoot, localPath, transportManifestPath, authorityId, environment = process.env
})
{
    const manifestPath = transportManifestPath
        ?? String(environment[EVIDENCE_TRANSPORT_MANIFEST_ENV] ?? '').trim();
    const downloadedRoot = path.join(repositoryRoot, '.tmp/downloaded-artifacts');
    if (manifestPath)
    {
        const manifest = validateEvidenceTransportManifest(JSON.parse(fs.readFileSync(
            path.resolve(repositoryRoot, manifestPath), 'utf8')));
        const mapped = manifest.objects.filter((object) => object.authorityId === authorityId);
        assert(mapped.length === 1, mapped.length === 0
            ? `transport mapping is missing for ${authorityId}`
            : `duplicate transport mapping for ${authorityId}`);
        return path.resolve(repositoryRoot, mapped[0].extractedPath);
    }
    if (fs.existsSync(downloadedRoot))
    {
        throw new Error('downloaded artifacts exist without a transport manifest');
    }
    assert(typeof localPath === 'string' && localPath.length > 0, 'explicit local evidence path is required');
    assertUnboundDownloadedEvidenceRejected(localPath);
    const absolute = path.resolve(repositoryRoot, localPath);
    assert(fs.existsSync(absolute), `explicit evidence path is missing: ${localPath}`);
    return absolute;
}

export function listTransportedArchiveFiles({ repositoryRoot, transportManifestPath, authorityId })
{
    const manifest = validateEvidenceTransportManifest(JSON.parse(fs.readFileSync(
        path.resolve(repositoryRoot, transportManifestPath), 'utf8')));
    const mapped = manifest.objects.filter((object) => object.authorityId === authorityId);
    assert(mapped.length === 1, mapped.length === 0
        ? `transport mapping is missing for ${authorityId}`
        : `duplicate transport mapping for ${authorityId}`);
    return mapped[0].archiveEntries.map((entry) => path.resolve(repositoryRoot, entry.extractedPath));
}
