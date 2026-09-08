import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
    validateFrontendBuildStageReceiptBinding,
    validateFrontendBuildStageReceiptIdentity
} from '../test-matrix/frontend-build-ready-marker.mjs';
import { productionBuildLayoutDigest } from '../test-matrix/production-build-layout.mjs';

function sha256(value)
{
    return createHash('sha256').update(value).digest('hex');
}

function relative(root, target)
{
    return path.relative(root, target).replaceAll(path.sep, '/');
}

function writeJsonAtomic(file, value)
{
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.next-${process.pid}-${randomUUID()}`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(temporary, file);
}

export function productionBuildLayoutBinding({ root, layout, sourceState })
{
    return Object.freeze({
        runId: layout.runId,
        manifestPath: relative(root, layout.manifestFile),
        manifestDigest: productionBuildLayoutDigest(layout),
        sourceCommit: sourceState.commit,
        sourceFingerprint: sourceState.worktreeFingerprint
    });
}

export function productionFileArtifactEvidence(root, file)
{
    const absolute = path.resolve(file);
    if (!absolute.startsWith(`${path.resolve(root)}${path.sep}`))
    {
        throw new Error(`production artifact escapes repository: ${file}`);
    }
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink())
    {
        throw new Error(`production artifact must be a regular file: ${file}`);
    }
    const artifactPath = relative(root, absolute);
    const content = sha256(fs.readFileSync(absolute));
    return Object.freeze({
        path: artifactPath,
        exists: true,
        digest: `sha256:${sha256(`file:${Number(stat.mode)}:${Number(stat.size)}:${content}`)}`,
        artifactRef: `artifact:${sha256(`path:${artifactPath}`)}`
    });
}

export function publishBackendBuildReadyAuthority({ root, layout, sourceState })
{
    const serverDll = layout.artifacts.serverDll;
    const marker = {
        schema: 'fsusblog.local-production.backend-build-ready.v1',
        status: 'success',
        physicalBundleId: 'backend-tests',
        schedulerRunId: layout.runId,
        buildLayout: productionBuildLayoutBinding({ root, layout, sourceState }),
        serverDll: productionFileArtifactEvidence(root, serverDll),
        generatedAt: new Date().toISOString()
    };
    const file = path.join(root, '.tmp', 'test-runs', layout.runId, 'backend-build-ready.json');
    writeJsonAtomic(file, marker);
    return Object.freeze({ file, marker });
}

function fileContentDigest(file)
{
    return `sha256:${sha256(fs.readFileSync(file))}`;
}

export function publishFrontendBuildReadyAuthority({
    root,
    layout,
    sourceState,
    expectedStages,
    criticalOutputPaths,
    stageReceiptFile
})
{
    const stageReceipt = JSON.parse(fs.readFileSync(stageReceiptFile, 'utf8'));
    const identity = validateFrontendBuildStageReceiptIdentity(stageReceipt, {
        runId: layout.runId,
        sourceState
    });
    const stageReceiptPath = relative(root, stageReceiptFile);
    const marker = {
        schema: 'fsusblog.local-production.frontend-build-ready.v1',
        status: 'success',
        physicalBundleId: 'build-static',
        producerStepId: 'sync-static-assets',
        schedulerRunId: layout.runId,
        buildLayout: productionBuildLayoutBinding({ root, layout, sourceState }),
        stageReceipt: {
            path: stageReceiptPath,
            contentDigest: fileContentDigest(stageReceiptFile),
            identity
        },
        generatedAt: new Date().toISOString()
    };
    validateFrontendBuildStageReceiptBinding({
        root,
        marker,
        runId: layout.runId,
        sourceState,
        expectedPath: stageReceiptPath,
        expectedStages,
        stageCwd: path.join(root, 'src', 'frontend'),
        criticalOutputPaths
    });
    const file = path.join(root, '.tmp', 'test-runs', layout.runId, 'frontend-build-ready.json');
    writeJsonAtomic(file, marker);
    return Object.freeze({ file, marker });
}
