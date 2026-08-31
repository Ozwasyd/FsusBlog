import fs from 'node:fs';
import path from 'node:path';

import { assertPreRuntimeQualified } from '../test-matrix/behavior-evidence-pre-runtime.mjs';
import { publishRunBoundMarker, readRunBoundMarker } from '../test-matrix/run-bound-marker.mjs';

function normalizeFingerprint(value)
{
    return String(value ?? '').replace(/^sha256:/u, '');
}

function receiptFile(root, file)
{
    const repositoryRoot = path.resolve(root);
    const absolute = path.resolve(file);
    const relative = path.relative(repositoryRoot, absolute);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    {
        throw new Error('behavior evidence receipt must remain inside the repository');
    }
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink())
    {
        throw new Error('behavior evidence receipt must be a regular non-symlink file');
    }
    return absolute;
}

export function readBehaviorEvidenceReadyReceipt({ root, file, runId, sourceState })
{
    const absolute = receiptFile(root, file);
    const receipt = assertPreRuntimeQualified(JSON.parse(fs.readFileSync(absolute, 'utf8')), {
        factExtractorRegistry: path.join(root, 'config', 'contracts', 'behavior-fact-extractors.json')
    });
    if (receipt.runIdentity !== runId)
    {
        throw new Error('behavior evidence receipt belongs to another run');
    }
    if (receipt.sourceIdentity?.commit !== sourceState.commit
    || normalizeFingerprint(receipt.sourceIdentity?.worktreeFingerprint)
        !== normalizeFingerprint(sourceState.worktreeFingerprint))
    {
        throw new Error('behavior evidence receipt belongs to another source state');
    }
    return Object.freeze({ file: absolute, receipt });
}

function markerExpectation({ root, receiptFile: file, runId, sourceState })
{
    return {
        root,
        markerId: 'behavior-evidence-ready',
        runId,
        sourceState,
        producerBundleId: 'backend-tests',
        producerStepId: 'behavior-evidence-pre-runtime',
        artifacts: [file]
    };
}

export function publishBehaviorEvidenceReadyAuthority({
    root,
    receiptFile: file,
    runId,
    sourceState,
    markerFile = path.join(root, '.tmp', 'test-runs', runId, 'behavior-evidence-ready.json')
})
{
    const authority = readBehaviorEvidenceReadyReceipt({ root, file, runId, sourceState });
    const expected = markerExpectation({ root, receiptFile: authority.file, runId, sourceState });
    const marker = publishRunBoundMarker({ file: markerFile, ...expected });
    readRunBoundMarker(markerFile, expected);
    return Object.freeze({ ...authority, marker, markerFile });
}

export function readBehaviorEvidenceReadyAuthority({
    root,
    receiptFile: file,
    markerFile,
    runId,
    sourceState
})
{
    const authority = readBehaviorEvidenceReadyReceipt({ root, file, runId, sourceState });
    const expected = markerExpectation({ root, receiptFile: authority.file, runId, sourceState });
    const marker = readRunBoundMarker(markerFile, expected);
    return Object.freeze({ ...authority, marker, markerFile });
}
