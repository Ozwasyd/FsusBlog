import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const { canonicalJson, digestCanonical, sealContentDigest, sha256 } = await import(new URL('../test/attempt-provenance.mjs', import.meta.url));
const { snapshotRepositorySourceIdentity, verifyRepositorySourceSnapshot } = await import(new URL('../test/repository-source-snapshot.mjs', import.meta.url));

export const submoduleCheckoutIdentitySchema = 'fsusblog.candidate-submodule-checkouts.v1';

function git(root, args, allowedStatuses = [0])
{
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    const result = spawnSync('git', ['--no-replace-objects', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-C', root, ...args], {
        env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
        maxBuffer: 128 * 1024 * 1024
    });
    if (result.error || !allowedStatuses.includes(result.status))
    {
        throw new Error(`submodule git ${args[0]} failed: ${result.error?.message ?? result.stderr.toString()}`);
    }
    return result;
}

function relativePath(value)
{
    if (typeof value !== 'string' || value !== value.normalize('NFC') || value.includes('\\') || path.posix.isAbsolute(value)
        || value.split('/').some((part) => !part || part === '.' || part === '..' || part === '.git'))
    {
        throw new Error(`submodule path is not canonical/contained: ${value}`);
    }
    return value;
}

function physicalCheckout(root, relative)
{
    let current = root;
    for (const part of relativePath(relative).split('/'))
    {
        current = path.join(current, part);
        const stat = fs.lstatSync(current);
        if (!stat.isDirectory() || stat.isSymbolicLink())
        {
            throw new Error(`submodule checkout is not a physical directory: ${relative}`);
        }
    }
    return current;
}

function urlClass(value)
{
    if (typeof value !== 'string' || !value || value.includes('\n') || value.includes('\0'))
    {
        throw new Error('submodule URL declaration is missing/invalid');
    }
    if (/^\.{1,2}\//u.test(value))
    {
        return 'relative';
    }
    if (path.isAbsolute(value) || /^file:/u.test(value))
    {
        return 'local';
    }
    if (/^(?:https?|ssh|git):\/\//u.test(value))
    {
        const url = new URL(value);
        if (!url.hostname || url.password)
        {
            throw new Error('submodule remote URL is invalid or contains credentials');
        }
        return url.protocol.slice(0, -1);
    }
    if (/^(?:[^@/:]+@)?[^/:]+:.+$/u.test(value))
    {
        return 'ssh-scp';
    }
    throw new Error('submodule URL class is unsupported/ambiguous');
}

function declarations(root, parentSnapshot)
{
    const pointers = Object.keys(parentSnapshot.submoduleEntries).sort();
    const source = parentSnapshot.worktreeEntries['.gitmodules'];
    if (!source || source.fileType === 'missing')
    {
        if (pointers.length)
        {
            throw new Error('Git index pointers require an observed .gitmodules declaration');
        }
        return [];
    }
    if (source.fileType !== 'file' || !parentSnapshot.indexEntries['.gitmodules'])
    {
        throw new Error('.gitmodules must be a tracked regular source input');
    }
    const output = git(root, ['config', '--no-includes', '--file', path.join(root, '.gitmodules'), '--null', '--list']).stdout.toString();
    const modules = new Map();
    for (const item of output.split('\0').filter(Boolean))
    {
        const newline = item.indexOf('\n');
        const key = item.slice(0, newline);
        const value = item.slice(newline + 1);
        const match = /^submodule\.([a-z][a-z0-9._-]*)\.(path|url|branch|update|ignore|shallow)$/u.exec(key);
        if (newline < 0 || !match)
        {
            throw new Error(`unsupported submodule declaration: ${key}`);
        }
        const [, id, field] = match;
        const module = modules.get(id) ?? { id };
        if (Object.hasOwn(module, field))
        {
            throw new Error(`duplicate submodule declaration: ${key}`);
        }
        module[field] = value;
        modules.set(id, module);
    }
    const result = [...modules.values()].map((module) => ({ id: module.id, path: relativePath(module.path), urlIdentityClass: urlClass(module.url) }))
        .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const paths = result.map((module) => module.path).sort();
    if (new Set(paths).size !== paths.length || canonicalJson(paths) !== canonicalJson(pointers))
    {
        throw new Error('.gitmodules declarations and parent Git index pointers must have exact closure');
    }
    return result;
}

function checkoutDirty(root, snapshot)
{
    if (Object.keys(snapshot.untrackedEntries).length || git(root, ['diff', '--no-ext-diff', '--no-textconv', '--cached', '--quiet', 'HEAD', '--'], [0, 1]).status === 1)
    {
        return true;
    }
    for (const [relative, index] of Object.entries(snapshot.indexEntries))
    {
        const actual = snapshot.worktreeEntries[relative];
        if (index.length !== 1 || index[0].stage !== 0 || !actual || actual.fileType === 'missing'
            || actual.mode !== index[0].mode || sha256(git(root, ['cat-file', 'blob', index[0].objectId]).stdout) !== actual.contentDigest)
        {
            return true;
        }
    }
    return false;
}

/** Independently usable submodule portion of #2658. This is NOT an alias
 * fragment or aggregate admission. No checkout/init/fetch/install is invoked.
 * Nested checkout support and declaration-owner alias inventory remain unmet. */
export function collectSubmoduleCheckoutIdentities({ repositoryRoot, parentSnapshot, targetPolicies })
{
    verifyRepositorySourceSnapshot(parentSnapshot);
    const root = path.resolve(repositoryRoot);
    const observeParent = () => snapshotRepositorySourceIdentity(root, { sourcePolicy: parentSnapshot.sourcePolicy });
    if (observeParent().snapshotDigest !== parentSnapshot.snapshotDigest)
    {
        throw new Error('submodule parent source snapshot is stale/cross-source');
    }
    const inventory = declarations(root, parentSnapshot);
    if (!targetPolicies || Object.getPrototypeOf(targetPolicies) !== Object.prototype
        || canonicalJson(Object.keys(targetPolicies).sort()) !== canonicalJson(inventory.map((module) => module.path).sort()))
    {
        throw new Error('submodule target policies must exactly cover declared checkout paths');
    }
    const checkouts = {};
    const observed = [];
    for (const module of inventory)
    {
        const pointer = parentSnapshot.submoduleEntries[module.path];
        if (pointer.length !== 1 || pointer[0].stage !== 0 || pointer[0].mode !== '160000')
        {
            throw new Error(`submodule parent pointer is conflicted/ambiguous: ${module.id}`);
        }
        const checkoutRoot = physicalCheckout(root, module.path);
        const snapshot = snapshotRepositorySourceIdentity(checkoutRoot, { sourcePolicy: targetPolicies[module.path] });
        if (snapshot.commit !== pointer[0].objectId)
        {
            throw new Error(`submodule pointer/checkout HEAD mismatch: ${module.id}`);
        }
        if (Object.keys(snapshot.submoduleEntries).length)
        {
            throw new Error(`nested submodule checkout closure capability is required: ${module.id}`);
        }
        checkouts[module.id] = { path: module.path, parentPointer: pointer[0].objectId, checkoutCommit: snapshot.commit,
            repositoryIdentityDigest: snapshot.repositoryIdentityDigest, worktreeFingerprint: snapshot.snapshotDigest,
            sourcePolicyDigest: snapshot.sourcePolicyDigest, urlIdentityClass: module.urlIdentityClass,
            initialized: true, dirty: checkoutDirty(checkoutRoot, snapshot) };
        observed.push({ root: checkoutRoot, snapshot });
    }
    for (const target of observed)
    {
        if (snapshotRepositorySourceIdentity(target.root, { sourcePolicy: target.snapshot.sourcePolicy }).snapshotDigest !== target.snapshot.snapshotDigest)
        {
            throw new Error('submodule checkout changed during collection');
        }
    }
    if (observeParent().snapshotDigest !== parentSnapshot.snapshotDigest)
    {
        throw new Error('submodule parent changed during collection');
    }
    return sealContentDigest({ schema: submoduleCheckoutIdentitySchema, status: 'verified', warnings: [],
        sourceCommit: parentSnapshot.commit, parentSnapshotDigest: parentSnapshot.snapshotDigest,
        declarationDigest: digestCanonical(inventory), checkouts });
}

/** Recollect from explicit current inputs; a rehashed synthetic receipt is not
 * evidence that the declared physical checkout still has the same contents. */
export function verifySubmoduleCheckoutIdentities(receipt, inputs)
{
    const actual = collectSubmoduleCheckoutIdentities(inputs);
    if (canonicalJson(actual) !== canonicalJson(receipt))
    {
        throw new Error('submodule checkout identity content/current-source mismatch');
    }
    return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    process.stderr.write('complete source-alias admission requires the canonical resolver declaration inventory and package/lock binding capability; submodule-only output is not a candidate fragment\n');
    process.exitCode = 1;
}
