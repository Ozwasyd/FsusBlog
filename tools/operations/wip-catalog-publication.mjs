#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parsePlanCli, readRegular, requireCanonicalOwnedPath } from './local-task-plan.mjs';
import { assertDestinationAbsent, assertOriginal, attachRefs, auditWip, checkedInventory, commitFiles, createWipContext, expectedRefs, git, liveRemote, readReceipt, requireMutation, saveReceipt, sha256 } from './wip-publication.mjs';

function sourceCopies(context) {
    return context.plan.catalog.sources.map(row => {
        if (!/\.(?:mjs|cjs|js|ts|sh|bash|py|ps1|md)$/u.test(row.target)) {
            throw new Error('catalog admits selected operational source text only');
        }
        requireCanonicalOwnedPath(row.source);
        const source = readRegular(row.source, context.plan.maxSourceBytes);
        if (source.bytes.includes(0) || source.sha256 !== row.sha256) {
            throw new Error('catalog source digest differs from frozen plan');
        }
        return { path: row.target, bytes: source.bytes, source: row.source, sha256: row.sha256, identity: source.identity };
    });
}

function receipts(context) {
    return {
        inventory: checkedInventory(context),
        prepared: readReceipt(context, 'wip-prepared.json'),
        dirty: readReceipt(context, 'wip-dirty.json')
    };
}

function entriesFor(context, receipt) {
    const entries = [...receipt.prepared.prepared, ...receipt.dirty.snapshots.map(row => row.prepared)];
    const expected = expectedRefs(context, false);
    if (entries.length !== expected.length || new Set(entries.map(row => row.ref)).size !== entries.length || entries.some(row => !expected.includes(row.ref))) {
        throw new Error('prepared source/ref mapping incomplete');
    }
    for (const row of receipt.inventory.branches) {
        validateHandoff(context, entries.find(entry => entry.ref === `refs/heads/${context.plan.prefix}/${row.branch}`), row.sha);
    }
    for (const row of receipt.inventory.stashes) {
        validateHandoff(context, entries.find(entry => entry.ref === `refs/heads/${context.plan.prefix}/stash/${row.sha}`), row.sha);
    }
    if (receipt.dirty.snapshots.length !== receipt.inventory.dirty.length) {
        throw new Error('dirty snapshot mapping incomplete');
    }
    for (const row of receipt.inventory.dirty) {
        const snapshot = receipt.dirty.snapshots.find(item => item.root === row.root && item.ref === row.ref);
        if (!snapshot || git(context, ['show', '-s', '--format=%P', snapshot.snapshot]).trim() !== row.head) {
            throw new Error('dirty snapshot original parent mismatch');
        }
        const paths = git(context, ['diff-tree', '--no-commit-id', '--name-only', '-z', '-r', row.head, snapshot.snapshot]).split('\0').filter(Boolean).sort();
        if (JSON.stringify(paths) !== JSON.stringify(row.files.map(file => file.path).sort())) {
            throw new Error('dirty snapshot changed unrelated paths');
        }
        for (const file of row.files) {
            if (file.sha256 === null) {
                if (git(context, ['ls-tree', snapshot.snapshot, '--', file.path]).trim()) {
                    throw new Error('deleted dirty source present in snapshot');
                }
            } else if (sha256(git(context, ['show', `${snapshot.snapshot}:${file.path}`], undefined, null)) !== file.sha256) {
                throw new Error('dirty snapshot pinned byte mismatch');
            }
        }
        validateHandoff(context, entries.find(entry => entry.ref === `refs/heads/${context.plan.prefix}/${row.ref}`), snapshot.snapshot);
    }
    return entries;
}

function validateHandoff(context, entry, parent) {
    if (!entry || entry.original !== parent || entry.handoffPath !== context.plan.handoffPath || git(context, ['show', '-s', '--format=%P', entry.sha]).trim() !== parent || git(context, ['diff-tree', '--no-commit-id', '--name-only', '-z', '-r', parent, entry.sha]) !== `${context.plan.handoffPath}\0`) {
        throw new Error('prepared handoff is not bound to exact original source');
    }
}

function catalogFiles(context, receipt, copies) {
    const manifest = {
        schema: 'fsusblog.wip-handoff-catalog.v2',
        planSha256: context.planSha256,
        status: 'historical-preservation-not-acceptance',
        baseline: receipt.inventory.baseline,
        sourceBranches: receipt.inventory.branches,
        sourceCommits: receipt.inventory.unpublishedCommits,
        stashes: receipt.inventory.stashes,
        dirtySnapshots: receipt.dirty.snapshots,
        prepared: receipt.prepared.prepared,
        operationalSources: copies.map(({ bytes, identity, ...row }) => row),
        excluded: ['.qoder', 'credentials/private keys', 'VM/COW images', 'raw logs/traces/recovery archives', 'shared dependencies/caches', 'unlisted ignored source'],
        acceptance: { tests: false, ci: false, merge: false, issuesClosed: false, trustedBaseline: false }
    };
    const listing = entriesFor(context, receipt).map(row => `- ${row.ref}: original ${row.original}; preservation ${row.sha}`).join('\n');
    const readme = `# Recoverable WIP catalog\n\nHistorical preservation only. Do not merge preservation heads as accepted candidates.\nRestore branches from their original commits and apply stashes using their original object IDs.\nOriginal branches, registered worktrees, indexes, dirty bytes, stashes and ignored materials remain local.\nGenerated/fixture/lockfile copies retain original producer ownership and require fresh validation.\nThe manifest records actual selected sources and excludes raw evidence, VM state and credentials.\nNo test/CI pass, merge, issue closure or trusted baseline promotion is claimed.\n\n${listing}\n`;
    return [
        { path: `${context.plan.catalog.directory}/WIP.md`, bytes: Buffer.from(readme) },
        { path: `${context.plan.catalog.directory}/manifest.json`, bytes: Buffer.from(`${JSON.stringify(manifest, null, 4)}\n`) },
        ...copies
    ];
}

/** Preserve catalog metadata and selected operational source bytes, never historical archives. */
export function prepareWipCatalog(context) {
    requireMutation(context);
    const receipt = receipts(context);
    const entries = entriesFor(context, receipt);
    const ref = `refs/heads/${context.plan.prefix}/${context.plan.catalog.ref}`;
    assertDestinationAbsent(context, [ref]);
    const copies = sourceCopies(context);
    const files = catalogFiles(context, receipt, copies);
    if (new Set(files.map(row => row.path)).size !== files.length) {
        throw new Error('duplicate catalog path');
    }
    for (const file of files) {
        if (git(context, ['ls-tree', receipt.inventory.baseline, '--', file.path]).trim()) {
            throw new Error('catalog target already exists in original baseline');
        }
    }
    const catalog = { ref, ...commitFiles(context, receipt.inventory.baseline, files, 'chore(governance): preserve wip catalog and operational sources [skip ci]\n\nHistorical preservation only; no acceptance.\n'), catalog: true };
    const audit = auditWip(context, receipt.inventory, [...entries.map(row => row.sha), catalog.sha]);
    // Verify source physical epochs again before attaching any catalog ref.
    const afterCopies = sourceCopies(context);
    if (JSON.stringify(copies.map(row => row.identity)) !== JSON.stringify(afterCopies.map(row => row.identity))) {
        throw new Error('catalog source epoch changed');
    }
    assertOriginal(context, receipt.inventory);
    attachRefs(context, [catalog]);
    return saveReceipt(context, 'wip-publication.json', { planSha256: context.planSha256, refs: [...entries, catalog], inventorySha256: sha256(JSON.stringify(receipt.inventory)), audit, operationalSources: copies.map(({ bytes, ...row }) => row), pushed: false, acceptance: false });
}

function validatePublication(context, receipt, publication) {
    const entries = entriesFor(context, receipt);
    const refs = expectedRefs(context);
    if (!Array.isArray(publication.refs) || publication.refs.length !== refs.length || new Set(publication.refs.map(row => row.ref)).size !== refs.length || publication.refs.some(row => !refs.includes(row.ref)) || publication.inventorySha256 !== sha256(JSON.stringify(receipt.inventory))) {
        throw new Error('publication source/ref/plan binding mismatch');
    }
    for (const entry of entries) {
        if (publication.refs.find(row => row.ref === entry.ref)?.sha !== entry.sha) {
            throw new Error('publication prepared commit mismatch');
        }
    }
    const catalog = publication.refs.find(row => row.ref === `refs/heads/${context.plan.prefix}/${context.plan.catalog.ref}`);
    if (!catalog?.catalog || git(context, ['show', '-s', '--format=%P', catalog.sha]).trim() !== receipt.inventory.baseline) {
        throw new Error('catalog baseline parent mismatch');
    }
    const files = catalogFiles(context, receipt, sourceCopies(context));
    const paths = git(context, ['diff-tree', '--no-commit-id', '--name-only', '-z', '-r', receipt.inventory.baseline, catalog.sha]).split('\0').filter(Boolean).sort();
    if (JSON.stringify(paths) !== JSON.stringify(files.map(row => row.path).sort())) {
        throw new Error('catalog unrelated source paths');
    }
    for (const file of files) {
        if (sha256(git(context, ['show', `${catalog.sha}:${file.path}`], undefined, null)) !== sha256(file.bytes)) {
            throw new Error('catalog source byte/digest mismatch');
        }
    }
    for (const row of publication.refs) {
        if (git(context, ['rev-parse', row.ref]).trim() !== row.sha || !git(context, ['show', '-s', '--format=%B', row.sha]).includes('[skip ci]')) {
            throw new Error('prepared local ref/CI marker drifted');
        }
    }
    auditWip(context, receipt.inventory, publication.refs.map(row => row.sha));
}

/** Remote creation is an explicit atomic CAS; no overwrite, deletion, issue or PR APIs exist. */
export function publishWip(context) {
    requireMutation(context);
    const receipt = receipts(context);
    const publication = readReceipt(context, 'wip-publication.json');
    validatePublication(context, receipt, publication);
    assertOriginal(context, receipt.inventory);
    const memoryMatch = /^MemAvailable:\s+(\d+)/mu.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
    const disk = fs.statfsSync(context.plan.repoRoot, { bigint: true });
    if (!memoryMatch || BigInt(memoryMatch[1]) * 1024n < BigInt(context.plan.resourceFloor.availableMemoryBytes) || disk.bavail * disk.bsize < BigInt(context.plan.resourceFloor.availableDiskBytes)) {
        throw new Error('actual publication resource floor refused');
    }
    const before = liveRemote(context);
    const actual = new Map(before.map(row => [row.ref, row.sha]));
    if (receipt.inventory.remote.some(row => actual.get(row.ref) !== row.sha) || publication.refs.some(row => actual.has(row.ref))) {
        throw new Error('actual remote changed or destination exists; freeze a fresh task plan');
    }
    if (fs.existsSync(path.join(context.plan.taskRoot, 'wip-push-actual.json'))) {
        throw new Error('prior push attempt exists; inspect actual remote before a fresh plan');
    }
    let output;
    try {
        output = git(context, ['-c', 'pack.threads=1', '-c', 'pack.windowMemory=32m', '-c', 'pack.deltaCacheSize=16m', '-c', 'pack.window=5', '-c', 'push.followTags=false', 'push', '--atomic', '--porcelain', '--no-follow-tags', '--recurse-submodules=no', ...publication.refs.map(row => `--force-with-lease=${row.ref}:`), context.plan.remote.url, ...publication.refs.map(row => `${row.sha}:${row.ref}`)]);
    } catch (error) {
        saveReceipt(context, 'wip-push-actual.json', { planSha256: context.planSha256, status: error.status ?? null, signal: error.signal ?? null, message: error.message, acceptance: false });
        throw new Error('atomic publication failed; inspect actual remote before any fresh-plan retry');
    }
    saveReceipt(context, 'wip-push-actual.json', { planSha256: context.planSha256, status: 0, output, atomic: true, createOnly: true, acceptance: false });
    const after = new Map(liveRemote(context).map(row => [row.ref, row.sha]));
    if (before.some(row => after.get(row.ref) !== row.sha) || publication.refs.some(row => after.get(row.ref) !== row.sha)) {
        throw new Error('actual post-publication remote ref mismatch');
    }
    const missing = receipt.inventory.unpublishedCommits.length ? git(context, ['rev-list', ...receipt.inventory.unpublishedCommits, '--not', ...publication.refs.map(row => row.sha)]).trim() : '';
    if (missing) {
        throw new Error('original source commits not reachable from preservation refs');
    }
    assertOriginal(context, receipt.inventory);
    return saveReceipt(context, 'wip-remote-verification.json', { planSha256: context.planSha256, refsMatched: publication.refs.length, originalRemoteRefsUnchanged: before.length, sourceCommitsReachable: receipt.inventory.unpublishedCommits.length, originalSourcesPreserved: true, acceptance: false });
}

export function runWipCatalogCli(args) {
    const cli = parsePlanCli(args, ['inspect', 'catalog', 'push']);
    const context = createWipContext(cli.planPath, cli.planSha256);
    if (cli.mode === 'inspect') {
        const receipt = receipts(context);
        return { planSha256: context.planSha256, refs: entriesFor(context, receipt), sourceCopies: sourceCopies(context).map(({ bytes, ...row }) => row), acceptance: false };
    }
    return cli.mode === 'catalog' ? prepareWipCatalog(context) : publishWip(context);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        console.log(JSON.stringify(runWipCatalogCli(process.argv.slice(2)), null, 4));
    } catch (error) {
        console.error(`[wip-catalog-publication] ${error.message}`);
        process.exitCode = 1;
    }
}
