#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
    governanceContentDigest,
    verifyEvidenceLocationGovernance
} from './evidence-location-contract.mjs';
import { scanEvidenceLocations } from './evidence-location-scanner.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const registryPath = path.join(repositoryRoot, 'config/testing/evidence-locator-registry.json');
const ledgerPath = path.join(repositoryRoot, 'config/testing/evidence-location-migration-ledger.json');

const correctnessPrograms = new Set([
    '.github/workflows/quality-gate.yml',
    'tools/ci/check-flaky-evidence.mjs',
    'tools/ci/check-job-summaries.mjs',
    'tools/ci/summarize-quality-gate.mjs',
    'tools/operations/check-release-evidence-layout.mjs',
    'tools/operations/check-release-evidence-manifest.mjs',
    'tools/operations/collect-release-evidence.sh',
    'tools/operations/seal-release-evidence-bundle.mjs',
    'tools/release/check-release-final.mjs',
    'tools/release/public-preview-release-evidence.mjs',
    'tools/release/test-evidence-receipts-cli.mjs',
    'tools/run-test-matrix.mjs',
    'tools/test/aggregate-data-scale-evidence.mjs',
    'tools/test/aggregate-performance-evidence.mjs',
    'tools/test/write-release-domain-assertion-report.mjs',
    'tools/test-matrix/release-domain-projection-receipt.mjs',
    'tools/test-matrix/required-evidence-catalog.mjs'
]);
const diagnosticPrograms = new Set([
    '.github/workflows/browser-diagnostics.yml',
    'tests/browser-diagnostics/run.mjs',
    'tools/operations/check-evidence-metrics.mjs'
]);
const evidenceProgramName = /(?:artifact|evidence|flaky|manifest|quality-gate|receipt|release-final|report|summary)/iu;

function programClassification(file)
{
    if (correctnessPrograms.has(file))
    {
        return 'correctness-selection';
    }
    if (diagnosticPrograms.has(file) || file.startsWith('tools/docs/'))
    {
        return 'diagnostic-only';
    }
    if (file.startsWith('tools/') && evidenceProgramName.test(file))
    {
        return 'correctness-selection';
    }
    return 'not-evidence';
}

function stableSlug(value)
{
    return value.replace(/\.(?:mjs|js|json|sh|ya?ml)$/u, '')
        .replace(/^\.github\/workflows\//u, 'workflow.')
        .replace(/^tools\//u, '')
        .replaceAll('/', '.')
        .replace(/[^a-zA-Z0-9.-]+/gu, '-')
        .replace(/\.+/gu, '.')
        .toLowerCase();
}

function consumerIdFor(file)
{
    return `evidence-consumer.${stableSlug(file)}`;
}

function ownerFor(file)
{
    if (file.startsWith('.github/') || file.startsWith('tools/ci/')) return 'ci-governance';
    if (file.startsWith('tools/release/')) return 'release-final-governance';
    if (file.startsWith('tools/operations/')) return 'operations-governance';
    if (file.startsWith('tools/docs/')) return 'documentation-governance';
    if (file.startsWith('tools/frontend/')) return 'frontend-build-governance';
    if (file.startsWith('tools/test-matrix/')) return 'test-matrix-governance';
    return 'test-evidence-governance';
}

function receiptSchemaFor(file)
{
    if (file === 'tools/ci/check-flaky-evidence.mjs') return 'fsusblog.ci.flaky.v1';
    if (file === 'tools/ci/summarize-quality-gate.mjs') return 'fsusblog.quality-gate-summary.v1';
    if (file === 'tools/release/check-release-final.mjs') return 'fsusblog.current-run-evidence-reference.v1';
    if (file === 'tools/release/public-preview-release-evidence.mjs') return 'fsusblog.public-preview-screenshot-verification.v1';
    return 'fsusblog.current-run-evidence-binding.v1';
}

function producerCommandFor(file)
{
    if (file === 'tools/ci/summarize-quality-gate.mjs') return 'node tools/ci/summarize-quality-gate.mjs';
    if (file === 'tools/release/public-preview-release-evidence.mjs') return 'bash tools/docs/run-public-preview-capture.sh';
    if (file === 'tools/release/check-release-final.mjs') return 'bash tools/operations/collect-release-evidence.sh --require-ok';
    if (file.startsWith('.github/workflows/')) return 'node tools/run-test-matrix.mjs --mode ci';
    if (file.endsWith('.sh')) return `bash ${file}`;
    if (file.endsWith('.mjs') || file.endsWith('.js')) return `node ${file}`;
    return 'node tools/run-test-matrix.mjs --mode ci';
}

function bindingFor(consumerId)
{
    return `FSUSBLOG_${consumerId.replace(/^evidence-consumer\./u, '').replace(/[^a-zA-Z0-9]+/gu, '_').toUpperCase()}_EVIDENCE_PATH`;
}

function buildGovernance(scan)
{
    const entries = scan.findings.map((finding) =>
    {
        const classification = programClassification(finding.file);
        const consumerId = consumerIdFor(finding.file);
        const applicable = classification !== 'not-evidence';
        return {
            findingId: finding.findingId,
            consumerId,
            location: `${finding.file}:${finding.line}`,
            oldSelectionRule: finding.ruleId,
            classification,
            newAuthorityId: applicable ? `${consumerId}.current-run` : null,
            locatorMode: applicable
                ? (classification === 'diagnostic-only' ? 'content-addressed-reference' : 'explicit-run-path')
                : 'not-applicable',
            action: classification === 'correctness-selection'
                ? 'migrate consumer to its registered current-run authority after locator implementation'
                : classification === 'diagnostic-only'
                    ? 'retain only as diagnostic input behind the registered content-addressed authority'
                    : 'close exact location and rule as non-evidence behavior',
            owner: ownerFor(finding.file),
            proofTest: `tests/tools/evidence-location-governance.test.mjs#${finding.findingId}`
        };
    });
    const applicableFiles = [...new Set(scan.findings
        .filter((finding) => programClassification(finding.file) !== 'not-evidence')
        .map((finding) => finding.file))].sort();
    const registryEntries = applicableFiles.map((file) =>
    {
        const consumerId = consumerIdFor(file);
        const classification = programClassification(file);
        const hasDownloadedInput = scan.findings.some((finding) => finding.file === file
            && finding.ruleId === 'evidence-selection.downloaded-artifacts-scan');
        return {
            consumerId,
            authorityId: `${consumerId}.current-run`,
            producerId: `${consumerId}.producer`,
            receiptSchema: receiptSchemaFor(file),
            locatorMode: classification === 'diagnostic-only'
                ? 'content-addressed-reference'
                : 'explicit-run-path',
            requiredIdentityFields: [
                'attemptId',
                'buildIdentity',
                'candidateIdentity',
                'schedulerRunId',
                'sourceCommit',
                'worktreeFingerprint'
            ],
            requiredDigestFields: ['contentDigest', 'producerReceiptDigest'],
            expectedCardinality: 'exact-one',
            allowedRoots: hasDownloadedInput
                ? ['.tmp/downloaded-artifacts', 'artifacts/current-run']
                : ['artifacts/current-run'],
            producerCommand: producerCommandFor(file),
            outputBindingKey: bindingFor(consumerId)
        };
    });
    const registryPayload = {
        schema: 'fsusblog.evidence-locator-registry.v1',
        version: 1,
        entries: registryEntries
    };
    const ledgerPayload = {
        schema: 'fsusblog.evidence-location-migration-ledger.v1',
        version: 1,
        scannerSchema: scan.schema,
        scannerRuleIds: scan.rules.map((rule) => rule.id).sort(),
        scanDigest: scan.contentDigest,
        entries
    };
    return {
        registry: { ...registryPayload, contentDigest: governanceContentDigest(registryPayload) },
        ledger: { ...ledgerPayload, contentDigest: governanceContentDigest(ledgerPayload) }
    };
}

function serialized(value)
{
    return `${JSON.stringify(value, null, 4)}\n`;
}

export function generateEvidenceLocationGovernance({ root = repositoryRoot } = {})
{
    const scan = scanEvidenceLocations({ root });
    const { registry, ledger } = buildGovernance(scan);
    verifyEvidenceLocationGovernance({ registry, ledger, scan });
    return { scan, registry, ledger };
}

function main()
{
    const generated = generateEvidenceLocationGovernance();
    const outputs = [[registryPath, generated.registry], [ledgerPath, generated.ledger]];
    if (process.argv.includes('--check'))
    {
        const stale = outputs.filter(([file, value]) => fs.readFileSync(file, 'utf8') !== serialized(value));
        if (stale.length > 0)
        {
            throw new Error(`evidence location governance is stale: ${stale.map(([file]) => path.relative(repositoryRoot, file)).join(', ')}`);
        }
    }
    else
    {
        for (const [file, value] of outputs)
        {
            fs.writeFileSync(file, serialized(value));
        }
    }
    process.stdout.write(`[evidence-location-governance] findings=${generated.scan.findings.length} consumers=${generated.registry.entries.length} digest=${generated.scan.contentDigest}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    main();
}
