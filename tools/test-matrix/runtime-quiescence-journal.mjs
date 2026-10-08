import fs from 'node:fs';

import {quiescenceDigest} from './quiescence-contract.mjs';

const maximumJournalBytes = 8 * 1024 * 1024;
const transitions = new Map([
    ['initial', new Set(['prepared', 'released'])],
    ['prepared', new Set(['frozen', 'released'])],
    ['frozen', new Set(['observed', 'released'])],
    ['observed', new Set(['observed', 'sealed', 'released'])],
    ['sealed', new Set(['released'])],
    ['released', new Set()]
]);

export function validateQuiescenceJournal(entries, {attemptId, identity})
{
    let previous = null;
    let state = 'initial';
    for (const [index, entry] of entries.entries())
    {
        const {contentDigest, ...payload} = entry;
        if (entry.schema !== 'fsusblog.quiescence-journal-entry.v1' || entry.sequence !== index + 1 ||
            entry.previousDigest !== previous || contentDigest !== quiescenceDigest(payload) ||
            entry.event.attemptId !== attemptId || quiescenceDigest(entry.event.identity) !== quiescenceDigest(identity) ||
            !transitions.get(state)?.has(entry.event.state))
        {
            throw new Error('quiescence append-only journal identity, chain or lifecycle drift');
        }
        if (entry.event.state === 'released')
        {
            const release = entry.event.releaseReceipt;
            const {contentDigest: releaseDigest, ...releasePayload} = release ?? {};
            if (release?.schema !== 'fsusblog.quiescence-release.v1' || release.attemptId !== attemptId ||
                quiescenceDigest(release.identity) !== quiescenceDigest(identity) ||
                !['released', 'failed'].includes(release.status) || !Array.isArray(release.errors) ||
                releaseDigest !== quiescenceDigest(releasePayload) || (release.status === 'released' && release.errors.length))
            {
                throw new Error('quiescence journal release proof missing or invalid');
            }
        }
        state = entry.event.state;
        previous = contentDigest;
    }
    return {state, headDigest: previous, count: entries.length,
        ownerRecoveryRequired: entries.length > 0 && (state !== 'released' || entries.at(-1).event.releaseReceipt?.status !== 'released')};
}

export function readQuiescenceJournal(file, binding)
{
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try
    {
        const stat = fs.fstatSync(descriptor);
        if (!stat.isFile() || stat.size > maximumJournalBytes)
        {
            throw new Error('quiescence journal is not a bounded regular file');
        }
        const source = fs.readFileSync(descriptor, 'utf8');
        if (source && !source.endsWith('\n'))
        {
            throw new Error('quiescence journal has an interrupted partial append');
        }
        const entries = source ? source.trimEnd().split('\n').map((line) => JSON.parse(line)) : [];
        return {entries, ...validateQuiescenceJournal(entries, binding)};
    }
    finally
    {
        fs.closeSync(descriptor);
    }
}

// One explicitly supplied file, exclusive creation and fsync per complete append.
// Existing journals are never overwritten/resumed by guessing a live owner.
export function createQuiescenceJournal(file)
{
    const descriptor = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND |
        fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    const entries = [];
    let closed = false;
    let bytes = 0;
    return {
        append(event)
        {
            if (closed)
            {
                throw new Error('quiescence journal writer is closed');
            }
            const copied = structuredClone(event);
            const payload = {schema: 'fsusblog.quiescence-journal-entry.v1', sequence: entries.length + 1,
                previousDigest: entries.at(-1)?.contentDigest ?? null, event: copied};
            const entry = {...payload, contentDigest: quiescenceDigest(payload)};
            validateQuiescenceJournal([...entries, entry], {attemptId: copied.attemptId, identity: copied.identity});
            const data = Buffer.from(`${JSON.stringify(entry)}\n`);
            if (bytes + data.length > maximumJournalBytes)
            {
                throw new Error('quiescence journal bounded byte limit exceeded');
            }
            let offset = 0;
            while (offset < data.length)
            {
                const written = fs.writeSync(descriptor, data, offset, data.length - offset);
                if (written <= 0)
                {
                    throw new Error('quiescence journal append did not advance');
                }
                offset += written;
            }
            fs.fsyncSync(descriptor);
            bytes += data.length;
            entries.push(entry);
            return structuredClone(entry);
        },
        close()
        {
            if (!closed)
            {
                closed = true;
                fs.closeSync(descriptor);
            }
        }
    };
}
