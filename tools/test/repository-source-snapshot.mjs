import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { canonicalJson, digestCanonical, sha256, sealContentDigest } from './attempt-provenance.mjs';

export const repositorySourceSnapshotSchema = 'fsusblog.repository-source-snapshot.v1';
const maximumFileBytes = 128 * 1024 * 1024;

function git(root, args)
{
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    const result = spawnSync('git', ['--no-replace-objects', '-C', root, ...args], {
        env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
        encoding: 'utf8', maxBuffer: maximumFileBytes
    });
    if (result.error || result.status !== 0) throw new Error(`source git ${args[0]} failed: ${result.error?.message ?? result.stderr}`);
    return result.stdout;
}

function safePath(value)
{
    if (!value || value !== value.normalize('NFC') || value.includes('\\') || path.posix.isAbsolute(value)
        || value.split('/').some((part) => !part || part === '..' || part === '.' || part === '.git'))
    {
        throw new Error(`source path is not canonical/contained: ${value}`);
    }
    return value;
}

function sourcePath(root, relative)
{
    safePath(relative);
    let current = root;
    for (const part of relative.split('/').slice(0, -1))
    {
        current = path.join(current, part);
        const stat = fs.lstatSync(current);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`source ancestor is not a physical directory: ${relative}`);
    }
    return path.join(root, relative);
}

function sameStat(left, right)
{
    return ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs'].every((key) => left[key] === right[key]);
}

function readEntry(root, relative)
{
    let absolute;
    let stat;
    try
    {
        absolute = sourcePath(root, relative);
        stat = fs.lstatSync(absolute, { bigint: true });
    }
    catch (error)
    {
        if (error.code === 'ENOENT') return { fileType: 'missing', mode: null, contentDigest: null, sizeBytes: 0 };
        throw error;
    }
    if (stat.isSymbolicLink())
    {
        const target = fs.readlinkSync(absolute);
        const resolved = path.resolve(path.dirname(absolute), target);
        const within = path.relative(root, resolved);
        if (path.isAbsolute(target) || within === '..' || within.startsWith(`..${path.sep}`))
        {
            throw new Error(`source symlink escapes declared root: ${relative}`);
        }
        if (!sameStat(stat, fs.lstatSync(absolute, { bigint: true }))) throw new Error(`source changed while reading: ${relative}`);
        return { fileType: 'symlink', mode: '120000', contentDigest: sha256(target), sizeBytes: Buffer.byteLength(target) };
    }
    if (!stat.isFile() || stat.size > BigInt(maximumFileBytes)) throw new Error(`source special/oversized input: ${relative}`);
    const fd = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try
    {
        if (!sameStat(stat, fs.fstatSync(fd, { bigint: true }))) throw new Error(`source changed before reading: ${relative}`);
        const bytes = fs.readFileSync(fd);
        if (!sameStat(stat, fs.fstatSync(fd, { bigint: true }))
            || !sameStat(stat, fs.lstatSync(absolute, { bigint: true })) || BigInt(bytes.length) !== stat.size)
        {
            throw new Error(`source changed while reading: ${relative}`);
        }
        return { fileType: 'file', mode: (stat.mode & 0o111n) ? '100755' : '100644', contentDigest: sha256(bytes), sizeBytes: bytes.length };
    }
    finally { fs.closeSync(fd); }
}

function validatePolicy(policy)
{
    if (!policy || Object.keys(policy).sort().join(',') !== 'ignoredInputs,schema,untracked'
        || policy.schema !== 'fsusblog.repository-source-policy.v1' || !['include', 'reject'].includes(policy.untracked)
        || !Array.isArray(policy.ignoredInputs)) throw new Error('explicit source policy is invalid');
    const paths = new Set();
    for (const input of policy.ignoredInputs)
    {
        if (!input || Object.keys(input).sort().join(',') !== 'consumedBy,ownerId,path,reason,required'
            || !/^[a-z][a-z0-9-]*$/u.test(input.ownerId ?? '') || !input.reason
            || !Array.isArray(input.consumedBy) || !input.consumedBy.length
            || input.consumedBy.some((id) => typeof id !== 'string' || !id)
            || new Set(input.consumedBy).size !== input.consumedBy.length || typeof input.required !== 'boolean')
        {
            throw new Error('ignored source input requires owner/reason/consumers/required');
        }
        safePath(input.path);
        if (paths.has(input.path)) throw new Error(`duplicate ignored source input: ${input.path}`);
        paths.add(input.path);
    }
}

function inventory(root)
{
    return {
        head: git(root, ['rev-parse', '--verify', 'HEAD^{commit}']).trim(),
        index: git(root, ['ls-files', '--stage', '-z']),
        flags: git(root, ['ls-files', '-v', '-z']),
        untracked: git(root, ['ls-files', '--others', '--exclude-standard', '-z'])
    };
}

function snapshotPayload(receipt)
{
    const { contentDigest, snapshotDigest, diagnostics, ...payload } = receipt;
    return payload;
}

export function verifyRepositorySourceSnapshot(receipt)
{
    const required = ['schema', 'commit', 'repositoryIdentityDigest', 'sourcePolicy', 'sourcePolicyDigest', 'indexEntries',
        'worktreeEntries', 'untrackedEntries', 'submoduleEntries', 'registeredIgnoredInputs', 'entryCount', 'hashedByteCount',
        'snapshotDigest', 'contentDigest', 'diagnostics'];
    if (!receipt || required.some((key) => !Object.hasOwn(receipt, key))
        || Object.keys(receipt).some((key) => !required.includes(key)) || receipt.schema !== repositorySourceSnapshotSchema
        || !/^[a-f0-9]{40}$/u.test(receipt.commit ?? '')) throw new Error('invalid source snapshot schema/fields/commit');
    validatePolicy(receipt.sourcePolicy);
    for (const group of ['indexEntries', 'submoduleEntries', 'worktreeEntries', 'untrackedEntries', 'registeredIgnoredInputs'])
    {
        if (!receipt[group] || Object.getPrototypeOf(receipt[group]) !== Object.prototype) throw new Error(`invalid source inventory: ${group}`);
        for (const [relative, entry] of Object.entries(receipt[group]))
        {
            safePath(relative);
            if (group === 'indexEntries' || group === 'submoduleEntries')
            {
                if (!Array.isArray(entry) || !entry.length || entry.some((item) => !item
                    || Object.keys(item).sort().join(',') !== 'mode,objectId,stage'
                    || !['100644', '100755', '120000', '160000'].includes(item.mode)
                    || !/^[0-9a-f]{40}$/u.test(item.objectId ?? '') || ![0, 1, 2, 3].includes(item.stage))
                    || new Set(entry.map((item) => item.stage)).size !== entry.length)
                {
                    throw new Error(`invalid source index entry: ${relative}`);
                }
            }
            else if (!entry || Object.keys(entry).sort().join(',') !== 'contentDigest,fileType,mode,sizeBytes'
                || !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0 || entry.sizeBytes > maximumFileBytes
                || !['file', 'symlink', 'missing'].includes(entry.fileType)
                || (entry.fileType === 'missing' ? entry.mode !== null || entry.contentDigest !== null || entry.sizeBytes !== 0
                    : !/^sha256:[0-9a-f]{64}$/u.test(entry.contentDigest ?? '')
                        || !(entry.fileType === 'symlink' ? entry.mode === '120000' : ['100644', '100755'].includes(entry.mode))))
            {
                throw new Error(`invalid source content entry: ${relative}`);
            }
        }
    }
    const indexPaths = Object.keys(receipt.indexEntries).sort();
    if (indexPaths.some((relative) => (receipt.indexEntries[relative].some((entry) => entry.mode === '160000')
        ? canonicalJson(receipt.submoduleEntries[relative]) !== canonicalJson(receipt.indexEntries[relative])
        : !Object.hasOwn(receipt.worktreeEntries, relative)))
        || Object.keys(receipt.worktreeEntries).some((relative) => !Object.hasOwn(receipt.indexEntries, relative))
        || Object.keys(receipt.submoduleEntries).some((relative) => !Object.hasOwn(receipt.indexEntries, relative))
        || Object.keys(receipt.untrackedEntries).some((relative) => Object.hasOwn(receipt.indexEntries, relative))
        || canonicalJson(Object.keys(receipt.registeredIgnoredInputs).sort())
            !== canonicalJson(receipt.sourcePolicy.ignoredInputs.map((input) => input.path).sort()))
    {
        throw new Error('source inventory closure mismatch');
    }
    const byteCount = ['worktreeEntries', 'untrackedEntries', 'registeredIgnoredInputs']
        .reduce((sum, group) => sum + Object.values(receipt[group]).reduce((bytes, entry) => bytes + entry.sizeBytes, 0), 0);
    if (receipt.hashedByteCount !== byteCount || receipt.entryCount !== indexPaths.length
        + Object.keys(receipt.untrackedEntries).length + Object.keys(receipt.registeredIgnoredInputs).length)
    {
        throw new Error('source inventory counts mismatch');
    }
    if (digestCanonical(receipt.sourcePolicy) !== receipt.sourcePolicyDigest
        || digestCanonical(snapshotPayload(receipt)) !== receipt.snapshotDigest
        || sealContentDigest(receipt).contentDigest !== receipt.contentDigest) throw new Error('source snapshot digest mismatch');
    return receipt;
}

/** Read the explicit physical Git root without changing index, worktree or refs.
 * Submodule checkout and alias contents belong to the alias collector. */
export function snapshotRepositorySourceIdentity(repositoryRoot, { sourcePolicy } = {})
{
    validatePolicy(sourcePolicy);
    const root = path.resolve(repositoryRoot);
    if (fs.realpathSync(root) !== root || git(root, ['rev-parse', '--show-toplevel']).trim() !== root
        || git(root, ['rev-parse', '--is-inside-work-tree']).trim() !== 'true')
    {
        throw new Error('source collection requires the explicit physical repository root');
    }
    if (git(root, ['rev-parse', '--is-shallow-repository']).trim() !== 'false') throw new Error('shallow source repository is ambiguous');
    const before = inventory(root);
    if (!/^[a-f0-9]{40}$/u.test(before.head)) throw new Error('source HEAD must be full 40-hex');
    for (const flag of before.flags.split('\0').filter(Boolean))
    {
        if (flag[0] !== 'H') throw new Error(`assume-unchanged/skip-worktree/unmerged input is not observable: ${flag.slice(2)}`);
    }
    const indexEntries = {};
    for (const record of before.index.split('\0').filter(Boolean))
    {
        const match = /^(\d{6}) ([a-f0-9]{40}) ([0-3])\t([\s\S]+)$/u.exec(record);
        if (!match) throw new Error('source index record is invalid');
        const [, mode, objectId, stage, relative] = match;
        safePath(relative);
        if (!['100644', '100755', '120000', '160000'].includes(mode)) throw new Error(`unsupported source index mode: ${relative}`);
        if (mode !== '160000') git(root, ['cat-file', '-e', `${objectId}^{blob}`]);
        (indexEntries[relative] ??= []).push({ mode, objectId, stage: Number(stage) });
    }
    const worktreeEntries = {};
    const untrackedEntries = {};
    const submoduleEntries = {};
    const registeredIgnoredInputs = {};
    let hashedByteCount = 0;
    for (const relative of Object.keys(indexEntries).sort())
    {
        const entries = indexEntries[relative];
        if (entries.some((entry) => entry.mode === '160000'))
        {
            submoduleEntries[relative] = entries;
            continue;
        }
        const entry = readEntry(root, relative);
        worktreeEntries[relative] = entry;
        hashedByteCount += entry.sizeBytes;
    }
    const untracked = before.untracked.split('\0').filter(Boolean).sort();
    if (sourcePolicy.untracked === 'reject' && untracked.length) throw new Error(`source policy rejects untracked inputs: ${untracked.join(', ')}`);
    for (const relative of untracked)
    {
        const entry = readEntry(root, relative);
        if (entry.fileType === 'missing') throw new Error(`source untracked input disappeared: ${relative}`);
        untrackedEntries[relative] = entry;
        hashedByteCount += entry.sizeBytes;
    }
    for (const input of sourcePolicy.ignoredInputs)
    {
        const ignored = git(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', input.path]);
        if (!ignored.split('\0').includes(input.path)) throw new Error(`registered input is not an exact ignored file: ${input.path}`);
        const entry = readEntry(root, input.path);
        if (input.required && entry.fileType === 'missing') throw new Error(`required ignored input missing: ${input.path}`);
        registeredIgnoredInputs[input.path] = entry;
        hashedByteCount += entry.sizeBytes;
    }
    // Reobserve every byte as well as Git metadata. Stat checks alone cannot
    // detect a file changed after it was individually read earlier in a scan.
    for (const entries of [worktreeEntries, untrackedEntries, registeredIgnoredInputs])
    {
        for (const [relative, entry] of Object.entries(entries))
        {
            if (canonicalJson(entry) !== canonicalJson(readEntry(root, relative))) throw new Error(`source changed during snapshot: ${relative}`);
        }
    }
    if (canonicalJson(before) !== canonicalJson(inventory(root))) throw new Error('source Git inventory changed during snapshot');
    const normalizedPolicy = { ...sourcePolicy, ignoredInputs: [...sourcePolicy.ignoredInputs]
        .map((input) => ({ ...input, consumedBy: [...input.consumedBy].sort() })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) };
    const payload = {
        schema: repositorySourceSnapshotSchema, commit: before.head,
        repositoryIdentityDigest: digestCanonical({ rootCommits: git(root, ['rev-list', '--max-parents=0', 'HEAD']).trim().split('\n').sort() }),
        sourcePolicy: normalizedPolicy, sourcePolicyDigest: digestCanonical(normalizedPolicy),
        indexEntries, worktreeEntries, untrackedEntries, submoduleEntries, registeredIgnoredInputs,
        entryCount: Object.keys(indexEntries).length + untracked.length + sourcePolicy.ignoredInputs.length, hashedByteCount
    };
    return sealContentDigest({ ...payload, snapshotDigest: digestCanonical(payload), diagnostics: { repositoryRoot: root } });
}

export function diffRepositorySourceSnapshots(before, after)
{
    verifyRepositorySourceSnapshot(before);
    verifyRepositorySourceSnapshot(after);
    const changes = [];
    for (const group of ['indexEntries', 'worktreeEntries', 'untrackedEntries', 'submoduleEntries', 'registeredIgnoredInputs'])
    {
        for (const relative of [...new Set([...Object.keys(before[group]), ...Object.keys(after[group])])].sort())
        {
            if (canonicalJson(before[group][relative] ?? null) !== canonicalJson(after[group][relative] ?? null))
            {
                changes.push({ group, path: relative, before: before[group][relative] ?? null, after: after[group][relative] ?? null });
            }
        }
    }
    for (const field of ['commit', 'repositoryIdentityDigest', 'sourcePolicyDigest'])
    {
        if (before[field] !== after[field]) changes.push({ field, before: before[field], after: after[field] });
    }
    return changes;
}
