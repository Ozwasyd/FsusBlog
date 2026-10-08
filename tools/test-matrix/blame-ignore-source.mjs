import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const metadataPath = '.git-blame-ignore-revs';
const authorityPaths = Object.freeze([
    'commitlint.config.mjs',
    'docs/development/native-tooling-style-enforcement.md',
    'tools/governance/change-contract.mjs',
    'tools/governance/change-contract-registry.mjs',
    'tools/governance/generated-output-digest-repair-repository.mjs',
    'tools/governance/generated-output-digest-repair-v2.mjs',
    'tools/governance/generated-output-history-repair-v3.mjs',
    'tools/governance/javascript-format-equivalence.mjs',
    'tools/governance/javascript-format-parser/package.json',
    'tools/governance/javascript-format-parser/package-lock.json'
]);
const schema = 'fsusblog.blame-ignore-source-check.v1';
const revisionPattern = /^[a-f0-9]{40}$/u;
const validatedReceipts = new WeakSet();

export function isValidatedBlameIgnoreSourceReceipt(receipt)
{
    return receipt !== null && typeof receipt === 'object' && validatedReceipts.has(receipt);
}

function git(root, args)
{
    return execFileSync('git', ['-C', root, ...args], { maxBuffer: 16 * 1024 * 1024 });
}

function digest(bytes)
{
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function epoch(stat)
{
    return ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs']
        .map(key => String(stat[key]));
}

function freezeProof(value)
{
    for (const child of Object.values(value))
    {
        if (child !== null && typeof child === 'object')
        {
            freezeProof(child);
        }
    }
    return Object.freeze(value);
}

function bindFile(root, file, base = null)
{
    let ancestor = root;
    const ancestors = [];
    for (const part of ['.', ...file.split('/').slice(0, -1)])
    {
        ancestor = path.resolve(ancestor, part);
        const stat = fs.lstatSync(ancestor, { bigint: true });
        if (!stat.isDirectory() || stat.isSymbolicLink())
        {
            throw new Error(`blame source linked ancestor: ${file}`);
        }
        ancestors.push({ path: ancestor, epoch: epoch(stat) });
    }
    const absolute = path.join(root, file);
    const descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try
    {
        const before = fs.fstatSync(descriptor, { bigint: true });
        if (!before.isFile() || before.nlink !== 1n || before.size > 16n * 1024n * 1024n
            || ![0o600n, 0o644n].includes(before.mode & 0o777n))
        {
            throw new Error(`blame source requires bounded regular nonexecutable text: ${file}`);
        }
        const bytes = fs.readFileSync(descriptor);
        if (!Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes) || bytes.includes(0))
        {
            throw new Error(`blame source requires exact UTF-8 text: ${file}`);
        }
        const index = git(root, ['ls-files', '--stage', '-z', '--', `:(literal)${file}`]).toString('utf8');
        const entry = index.match(/^100644 ([a-f0-9]{40}) 0\t([^\0]+)\0$/u);
        const head = git(root, ['ls-tree', '-z', 'HEAD', '--', `:(literal)${file}`]).toString('utf8')
            .match(/^100644 blob ([a-f0-9]{40})\t([^\0]+)\0$/u);
        if (!entry || entry[2] !== file || !git(root, ['cat-file', 'blob', entry[1]]).equals(bytes)
            || !head || head[2] !== file || head[1] !== entry[1])
        {
            throw new Error(`blame source HEAD/index/physical bytes disagree: ${file}`);
        }
        let baseBlob = null;
        if (base !== null)
        {
            const tree = git(root, ['ls-tree', '-z', base, '--', `:(literal)${file}`]).toString('utf8');
            const trusted = tree.match(/^100644 blob ([a-f0-9]{40})\t([^\0]+)\0$/u);
            if (!trusted || trusted[2] !== file || trusted[1] !== entry[1])
            {
                throw new Error(`blame source cannot replace previous-trusted authority: ${file}`);
            }
            baseBlob = trusted[1];
        }
        if (!isDeepStrictEqual(epoch(before), epoch(fs.fstatSync(descriptor, { bigint: true })))
            || !isDeepStrictEqual(epoch(before), epoch(fs.lstatSync(absolute, { bigint: true })))
            || ancestors.some(value => !isDeepStrictEqual(value.epoch,
                epoch(fs.lstatSync(value.path, { bigint: true })))))
        {
            throw new Error(`blame source changed during held-byte inspection: ${file}`);
        }
        return { path: file, contentDigest: digest(bytes), indexDigest: digest(bytes),
            headBlob: entry[1], baseBlob, epoch: epoch(before) };
    }
    finally
    {
        fs.closeSync(descriptor);
    }
}

function bindInputs(root, base, expectedHead)
{
    if (typeof base !== 'string' || !revisionPattern.test(base)
        || typeof expectedHead !== 'string' || !revisionPattern.test(expectedHead)
        || git(root, ['rev-parse', `${base}^{commit}`]).toString('utf8').trim() !== base
        || git(root, ['rev-parse', 'HEAD']).toString('utf8').trim() !== expectedHead)
    {
        throw new Error('blame source requires exact trusted base and current HEAD');
    }
    return { metadata: bindFile(root, metadataPath),
        authority: authorityPaths.map(file => bindFile(root, file, base)) };
}

export function validateBlameIgnoreSourceReceipt({ repositoryRoot, trustedBaseCommit, expectedHead, receipt })
{
    const root = path.resolve(repositoryRoot);
    if (!isDeepStrictEqual(Object.keys(receipt ?? {}).sort(),
        ['schema', 'status', 'qualificationEligible', 'head', 'trustedBase', 'metadata', 'authority', 'errors'].sort())
        || receipt.schema !== schema || receipt.status !== 'success' || receipt.qualificationEligible !== false
        || receipt.head !== expectedHead || receipt.trustedBase !== trustedBaseCommit
        || !Array.isArray(receipt.errors) || receipt.errors.length)
    {
        throw new Error('blame source receipt is not a successful bound source-only check');
    }
    const current = bindInputs(root, trustedBaseCommit, expectedHead);
    if (!isDeepStrictEqual(current.metadata, receipt.metadata)
        || !isDeepStrictEqual(current.authority, receipt.authority))
    {
        throw new Error('blame source receipt input identity or previous-trusted closure drifted');
    }
    freezeProof(receipt);
    validatedReceipts.add(receipt);
    return receipt;
}

async function run({ repositoryRoot, trustedBaseCommit, expectedHead })
{
    const root = path.resolve(repositoryRoot);
    // This CLI is a fresh child. The complete original owner closure must still
    // equal the previous-trusted Git blobs before any of it is loaded or invoked.
    if (fs.realpathSync(root) !== root)
    {
        throw new Error('blame source refuses a linked repository root');
    }
    const before = bindInputs(root, trustedBaseCommit, expectedHead);
    const owner = fileURLToPath(new URL('../governance/change-contract.mjs', import.meta.url));
    if (owner !== path.join(root, 'tools/governance/change-contract.mjs'))
    {
        throw new Error('blame source owner must belong to the bound repository');
    }
    const { validateRepositoryBlameIgnore } = await import(new URL('../governance/change-contract.mjs', import.meta.url));
    const errors = validateRepositoryBlameIgnore(root);
    const after = bindInputs(root, trustedBaseCommit, expectedHead);
    if (!isDeepStrictEqual(before, after))
    {
        throw new Error('blame source input changed during original validation');
    }
    if (!Array.isArray(errors) || errors.some(error => typeof error !== 'string'))
    {
        throw new Error('original blame validator returned an invalid result');
    }
    return { schema, status: errors.length ? 'failure' : 'success', qualificationEligible: false,
        head: expectedHead, trustedBase: trustedBaseCommit,
        metadata: before.metadata, authority: before.authority, errors };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    try
    {
        const options = {};
        const names = new Map([['--root', 'repositoryRoot'], ['--base', 'trustedBaseCommit'], ['--head', 'expectedHead']]);
        for (let index = 2; index < process.argv.length; index += 2)
        {
            const name = names.get(process.argv[index]);
            if (!name || options[name] !== undefined || !process.argv[index + 1])
            {
                throw new Error('invalid blame source arguments');
            }
            options[name] = process.argv[index + 1];
        }
        if (Object.keys(options).length !== names.size)
        {
            throw new Error('blame source requires --root, --base and --head');
        }
        const receipt = await run(options);
        process.stdout.write(`${JSON.stringify(receipt)}\n`);
        process.exitCode = receipt.status === 'success' ? 0 : 1;
    }
    catch (error)
    {
        console.error(error.message);
        process.exitCode = 1;
    }
}
