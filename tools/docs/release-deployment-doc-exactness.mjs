#!/usr/bin/env node

/**
 * Release/deployment document exactness: bidirectional claim/section ledger,
 * generated-section drift, controlled prose verification, forbidden manual
 * authority residue and mutation evidence for the release-final aggregate
 * contract and the blue/green + runtime-role deployment behavior.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { digestValue } from '../fact-extractors/identity.mjs';
import { readFactObservationReceipt } from '../fact-extractors/reader.mjs';

import { buildBehaviorDocExactnessReceipt } from './behavior-doc-exactness.mjs';
import { parseRepositoryClaims } from './doc-claim.mjs';
import { renderSectionFromReceipt } from './generated-fact-sections/generator.mjs';
import { parseGeneratedMarkers } from './generated-fact-sections/markers.mjs';
import { verifyProseClaims } from './prose-claim-verifier/verifier.mjs';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const releaseDeploymentScopeId = 'protocol-release-deployment-ownership';
export const releaseDeploymentBehaviorIds = Object.freeze([
    'release-final-aggregate-contract',
    'deployment-blue-green-runtime-role'
]);
export const releaseDeploymentExactnessSchema = 'fsusblog.release-deployment-doc-exactness-receipt.v1';

const readJson = (repositoryRoot, relative) =>
    JSON.parse(readFileSync(path.join(repositoryRoot, relative), 'utf8'));

const forbiddenSurfaces = Object.freeze([
    ['manual-runtime-role-table', /(?:^\|\s*模式\s*\|(?:\n\|[^\n]*){1,8})|(?:^\|\s*Mode\s*\|[^\n]*\n(?:\|[^\n]*\n){0,2}[^\n]*`?(?:single|static-role|adaptive)`?)/im],
    ['manual-stage-table', /^\|\s*(?:stage|phase|阶段|階段)\s*\|/imu],
    ['finalizer-as-rerun', /(?:release[- ]final|finalizer|收尾)[^\n]{0,80}(?:re-?runs?\b|rerun|再跑一次|重新运行|重新運行)/iu],
    ['job-success-authority', /(?:job|ci|workflow)[^\n]{0,40}(?:success|succeeded|成功)[^\n]{0,60}(?:authority|proof|权威|權威|证据|證據|代替|取代|replace)/iu],
    ['auto-spawn-evidence', /(?:auto|自动|自動)[^\n]{0,10}(?:spawn|rerun|re-run|produce|生成|重跑)[^\n]{0,30}(?:allowed|permitted|is ok|允许|允許|即可|可以)|(?:may be auto|可以自动|可以自動)[^\n]{0,30}(?:spawn|produce|rerun|生成|重跑)/iu],
    ['unknown-active-standby', /unknown[^\n]{0,40}active[^\n]{0,60}(?:standby|safe|备用|備用|安全)|(?:把|将|將)[^\n]{0,20}unknown[^\n]{0,30}(?:当|當)[^\n]{0,10}(?:standby|备用|備用)/iu],
    ['active-cleanup-allowed', /(?:cleanup|gc|delete|清除|删除|刪除|清掉)[^\n]{0,50}(?:active release|active artifact|当前\s*active|當前\s*active|active slot|active volume|active schema)/iu],
    ['compose-workflow-role-authority', /compose[^\n]{0,60}(?:runtime[- ]role|角色|模式)[^\n]{0,40}(?:authority|truth|权威|權威|真源)|(?:runtime[- ]role|角色|模式)[^\n]{0,60}compose[^\n]{0,40}(?:authority|truth|权威|權威|真源)/iu],
    ['waiver', /(?:release|deployment|blue[- ]green|runtime|role|slot|fact|document)[ -]?waiver|(?:部署|蓝绿|藍綠|运行时|運行時|事实|事實|文档|文件)豁免/iu],
    ['hidden-compatibility', /<details\b[^>]*>[\s\S]{0,500}(?:legacy|compat)|compat(?:ibility)?[- ]table|current[- ]equivalent/iu],
    ['overbroad-claim', /(?:one|single|一个|一個)[^\n]{0,60}claim[^\n]{0,80}(?:all|every|全部)[^\n]{0,30}(?:behavior|behaviour|行为|行為)/iu],
    ['self-certification', /(?:lastReviewedAt\s*:|lastVerifiedCommit\s*:|manual(?:ly)?[- ]approved\s*:|self[- ]certified)/iu]
]);

function seal(value)
{
    const result = { ...value, contentDigest: null };
    result.contentDigest = digestValue(result);
    return result;
}

function sourceOutsideGeneratedSections(source)
{
    const lines = source.split(/\r?\n/u);
    let generated = false;
    let fenced = false;
    return lines.map((line) =>
    {
        if (/^\s*```/u.test(line))
        {
            fenced = !fenced;
        }
        if (line.includes('FSUSBLOG-GENERATED:BEGIN'))
        {
            generated = true;
        }
        const retained = generated || fenced ? '' : line;
        if (line.includes('FSUSBLOG-GENERATED:END'))
        {
            generated = false;
        }
        return retained;
    }).join('\n');
}

export function scanReleaseDeploymentDocResidue(repositoryRoot, documentPaths)
{
    const findings = [];
    for (const documentPath of [...new Set(documentPaths)].sort())
    {
        const source = sourceOutsideGeneratedSections(readFileSync(path.join(repositoryRoot, documentPath), 'utf8'));
        for (const [classId, pattern] of forbiddenSurfaces)
        {
            const match = source.match(pattern);
            if (match)
            {
                findings.push({ classId, documentPath, evidence: match[0].slice(0, 160) });
            }
        }
    }
    return findings;
}

export function runReleaseDeploymentDocMutationCases()
{
    const samples = [
        ['manual-runtime-role-table', '| Mode | Responsibility |\n| --- | --- |\n| `single` | owns everything |'],
        ['manual-stage-table', '| Stage | Owner |\n| --- | --- |\n| release-final | aggregate |'],
        ['finalizer-as-rerun', 'release-final re-runs every producer to confirm success'],
        ['job-success-authority', 'the CI job success is the authority for release evidence'],
        ['auto-spawn-evidence', 'missing evidence auto-spawn is allowed before closeout'],
        ['unknown-active-standby', 'unknown active identity is treated as a safe standby'],
        ['active-cleanup-allowed', 'the GC may delete the active release assets'],
        ['compose-workflow-role-authority', 'the compose file is the runtime-role authority'],
        ['waiver', 'deployment-waiver'],
        ['hidden-compatibility', '<details>legacy compatibility table</details>'],
        ['overbroad-claim', 'one claim covers all behaviors'],
        ['self-certification', 'lastVerifiedCommit: deadbeef']
    ];
    const rows = samples.map(([classId, source]) => ({
        classId,
        killed: forbiddenSurfaces.find(([id]) => id === classId)[1].test(source),
        detector: classId
    }));
    return seal({
        schema: 'fsusblog.release-deployment-doc-mutation-evidence.v1',
        rows,
        killed: rows.filter((row) => row.killed).length,
        total: rows.length
    });
}

export function verifyReleaseDeploymentGeneratedSections(repositoryRoot, sectionCatalog, observationReceipt)
{
    const drifts = [];
    const sections = sectionCatalog.sections
        .filter((entry) => releaseDeploymentBehaviorIds.includes(entry.behaviorId));
    for (const section of sections)
    {
        const source = readFileSync(path.join(repositoryRoot, section.documentPath), 'utf8');
        const markers = parseGeneratedMarkers(source, section.documentPath);
        const marker = markers.find((entry) => entry.sectionId === section.sectionId);
        if (!marker)
        {
            drifts.push(`${section.sectionId} marker missing`);
            continue;
        }
        const expected = renderSectionFromReceipt(section, observationReceipt, null).replace(/\n+$/u, '');
        const actual = marker.existingBody.replace(/\n+$/u, '');
        if (actual !== expected)
        {
            drifts.push(`${section.sectionId} generated section drift`);
        }
    }
    return drifts;
}

export function loadReleaseDeploymentExactnessInputs(repositoryRoot, observationReceipt)
{
    const catalog = readJson(repositoryRoot, 'config/contracts/behavior-contracts.json');
    const lifecycle = readJson(repositoryRoot, 'config/development/document-lifecycle.json');
    const migrationLedger = readJson(repositoryRoot, 'config/contracts/document-claim-migration-ledger.json');
    const sectionCatalog = readJson(repositoryRoot, 'config/contracts/generated-fact-sections.json');
    const claimReceipt = parseRepositoryClaims(repositoryRoot, { catalog });
    const receiptRaw = typeof observationReceipt === 'string'
        ? JSON.parse(readFileSync(observationReceipt, 'utf8'))
        : observationReceipt;
    const receipt = readFactObservationReceipt(receiptRaw);
    return { catalog, lifecycle, migrationLedger, sectionCatalog, claimReceipt, receiptRaw, receipt };
}

export function buildReleaseDeploymentDocExactnessReceipt({
    repositoryRoot = root,
    observationReceipt,
    sourceCommit,
    worktreeFingerprint
})
{
    const inputs = loadReleaseDeploymentExactnessInputs(repositoryRoot, observationReceipt);
    const exactness = buildBehaviorDocExactnessReceipt({
        repositoryRoot,
        catalog: inputs.catalog,
        lifecycle: inputs.lifecycle,
        migrationLedger: inputs.migrationLedger,
        claimReceipt: inputs.claimReceipt,
        sectionCatalog: inputs.sectionCatalog,
        observationReceipts: [inputs.receiptRaw],
        domains: ['release', 'deployment'],
        selectedBehaviorIds: [...releaseDeploymentBehaviorIds],
        sourceCommit,
        worktreeFingerprint,
        scopeId: releaseDeploymentScopeId,
        scannerDigest: createHash('sha256')
            .update(forbiddenSurfaces.map(([id, pattern]) => `${id}:${pattern}`).join('\n'))
            .digest('hex')
    });
    const documentPaths = inputs.catalog.contracts
        .filter((entry) => releaseDeploymentBehaviorIds.includes(entry.id))
        .flatMap((entry) => entry.documents);
    const residue = scanReleaseDeploymentDocResidue(repositoryRoot, documentPaths);
    const generatedDrifts = verifyReleaseDeploymentGeneratedSections(
        repositoryRoot,
        inputs.sectionCatalog,
        inputs.receipt
    );
    const mutationEvidence = runReleaseDeploymentDocMutationCases();
    const proseClaims = inputs.claimReceipt.claims.filter((claim) =>
        releaseDeploymentBehaviorIds.includes(claim.declaration.behaviorId)
        && claim.declaration.claimType !== 'generated-section');
    const proseVerification = verifyProseClaims({
        claims: proseClaims,
        receipts: [inputs.receiptRaw]
    });
    const failureReasons = [
        ...exactness.failureReasons,
        ...generatedDrifts,
        ...proseVerification.diagnostics.map((entry) =>
            `${entry.claimId} prose verification ${entry.code}`),
        ...residue.map((entry) => `${entry.classId} in ${entry.documentPath}`),
        ...(mutationEvidence.killed === mutationEvidence.total ? [] : ['release/deployment mutation evidence incomplete'])
    ].sort();
    return seal({
        schema: releaseDeploymentExactnessSchema,
        scopeId: releaseDeploymentScopeId,
        source: exactness.source,
        authorityDigests: exactness.authorityDigests,
        exactnessDigest: exactness.contentDigest,
        rows: exactness.rows,
        counts: {
            ...exactness.counts,
            residue: residue.length,
            generatedDrift: generatedDrifts.length,
            proseVerified: proseClaims.length - proseVerification.diagnostics.length,
            proseTotal: proseClaims.length,
            mutationKilled: mutationEvidence.killed,
            mutationTotal: mutationEvidence.total
        },
        mutationEvidence,
        residue,
        generatedDrifts,
        proseVerification,
        status: failureReasons.length === 0 ? 'ok' : 'failed',
        failureReasons
    });
}

export function validateReleaseDeploymentDocExactnessReceipt(receipt)
{
    if (receipt?.schema !== releaseDeploymentExactnessSchema)
    {
        throw new Error('unexpected release/deployment exactness schema');
    }
    if (receipt.contentDigest !== digestValue({ ...receipt, contentDigest: null }))
    {
        throw new Error('release/deployment exactness contentDigest mismatch');
    }
    if (receipt.status !== 'ok' || receipt.failureReasons.length !== 0
        || receipt.counts.warnings !== 0 || receipt.counts.residue !== 0
        || receipt.counts.generatedDrift !== 0
        || receipt.counts.proseVerified !== receipt.counts.proseTotal
        || receipt.mutationEvidence.killed !== receipt.mutationEvidence.total)
    {
        throw new Error(`release/deployment exactness failed: ${receipt.failureReasons.join('; ')}`);
    }
    return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    const receiptIndex = process.argv.indexOf('--receipt');
    const receiptPath = receiptIndex >= 0 ? process.argv[receiptIndex + 1] : null;
    if (!receiptPath)
    {
        throw new Error('usage: release-deployment-doc-exactness.mjs --receipt <fact-observation-receipt>');
    }
    const absoluteReceiptPath = path.resolve(receiptPath);
    const observation = readFactObservationReceipt(absoluteReceiptPath);
    const result = buildReleaseDeploymentDocExactnessReceipt({
        repositoryRoot: root,
        observationReceipt: absoluteReceiptPath,
        sourceCommit: observation.sourceCommit,
        worktreeFingerprint: observation.worktreeFingerprint
    });
    validateReleaseDeploymentDocExactnessReceipt(result);
    console.log(`[release-deployment-doc-exactness] ok claims=${result.rows.length} mutations=${result.counts.mutationKilled}/${result.counts.mutationTotal}`);
}
