#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { identity, taskEnvironment, parsePlanCli, readFrozenPlan, readRegular, requireCanonicalOwnedPath, requireHeldTaskLock, requireInside, requireSourceClosure, writeNewJson } from './local-task-plan.mjs';

const credentialPattern = /-----BEGIN (?:(?:OPENSSH|RSA|EC|DSA|ENCRYPTED) )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{70,}|AKIA[A-Z0-9]{16}/u;
const objectIdPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const digestPattern = /^[a-f0-9]{64}$/u;
const planKeys = ['sourceInputs', 'taskLock', 'repoRoot', 'remote', 'baselineRef', 'prefix', 'handoffPath', 'branches', 'stashes', 'dirty', 'publicTemplates', 'catalog', 'maxObjectBytes', 'maxSourceBytes', 'resourceFloor'];

export function sha256(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function exactKeys(value, keys, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) {
        throw new Error(`invalid closed ${label} fields`);
    }
}

export function safeRelative(value) {
    if (typeof value !== 'string' || !value || value.startsWith('-') || path.posix.isAbsolute(value) || value.includes('\\') || value.split('/').some(part => !part || part === '.' || part === '..') || /[\x00-\x1f\x7f]/u.test(value)) {
        throw new Error('invalid repository-relative path');
    }
    return value;
}

export function sensitivePath(value) {
    return /(?:^|\/)\.qoder(?:\/|$)/iu.test(value) || /(?:^|\/)(?:qa_ed25519|id_rsa|id_ed25519|\.env(?:\..*)?|credentials\.json|secrets\.json)$/iu.test(value);
}

function uniqueStrings(value, label) {
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item) || new Set(value).size !== value.length) {
        throw new Error(`invalid ${label}`);
    }
}

/** Load one explicit frozen task plan. Inspection never fetches or changes refs. */
export function createWipContext(planPath, expectedSha256) {
    const { plan, planSha256 } = readFrozenPlan(planPath, expectedSha256, planKeys);
    requireSourceClosure(plan.sourceInputs, [fileURLToPath(import.meta.url), fileURLToPath(new URL('./wip-catalog-publication.mjs', import.meta.url)), fileURLToPath(new URL('./local-task-plan.mjs', import.meta.url))]);
    requireCanonicalOwnedPath(plan.repoRoot, { directory: true });
    requireCanonicalOwnedPath(plan.taskRoot, { directory: true });
    requireInside(plan.taskRoot, plan.taskLock);
    if (plan.taskRoot === plan.repoRoot || plan.taskRoot.startsWith(`${plan.repoRoot}${path.sep}`)) {
        throw new Error('taskRoot must be outside the source worktree');
    }
    exactKeys(plan.remote, ['name', 'url'], 'remote');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(plan.remote.name) || typeof plan.remote.url !== 'string' || !plan.remote.url || plan.remote.url.startsWith('-') || plan.remote.url.startsWith('ext::') || /[\x00-\x1f]/u.test(plan.remote.url)) {
        throw new Error('invalid explicit remote');
    }
    if (typeof plan.baselineRef !== 'string' || !plan.baselineRef.startsWith('refs/heads/')) {
        throw new Error('baselineRef must be a remote head');
    }
    safeRelative(plan.prefix);
    safeRelative(plan.handoffPath);
    if (!plan.handoffPath.startsWith('.wip/') || sensitivePath(plan.handoffPath)) {
        throw new Error('handoffPath must be a safe .wip/ path');
    }
    uniqueStrings(plan.branches, 'branches');
    uniqueStrings(plan.stashes, 'stashes');
    if (plan.stashes.some(sha => !objectIdPattern.test(sha))) {
        throw new Error('stash must be pinned by full object ID');
    }
    for (const key of ['maxObjectBytes', 'maxSourceBytes']) {
        if (!Number.isSafeInteger(plan[key]) || plan[key] < 1 || plan[key] > 64 * 1024 * 1024) {
            throw new Error(`invalid bounded ${key}`);
        }
    }
    exactKeys(plan.resourceFloor, ['availableMemoryBytes', 'availableDiskBytes'], 'publication resource floor');
    if (Object.values(plan.resourceFloor).some(value => !Number.isSafeInteger(value) || value < 0)) {
        throw new Error('invalid explicit publication resource floor');
    }
    if (!Array.isArray(plan.dirty) || !Array.isArray(plan.publicTemplates)) {
        throw new Error('dirty/publicTemplates must be arrays');
    }
    for (const row of plan.dirty) {
        exactKeys(row, ['root', 'head', 'ref', 'paths'], 'dirty snapshot');
        requireCanonicalOwnedPath(row.root, { directory: true });
        safeRelative(row.ref);
        if (!objectIdPattern.test(row.head) || !Array.isArray(row.paths) || !row.paths.length || new Set(row.paths.map(item => item.path)).size !== row.paths.length) {
            throw new Error('invalid dirty source selection');
        }
        for (const file of row.paths) {
            exactKeys(file, ['path', 'sha256'], 'dirty file');
            safeRelative(file.path);
            if (sensitivePath(file.path) || (file.sha256 !== null && !digestPattern.test(file.sha256))) {
                throw new Error('sensitive/unpinned dirty source');
            }
        }
    }
    for (const row of plan.publicTemplates) {
        exactKeys(row, ['path', 'baselinePath', 'blob'], 'public template');
        safeRelative(row.path);
        safeRelative(row.baselinePath);
        if (!sensitivePath(row.path) || /(?:^|\/)\.qoder(?:\/|$)/iu.test(row.path) || !objectIdPattern.test(row.blob)) {
            throw new Error('invalid public template exception');
        }
    }
    if (new Set(plan.publicTemplates.map(row => row.path)).size !== plan.publicTemplates.length) {
        throw new Error('duplicate template exception');
    }
    exactKeys(plan.catalog, ['ref', 'directory', 'sources'], 'catalog');
    safeRelative(plan.catalog.ref);
    safeRelative(plan.catalog.directory);
    if (!plan.catalog.directory.startsWith('.wip/') || !Array.isArray(plan.catalog.sources)) {
        throw new Error('invalid catalog selection');
    }
    for (const row of plan.catalog.sources) {
        exactKeys(row, ['source', 'target', 'sha256'], 'catalog source');
        safeRelative(row.target);
        if (!row.target.startsWith(`${plan.catalog.directory}/local-tools/`) || sensitivePath(row.target) || !digestPattern.test(row.sha256)) {
            throw new Error('invalid catalog source target/digest');
        }
    }
    const context = { plan, planSha256 };
    if (git(context, ['rev-parse', '--show-toplevel']).trim() !== plan.repoRoot) {
        throw new Error('repoRoot is not the exact Git worktree root');
    }
    for (const ref of [plan.baselineRef, `refs/heads/${plan.prefix}`, ...plan.branches.map(branch => `refs/heads/${branch}`), ...expectedRefs(context)]) {
        git(context, ['check-ref-format', ref]);
    }
    if (new Set(expectedRefs(context)).size !== expectedRefs(context).length) {
        throw new Error('duplicate destination refs');
    }
    liveRemote(context);
    return context;
}

/** Git runs without ambient index, replacement, or injected command configuration. */
export function git(context, args, input, encoding = 'utf8', extraEnv = {}, root = context.plan.repoRoot) {
    const env = { ...taskEnvironment };
    return execFileSync('git', ['-C', root, '-c', 'core.fsmonitor=false', ...args], {
        env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', ...extraEnv },
        input, encoding, maxBuffer: 64 * 1024 * 1024, timeout: 180000, stdio: ['pipe', 'pipe', 'pipe']
    });
}

export function liveRemote(context) {
    const urls = git(context, ['remote', 'get-url', '--all', context.plan.remote.name]).trim().split('\n');
    const pushUrls = git(context, ['remote', 'get-url', '--push', '--all', context.plan.remote.name]).trim().split('\n');
    if (urls.length !== 1 || pushUrls.length !== 1 || urls[0] !== context.plan.remote.url || pushUrls[0] !== context.plan.remote.url) {
        throw new Error('actual remote URL differs from frozen plan');
    }
    return git(context, ['ls-remote', '--heads', '--tags', context.plan.remote.url]).trim().split('\n').filter(Boolean).map(line => {
        const [sha, ref] = line.split(/\s+/u);
        if (!objectIdPattern.test(sha) || !(ref.startsWith('refs/heads/') || ref.startsWith('refs/tags/'))) {
            throw new Error('invalid actual remote ref');
        }
        return { sha, ref };
    }).sort((left, right) => left.ref.localeCompare(right.ref));
}

export function expectedRefs(context, includeCatalog = true) {
    const { plan } = context;
    return [...plan.branches.map(branch => `refs/heads/${plan.prefix}/${branch}`), ...plan.stashes.map(sha => `refs/heads/${plan.prefix}/stash/${sha}`), ...plan.dirty.map(row => `refs/heads/${plan.prefix}/${row.ref}`), ...(includeCatalog ? [`refs/heads/${plan.prefix}/${plan.catalog.ref}`] : [])];
}

export function originalIdentity(context, root = context.plan.repoRoot) {
    const indexFile = git(context, ['rev-parse', '--path-format=absolute', '--git-path', 'index'], undefined, 'utf8', {}, root).trim();
    const changes = git(context, ['diff', '--binary', 'HEAD', '--'], undefined, null, {}, root);
    const status = git(context, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], undefined, 'utf8', {}, root);
    const listed = git(context, ['ls-files', '-z', '--others', '--exclude-standard'], undefined, 'utf8', {}, root).split('\0').filter(Boolean);
    const untracked = listed.filter(file => !/(?:^|\/)\.qoder(?:\/|$)/iu.test(file)).map(file => {
        const absolute = path.join(root, file);
        const stat = fs.lstatSync(absolute, { bigint: true });
        return { path: file, identity: identity(stat) };
    });
    let branch = null;
    try {
        branch = git(context, ['symbolic-ref', '-q', 'HEAD'], undefined, 'utf8', {}, root).trim();
    } catch (error) {
        if (error.status !== 1) {
            throw error;
        }
    }
    return { root, head: git(context, ['rev-parse', 'HEAD'], undefined, 'utf8', {}, root).trim(), branch, indexSha256: fs.existsSync(indexFile) ? sha256(fs.readFileSync(indexFile)) : null, status, changesSha256: sha256(changes), untracked };
}

export function assertOriginal(context, inventory) {
    if (JSON.stringify(originalIdentity(context)) !== JSON.stringify(inventory.original)) {
        throw new Error('original source head/index/worktree changed');
    }
    for (const row of inventory.branches) {
        if (git(context, ['rev-parse', `refs/heads/${row.branch}`]).trim() !== row.sha) {
            throw new Error('original branch drifted');
        }
    }
    if (git(context, ['stash', 'list', '--format=%H']).trim() !== inventory.allStashes.join('\n')) {
        throw new Error('original stashes drifted');
    }
    for (const row of inventory.dirty) {
        if (JSON.stringify(originalIdentity(context, row.root)) !== JSON.stringify(row.original)) {
            throw new Error('dirty source head/index/worktree changed');
        }
        for (const file of row.files) {
            const read = verifySource(context, row.root, file);
            if (read && JSON.stringify(read.identity) !== JSON.stringify(file.identity)) {
                throw new Error('dirty physical file epoch drifted');
            }
        }
    }
}

function verifySource(context, root, file) {
    const absolute = path.join(root, file.path);
    if (file.sha256 === null) {
        try {
            fs.lstatSync(absolute);
        } catch (error) {
            if (error.code === 'ENOENT') {
                return null;
            }
            throw error;
        }
        throw new Error('deleted source reappeared');
    }
    requireCanonicalOwnedPath(absolute, { insideRoot: root });
    const read = readRegular(absolute, context.plan.maxSourceBytes);
    if (read.sha256 !== file.sha256 || credentialPattern.test(read.bytes.toString('utf8'))) {
        throw new Error('dirty source digest/credential mismatch');
    }
    return read;
}

function lines(value) {
    return value.trim().split('\n').filter(Boolean);
}

function revisionList(context, tips, exclusions = [], objects = false) {
    return tips.length ? lines(git(context, ['rev-list', ...(objects ? ['--objects'] : []), ...tips, '--not', ...exclusions])) : [];
}

function remoteCommits(context, refs) {
    return [...new Set(refs.filter(row => !row.ref.endsWith('^{}')).flatMap(row => {
        try {
            return [git(context, ['rev-parse', '--verify', `${row.sha}^{commit}`]).trim()];
        } catch {
            throw new Error('remote object unavailable locally; explicitly fetch before planning');
        }
    }))];
}

/** Capture only declared branch/stash/dirty sources; other registered roots are listed, never opened. */
export function inventoryWip(context) {
    const original = originalIdentity(context);
    const remote = liveRemote(context);
    const baseline = remote.find(row => row.ref === context.plan.baselineRef)?.sha;
    if (!baseline) {
        throw new Error('actual remote baseline missing');
    }
    const published = remoteCommits(context, remote);
    const allBranches = lines(git(context, ['for-each-ref', '--format=%(objectname) %(refname:strip=2)', 'refs/heads'])).map(line => ({ sha: line.slice(0, line.indexOf(' ')), branch: line.slice(line.indexOf(' ') + 1) }));
    const worktrees = git(context, ['worktree', 'list', '--porcelain', '-z']).split('\0\0').filter(Boolean).map(block => Object.fromEntries(block.split('\0').filter(Boolean).map(line => {
        const at = line.indexOf(' ');
        return at < 0 ? [line, true] : [line.slice(0, at), line.slice(at + 1)];
    })));
    const branches = context.plan.branches.map(branch => {
        const row = allBranches.find(item => item.branch === branch);
        if (!row) {
            throw new Error('selected local branch missing');
        }
        const recentHistory = git(context, ['log', '-8', '--format=%h %s%n%b', row.sha]);
        let base = null;
        try {
            base = git(context, ['merge-base', baseline, row.sha]).trim();
        } catch (error) {
            if (error.status !== 1) {
                throw error;
            }
        }
        const linkedIssues = [...new Set([...`${branch}\n${recentHistory}`.matchAll(/(?:issue-|task\/|Refs:\s*#?|Closes\s*#?|Fixes\s*#?|#)(\d+)\b/gu)].map(match => Number(match[1])))];
        return { ...row, tree: git(context, ['rev-parse', `${row.sha}^{tree}`]).trim(), base, linkedIssues, recentHistory, diffStat: git(context, ['diff', '--stat', base ?? `${baseline}^{tree}`, row.sha]), worktrees: worktrees.filter(tree => tree.branch === `refs/heads/${branch}`) };
    });
    const allStashes = lines(git(context, ['stash', 'list', '--format=%H']));
    const stashes = context.plan.stashes.map(sha => {
        if (!allStashes.includes(sha)) {
            throw new Error('selected stash missing');
        }
        return { sha, subject: git(context, ['show', '-s', '--format=%s', sha]).trim(), parents: lines(git(context, ['show', '-s', '--format=%P', sha])).join(' ').split(' '), stat: git(context, ['show', '--stat', '--format=', sha]) };
    });
    const commonDir = git(context, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
    const dirty = context.plan.dirty.map(row => {
        if (!worktrees.some(tree => tree.worktree === row.root) || git(context, ['rev-parse', '--path-format=absolute', '--git-common-dir'], undefined, 'utf8', {}, row.root).trim() !== commonDir) {
            throw new Error('dirty root is not a registered worktree of this repository');
        }
        const identity = originalIdentity(context, row.root);
        if (identity.head !== row.head) {
            throw new Error('dirty source head differs from frozen plan');
        }
        const files = row.paths.map(file => {
            const read = verifySource(context, row.root, file);
            return { ...file, bytes: read?.bytes.length ?? 0, identity: read?.identity ?? null };
        });
        return { root: row.root, head: row.head, ref: row.ref, original: identity, files };
    });
    const tips = [...branches.map(row => row.sha), ...stashes.map(row => row.sha)];
    const unpublishedCommits = revisionList(context, tips, published);
    const result = { schema: 'fsusblog.wip-preservation-inventory.v2', planSha256: context.planSha256, original, remote, baseline, branches, allStashes, stashes, dirty, localBranchCount: allBranches.length, worktrees, unpublishedCommits, acceptance: false };
    assertOriginal(context, result);
    return result;
}

/** Audit bytes and every path of complete reachable snapshots, including stash parents. */
export function auditWip(context, inventory, extraTips = []) {
    assertOriginal(context, inventory);
    const remoteTips = remoteCommits(context, inventory.remote);
    const tips = [...new Set([...inventory.branches.map(row => row.sha), ...inventory.stashes.flatMap(row => [row.sha, ...row.parents]), ...inventory.dirty.map(row => row.head), ...extraTips])];
    const commits = [...new Set([...revisionList(context, tips, remoteTips), ...tips])];
    const trees = [...new Set(commits.map(sha => git(context, ['rev-parse', `${sha}^{tree}`]).trim()))];
    const templates = new Map(context.plan.publicTemplates.map(row => [row.path, row]));
    for (const row of templates.values()) {
        if (git(context, ['ls-tree', inventory.baseline, '--', row.baselinePath]).trim() !== `100644 blob ${row.blob}\t${row.baselinePath}`) {
            throw new Error('public template actual baseline binding mismatch');
        }
    }
    const checkedObjects = new Set();
    let checkedPaths = 0;
    let checkedBlobBytes = 0;
    let exactPublishedTemplatePaths = 0;
    function checkObject(type, sha) {
        if (checkedObjects.has(sha)) {
            return;
        }
        const size = Number(git(context, ['cat-file', '-s', sha]).trim());
        if (size >= context.plan.maxObjectBytes) {
            throw new Error('large object requires review');
        }
        const bytes = git(context, ['cat-file', type, sha], undefined, null);
        if (credentialPattern.test(bytes.toString('utf8'))) {
            throw new Error('credential-pattern review required');
        }
        checkedObjects.add(sha);
        if (type === 'blob') {
            checkedBlobBytes += size;
        }
    }
    for (const sha of commits) {
        checkObject('commit', sha);
    }
    for (const tree of trees) {
        for (const line of git(context, ['ls-tree', '-r', '-z', tree]).split('\0').filter(Boolean)) {
            const at = line.indexOf('\t');
            const [mode, type, sha] = line.slice(0, at).split(' ');
            const file = line.slice(at + 1);
            checkedPaths += 1;
            if (sensitivePath(file)) {
                const exception = templates.get(file);
                if (!exception || mode !== '100644' || type !== 'blob' || sha !== exception.blob) {
                    throw new Error(`full-tree sensitive path requires review: ${file}`);
                }
                exactPublishedTemplatePaths += 1;
            }
            if (type === 'blob') {
                checkObject(type, sha);
            } else {
                throw new Error('unreviewed submodule/object publication');
            }
        }
    }
    assertOriginal(context, inventory);
    return { schema: 'fsusblog.wip-safety-audit.v2', planSha256: context.planSha256, inventorySha256: sha256(JSON.stringify(inventory)), commits: commits.length, trees: trees.length, checkedPaths, checkedObjects: checkedObjects.size, checkedBlobBytes, exactPublishedTemplatePaths, auditCompleted: true, acceptance: false };
}

export function readReceipt(context, name) {
    const file = path.join(context.plan.taskRoot, name);
    requireCanonicalOwnedPath(file, { insideRoot: context.plan.taskRoot });
    const receipt = JSON.parse(readRegular(file).bytes.toString('utf8'));
    if (receipt.planSha256 !== context.planSha256) {
        throw new Error('receipt frozen plan binding mismatch');
    }
    return receipt;
}

export function saveReceipt(context, name, value) {
    writeNewJson(path.join(context.plan.taskRoot, name), value);
    return value;
}

export function requireMutation(context) {
    requireHeldTaskLock(context.plan.taskLock);
}

export function checkedInventory(context) {
    const inventory = readReceipt(context, 'wip-inventory.json');
    const audit = readReceipt(context, 'wip-audit.json');
    if (!audit.auditCompleted || audit.inventorySha256 !== sha256(JSON.stringify(inventory))) {
        throw new Error('complete safety audit missing/stale');
    }
    assertOriginal(context, inventory);
    return inventory;
}

/** Build a private index and preserve exact supplied bytes; never stage the user's index. */
export function commitFiles(context, parent, files, message) {
    const scratch = fs.mkdtempSync(path.join(context.plan.taskRoot, 'wip-index-'));
    const privateEnv = { GIT_INDEX_FILE: path.join(scratch, 'index') };
    try {
        git(context, ['-c', 'core.sparseCheckout=false', 'read-tree', '--reset', '-i', parent], undefined, 'utf8', privateEnv);
        for (const file of files) {
            safeRelative(file.path);
            if (file.bytes === null) {
                git(context, ['update-index', '--force-remove', '--', file.path], undefined, 'utf8', privateEnv);
            } else {
                const blob = git(context, ['hash-object', '-w', '--stdin'], file.bytes).trim();
                git(context, ['update-index', '--add', '--cacheinfo', `${file.mode ?? '100644'},${blob},${file.path}`], undefined, 'utf8', privateEnv);
            }
        }
        const tree = git(context, ['write-tree'], undefined, 'utf8', privateEnv).trim();
        const changed = git(context, ['diff-tree', '--no-commit-id', '--name-only', '-z', '-r', `${parent}^{tree}`, tree]).split('\0').filter(Boolean).sort();
        if (JSON.stringify(changed) !== JSON.stringify(files.map(file => file.path).sort())) {
            throw new Error('private snapshot changed unexpected/no-op paths');
        }
        for (const file of files.filter(row => row.bytes !== null)) {
            if (sha256(git(context, ['show', `${tree}:${file.path}`], undefined, null)) !== sha256(file.bytes)) {
                throw new Error('private snapshot byte mismatch');
            }
        }
        const sha = git(context, ['commit-tree', tree, '-p', parent], message).trim();
        return { sha, tree, original: parent, originalTree: git(context, ['rev-parse', `${parent}^{tree}`]).trim() };
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
}

export function assertDestinationAbsent(context, refs) {
    const remote = new Map(liveRemote(context).map(row => [row.ref, row.sha]));
    for (const ref of refs) {
        if (remote.has(ref)) {
            throw new Error('remote destination already exists');
        }
        try {
            git(context, ['show-ref', '--verify', '--quiet', ref]);
        } catch (error) {
            if (error.status === 1) {
                continue;
            }
            throw error;
        }
        throw new Error('local destination already exists');
    }
}

export function attachRefs(context, entries) {
    const zeros = '0'.repeat(git(context, ['rev-parse', 'HEAD']).trim().length);
    git(context, ['update-ref', '--stdin'], `start\n${entries.map(row => `create ${row.ref} ${row.sha}`).join('\n')}\nprepare\ncommit\n`);
    for (const row of entries) {
        if (row.sha === zeros || git(context, ['rev-parse', row.ref]).trim() !== row.sha) {
            throw new Error('prepared ref mismatch');
        }
    }
}

function handoff(context, parent, ref, details) {
    if (git(context, ['ls-tree', parent, '--', context.plan.handoffPath]).trim()) {
        throw new Error('handoff path already exists');
    }
    const bytes = Buffer.from(`# Recoverable WIP\n\nHistorical preservation only. No merge, issue closure, test/CI pass or trusted baseline promotion.\nRestore from the original source commit; generated outputs still require their original producer.\nOriginal local branches, stashes, indexes and worktree bytes remain owned locally.\n\n${JSON.stringify(details, null, 4)}\n`);
    if (credentialPattern.test(bytes.toString('utf8'))) {
        throw new Error('handoff metadata credential marker');
    }
    return { ref, ...commitFiles(context, parent, [{ path: context.plan.handoffPath, bytes }], 'docs(governance): preserve recoverable wip [skip ci]\n\nHistorical preservation only; no acceptance or issue closure.\n'), handoffPath: context.plan.handoffPath };
}

export function prepareWip(context) {
    requireMutation(context);
    const inventory = checkedInventory(context);
    const refs = [...inventory.branches.map(row => `refs/heads/${context.plan.prefix}/${row.branch}`), ...inventory.stashes.map(row => `refs/heads/${context.plan.prefix}/stash/${row.sha}`)];
    assertDestinationAbsent(context, refs);
    const prepared = [...inventory.branches.map(row => handoff(context, row.sha, `refs/heads/${context.plan.prefix}/${row.branch}`, row)), ...inventory.stashes.map(row => handoff(context, row.sha, `refs/heads/${context.plan.prefix}/stash/${row.sha}`, { ...row, recovery: `git stash apply ${row.sha}` }))];
    assertOriginal(context, inventory);
    if (prepared.length) {
        attachRefs(context, prepared);
    }
    return saveReceipt(context, 'wip-prepared.json', { planSha256: context.planSha256, prepared, acceptance: false, pushed: false });
}

export function snapshotDirtyWip(context) {
    requireMutation(context);
    const inventory = checkedInventory(context);
    assertDestinationAbsent(context, inventory.dirty.map(row => `refs/heads/${context.plan.prefix}/${row.ref}`));
    const snapshots = inventory.dirty.map(row => {
        const files = row.files.map(file => {
            const read = verifySource(context, row.root, file);
            if (read && JSON.stringify(read.identity) !== JSON.stringify(file.identity)) {
                throw new Error('dirty physical file epoch drifted');
            }
            return { path: file.path, bytes: read?.bytes ?? null, mode: read && (fs.statSync(path.join(row.root, file.path)).mode & 0o111) ? '100755' : '100644' };
        });
        const snapshot = commitFiles(context, row.head, files, 'chore(governance): preserve exact uncommitted wip [skip ci]\n\nOriginal index/worktree retained; generated outputs unqualified.\n');
        const prepared = handoff(context, snapshot.sha, `refs/heads/${context.plan.prefix}/${row.ref}`, { root: row.root, original: row.head, snapshot: snapshot.sha, files: row.files });
        return { ...row, snapshot: snapshot.sha, snapshotTree: snapshot.tree, prepared };
    });
    auditWip(context, inventory, snapshots.flatMap(row => [row.snapshot, row.prepared.sha]));
    assertOriginal(context, inventory);
    if (snapshots.length) {
        attachRefs(context, snapshots.map(row => row.prepared));
    }
    return saveReceipt(context, 'wip-dirty.json', { planSha256: context.planSha256, snapshots, acceptance: false, pushed: false });
}

export function runWipCli(args) {
    const cli = parsePlanCli(args, ['inspect', 'inventory', 'safety-audit', 'complete-path-audit', 'prepare', 'snapshot-dirty']);
    const context = createWipContext(cli.planPath, cli.planSha256);
    if (cli.mode === 'inspect') {
        return inventoryWip(context);
    }
    if (cli.mode === 'inventory') {
        requireMutation(context);
        return saveReceipt(context, 'wip-inventory.json', inventoryWip(context));
    }
    if (cli.mode === 'safety-audit' || cli.mode === 'complete-path-audit') {
        const inventory = readReceipt(context, 'wip-inventory.json');
        const result = auditWip(context, inventory);
        if (cli.mode === 'complete-path-audit') {
            requireMutation(context);
            saveReceipt(context, 'wip-audit.json', result);
        }
        return result;
    }
    return cli.mode === 'prepare' ? prepareWip(context) : snapshotDirtyWip(context);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        console.log(JSON.stringify(runWipCli(process.argv.slice(2)), null, 4));
    } catch (error) {
        console.error(`[wip-publication] ${error.message}`);
        process.exitCode = 1;
    }
}
