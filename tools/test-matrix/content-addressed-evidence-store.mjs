import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

export const evidenceObjectSchema = 'fsusblog.run-evidence-object.v1';
export const evidenceLogicalReceiptSchema = 'fsusblog.run-evidence-logical-receipt.v1';
export const evidenceJournalEventSchema = 'fsusblog.run-evidence-journal-event.v1';
export const evidenceCheckpointSchema = 'fsusblog.run-evidence-checkpoint.v1';
export const evidenceMetricsSchema = 'fsusblog.run-evidence-storage-metrics.v1';

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const semanticIdPattern = /^[A-Za-z][A-Za-z0-9_.-]*$/u;
const eventDimensionPattern = /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/u;
const runIdentityPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u;
const issueIdentityPattern = /(?:^|[-_.])(?:issue|pr)[-_.]?\d+(?:$|[-_.])/iu;
const waitArray = new Int32Array(new SharedArrayBuffer(4));

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

function serialize(value)
{
    return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function sha256(value)
{
    return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function digestValue(value)
{
    const content = { ...(value ?? {}) };
    delete content.contentDigest;
    return sha256(JSON.stringify(canonicalize(content)));
}

function requiredText(value, label)
{
    const normalized = String(value ?? '').trim();
    if (!normalized)
    {
        throw new Error(`${label} must be non-empty`);
    }
    return normalized;
}

function validateSemanticId(value, label)
{
    const normalized = requiredText(value, label);
    if (!semanticIdPattern.test(normalized)
        || normalized === '.'
        || normalized === '..'
        || issueIdentityPattern.test(normalized))
    {
        throw new Error(`${label} must be a semantic identifier without an issue or PR number`);
    }
    return normalized;
}

function validateRunIdentity(value, label)
{
    const normalized = requiredText(value, label);
    if (!runIdentityPattern.test(normalized) || normalized === '.' || normalized === '..')
    {
        throw new Error(`${label} is invalid`);
    }
    return normalized;
}

function validateEventDimension(value, label)
{
    const normalized = requiredText(value, label);
    if (!eventDimensionPattern.test(normalized) || normalized === '.' || normalized === '..')
    {
        throw new Error(`${label} is invalid`);
    }
    return normalized;
}

function validateDigest(value, label)
{
    const normalized = String(value ?? '');
    if (!digestPattern.test(normalized))
    {
        throw new Error(`${label} must be a SHA-256 digest`);
    }
    return normalized;
}

function normalizeSourceState(sourceState, label = 'sourceState')
{
    const commit = sourceState?.commit === null || sourceState?.commit === undefined
        ? null
        : requiredText(sourceState.commit, `${label}.commit`);
    const worktreeFingerprint = requiredText(sourceState?.worktreeFingerprint, `${label}.worktreeFingerprint`);
    return { commit, worktreeFingerprint };
}

function sameSourceState(left, right)
{
    return left?.commit === right?.commit
        && left?.worktreeFingerprint === right?.worktreeFingerprint;
}

function sortedUnique(values, label, { allowEmpty = false } = {})
{
    if (!Array.isArray(values) || (!allowEmpty && values.length === 0))
    {
        throw new Error(`${label} must be ${allowEmpty ? 'an' : 'a non-empty'} array`);
    }
    const normalized = values.map((value) => requiredText(value, `${label} entry`));
    const sorted = [...new Set(normalized)].sort();
    if (JSON.stringify(normalized) !== JSON.stringify(sorted))
    {
        throw new Error(`${label} must be sorted and unique`);
    }
    return normalized;
}

function assertSafeDirectory(directory, label)
{
    try
    {
        fs.mkdirSync(directory, { recursive: false, mode: 0o700 });
    }
    catch (error)
    {
        if (error?.code !== 'EEXIST')
        {
            throw error;
        }
    }

    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory())
    {
        throw new Error(`${label} must be a real directory, not a symlink`);
    }
}

function assertRegularFile(file, label)
{
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile())
    {
        throw new Error(`${label} must be a regular file, not a symlink`);
    }
}

function atomicWrite(file, bytes, { immutable = false, mode = 0o600 } = {})
{
    const directory = path.dirname(file);
    const temporary = path.join(
        directory,
        `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
    );
    const descriptor = fs.openSync(temporary, 'wx', mode);
    try
    {
        fs.writeFileSync(descriptor, bytes);
        fs.fsyncSync(descriptor);
    }
    finally
    {
        fs.closeSync(descriptor);
    }
    try
    {
        if (immutable)
        {
            fs.linkSync(temporary, file);
        }
        else
        {
            fs.renameSync(temporary, file);
        }
    }
    finally
    {
        fs.rmSync(temporary, { force: true });
    }
}

function normalizedReference(reference, expectedRunId, label)
{
    const runId = validateRunIdentity(reference?.runId, `${label}.runId`);
    if (runId !== expectedRunId)
    {
        throw new Error(`${label} crosses run boundary: ${runId} != ${expectedRunId}`);
    }
    return {
        name: validateSemanticId(reference?.name, `${label}.name`),
        runId,
        digest: validateDigest(reference?.digest, `${label}.digest`)
    };
}

function normalizedReferences(references, expectedRunId, label)
{
    if (!Array.isArray(references))
    {
        throw new Error(`${label} must be an array`);
    }
    const normalized = references.map((reference, index) => (
        normalizedReference(reference, expectedRunId, `${label}[${index}]`)
    )).sort((left, right) => left.name.localeCompare(right.name));
    const names = normalized.map((reference) => reference.name);
    if (new Set(names).size !== names.length)
    {
        throw new Error(`${label} contains duplicate reference names`);
    }
    return normalized;
}

export function validateObjectReferenceGraph(rootReferences, loadObject)
{
    const visiting = new Set();
    const visited = new Set();
    const visit = (reference) =>
    {
        const key = `${reference.runId}:${reference.digest}`;
        if (visiting.has(key))
        {
            throw new Error(`object reference cycle detected at ${reference.digest}`);
        }
        if (visited.has(key))
        {
            return;
        }
        visiting.add(key);
        const object = loadObject(reference);
        for (const child of object.references ?? [])
        {
            visit(child);
        }
        visiting.delete(key);
        visited.add(key);
    };
    for (const reference of rootReferences)
    {
        visit(reference);
    }
}

function acquireLock(lockFile, timeoutMs = 5_000)
{
    const startedAt = Date.now();
    while (true)
    {
        try
        {
            const descriptor = fs.openSync(lockFile, 'wx', 0o600);
            fs.writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid })}\n`);
            fs.fsyncSync(descriptor);
            return descriptor;
        }
        catch (error)
        {
            if (error?.code !== 'EEXIST')
            {
                throw error;
            }
            const ageMs = Date.now() - fs.lstatSync(lockFile).mtimeMs;
            if (ageMs > 30_000)
            {
                fs.rmSync(lockFile, { force: true });
                continue;
            }
            if (Date.now() - startedAt >= timeoutMs)
            {
                throw new Error(`timed out acquiring evidence journal lock: ${lockFile}`, { cause: error });
            }
            Atomics.wait(waitArray, 0, 0, 5);
        }
    }
}

function releaseLock(lockFile, descriptor)
{
    try
    {
        fs.closeSync(descriptor);
    }
    finally
    {
        fs.rmSync(lockFile, { force: true });
    }
}

function readJsonFile(file, label)
{
    assertRegularFile(file, label);
    try
    {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    catch (error)
    {
        throw new Error(`${label} is invalid JSON: ${error.message}`, { cause: error });
    }
}

function journalLines(file)
{
    if (!fs.existsSync(file))
    {
        return [];
    }
    assertRegularFile(file, 'evidence journal');
    const text = fs.readFileSync(file, 'utf8');
    if (!text)
    {
        return [];
    }
    if (!text.endsWith('\n'))
    {
        throw new Error('evidence journal has a truncated final record');
    }
    return text.trimEnd().split('\n').map((line, index) =>
    {
        try
        {
            return JSON.parse(line);
        }
        catch (error)
        {
            throw new Error(`evidence journal record ${index + 1} is invalid JSON: ${error.message}`, { cause: error });
        }
    });
}

function lastJournalEvent(file)
{
    if (!fs.existsSync(file))
    {
        return null;
    }
    assertRegularFile(file, 'evidence journal');
    const size = fs.statSync(file).size;
    if (size === 0)
    {
        return null;
    }
    const maximumRecordBytes = 64 * 1024;
    const length = Math.min(size, maximumRecordBytes);
    const descriptor = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(length);
    try
    {
        fs.readSync(descriptor, buffer, 0, length, size - length);
    }
    finally
    {
        fs.closeSync(descriptor);
    }
    const text = buffer.toString('utf8');
    if (!text.endsWith('\n'))
    {
        throw new Error('evidence journal has a truncated final record');
    }
    const records = text.trimEnd().split('\n');
    const record = records.at(-1);
    if (records.length === 1 && length < size)
    {
        throw new Error('evidence journal record exceeds the bounded tail reader');
    }
    try
    {
        return JSON.parse(record);
    }
    catch (error)
    {
        throw new Error(`evidence journal final record is invalid JSON: ${error.message}`, { cause: error });
    }
}

export class RunEvidenceObjectStore
{
    constructor({ root, runId, sourceState })
    {
        this.root = path.resolve(requiredText(root, 'root'));
        this.runId = validateRunIdentity(runId, 'runId');
        this.sourceState = normalizeSourceState(sourceState);
        if (fs.existsSync(this.root))
        {
            const stat = fs.lstatSync(this.root);
            if (stat.isSymbolicLink() || !stat.isDirectory())
            {
                throw new Error('evidence store root must be a real directory, not a symlink');
            }
        }
        else
        {
            fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
        }
        if (fs.realpathSync(this.root) !== this.root)
        {
            throw new Error('evidence store root must not traverse a symlink');
        }
        this.objectsDirectory = path.join(this.root, 'objects');
        this.receiptsDirectory = path.join(this.root, 'receipts');
        this.journalsDirectory = path.join(this.root, 'journals');
        this.checkpointsDirectory = path.join(this.root, 'checkpoints');
        for (const [directory, label] of [
            [this.objectsDirectory, 'objects directory'],
            [this.receiptsDirectory, 'receipts directory'],
            [this.journalsDirectory, 'journals directory'],
            [this.checkpointsDirectory, 'checkpoints directory']
        ])
        {
            assertSafeDirectory(directory, label);
        }
        this.statistics = {
            jsonBytesWritten: 0,
            objectBytesStored: 0,
            rewriteCount: 0,
            objectPublishCount: 0,
            objectReuseCount: 0,
            journalAppendCount: 0,
            compactCheckpointCount: 0,
            serializationCpuNanoseconds: 0n,
            recoveryCpuNanoseconds: 0n,
            recoveryObjectReads: 0,
            recoveryJournalEvents: 0
        };
    }

    objectFile(digest)
    {
        const normalized = validateDigest(digest, 'object digest');
        return path.join(this.objectsDirectory, normalized.slice('sha256:'.length));
    }

    publishObject(value, { references = [] } = {})
    {
        const normalized = normalizedReferences(references, this.runId, 'object references');
        const startedAt = process.cpuUsage();
        const envelope = {
            schema: evidenceObjectSchema,
            runId: this.runId,
            sourceState: this.sourceState,
            references: normalized,
            value
        };
        const bytes = serialize(envelope);
        const digest = sha256(bytes);
        const file = this.objectFile(digest);
        const elapsed = process.cpuUsage(startedAt);
        this.statistics.serializationCpuNanoseconds += BigInt(elapsed.user + elapsed.system) * 1_000n;
        this.statistics.objectPublishCount += 1;
        if (fs.existsSync(file))
        {
            assertRegularFile(file, `evidence object ${digest}`);
            if (fs.readFileSync(file, 'utf8') !== bytes)
            {
                throw new Error(`immutable evidence object collision: ${digest}`);
            }
            this.statistics.objectReuseCount += 1;
            return { digest, bytes: Buffer.byteLength(bytes), reused: true };
        }
        try
        {
            atomicWrite(file, bytes, { immutable: true });
            this.statistics.jsonBytesWritten += Buffer.byteLength(bytes);
            this.statistics.objectBytesStored += Buffer.byteLength(bytes);
            return { digest, bytes: Buffer.byteLength(bytes), reused: false };
        }
        catch (error)
        {
            if (error?.code !== 'EEXIST')
            {
                throw error;
            }
            assertRegularFile(file, `evidence object ${digest}`);
            if (fs.readFileSync(file, 'utf8') !== bytes)
            {
                throw new Error(`immutable evidence object collision: ${digest}`, { cause: error });
            }
            this.statistics.objectReuseCount += 1;
            return { digest, bytes: Buffer.byteLength(bytes), reused: true };
        }
    }

    readObject(digest)
    {
        const file = this.objectFile(digest);
        if (!fs.existsSync(file))
        {
            throw new Error(`evidence object is missing: ${digest}`);
        }
        assertRegularFile(file, `evidence object ${digest}`);
        const bytes = fs.readFileSync(file);
        if (sha256(bytes) !== digest)
        {
            throw new Error(`evidence object digest mismatch: ${digest}`);
        }
        let object;
        try
        {
            object = JSON.parse(bytes.toString('utf8'));
        }
        catch (error)
        {
            throw new Error(`evidence object is invalid JSON: ${digest}`, { cause: error });
        }
        if (object?.schema !== evidenceObjectSchema)
        {
            throw new Error(`unexpected evidence object schema: ${object?.schema ?? 'missing'}`);
        }
        if (object.runId !== this.runId)
        {
            throw new Error(`evidence object belongs to another run: ${object.runId}`);
        }
        if (!sameSourceState(object.sourceState, this.sourceState))
        {
            throw new Error('evidence object source binding mismatch');
        }
        object.references = normalizedReferences(object.references, this.runId, 'object references');
        return object;
    }

    validateReferences(references)
    {
        const normalized = normalizedReferences(references, this.runId, 'root references');
        validateObjectReferenceGraph(normalized, (reference) => this.readObject(reference.digest));
        return normalized;
    }

    publishLogicalReceipt({
        logicalOwner,
        requiredIds,
        decision,
        document,
        documentReferences = [],
        retention = {}
    })
    {
        const owner = validateSemanticId(logicalOwner, 'logicalOwner');
        const nestedReferences = normalizedReferences(documentReferences, this.runId, 'documentReferences');
        this.validateReferences(nestedReferences);
        const published = this.publishObject(document, { references: nestedReferences });
        const references = [{
            name: 'document',
            runId: this.runId,
            digest: published.digest
        }];
        const receipt = {
            schema: evidenceLogicalReceiptSchema,
            logicalOwner: owner,
            requiredIds: sortedUnique(requiredIds, 'requiredIds', { allowEmpty: true }),
            sourceState: this.sourceState,
            runId: this.runId,
            decision: requiredText(decision, 'decision'),
            objectReferences: references,
            retention: {
                activeRun: retention.activeRun === true,
                releaseBinding: retention.releaseBinding === true
            },
            contentDigest: null
        };
        receipt.contentDigest = digestValue(receipt);
        const bytes = serialize(receipt);
        const file = path.join(this.receiptsDirectory, `${owner}.json`);
        if (fs.existsSync(file))
        {
            assertRegularFile(file, `logical receipt ${owner}`);
            if (fs.readFileSync(file, 'utf8') !== bytes)
            {
                throw new Error(`logical receipt ${owner} is immutable within run ${this.runId}`);
            }
        }
        else
        {
            atomicWrite(file, bytes, { immutable: true });
            this.statistics.jsonBytesWritten += Buffer.byteLength(bytes);
        }
        return { file, receipt, documentDigest: published.digest, reusedObject: published.reused };
    }

    readLogicalReceipt(fileOrOwner)
    {
        const file = path.isAbsolute(fileOrOwner)
            ? path.resolve(fileOrOwner)
            : path.join(this.receiptsDirectory, `${validateSemanticId(fileOrOwner, 'logicalOwner')}.json`);
        if (path.dirname(file) !== this.receiptsDirectory)
        {
            throw new Error('logical receipt path escapes the receipts directory');
        }
        if (!fs.existsSync(file))
        {
            throw new Error(`logical receipt is missing: ${path.basename(file)}`);
        }
        const receipt = readJsonFile(file, 'logical receipt');
        if (receipt?.schema !== evidenceLogicalReceiptSchema)
        {
            throw new Error(`unexpected logical receipt schema: ${receipt?.schema ?? 'missing'}`);
        }
        if (receipt.contentDigest !== digestValue(receipt))
        {
            throw new Error('logical receipt content digest mismatch');
        }
        if (receipt.runId !== this.runId || !sameSourceState(receipt.sourceState, this.sourceState))
        {
            throw new Error('logical receipt run/source binding mismatch');
        }
        validateSemanticId(receipt.logicalOwner, 'logical receipt owner');
        sortedUnique(receipt.requiredIds, 'logical receipt requiredIds', { allowEmpty: true });
        const references = this.validateReferences(receipt.objectReferences);
        const documentReference = references.find((reference) => reference.name === 'document');
        if (!documentReference)
        {
            throw new Error('logical receipt has no document object reference');
        }
        return {
            receipt,
            document: this.readObject(documentReference.digest).value
        };
    }

    appendJournalEvent({ eventType, tier = null, step = null, status, payload })
    {
        const journal = path.join(this.journalsDirectory, `${this.runId}.jsonl`);
        const lockFile = path.join(this.journalsDirectory, `${this.runId}.lock`);
        const descriptor = acquireLock(lockFile);
        try
        {
            const previous = lastJournalEvent(journal);
            if (previous)
            {
                if (previous.schema !== evidenceJournalEventSchema
                    || previous.runId !== this.runId
                    || !sameSourceState(previous.sourceState, this.sourceState)
                    || previous.contentDigest !== digestValue(previous)
                    || !Number.isInteger(previous.sequence)
                    || previous.sequence <= 0
                    || !digestPattern.test(String(previous.payloadDigest ?? '')))
                {
                    throw new Error('evidence journal final record is invalid');
                }
            }
            const sequence = (previous?.sequence ?? 0) + 1;
            const published = this.publishObject(payload);
            const event = {
                schema: evidenceJournalEventSchema,
                runId: this.runId,
                sourceState: this.sourceState,
                sequence,
                eventType: validateSemanticId(eventType, 'eventType'),
                tier: tier === null ? null : validateEventDimension(tier, 'tier'),
                step: step === null ? null : validateEventDimension(step, 'step'),
                status: requiredText(status, 'status'),
                payloadDigest: published.digest,
                contentDigest: null
            };
            event.contentDigest = digestValue(event);
            const bytes = JSON.stringify(canonicalize(event));
            const journalDescriptor = fs.openSync(journal, 'a', 0o600);
            try
            {
                fs.writeFileSync(journalDescriptor, `${bytes}\n`);
                fs.fsyncSync(journalDescriptor);
            }
            finally
            {
                fs.closeSync(journalDescriptor);
            }
            this.statistics.jsonBytesWritten += Buffer.byteLength(`${bytes}\n`);
            this.statistics.journalAppendCount += 1;
            return event;
        }
        finally
        {
            releaseLock(lockFile, descriptor);
        }
    }

    readJournal()
    {
        const journal = path.join(this.journalsDirectory, `${this.runId}.jsonl`);
        const events = journalLines(journal);
        let expectedSequence = 1;
        for (const event of events)
        {
            if (event?.schema !== evidenceJournalEventSchema)
            {
                throw new Error(`unexpected evidence journal schema at sequence ${expectedSequence}`);
            }
            if (event.runId !== this.runId || !sameSourceState(event.sourceState, this.sourceState))
            {
                throw new Error(`evidence journal run/source binding mismatch at sequence ${expectedSequence}`);
            }
            if (event.sequence !== expectedSequence)
            {
                throw new Error(`evidence journal sequence gap: expected ${expectedSequence}, got ${event.sequence}`);
            }
            if (event.contentDigest !== digestValue(event))
            {
                throw new Error(`evidence journal content digest mismatch at sequence ${event.sequence}`);
            }
            validateDigest(event.payloadDigest, `journal payload digest at sequence ${event.sequence}`);
            this.readObject(event.payloadDigest);
            expectedSequence += 1;
        }
        return events;
    }

    writeCompactCheckpoint({ stage, state, lastSequence = null, retention = {} })
    {
        const events = this.readJournal();
        const sequence = lastSequence ?? (events.at(-1)?.sequence ?? 0);
        if (!Number.isInteger(sequence) || sequence < 0 || sequence > (events.at(-1)?.sequence ?? 0))
        {
            throw new Error('compact checkpoint sequence is outside the validated journal');
        }
        const published = this.publishObject(state);
        const checkpoint = {
            schema: evidenceCheckpointSchema,
            runId: this.runId,
            sourceState: this.sourceState,
            stage: validateSemanticId(stage, 'checkpoint stage'),
            lastSequence: sequence,
            stateReference: {
                name: 'state',
                runId: this.runId,
                digest: published.digest
            },
            retention: {
                activeRun: retention.activeRun === true,
                releaseBinding: retention.releaseBinding === true
            },
            contentDigest: null
        };
        checkpoint.contentDigest = digestValue(checkpoint);
        const bytes = serialize(checkpoint);
        const file = path.join(this.checkpointsDirectory, `${this.runId}.json`);
        const rewrite = fs.existsSync(file);
        if (rewrite)
        {
            assertRegularFile(file, 'compact checkpoint');
        }
        atomicWrite(file, bytes);
        this.statistics.jsonBytesWritten += Buffer.byteLength(bytes);
        this.statistics.compactCheckpointCount += 1;
        if (rewrite)
        {
            this.statistics.rewriteCount += 1;
        }
        return { file, checkpoint };
    }

    readCompactCheckpoint()
    {
        const file = path.join(this.checkpointsDirectory, `${this.runId}.json`);
        if (!fs.existsSync(file))
        {
            return null;
        }
        const checkpoint = readJsonFile(file, 'compact checkpoint');
        if (checkpoint?.schema !== evidenceCheckpointSchema)
        {
            throw new Error(`unexpected compact checkpoint schema: ${checkpoint?.schema ?? 'missing'}`);
        }
        if (checkpoint.contentDigest !== digestValue(checkpoint))
        {
            throw new Error('compact checkpoint content digest mismatch');
        }
        if (checkpoint.runId !== this.runId || !sameSourceState(checkpoint.sourceState, this.sourceState))
        {
            throw new Error('compact checkpoint run/source binding mismatch');
        }
        const reference = normalizedReference(checkpoint.stateReference, this.runId, 'checkpoint stateReference');
        const state = this.readObject(reference.digest).value;
        return { checkpoint, state };
    }

    recover(reducer)
    {
        if (typeof reducer !== 'function')
        {
            throw new Error('recovery reducer must be a function');
        }
        const startedAt = process.cpuUsage();
        const compact = this.readCompactCheckpoint();
        let state = compact?.state ?? null;
        const sequence = compact?.checkpoint.lastSequence ?? 0;
        const events = this.readJournal();
        for (const event of events)
        {
            if (event.sequence <= sequence)
            {
                continue;
            }
            const payload = this.readObject(event.payloadDigest).value;
            state = reducer(state, event, payload);
            this.statistics.recoveryObjectReads += 1;
            this.statistics.recoveryJournalEvents += 1;
        }
        const elapsed = process.cpuUsage(startedAt);
        this.statistics.recoveryCpuNanoseconds += BigInt(elapsed.user + elapsed.system) * 1_000n;
        return {
            state,
            lastSequence: events.at(-1)?.sequence ?? sequence,
            checkpointSequence: sequence,
            replayedEvents: events.filter((event) => event.sequence > sequence).length
        };
    }

    garbageCollect({ activeRunIds = [], releaseBindings = [] } = {})
    {
        const active = new Set(activeRunIds.map((value) => validateRunIdentity(value, 'activeRunId')));
        const release = new Set(releaseBindings.map((value) => validateDigest(value, 'release binding digest')));
        const protectedDigests = new Set();
        const visit = (reference) =>
        {
            if (protectedDigests.has(reference.digest))
            {
                return;
            }
            protectedDigests.add(reference.digest);
            for (const child of this.readObject(reference.digest).references)
            {
                visit(child);
            }
        };
        for (const entry of fs.readdirSync(this.receiptsDirectory, { withFileTypes: true }))
        {
            if (!entry.isFile() || !entry.name.endsWith('.json'))
            {
                continue;
            }
            const receipt = readJsonFile(path.join(this.receiptsDirectory, entry.name), 'logical receipt');
            if (receipt.contentDigest !== digestValue(receipt))
            {
                throw new Error(`logical receipt content digest mismatch during GC: ${entry.name}`);
            }
            for (const reference of normalizedReferences(receipt.objectReferences, this.runId, 'receipt references'))
            {
                visit(reference);
            }
        }
        const compact = this.readCompactCheckpoint();
        if (compact)
        {
            const checkpoint = compact.checkpoint;
            visit(normalizedReference(checkpoint.stateReference, this.runId, 'checkpoint stateReference'));
        }
        for (const event of this.readJournal())
        {
            if (active.has(event.runId))
            {
                visit({
                    name: `journal-${event.sequence}`,
                    runId: this.runId,
                    digest: event.payloadDigest
                });
            }
        }
        for (const digest of release)
        {
            if (fs.existsSync(this.objectFile(digest)))
            {
                visit({
                    name: 'release-binding',
                    runId: this.runId,
                    digest
                });
            }
        }
        const deleted = [];
        for (const entry of fs.readdirSync(this.objectsDirectory, { withFileTypes: true }))
        {
            if (!entry.isFile() || !/^[a-f0-9]{64}$/u.test(entry.name))
            {
                if (entry.isSymbolicLink())
                {
                    throw new Error(`objects directory contains a symlink: ${entry.name}`);
                }
                continue;
            }
            const digest = `sha256:${entry.name}`;
            if (protectedDigests.has(digest))
            {
                continue;
            }
            fs.unlinkSync(path.join(this.objectsDirectory, entry.name));
            deleted.push(digest);
        }
        return {
            deleted: deleted.sort(),
            protected: [...protectedDigests].sort()
        };
    }

    metrics()
    {
        return {
            schema: evidenceMetricsSchema,
            runId: this.runId,
            sourceState: this.sourceState,
            evidenceClass: 'optimization',
            affectsCorrectness: false,
            jsonBytesWritten: this.statistics.jsonBytesWritten,
            objectBytesStored: this.statistics.objectBytesStored,
            rewriteCount: this.statistics.rewriteCount,
            objectPublishCount: this.statistics.objectPublishCount,
            objectReuseCount: this.statistics.objectReuseCount,
            journalAppendCount: this.statistics.journalAppendCount,
            compactCheckpointCount: this.statistics.compactCheckpointCount,
            serializationCpuNanoseconds: Number(this.statistics.serializationCpuNanoseconds),
            recovery: {
                cpuNanoseconds: Number(this.statistics.recoveryCpuNanoseconds),
                objectReads: this.statistics.recoveryObjectReads,
                journalEvents: this.statistics.recoveryJournalEvents
            }
        };
    }
}

export function readEvidenceDocument(file, { storeRoot = null } = {})
{
    const document = readJsonFile(path.resolve(file), 'evidence document');
    if (document?.schema !== evidenceLogicalReceiptSchema)
    {
        return document;
    }
    const root = storeRoot
        ? path.resolve(storeRoot)
        : path.dirname(path.dirname(path.resolve(file)));
    const store = new RunEvidenceObjectStore({
        root,
        runId: document.runId,
        sourceState: document.sourceState
    });
    return store.readLogicalReceipt(path.resolve(file)).document;
}
