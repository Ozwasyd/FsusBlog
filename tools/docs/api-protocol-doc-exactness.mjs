#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { digestValue } = await import(new URL('../fact-extractors/identity.mjs', import.meta.url));
const { readFactObservationReceipt } = await import(new URL('../fact-extractors/reader.mjs', import.meta.url));
import {
    buildBehaviorDocExactnessReceipt,
    // eslint-disable-next-line no-unused-vars
    validateBehaviorDocExactnessReceipt
} from './behavior-doc-exactness.mjs';
import { parseRepositoryClaims } from './doc-claim.mjs';
import { renderSectionFromReceipt } from './generated-fact-sections/generator.mjs';
import { parseGeneratedMarkers } from './generated-fact-sections/markers.mjs';
import { verifyProseClaims } from './prose-claim-verifier/verifier.mjs';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const apiProtocolScopeId = 'api-protocol-documents';
export const apiProtocolExactnessSchema = 'fsusblog.api-protocol-doc-exactness-receipt.v1';

const readJson = (repositoryRoot, relative) =>
    JSON.parse(readFileSync(path.join(repositoryRoot, relative), 'utf8'));

const forbiddenSurfaces = Object.freeze([
    ['manual-operation-table', /^\|\s*(?:method|方法)\s*\|\s*(?:path|路径|路徑)\s*\|[^\n]*$\n(?:^\|[^\n]*$\n)*?^\|[^\n]*\/api\/binary\/[^\n]*$/imu],
    ['copied-public-error-table', /^\|\s*(?:public error|error id|错误 id|錯誤 id)\s*\|/imu],
    ['legacy-protocol-current', /(?:legacy|retired|migration-only)[^\n]{0,80}(?:is|listed as|列为|列為)\s+current/iu],
    ['example-as-contract', /(?:example|示例)[^\n]{0,80}(?:is|as|作为|作為)\s+(?:the\s+)?(?:contract|default|required|契约|契約|默认|預設|必填)/iu],
    ['global-error-substitute', /(?:global ErrorCode|全局\s*ErrorCode|全域\s*ErrorCode)[^\n]{0,100}(?:complete|sufficient|covers all|完整|足够|足夠|覆盖全部|覆蓋全部)/iu],
    ['controller-source-grep', /(?:controller|source)[ -]?grep[^\n]{0,80}(?:authority|generator|truth|权威|權威|生成器|真源)/iu],
    ['known-file-baseline', /(?:known[- ]file|固定文件)[^\n]{0,80}(?:baseline|allowlist|基线|基線|白名单|白名單)/iu],
    ['waiver', /(?:fact|protocol|document)[ -]?waiver|(?:事实|事實|协议|協議|文档|文件)豁免/iu],
    ['hidden-compatibility', /<details\b[^>]*>[\s\S]{0,500}(?:legacy|compat)|compat(?:ibility)?[- ]table|current[- ]equivalent/iu],
    ['direction-reversal', /(?:request|请求|請求)[^\n]{0,80}(?:comes from|来自|來自)\s+(?:response|result|响应|回應|结果|結果)/iu],
    ['result-placement-reversal', /(?:result|结果|結果)[^\n]{0,80}(?:json body|text body|outside the aeds frame|位于\s*JSON|位於\s*JSON)/iu],
    ['overbroad-claim', /(?:one|single|一个|一個)[^\n]{0,60}claim[^\n]{0,80}(?:all|every|全部)[^\n]{0,30}(?:operation|behavior|操作|行为|行為)/iu],
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

export function scanApiProtocolDocResidue(repositoryRoot, documentPaths)
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

export function runApiProtocolDocMutationCases()
{
    const samples = [
        ['manual-operation-table', '| Method | Path | Operation |\n| --- | --- | --- |\n| GET | /api/binary/example | Example |'],
        ['copied-public-error-table', '| Public error | HTTP |'],
        ['legacy-protocol-current', 'legacy frame is listed as current'],
        ['example-as-contract', 'This example is the required contract.'],
        ['global-error-substitute', 'The global ErrorCode set is sufficient and covers all operations.'],
        ['controller-source-grep', 'controller grep is the generator authority'],
        ['known-file-baseline', 'known-file allowlist is the baseline'],
        ['waiver', 'protocol-waiver'],
        ['hidden-compatibility', '<details>legacy compatibility table</details>'],
        ['direction-reversal', 'request comes from response'],
        ['result-placement-reversal', 'result is in JSON body'],
        ['overbroad-claim', 'one claim covers all operations'],
        ['self-certification', 'lastVerifiedCommit: deadbeef']
    ];
    const rows = samples.map(([classId, source]) => ({
        classId,
        killed: forbiddenSurfaces.find(([id]) => id === classId)[1].test(source),
        detector: classId
    }));
    return seal({
        schema: 'fsusblog.api-protocol-doc-mutation-evidence.v1',
        rows,
        killed: rows.filter((row) => row.killed).length,
        total: rows.length
    });
}

export function verifyApiProtocolGeneratedSections(repositoryRoot, sectionCatalog, observationReceipt)
{
    const drifts = [];
    const sections = sectionCatalog.sections
        .filter((entry) => entry.behaviorId === 'binary-api-aeds-contract');
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

export function loadApiProtocolExactnessInputs(repositoryRoot, observationReceipt)
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

export function buildApiProtocolDocExactnessReceipt({
    repositoryRoot = root,
    observationReceipt,
    sourceCommit,
    worktreeFingerprint
})
{
    const inputs = loadApiProtocolExactnessInputs(repositoryRoot, observationReceipt);
    const exactness = buildBehaviorDocExactnessReceipt({
        repositoryRoot,
        catalog: inputs.catalog,
        lifecycle: inputs.lifecycle,
        migrationLedger: inputs.migrationLedger,
        claimReceipt: inputs.claimReceipt,
        sectionCatalog: inputs.sectionCatalog,
        observationReceipts: [inputs.receiptRaw],
        domains: ['protocol'],
        selectedBehaviorIds: ['binary-api-aeds-contract'],
        sourceCommit,
        worktreeFingerprint,
        scopeId: apiProtocolScopeId,
        scannerDigest: createHash('sha256')
            .update(forbiddenSurfaces.map(([id, pattern]) => `${id}:${pattern}`).join('\n'))
            .digest('hex')
    });
    const documentPaths = inputs.catalog.contracts
        .find((entry) => entry.id === 'binary-api-aeds-contract').documents;
    const residue = scanApiProtocolDocResidue(repositoryRoot, documentPaths);
    const generatedDrifts = verifyApiProtocolGeneratedSections(
        repositoryRoot,
        inputs.sectionCatalog,
        inputs.receipt
    );
    const mutationEvidence = runApiProtocolDocMutationCases();
    const proseClaims = inputs.claimReceipt.claims.filter((claim) =>
        claim.declaration.behaviorId === 'binary-api-aeds-contract'
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
        ...(mutationEvidence.killed === mutationEvidence.total ? [] : ['API/protocol mutation evidence incomplete'])
    ].sort();
    return seal({
        schema: apiProtocolExactnessSchema,
        scopeId: apiProtocolScopeId,
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

export function validateApiProtocolDocExactnessReceipt(receipt)
{
    if (receipt?.schema !== apiProtocolExactnessSchema)
    {
        throw new Error('unexpected API/protocol exactness schema');
    }
    if (receipt.contentDigest !== digestValue({ ...receipt, contentDigest: null }))
    {
        throw new Error('API/protocol exactness contentDigest mismatch');
    }
    if (receipt.status !== 'ok' || receipt.failureReasons.length !== 0
        || receipt.counts.warnings !== 0 || receipt.counts.residue !== 0
        || receipt.counts.generatedDrift !== 0
        || receipt.counts.proseVerified !== receipt.counts.proseTotal
        || receipt.mutationEvidence.killed !== receipt.mutationEvidence.total)
    {
        throw new Error(`API/protocol exactness failed: ${receipt.failureReasons.join('; ')}`);
    }
    return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    const receiptIndex = process.argv.indexOf('--receipt');
    const receiptPath = receiptIndex >= 0 ? process.argv[receiptIndex + 1] : null;
    if (!receiptPath)
    {
        throw new Error('usage: api-protocol-doc-exactness.mjs --receipt <fact-observation-receipt>');
    }
    const absoluteReceiptPath = path.resolve(receiptPath);
    const observation = readFactObservationReceipt(absoluteReceiptPath);
    const result = buildApiProtocolDocExactnessReceipt({
        repositoryRoot: root,
        observationReceipt: absoluteReceiptPath,
        sourceCommit: observation.sourceCommit,
        worktreeFingerprint: observation.worktreeFingerprint
    });
    validateApiProtocolDocExactnessReceipt(result);
    console.log(`[api-protocol-doc-exactness] ok claims=${result.rows.length} mutations=${result.counts.mutationKilled}/${result.counts.mutationTotal}`);
}
