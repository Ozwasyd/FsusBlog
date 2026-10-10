import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';

import { createCohortLedger, verifyCohortLedger, appendCohortLedger, sealCohortLedger, validateRunReceiptRef } from './cohort-ledger.mjs';

const { canonicalJson } = await import(new URL('../test/attempt-provenance.mjs', import.meta.url));

function physicalDirectory(root)
{
    const absolute = path.resolve(root);
    const stat = fs.lstatSync(absolute);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(absolute) !== absolute)
    {
        throw new Error('cohort store requires an explicit existing physical directory');
    }
    return absolute;
}

function cohortPath(root, cohortId)
{
    if (!/^sha256:[a-f0-9]{64}$/u.test(cohortId ?? ''))
    {
        throw new Error('cohort ref requires a content-addressed cohort ID');
    }
    return path.join(physicalDirectory(root), cohortId.slice(7));
}

function syncedWrite(file, document)
{
    const descriptor = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try
    {
        fs.writeFileSync(descriptor, `${canonicalJson(document)}\n`);
        fs.fsyncSync(descriptor);
    }
    finally
    {
        fs.closeSync(descriptor);
    }
}

function syncDirectory(directory)
{
    const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try
    {
        fs.fsyncSync(descriptor);
    }
    finally
    {
        fs.closeSync(descriptor);
    }
}

function physicalRead(file)
{
    const before = fs.lstatSync(file, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink())
    {
        throw new Error('cohort object must be a physical regular file');
    }
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try
    {
        const opened = fs.fstatSync(descriptor, { bigint: true });
        const bytes = fs.readFileSync(descriptor);
        const after = fs.fstatSync(descriptor, { bigint: true });
        const current = fs.lstatSync(file, { bigint: true });
        if ([opened, after, current].some((stat) => ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs']
            .some((key) => stat[key] !== before[key])) || BigInt(bytes.length) !== before.size)
        {
            throw new Error('cohort object changed during read');
        }
        return JSON.parse(bytes);
    }
    finally
    {
        fs.closeSync(descriptor);
    }
}

export function readCohortStore({ root, cohortId, expectedDigest })
{
    const directory = physicalDirectory(cohortPath(root, cohortId));
    const ledger = physicalRead(path.join(directory, 'ledger.json'));
    const rootObject = physicalRead(path.join(directory, 'identity.json'));
    const inspected = verifyCohortLedger(ledger, { expectedDigest });
    if (inspected.cohortId !== cohortId || canonicalJson(rootObject) !== canonicalJson(ledger.root))
    {
        throw new Error('cohort immutable root/ref mismatch');
    }
    return { ledger, inspected };
}

/** verifyIdentityPlan is the independently verified six-fragment capability.
 * It is mandatory; a bare digest or manually assembled identity is no substitute. */
export function createCohortStore({ root, identityPlan, verifyIdentityPlan, instanceKey, createdAt, reuse = null })
{
    if (typeof verifyIdentityPlan !== 'function')
    {
        throw new Error('missing verified six-fragment identity-plan capability');
    }
    const identity = verifyIdentityPlan(identityPlan);
    if (reuse !== null)
    {
        const existing = readCohortStore({ root, ...reuse });
        if (existing.inspected.sealed || canonicalJson(existing.inspected.candidateIdentity) !== canonicalJson(identity))
        {
            throw new Error('explicit reuse requires the exact identity and an unsealed cohort');
        }
        return { cohortId: reuse.cohortId, contentDigest: existing.ledger.contentDigest, reused: true };
    }
    const ledger = createCohortLedger(identity, { instanceKey, createdAt });
    const destination = cohortPath(root, ledger.root.cohortId);
    const staging = path.join(physicalDirectory(root), `.create-${randomUUID()}`);
    fs.mkdirSync(staging, { mode: 0o700 });
    try
    {
        syncedWrite(path.join(staging, 'identity.json'), ledger.root);
        syncedWrite(path.join(staging, 'ledger.json'), ledger);
        syncDirectory(staging);
        fs.renameSync(staging, destination);
        syncDirectory(physicalDirectory(root));
    }
    finally
    {
        // Only this task-created, unpublished staging directory may be removed.
        if (fs.existsSync(staging))
        {
            fs.rmSync(staging, { recursive: true });
        }
    }
    return { cohortId: ledger.root.cohortId, contentDigest: ledger.contentDigest, reused: false };
}

function mutateStore(options, mutation)
{
    const directory = physicalDirectory(cohortPath(options.root, options.cohortId));
    const lock = path.join(directory, '.writer');
    try
    {
        fs.mkdirSync(lock, { mode: 0o700 });
    }
    catch (error)
    {
        throw new Error('cohort writer busy; preserve the lock and retry with an explicit current digest', { cause: error });
    }
    const temporary = path.join(directory, `.ledger-${randomUUID()}`);
    try
    {
        const current = readCohortStore(options);
        const next = mutation(current.ledger);
        verifyCohortLedger(next, { expectedDigest: next.contentDigest });
        syncedWrite(temporary, next);
        fs.renameSync(temporary, path.join(directory, 'ledger.json'));
        syncDirectory(directory);
        return { cohortId: options.cohortId, contentDigest: next.contentDigest };
    }
    finally
    {
        if (fs.existsSync(temporary))
        {
            fs.unlinkSync(temporary);
        }
        fs.rmdirSync(lock);
    }
}

/** readVerifiedRun must use the existing current-run locator and independently
 * verify outcome/Fresh cleanup/runtime receipts. No directory scan is performed. */
export function appendCohortStore(options)
{
    validateRunReceiptRef(options.runReceiptRef);
    if (typeof options.readVerifiedRun !== 'function')
    {
        throw new Error('missing current-run locator and independent run-membership capability');
    }
    return mutateStore(options, (ledger) =>
    {
        const member = options.readVerifiedRun(options.runReceiptRef);
        if (canonicalJson(member.runReceiptRef) !== canonicalJson(options.runReceiptRef))
        {
            throw new Error('verified run locator returned a different explicit receipt ref');
        }
        return appendCohortLedger(ledger, { ordinal: options.ordinal, member, addedAt: options.addedAt, expectedDigest: options.expectedDigest });
    });
}

export function sealCohortStore(options)
{
    return mutateStore(options, (ledger) => sealCohortLedger(ledger, { addedAt: options.addedAt, expectedDigest: options.expectedDigest }));
}
