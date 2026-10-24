#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const {
    canonicalTestDeclarationBindingFile,
    canonicalTestDeclarationModules,
    canonicalTestDeclarationOutputs,
    canonicalTestDeclarationProducer,
    canonicalTestDeclarationReadOnlyInputs
} = await import(new URL('../frontend/canonical-test-declaration-inputs.mjs', import.meta.url));
const { generateCanonicalTestDeclarations } = await import(
    new URL('../frontend/generate-canonical-test-declarations.mjs', import.meta.url)
);

import { projectCanonicalWorkspaceSourceAliases } from './canonical-workspace-source.mjs';
import { bindSourceFile, verifySourceFileBinding } from './check-solution-source.mjs';

const { resolveLocalFsusUiRepositoryRoot } = await import(
    new URL('../../src/frontend/scripts/fsusui-root.mjs', import.meta.url)
);
const { inspectLocalFsusUiPublicDependencyBindings } = await import(
    new URL('../../src/frontend/scripts/prepare-local-fsusui-install.mjs', import.meta.url)
);

const authorityRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const compilerRequire = createRequire(new URL('../frontend/style-toolchain/package.json', import.meta.url));
const schema = 'fsusblog.canonical-declaration-source.v1';
const inputOwner = 'tools/frontend/canonical-test-declaration-inputs.mjs';
const compilerLock = 'tools/frontend/style-toolchain/package-lock.json';
const generatedProject = 'src/frontend/.tmp/typecheck/tsconfig.fsusui-local.tests.generated.json';
const publicInstallOwner = 'src/frontend/scripts/prepare-local-fsusui-install.mjs';
const codeOwners = [canonicalTestDeclarationProducer, inputOwner,
    'src/frontend/scripts/fsusui-root.mjs', 'src/frontend/scripts/run-local-fsusui-typecheck.mjs', publicInstallOwner];
export const canonicalDeclarationSourceLimits = Object.freeze({
    fileBytes: 8 * 1024 * 1024, batchBytes: 256 * 1024 * 1024,
    files: 8192, probes: 262144, directoryEntries: 16384, compilerBytes: 32 * 1024 * 1024
});

function digest(bytes)
{
    return createHash('sha256').update(bytes).digest('hex');
}

function epoch(stat)
{
    return Object.fromEntries(['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs']
        .map(key => [key, stat[key].toString()]));
}

function sameEpoch(before, after)
{
    return isDeepStrictEqual(epoch(before), epoch(after));
}

function contained(root, file)
{
    return file === root || file.startsWith(root + path.sep);
}

function git(root, args)
{
    return execFileSync('git', ['-C', root, '--no-replace-objects', '-c', 'core.fsmonitor=false', ...args], {
        env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0' },
        maxBuffer: 64 * 1024 * 1024
    });
}

function repository(root)
{
    root = path.resolve(root);
    if (fs.realpathSync(root) !== root || !fs.lstatSync(root).isDirectory()
        || git(root, ['rev-parse', '--show-toplevel']).toString().trim() !== root)
    {
        throw new Error('canonical declarations require the actual canonical Git repository root');
    }
    const contextNames = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
        'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_REPLACE_REF_BASE', 'GIT_GRAFT_FILE',
        'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS'];
    if (contextNames.some(name => process.env[name] !== undefined)
        || git(root, ['for-each-ref', '--format=%(refname)', 'refs/replace/']).length
        || fs.existsSync(git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'info/grafts']).toString().trim())
        || fs.existsSync(git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'objects/info/alternates']).toString().trim()))
    {
        throw new Error('canonical declarations refuse a rewritten or alternate Git context');
    }
    const head = git(root, ['rev-parse', 'HEAD']).toString().trim();
    if (!/^[a-f0-9]{40}$/u.test(head) || git(root, ['cat-file', '-t', head]).toString().trim() !== 'commit')
    {
        throw new Error('canonical declarations require an exact Git commit');
    }
    const indexBytes = git(root, ['ls-files', '--stage', '-z']);
    const treeBytes = git(root, ['ls-tree', '-r', '-z', head]);
    const index = new Map();
    for (const record of indexBytes.toString().split('\0').filter(Boolean))
    {
        const match = /^(100644|100755|120000|160000) ([a-f0-9]{40}) 0\t(.+)$/u.exec(record);
        if (!match || index.has(match[3]))
        {
            throw new Error('canonical declarations require a complete unambiguous stage-zero index');
        }
        index.set(match[3], { mode: match[1], blob: match[2] });
    }
    const tree = new Map();
    for (const record of treeBytes.toString().split('\0').filter(Boolean))
    {
        const match = /^(100644|100755|120000|160000) (?:blob|commit) ([a-f0-9]{40})\t(.+)$/u.exec(record);
        if (!match || tree.has(match[3]))
        {
            throw new Error('canonical declarations require a complete unambiguous HEAD tree');
        }
        tree.set(match[3], { mode: match[1], blob: match[2] });
    }
    const ordered = values => [...values].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    if (!isDeepStrictEqual(ordered(index), ordered(tree)))
    {
        throw new Error('canonical declaration HEAD and complete index disagree');
    }
    return { root, head, index, indexDigest: digest(indexBytes) };
}

function rawRead(absolute, maximumBytes)
{
    const descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try
    {
        const before = fs.fstatSync(descriptor, { bigint: true });
        if (!before.isFile() || before.nlink !== 1n
            || !sameEpoch(before, fs.lstatSync(absolute, { bigint: true }))
            || before.size > BigInt(maximumBytes))
        {
            throw new Error('canonical declaration input requires one bounded regular single-link file: ' + absolute);
        }
        const chunks = [];
        const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maximumBytes + 1));
        let length = 0;
        while (length <= maximumBytes)
        {
            const count = fs.readSync(descriptor, buffer, 0,
                Math.min(buffer.length, maximumBytes + 1 - length), null);
            if (!count)
            {
                break;
            }
            length += count;
            if (length > maximumBytes)
            {
                throw new Error('canonical declaration input grew beyond its byte limit: ' + absolute);
            }
            chunks.push(Buffer.from(buffer.subarray(0, count)));
        }
        const bytes = Buffer.concat(chunks, length);
        if (!sameEpoch(before, fs.fstatSync(descriptor, { bigint: true }))
            || !sameEpoch(before, fs.lstatSync(absolute, { bigint: true })))
        {
            throw new Error('canonical declaration input changed during its descriptor read: ' + absolute);
        }
        return { bytes, epoch: epoch(before), mode: Number(before.mode & 0o777n) };
    }
    finally
    {
        fs.closeSync(descriptor);
    }
}

function decode(bytes)
{
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe)
    {
        return bytes.subarray(2).toString('utf16le');
    }
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff)
    {
        return Buffer.from(bytes.subarray(2)).swap16().toString('utf16le');
    }
    const text = bytes.toString('utf8');
    if (!Buffer.from(text).equals(bytes))
    {
        throw new Error('canonical declaration compiler input is not exact UTF-8');
    }
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function boundedDirectoryEntries(directory, maximum)
{
    const handle = fs.opendirSync(directory);
    const entries = [];
    try
    {
        for (let entry = handle.readSync(); entry; entry = handle.readSync())
        {
            if (entries.length >= maximum)
            {
                throw new Error('canonical declaration directory inventory exceeds its remaining entry bound');
            }
            entries.push(entry);
        }
        return entries.sort((left, right) => left.name.localeCompare(right.name));
    }
    finally
    {
        handle.closeSync();
    }
}

export function inspectCanonicalWorkspaceParser(lock, remainingBytes = canonicalDeclarationSourceLimits.batchBytes)
{
    const locked = lock.packages?.['node_modules/js-yaml'];
    if (locked?.version !== '4.3.2' || !/^https:\/\/registry\.npmjs\.org\/js-yaml\/-\/js-yaml-/u.test(locked.resolved ?? '')
        || !/^sha512-/u.test(locked.integrity ?? ''))
    {
        throw new Error('canonical workspace parser requires its original executing authority lock');
    }
    const root = path.join(authorityRoot, 'tools/frontend/style-toolchain/node_modules/js-yaml');
    const inputs = new Map();
    const directories = new Map();
    const budget = Math.min(canonicalDeclarationSourceLimits.batchBytes, remainingBytes);
    let bytes = 0;
    let entryCount = 0;
    const rootStat = fs.lstatSync(root, { bigint: true });
    const rootEntries = boundedDirectoryEntries(root, 64).map(value => value.name).sort();
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || fs.realpathSync(root) !== root || rootEntries.length > 64)
    {
        throw new Error('canonical workspace parser requires one bounded exact authority package directory');
    }
    directories.set(root, { directory: root, epoch: epoch(rootStat), entries: rootEntries });
    const hold = file =>
    {
        if (inputs.size >= 64 || fs.realpathSync(file) !== file)
        {
            throw new Error('canonical workspace parser refuses an oversized or linked implementation closure');
        }
        const input = rawRead(file, Math.min(canonicalDeclarationSourceLimits.fileBytes, budget - bytes));
        bytes += input.bytes.length;
        inputs.set(file, { file, sha256: digest(input.bytes), epoch: input.epoch, bytes: input.bytes.length });
        return input.bytes;
    };
    const walk = (directory, depth = 0) =>
    {
        if (directories.size >= canonicalDeclarationSourceLimits.files || depth >= 64)
        {
            throw new Error('canonical workspace parser implementation directory depth or count exceeds its bound');
        }
        const stat = fs.lstatSync(directory, { bigint: true });
        if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory)
        {
            throw new Error('canonical workspace parser refuses a linked implementation directory');
        }
        const entries = boundedDirectoryEntries(directory, canonicalDeclarationSourceLimits.directoryEntries - entryCount);
        entryCount += entries.length;
        if (entryCount > canonicalDeclarationSourceLimits.directoryEntries)
        {
            throw new Error('canonical workspace parser implementation directory exceeds its bound');
        }
        directories.set(directory, { directory, epoch: epoch(stat), entries: entries.map(value => value.name).sort() });
        for (const entry of entries)
        {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory())
            {
                walk(file, depth + 1);
            }
            else if (entry.isFile())
            {
                hold(file);
            }
            else
            {
                throw new Error('canonical workspace parser refuses an unknown implementation entry');
            }
        }
    };
    const installed = JSON.parse(hold(path.join(root, 'package.json')));
    hold(path.join(root, 'index.js'));
    walk(path.join(root, 'lib'));
    if (installed.name !== 'js-yaml' || installed.version !== locked.version
        || compilerRequire.resolve('js-yaml') !== path.join(root, 'index.js'))
    {
        throw new Error('canonical workspace parser installed identity differs from its authority lock');
    }
    // Reusing a previously cached export would not prove which bytes created it.
    // Load only this already bound authority package afresh, then recheck its actual execution closure.
    for (const file of Object.keys(compilerRequire.cache))
    {
        if (contained(root, file))
        {
            delete compilerRequire.cache[file];
        }
    }
    const parser = compilerRequire('js-yaml');
    const closure = new Set();
    const visit = module =>
    {
        if (!module || closure.has(module.filename))
        {
            return;
        }
        if (!inputs.has(module.filename))
        {
            throw new Error('canonical workspace parser executed a module outside its held implementation closure');
        }
        closure.add(module.filename);
        module.children.forEach(visit);
    };
    visit(compilerRequire.cache[compilerRequire.resolve('js-yaml')]);
    const verify = () =>
    {
        for (const value of inputs.values())
        {
            const actual = rawRead(value.file, canonicalDeclarationSourceLimits.fileBytes);
            if (fs.realpathSync(value.file) !== value.file
                || digest(actual.bytes) !== value.sha256 || !isDeepStrictEqual(actual.epoch, value.epoch))
            {
                throw new Error('canonical workspace parser implementation changed during inspection');
            }
        }
        for (const value of directories.values())
        {
            if (fs.realpathSync(value.directory) !== value.directory
                || !isDeepStrictEqual(epoch(fs.lstatSync(value.directory, { bigint: true })), value.epoch)
                || !isDeepStrictEqual(boundedDirectoryEntries(value.directory, value.entries.length)
                    .map(entry => entry.name).sort(), value.entries))
            {
                throw new Error('canonical workspace parser implementation directory changed during inspection');
            }
        }
        return { lock: Object.fromEntries(['version', 'resolved', 'integrity'].map(key => [key, locked[key]])),
            schema: 'FAILSAFE_SCHEMA', inputs: [...inputs.values()], directories: [...directories.values()],
            executed: [...closure].sort() };
    };
    verify();
    return { parse: text => parser.load(text, { schema: parser.FAILSAFE_SCHEMA }), verify,
        bytes };
}

function assertScratchNamespace(root)
{
    const parts = generatedProject.split('/');
    let current = root;
    for (let index = 0; index < parts.length; index += 1)
    {
        current = path.join(current, parts[index]);
        let stat;
        try
        {
            stat = fs.lstatSync(current, { bigint: true });
        }
        catch (error)
        {
            if (error.code === 'ENOENT')
            {
                return;
            }
            throw error;
        }
        if (stat.isSymbolicLink() || (index === parts.length - 1
            ? !stat.isFile() || stat.nlink !== 1n : !stat.isDirectory()))
        {
            throw new Error('canonical declaration scratch namespace refuses linked or nonregular components: ' + current);
        }
    }
}

/** Prove a missing directory without following links or accepting an existing final entry. */
export function inspectCanonicalPeerDirectoryAbsence(directory)
{
    if (typeof directory !== 'string' || !path.isAbsolute(directory) || path.resolve(directory) !== directory
        || directory.includes('\0'))
    {
        throw new Error('canonical peer directory absence requires one exact absolute path');
    }
    const parsed = path.parse(directory);
    const parts = directory.slice(parsed.root.length).split(path.sep).filter(Boolean);
    let current = parsed.root;
    const ancestors = [];
    for (let index = -1; index < parts.length; index += 1)
    {
        if (index >= 0)
        {
            current = path.join(current, parts[index]);
        }
        let stat;
        try
        {
            stat = fs.lstatSync(current, { bigint: true });
        }
        catch (error)
        {
            if (error.code === 'ENOENT')
            {
                return { directory, missing: current, ancestors };
            }
            throw error;
        }
        if (stat.isSymbolicLink())
        {
            throw new Error('canonical peer directory absence refuses a linked component: ' + current);
        }
        if (current === directory || !stat.isDirectory())
        {
            throw new Error('canonical peer directory absence refuses an existing entry: ' + current);
        }
        ancestors.push({ directory: current, epoch: epoch(stat) });
    }
    throw new Error('canonical peer directory absence could not establish a missing component');
}

/** Bind the one pnpm link itself; descendants remain exact Git paths under its canonical source target. */
export function inspectCanonicalWorkspaceSourceAlias(value)
{
    const stat = fs.lstatSync(value.logical, { bigint: true });
    if (!stat.isSymbolicLink())
    {
        throw new Error('canonical declaration workspace source requires its original pnpm symlink');
    }
    const link = fs.readlinkSync(value.logical);
    if (path.isAbsolute(link) || path.resolve(path.dirname(value.logical), link) !== value.target
        || fs.realpathSync(value.logical) !== value.target || fs.realpathSync(value.target) !== value.target
        || (value.epoch && !isDeepStrictEqual(value.epoch, epoch(stat)))
        || (value.link !== undefined && value.link !== link))
    {
        throw new Error('canonical declaration workspace source alias differs from its original locked target: ' + value.logical);
    }
    return { ...value, link, epoch: epoch(stat) };
}

function captureCompilerReads(ts, repositories, main, ui, publicInputs, initialBytes, parser)
{
    const original = { ...ts.sys };
    const reads = new Map();
    const logicalReads = new Map();
    const contents = new Map();
    const virtualConfigurations = new Map();
    const probes = new Map();
    const peerDirectoryDerivations = new Map();
    const missingPeerDirectories = new Map();
    const ancestors = new Map();
    let total = initialBytes;
    // TypeScript catches some host read errors; a refused capability must still fail admission.
    let refused = null;
    let publicAliases = null;
    let workspaceSources = { configured: false, selectors: [], members: [], aliases: [] };
    const workspaceNamespaces = new Map();
    let workspaceNamespaceEntries = 0;
    const ancestorsForLookup = new Set();
    for (const repo of repositories)
    {
        let directory = repo.root;
        while (true)
        {
            ancestorsForLookup.add(directory);
            const parent = path.dirname(directory);
            if (parent === directory)
            {
                break;
            }
            directory = parent;
        }
    }
    const withinRepositories = absolute => repositories.some(value => contained(value.root, absolute));
    const metadataLookup = absolute => withinRepositories(absolute) || ancestorsForLookup.has(absolute)
        || [...ancestorsForLookup].some(directory => absolute === path.join(directory, 'package.json')
            || contained(path.join(directory, 'node_modules'), absolute));
    const validatePublicAlias = value =>
    {
        const stat = fs.lstatSync(value.logical, { bigint: true });
        if (!stat.isSymbolicLink() || fs.readlinkSync(value.logical) !== value.target
            || fs.realpathSync(value.logical) !== value.target || fs.realpathSync(value.target) !== value.target
            || (value.epoch && !isDeepStrictEqual(value.epoch, epoch(stat))))
        {
            throw new Error('canonical declaration public dependency alias differs from its original locked target: ' + value.logical);
        }
        observeAncestors(ui, value.logical);
        return { ...value, epoch: epoch(stat) };
    };
    const resolvePublicAliases = () =>
    {
        if (!publicAliases)
        {
            if (fs.existsSync(path.join(main.root, 'src/frontend/node_modules/@ozwasyd/element-plus/package.json')))
            {
                throw new Error('canonical declaration local source refuses an installed FsusUI registry package');
            }
            publicAliases = inspectLocalFsusUiPublicDependencyBindings({ ...publicInputs,
                readInstalledManifest(location)
                {
                    return JSON.parse(read(path.join(main.root, 'src/frontend', location, 'package.json')));
                },
                readWorkspaceManifest(name)
                {
                    return JSON.parse(read(path.join(ui.root, 'vue/packages', name.split('/')[1], 'package.json')));
                }
            }).map(binding => validatePublicAlias({
                name: binding.name,
                logical: path.join(ui.root, 'vue/packages/node_modules', binding.name),
                target: path.join(main.root, 'src/frontend', binding.location),
                lockedLocation: binding.lockedLocation,
                lock: Object.fromEntries(['name', 'version', 'resolved', 'integrity']
                    .filter(key => binding.locked[key] !== undefined).map(key => [key, binding.locked[key]]))
            }));
        }
        return publicAliases;
    };
    const validateWorkspaceAlias = value =>
    {
        const binding = inspectCanonicalWorkspaceSourceAlias(value);
        observeAncestors(ui, value.logical);
        observeAncestors(ui, path.join(value.target, 'package.json'));
        return binding;
    };
    const workspaceAliasFor = requested => workspaceSources.aliases.find(value => contained(value.logical, requested));
    const validateWorkspaceRequest = requested =>
    {
        const alias = workspaceAliasFor(requested);
        if (!alias)
        {
            return;
        }
        validateWorkspaceAlias(alias);
        const relative = path.relative(alias.logical, requested);
        let current = alias.target;
        for (const part of relative.split(path.sep).filter(Boolean))
        {
            current = path.join(current, part);
            let stat;
            try
            {
                stat = fs.lstatSync(current, { bigint: true });
            }
            catch (error)
            {
                if (error.code === 'ENOENT')
                {
                    return;
                }
                throw error;
            }
            if (stat.isSymbolicLink())
            {
                throw new Error('canonical declaration workspace source alias refuses a secondary linked target: ' + requested);
            }
            if (stat.isDirectory() && !ancestors.has(current))
            {
                ancestors.set(current, epoch(stat));
            }
        }
    };
    const validateMapping = (requested, physical) =>
    {
        const logicalRepo = repositories.filter(value => contained(value.root, requested))
            .sort((left, right) => right.root.length - left.root.length)[0];
        const physicalRepo = repositories.filter(value => contained(value.root, physical))
            .sort((left, right) => right.root.length - left.root.length)[0];
        if (!logicalRepo || !physicalRepo)
        {
            throw new Error('canonical declaration compiler path escapes its closed repositories: ' + requested);
        }
        const publicNamespace = path.join(ui.root, 'vue/packages/node_modules');
        if (contained(publicNamespace, requested))
        {
            const aliases = resolvePublicAliases();
            const alias = aliases.find(value => contained(value.logical, requested)
                && physical === path.join(value.target, path.relative(value.logical, requested)));
            const namespaceDirectory = physical === requested && fs.lstatSync(requested).isDirectory()
                && aliases.some(value => contained(requested, value.logical));
            if (!alias && !namespaceDirectory)
            {
                throw new Error('canonical declaration public dependency namespace is not an original locked alias: ' + requested);
            }
            if (alias)
            {
                validatePublicAlias(alias);
            }
        }
        if (logicalRepo.root !== physicalRepo.root)
        {
            const alias = logicalRepo === ui && physicalRepo === main
                ? resolvePublicAliases().find(value => contained(value.logical, requested)
                    && physical === path.join(value.target, path.relative(value.logical, requested))) : null;
            if (!alias)
            {
                throw new Error('canonical declaration cross-repository path is not an original locked public dependency alias: ' + requested);
            }
            validatePublicAlias(alias);
        }
        const workspaceAlias = logicalRepo === ui && physicalRepo === ui ? workspaceAliasFor(requested) : null;
        if (workspaceAlias)
        {
            validateWorkspaceAlias(workspaceAlias);
            if (physical !== path.join(workspaceAlias.target, path.relative(workspaceAlias.logical, requested)))
            {
                throw new Error('canonical declaration workspace source alias refuses a secondary linked target: ' + requested);
            }
        }
        return { logicalRepo, physicalRepo, workspaceAlias };
    };
    const observeAncestors = (repo, absolute) =>
    {
        let directory = path.dirname(absolute);
        while (contained(repo.root, directory))
        {
            if (!ancestors.has(directory))
            {
                const stat = fs.lstatSync(directory, { bigint: true });
                if (!stat.isDirectory() || stat.isSymbolicLink())
                {
                    throw new Error('canonical declaration compiler input has a linked ancestor: ' + absolute);
                }
                ancestors.set(directory, epoch(stat));
            }
            if (directory === repo.root)
            {
                break;
            }
            directory = path.dirname(directory);
        }
    };
    const read = file =>
    {
        const requested = path.resolve(file);
        if (virtualConfigurations.has(requested))
        {
            const value = virtualConfigurations.get(requested);
            record('virtual-read', [requested], value.sha256);
            return value.content;
        }
        if (!metadataLookup(requested))
        {
            throw new Error('canonical declaration compiler read escapes its closed repositories: ' + requested);
        }
        validateWorkspaceRequest(requested);
        if (!fs.existsSync(requested))
        {
            record('missing-read', [requested], false);
            return undefined;
        }
        const physical = fs.realpathSync(requested);
        const { logicalRepo, physicalRepo: repo, workspaceAlias: boundWorkspaceAlias } = validateMapping(requested, physical);
        const relative = path.relative(repo.root, physical).split(path.sep).join('/');
        const logicalRelative = path.relative(logicalRepo.root, requested).split(path.sep).join('/');
        const tracked = repo.index.get(relative);
        const dependency = relative.split('/').includes('node_modules')
            && logicalRelative.split('/').includes('node_modules');
        if (!tracked && !dependency)
        {
            throw new Error('canonical declaration compiler read is not a bound source or locked dependency: ' + requested);
        }
        if (tracked && (!['100644', '100755'].includes(tracked.mode) || (physical !== requested && !boundWorkspaceAlias)))
        {
            throw new Error('canonical declaration compiler source requires a regular exact Git path: ' + requested);
        }
        if (logicalReads.has(requested) && logicalReads.get(requested) !== physical)
        {
            throw new Error('canonical declaration compiler logical input changed its physical target: ' + requested);
        }
        logicalReads.set(requested, physical);
        if (!reads.has(physical))
        {
            if (reads.size >= canonicalDeclarationSourceLimits.files)
            {
                throw new Error('canonical declaration compiler read roster exceeds its file limit');
            }
            observeAncestors(repo, physical);
            const result = rawRead(physical, Math.min(canonicalDeclarationSourceLimits.fileBytes,
                canonicalDeclarationSourceLimits.batchBytes - total));
            total += result.bytes.length;
            if (tracked)
            {
                const blob = createHash('sha1').update('blob ' + result.bytes.length + '\0').update(result.bytes).digest('hex');
                if (blob !== tracked.blob || Boolean(result.mode & 0o111) !== (tracked.mode === '100755'))
                {
                    throw new Error('canonical declaration compiler source HEAD/index/physical bytes disagree: ' + requested);
                }
            }
            reads.set(physical, { physical, requested, repository: repo.root, path: relative,
                kind: tracked ? 'git-source' : 'dependency',
                sha256: digest(result.bytes), bytes: result.bytes.length, mode: result.mode,
                ...(tracked ? { blob: tracked.blob, gitMode: tracked.mode } : {}),
                epoch: result.epoch });
            contents.set(physical, decode(result.bytes));
        }
        return contents.get(physical);
    };
    const registerCompilerPeerDirectories = (file, content) =>
    {
        const requested = path.resolve(file);
        const absolute = logicalReads.get(requested) ?? requested;
        const input = reads.get(absolute);
        if (ts.version !== '6.0.3' || input?.kind !== 'git-source' || input.repository !== ui.root
            || !input.path.startsWith('vue/packages/') || path.basename(absolute) !== 'package.json')
        {
            return;
        }
        let manifest;
        try
        {
            manifest = JSON.parse(content);
        }
        catch
        {
            return;
        }
        if (!manifest?.peerDependencies || typeof manifest.peerDependencies !== 'object'
            || Array.isArray(manifest.peerDependencies))
        {
            return;
        }
        const packageDirectory = path.dirname(absolute);
        // Exact locked TypeScript 6.0.3 readPackageJsonPeerDependencies algorithm.
        // Source aliases can lack node_modules; only its actual missing directory probe is admitted.
        const prefix = packageDirectory.substring(0,
            packageDirectory.lastIndexOf('node_modules') + 'node_modules'.length) + path.sep;
        for (const peer of Object.keys(manifest.peerDependencies))
        {
            if (peer.length > 214 || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(peer))
            {
                continue;
            }
            const directory = path.resolve(prefix + peer);
            if (metadataLookup(directory))
            {
                continue;
            }
            const derivations = peerDirectoryDerivations.get(directory) ?? [];
            const value = { manifest: absolute, blob: input.blob, sha256: input.sha256, peer,
                algorithm: 'typescript-6.0.3/readPackageJsonPeerDependencies' };
            if (!derivations.some(existing => isDeepStrictEqual(existing, value)))
            {
                if (peerDirectoryDerivations.size >= canonicalDeclarationSourceLimits.probes)
                {
                    throw new Error('canonical compiler peer directory derivations exceed the probe limit');
                }
                derivations.push(value);
                peerDirectoryDerivations.set(directory, derivations);
            }
        }
    };
    function record(kind, args, result)
    {
        const key = kind + ':' + JSON.stringify(args);
        if (!probes.has(key) && probes.size >= canonicalDeclarationSourceLimits.probes)
        {
            throw new Error('canonical declaration compiler metadata probes exceed their limit');
        }
        const previous = probes.get(key);
        if (previous && !isDeepStrictEqual(previous.result, result))
        {
            throw new Error('canonical declaration compiler metadata changed during generation');
        }
        probes.set(key, { kind, args, result });
        return result;
    }
    // Keep the original TypeScript glob matcher while refusing escaping links before recursion.
    const directoryEntries = directory =>
    {
        const absolute = path.resolve(directory);
        if (!fs.existsSync(absolute))
        {
            return record('directoryEntries', [absolute], { files: [], directories: [] });
        }
        const physical = fs.realpathSync(absolute);
        validateMapping(absolute, physical);
        const files = [];
        const directories = [];
        const directoryHandle = fs.opendirSync(absolute);
        try
        {
            let count = 0;
            for (let entry = directoryHandle.readSync(); entry; entry = directoryHandle.readSync())
            {
                count += 1;
                if (count > canonicalDeclarationSourceLimits.directoryEntries)
                {
                    throw new Error('canonical declaration directory entry count exceeds its limit');
                }
                let stat = entry;
                if (entry.isSymbolicLink())
                {
                    const target = path.join(absolute, entry.name);
                    const targetPhysical = fs.realpathSync(target);
                    validateMapping(target, targetPhysical);
                    stat = fs.statSync(target);
                }
                if (stat.isFile())
                {
                    files.push(entry.name);
                }
                else if (stat.isDirectory())
                {
                    directories.push(entry.name);
                }
            }
        }
        finally
        {
            directoryHandle.closeSync();
        }
        return record('directoryEntries', [absolute], { files: files.sort(), directories: directories.sort() });
    };
    const observe = (kind, args) =>
    {
        if (!metadataLookup(path.resolve(args[0])))
        {
            const derivations = peerDirectoryDerivations.get(args[0]);
            if (kind === 'directoryExists' && derivations?.length)
            {
                const absence = inspectCanonicalPeerDirectoryAbsence(args[0]);
                const previous = missingPeerDirectories.get(args[0]);
                if (previous && !isDeepStrictEqual(previous.absence, absence))
                {
                    throw new Error('canonical compiler peer directory absence changed during inspection');
                }
                missingPeerDirectories.set(args[0], { directory: args[0], derivations: [...derivations], absence });
                return false;
            }
            throw new Error('canonical declaration metadata lookup escapes its closed source resolution roots: ' + args[0]);
        }
        if (kind === 'directoryEntries')
        {
            return directoryEntries(args[0]);
        }
        if (kind === 'getDirectories')
        {
            return directoryEntries(args[0]).directories.slice();
        }
        if (kind === 'readDirectory')
        {
            return ts.matchFiles(args[0], args[1], args[2], args[3], original.useCaseSensitiveFileNames,
                original.getCurrentDirectory(), args[4], directoryEntries, file => probe('realpath', [file]));
        }
        if (kind === 'realpath')
        {
            const result = original.realpath(...args);
            if (fs.existsSync(args[0]))
            {
                validateMapping(path.resolve(args[0]), path.resolve(result));
            }
            return result;
        }
        return original[kind](...args);
    };
    const probe = (kind, args) =>
    {
        const absolute = path.resolve(args[0]);
        validateWorkspaceRequest(absolute);
        if (['getDirectories', 'readDirectory'].includes(kind)
            && !repositories.some(value => contained(value.root, absolute)))
        {
            throw new Error('canonical declaration directory enumeration escapes its closed repositories: ' + absolute);
        }
        const normalized = [absolute, ...args.slice(1)];
        return record(kind, normalized, observe(kind, normalized));
    };
    if (fs.existsSync(path.join(ui.root, 'vue/packages/node_modules')))
    {
        resolvePublicAliases();
    }
    workspaceSources = projectCanonicalWorkspaceSourceAliases({ root: ui.root, index: ui.index, read, parse: parser.parse });
    workspaceSources.aliases = workspaceSources.aliases.map(validateWorkspaceAlias);
    const inventoryWorkspaceNamespace = (directory, scoped = false) =>
    {
        if (workspaceNamespaces.size >= canonicalDeclarationSourceLimits.probes)
        {
            throw new Error('canonical declaration workspace namespace inventory exceeds its probe bound');
        }
        let stat;
        try
        {
            stat = fs.lstatSync(directory, { bigint: true });
        }
        catch (error)
        {
            if (error.code === 'ENOENT')
            {
                workspaceNamespaces.set(directory, { directory, absent: true });
                return;
            }
            throw error;
        }
        if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory)
        {
            throw new Error('canonical declaration workspace namespace requires one exact real directory');
        }
        observeAncestors(ui, path.join(directory, 'entry'));
        const entries = boundedDirectoryEntries(directory, canonicalDeclarationSourceLimits.directoryEntries - workspaceNamespaceEntries);
        workspaceNamespaceEntries += entries.length;
        if (workspaceNamespaceEntries > canonicalDeclarationSourceLimits.directoryEntries)
        {
            throw new Error('canonical declaration workspace namespace exceeds its entry bound');
        }
        workspaceNamespaces.set(directory, { directory, epoch: epoch(stat), entries: entries.map(value => value.name).sort() });
        for (const entry of entries)
        {
            const logical = path.join(directory, entry.name);
            if (entry.name.startsWith('@') && entry.isDirectory())
            {
                if (scoped)
                {
                    throw new Error('canonical declaration workspace namespace refuses nested npm scopes');
                }
                inventoryWorkspaceNamespace(logical, true);
            }
            else if (entry.isSymbolicLink())
            {
                const physical = fs.realpathSync(logical);
                if (contained(ui.root, physical) && !path.relative(ui.root, physical).split(path.sep).includes('node_modules')
                    && !workspaceSources.aliases.some(value => value.logical === logical && value.target === physical))
                {
                    throw new Error('canonical declaration workspace namespace has an undeclared source alias: ' + logical);
                }
            }
        }
    };
    if (workspaceSources.configured)
    {
        for (const directory of ['.', ...workspaceSources.members.map(value => value.directory)])
        {
            inventoryWorkspaceNamespace(path.join(ui.root, directory, 'node_modules'));
        }
    }
    ts.sys.readFile = (...args) =>
    {
        try
        {
            const content = read(...args);
            registerCompilerPeerDirectories(args[0], content);
            return content;
        }
        catch (error)
        {
            refused ??= error;
            throw error;
        }
    };
    for (const kind of ['fileExists', 'directoryExists', 'realpath', 'getDirectories', 'readDirectory'])
    {
        if (typeof original[kind] !== 'function')
        {
            continue;
        }
        ts.sys[kind] = (...args) =>
        {
            try
            {
                return probe(kind, args);
            }
            catch (error)
            {
                refused ??= error;
                throw error;
            }
        };
    }
    ts.sys.writeFile = () =>
    {
        const error = new Error('canonical declaration source inspection refuses compiler filesystem writes');
        refused ??= error;
        throw error;
    };
    return {
        read,
        configuration(file, content)
        {
            if (file !== path.join(main.root, generatedProject) || typeof content !== 'string'
                || Buffer.byteLength(content) > canonicalDeclarationSourceLimits.fileBytes
                || virtualConfigurations.has(file))
            {
                throw new Error('canonical declaration source configuration must come once from the original finite owner');
            }
            virtualConfigurations.set(file, { file, content, sha256: digest(Buffer.from(content)), bytes: Buffer.byteLength(content) });
        },
        finish()
        {
            for (const [key, value] of Object.entries(original))
            {
                ts.sys[key] = value;
            }
            if (refused)
            {
                throw refused;
            }
            for (const [absolute, expected] of ancestors)
            {
                if (!isDeepStrictEqual(epoch(fs.lstatSync(absolute, { bigint: true })), expected))
                {
                    throw new Error('canonical declaration compiler source ancestor changed: ' + absolute);
                }
            }
            for (const value of reads.values())
            {
                const actual = rawRead(value.physical, canonicalDeclarationSourceLimits.fileBytes);
                if (digest(actual.bytes) !== value.sha256 || actual.mode !== value.mode
                    || (value.epoch && !isDeepStrictEqual(actual.epoch, value.epoch))
                    || fs.realpathSync(value.requested) !== value.physical)
                {
                    throw new Error('canonical declaration compiler input changed after generation: ' + value.requested);
                }
            }
            for (const [requested, physical] of logicalReads)
            {
                if (fs.realpathSync(requested) !== physical)
                {
                    throw new Error('canonical declaration compiler logical input changed after generation: ' + requested);
                }
                validateMapping(requested, physical);
            }
            for (const value of publicAliases ?? [])
            {
                validatePublicAlias(value);
            }
            workspaceSources.aliases.forEach(validateWorkspaceAlias);
            for (const value of workspaceNamespaces.values())
            {
                if (value.absent)
                {
                    try
                    {
                        fs.lstatSync(value.directory);
                    }
                    catch (error)
                    {
                        if (error.code === 'ENOENT')
                        {
                            continue;
                        }
                        throw error;
                    }
                    throw new Error('canonical declaration workspace namespace appeared during inspection');
                }
                if (!isDeepStrictEqual(epoch(fs.lstatSync(value.directory, { bigint: true })), value.epoch)
                    || !isDeepStrictEqual(boundedDirectoryEntries(value.directory, value.entries.length)
                        .map(entry => entry.name).sort(), value.entries))
                {
                    throw new Error('canonical declaration workspace namespace changed during inspection');
                }
            }
            for (const value of probes.values())
            {
                if (value.kind === 'virtual-read')
                {
                    if (virtualConfigurations.get(value.args[0])?.sha256 !== value.result)
                    {
                        throw new Error('canonical declaration derived configuration changed during generation');
                    }
                }
                else if (value.kind === 'missing-read')
                {
                    if (fs.existsSync(value.args[0]))
                    {
                        throw new Error('canonical declaration missing input became present');
                    }
                }
                else if (!isDeepStrictEqual(observe(value.kind, value.args), value.result))
                {
                    throw new Error('canonical declaration compiler resolution changed after generation');
                }
            }
            return {
                virtualConfigurations: [...virtualConfigurations.values()].map(({ file, sha256, bytes }) => ({ file, sha256, bytes })),
                publicDependencyAliases: publicAliases ?? [],
                workspaceSources,
                workspaceNamespaces: [...workspaceNamespaces.values()],
                missingPeerDirectories: [...missingPeerDirectories.values()]
                    .sort((left, right) => left.directory.localeCompare(right.directory)),
                logicalReads: [...logicalReads].map(([requested, physical]) => ({ requested, physical }))
                    .sort((left, right) => left.requested.localeCompare(right.requested)),
                reads: [...reads.values()].sort((left, right) => left.physical.localeCompare(right.physical)),
                probes: [...probes.values()].map(value => JSON.parse(JSON.stringify(value))).sort((left, right) =>
                    (left.kind + JSON.stringify(left.args)).localeCompare(right.kind + JSON.stringify(right.args)))
            };
        },
        restore()
        {
            for (const [key, value] of Object.entries(original))
            {
                ts.sys[key] = value;
            }
        }
    };
}

/** Reproduce the finite producer using bound source data and the executing checker's locked compiler. */
export function inspectCanonicalDeclarationSource({ repositoryRoot, files, localRoot })
{
    if (!Array.isArray(files) || !files.length || new Set(files).size !== files.length
        || files.some(file => !canonicalTestDeclarationOutputs.includes(file)))
    {
        throw new Error('canonical declaration source requires distinct explicit original output paths');
    }
    const main = repository(repositoryRoot);
    const ui = repository(localRoot ?? resolveLocalFsusUiRepositoryRoot({
        repositoryRoot: main.root, override: process.env.FSUSBLOG_LOCAL_FSUSUI_ROOT
    }));
    assertScratchNamespace(main.root);
    const authority = authorityRoot === main.root ? main : repository(authorityRoot);
    const repositories = [...new Map([main, ui, authority].map(value => [value.root, value])).values()];
    const held = [];
    let heldBytes = 0;
    const hold = (root, file) =>
    {
        const remaining = canonicalDeclarationSourceLimits.batchBytes - heldBytes;
        const named = fs.lstatSync(path.join(root, file), { bigint: true });
        if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1n)
        {
            throw new Error('canonical declaration source requires one regular single-link fixed input: ' + file);
        }
        const input = bindSourceFile(root, file, Math.min(canonicalDeclarationSourceLimits.fileBytes, remaining), true);
        heldBytes += input.bytes.length;
        held.push(input);
        return input;
    };
    const oldDirectory = process.cwd();
    let recorder;
    try
    {
        const fixed = [...new Set([canonicalTestDeclarationProducer, inputOwner,
            ...canonicalTestDeclarationModules, ...canonicalTestDeclarationReadOnlyInputs,
            ...canonicalTestDeclarationOutputs, canonicalTestDeclarationBindingFile])];
        const witnesses = fixed.map(file =>
        {
            const input = hold(main.root, file);
            return input.binding;
        });
        const publicOwner = hold(main.root, publicInstallOwner);
        for (const owner of codeOwners)
        {
            const source = held.find(input => input.absolute === path.join(main.root, owner));
            const authoritySource = authorityRoot === main.root ? source : hold(authority.root, owner);
            if (!source.bytes.equals(authoritySource.bytes))
            {
                throw new Error('canonical declaration source producer/helper differs from its executing authority: ' + owner);
            }
        }
        const uiSourceFiles = ['vue/packages/element-plus/index.ts',
            'vue/packages/icons-vue/src/index.ts', 'vue/global.d.ts',
            'vue/typings/components.d.ts', 'vue/typings/env.d.ts'];
        const uiLockFiles = ['pnpm-lock.yaml', 'vue/pnpm-lock.yaml', 'package-lock.json', 'vue/package-lock.json']
            .filter(file => ui.index.has(file));
        if (!uiLockFiles.length)
        {
            throw new Error('canonical declaration local FsusUI source requires its original dependency lock');
        }
        const uiWitnesses = [...uiSourceFiles, ...uiLockFiles].map(file =>
        {
            const input = hold(ui.root, file);
            return input.binding;
        });
        const publicManifest = hold(main.root, 'src/frontend/package.json');
        const uiManifest = hold(ui.root, 'vue/packages/element-plus/package.json');
        const publicDependencyWitnesses = [publicOwner.binding, publicManifest.binding, uiManifest.binding];
        const lock = hold(authority.root, compilerLock);
        const candidateLock = JSON.parse(held[fixed.indexOf('src/frontend/package-lock.json')].bytes);
        const actualLock = JSON.parse(lock.bytes);
        const compilerFields = value => Object.fromEntries(['version', 'resolved', 'integrity'].map(key => [key, value?.[key]]));
        const expectedCompiler = compilerFields(actualLock.packages?.['node_modules/typescript']);
        if (!isDeepStrictEqual(expectedCompiler, compilerFields(candidateLock.packages?.['node_modules/typescript']))
            || !expectedCompiler.version || !/^sha512-/u.test(expectedCompiler.integrity ?? ''))
        {
            throw new Error('canonical declaration source compiler differs from the two original locked archives');
        }
        const compilerPath = compilerRequire.resolve('typescript');
        const expectedCompilerRoot = path.join(authorityRoot, 'tools/frontend/style-toolchain/node_modules/typescript');
        if (!contained(expectedCompilerRoot, compilerPath) || fs.realpathSync(compilerPath) !== compilerPath)
        {
            throw new Error('canonical declaration compiler must come from the executing locked authority toolchain');
        }
        const compilerSource = rawRead(compilerPath, canonicalDeclarationSourceLimits.compilerBytes);
        const packagePath = path.resolve(path.dirname(compilerPath), '../package.json');
        const compilerPackage = rawRead(packagePath, canonicalDeclarationSourceLimits.fileBytes);
        const parser = inspectCanonicalWorkspaceParser(actualLock, canonicalDeclarationSourceLimits.batchBytes
            - heldBytes - compilerSource.bytes.length - compilerPackage.bytes.length);
        const ts = compilerRequire('typescript');
        if (ts.version !== expectedCompiler.version || JSON.parse(compilerPackage.bytes).version !== ts.version)
        {
            throw new Error('canonical declaration source compiler installed version differs from its lock');
        }
        process.chdir(main.root);
        recorder = captureCompilerReads(ts, repositories, main, ui, {
            manifest: JSON.parse(publicManifest.bytes), lockfile: candidateLock, sourceManifest: JSON.parse(uiManifest.bytes)
        }, heldBytes + compilerSource.bytes.length + compilerPackage.bytes.length + parser.bytes, parser);
        const generated = generateCanonicalTestDeclarations({ repositoryRoot: main.root, typescript: ts, localRoot: ui.root,
            inMemoryConfiguration: true, onConfiguration: recorder.configuration,
            readProvenanceInput(file)
            {
                const input = held.find(value => value.absolute === path.join(main.root, file));
                if (!fixed.includes(file) || !input)
                {
                    throw new Error('canonical declaration provenance requested an input outside its original held roster');
                }
                return input.bytes;
            }
        });
        const consumed = recorder.finish();
        recorder = null;
        const expectedOutputs = [...canonicalTestDeclarationOutputs, canonicalTestDeclarationBindingFile];
        if (!isDeepStrictEqual([...generated.keys()], expectedOutputs))
        {
            throw new Error('canonical declaration producer returned a different output roster');
        }
        for (const file of expectedOutputs)
        {
            const input = held.find(value => value.absolute === path.join(main.root, file));
            if (!input.bytes.equals(Buffer.from(generated.get(file))))
            {
                throw new Error('canonical declaration differs from its actual original producer: ' + file);
            }
        }
        for (const input of held)
        {
            verifySourceFileBinding(input);
        }
        for (const value of repositories)
        {
            const current = repository(value.root);
            if (current.head !== value.head || current.indexDigest !== value.indexDigest)
            {
                throw new Error('canonical declaration repository HEAD or index changed during generation');
            }
        }
        if (!sameEpoch(fs.statSync(compilerPath, { bigint: true }),
            Object.fromEntries(Object.entries(compilerSource.epoch).map(([key, value]) => [key, BigInt(value)]))))
        {
            throw new Error('canonical declaration authority compiler changed during generation');
        }
        const currentCompilerPackage = rawRead(packagePath, canonicalDeclarationSourceLimits.fileBytes);
        if (digest(currentCompilerPackage.bytes) !== digest(compilerPackage.bytes)
            || !isDeepStrictEqual(currentCompilerPackage.epoch, compilerPackage.epoch))
        {
            throw new Error('canonical declaration authority compiler package changed during generation');
        }
        return {
            schema, status: 'success', qualificationEligible: false, files,
            repositories: repositories.map(value => ({ root: value.root, head: value.head, indexDigest: value.indexDigest })),
            compiler: { ...expectedCompiler, file: compilerPath, sha256: digest(compilerSource.bytes),
                package: packagePath, packageSha256: digest(compilerPackage.bytes) },
            limits: canonicalDeclarationSourceLimits, witnesses, uiWitnesses, publicDependencyWitnesses, consumed,
            workspaceParser: parser.verify(),
            outputs: expectedOutputs.map(file => ({ file, sha256: digest(Buffer.from(generated.get(file))) }))
        };
    }
    finally
    {
        recorder?.restore();
        process.chdir(oldDirectory);
        for (const input of held)
        {
            fs.closeSync(input.descriptor);
        }
    }
}

/** Re-emit and reopen the complete actual input closure; reported digests cannot grant source coverage. */
export function validateCanonicalDeclarationSourceReceipt({ repositoryRoot, files, expectedHead, receipt, localRoot })
{
    if (receipt?.schema !== schema || receipt.status !== 'success' || receipt.qualificationEligible !== false
        || !isDeepStrictEqual(receipt.files, files)
        || receipt.repositories?.[0]?.head !== expectedHead)
    {
        throw new Error('canonical declaration source receipt has an invalid independent caller binding');
    }
    const actual = inspectCanonicalDeclarationSource({ repositoryRoot, files, localRoot });
    if (!isDeepStrictEqual(actual, receipt))
    {
        throw new Error('canonical declaration source receipt differs from independent original regeneration and input reopening');
    }
    return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
{
    const options = { files: [] };
    const args = process.argv.slice(2);
    for (let index = 0; index < args.length; index += 2)
    {
        if (!['--root', '--file', '--local-root'].includes(args[index]) || !args[index + 1])
        {
            throw new Error('usage: check-canonical-declaration-source.mjs --root repository --file output [--file output]');
        }
        if (args[index] === '--file')
        {
            options.files.push(args[index + 1]);
        }
        else
        {
            options[args[index] === '--root' ? 'repositoryRoot' : 'localRoot'] = args[index + 1];
        }
    }
    console.log(JSON.stringify(inspectCanonicalDeclarationSource(options)));
}
