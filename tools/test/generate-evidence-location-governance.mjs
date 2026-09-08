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
// These exact library modules contain evidence vocabulary but cannot publish a
// terminal receipt themselves. Their scanner findings remain in the ledger as
// closed non-evidence behavior; they must not acquire a synthetic CLI owner.
const nonEvidenceProgramOverrides = new Set([
    'tools/test-fixtures/receipt/postconditions.mjs'
]);
const evidenceProgramName = /(?:artifact|evidence|flaky|manifest|quality-gate|receipt|release-final|report|summary)/iu;

function programClassification(file)
{
    if (nonEvidenceProgramOverrides.has(file))
    {
        return 'not-evidence';
    }
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
    if (file === 'tools/release/release-final-domain-evidence.mjs') return 'fsusblog.current-run-evidence-parent.v1';
    if (file === 'tools/release/public-preview-release-evidence.mjs') return 'fsusblog.current-run-evidence-reference.v1';
    return 'fsusblog.current-run-evidence-binding.v1';
}

function producerCommandFor(file)
{
    if (file === 'tools/ci/summarize-quality-gate.mjs') return 'node tools/ci/summarize-quality-gate.mjs';
    if (file === 'tools/release/public-preview-release-evidence.mjs') return 'bash tools/docs/run-public-preview-capture.sh';
    if (file === 'tools/release/check-release-final.mjs') return 'bash tools/operations/collect-release-evidence.sh --require-ok';
    if (file === 'tools/release/release-final-domain-evidence.mjs') return 'node tools/test/publish-release-final-evidence-parent.mjs';
    if (file === '.github/workflows/browser-diagnostics.yml')
        return 'bash tools/test/lanes/browser-diagnostics.sh manual --workers 1';
    if (file === '.github/workflows/quality-gate.yml') return 'node tools/ci/summarize-quality-gate.mjs';
    if (file.endsWith('.sh')) return `bash ${file}`;
    if (file.endsWith('.mjs') || file.endsWith('.js')) return `node ${file}`;
    throw new Error(`evidence producer has no canonical command: ${file}`);
}

const canonicalCallerOverrides = new Map(Object.entries({
    'tools/ci/production-build-artifacts.mjs': ['tools/test/lanes/production-build-artifacts.sh',
        'bash tools/test/lanes/production-build-artifacts.sh'],
    'tools/docs/behavior-doc-exactness.mjs': ['tools/docs/api-protocol-doc-exactness.mjs',
        'node tools/docs/api-protocol-doc-exactness.mjs'],
    'tools/docs/doc-claim-staleness-mutation/runner.mjs': ['tools/docs/behavior-doc-static-admission.mjs',
        'node tools/docs/behavior-doc-static-admission.mjs'],
    'tools/docs/prose-claim-verifier/verifier.mjs': ['tools/docs/check-prose-claims.mjs',
        'node tools/docs/check-prose-claims.mjs'],
    'tools/governance/repository-governance-manifest.mjs': ['tools/governance/repository-governance-authority.mjs',
        'node tools/governance/repository-governance-authority.mjs validate-manifest'],
    'tools/release/clean-attempt-evidence-source.mjs': ['tools/release/browser-release-clean-attempt-consumers.mjs',
        'node tools/release/test-evidence-receipts-cli.mjs create-correctness'],
    'tools/release/release-reliability-qualified-receipt.mjs': ['tools/release/release-final-domain-evidence.mjs',
        'bash tools/test/run-release-reliability-qualified-local.sh'],
    'tools/runtime-profiles/runtime-publish-evidence.mjs': ['tools/runtime-profiles/run-runtime-publish-matrix.mjs',
        'node tools/runtime-profiles/run-runtime-publish-matrix.mjs'],
    'tools/test-fixtures/receipt/observations.mjs': ['tools/test-fixtures/receipt/index.mjs',
        'node --test tests/tools/fixture-receipt.test.mjs'],
    'tools/test-matrix/artifact-digest-table.mjs': ['tests/tools/artifact-digest-table.test.mjs',
        'node --test tests/tools/artifact-digest-table.test.mjs'],
    'tools/test-matrix/content-addressed-evidence-store.mjs': ['tests/tools/content-addressed-evidence-store.test.mjs',
        'node --test tests/tools/content-addressed-evidence-store.test.mjs'],
    'tools/test-matrix/cross-stack-receipts.mjs': ['tests/tools/cross-stack-receipt-join.test.mjs',
        'node --test tests/tools/cross-stack-receipt-join.test.mjs'],
    'tools/test-matrix/receipt-command-sources.mjs': ['tests/tools/test-matrix-execution-mode-contract.test.mjs',
        'node --test tests/tools/test-matrix-execution-mode-contract.test.mjs'],
    'tools/test-matrix/release-domain-native-evidence.mjs': ['tools/test-matrix/release-domain-evidence.mjs',
        'node tools/test-matrix/release-domain-evidence.mjs'],
    'tools/test-matrix/release-domain-projection-receipt.mjs': ['tools/test-matrix/release-domain-evidence.mjs',
        'node tools/test-matrix/release-domain-evidence.mjs'],
    'tools/test-observations/flaky-observer-execution.mjs': ['tools/test-observations/flaky-observer.mjs',
        'node --test tests/tools/flaky-observation-lane.test.mjs'],
    'tools/test-quality/artifact.mjs': ['tools/ci/check-test-quality.mjs',
        'bash tools/test/lanes/test-quality-lint.sh'],
    'tools/test/execution-envelope-receipt.mjs': ['tests/tools/execution-envelope-receipt.test.mjs',
        'node --test tests/tools/execution-envelope-receipt.test.mjs'],
    'tools/test/release-reliability-receipt.mjs': ['tools/test/run-release-reliability-qualified-local.sh',
        'bash tools/test/run-release-reliability-qualified-local.sh']
}));

function producerExecutableFile(command)
{
    const tokens = String(command).match(/(?:"[^"]*"|'[^']*'|\S+)/gu)
        ?.map((token) => token.replace(/^['"]|['"]$/gu, '')) ?? [];
    const file = tokens.find((token, index) => index > 0 && !token.startsWith('-') && !token.includes('='));
    if (!file) throw new Error(`canonical evidence producer has no executable file: ${command}`);
    return file;
}

function canonicalProducerFor(file)
{
    const override = canonicalCallerOverrides.get(file);
    const producer = {
        producerSource: file,
        producerCallsite: override?.[0] ?? file,
        producerExecutable: override?.[1] ?? producerCommandFor(file),
        producerBindingClass: file.startsWith('.github/workflows/')
            ? 'workflow'
            : override ? 'library-caller' : 'cli'
    };
    const executableFile = producerExecutableFile(producer.producerExecutable);
    if (!fs.existsSync(path.join(repositoryRoot, executableFile)))
        throw new Error(`canonical evidence producer executable is missing: ${producer.producerExecutable}`);
    if (!fs.existsSync(path.join(repositoryRoot, producer.producerCallsite)))
        throw new Error(`canonical evidence producer callsite is missing: ${producer.producerCallsite}`);
    return producer;
}

function bindingFor(consumerId)
{
    return `FSUSBLOG_${consumerId.replace(/^evidence-consumer\./u, '').replace(/[^a-zA-Z0-9]+/gu, '_').toUpperCase()}_EVIDENCE_PATH`;
}

function payloadBindingFor(consumerId)
{
    return bindingFor(consumerId).replace(/_EVIDENCE_PATH$/u, '_EVIDENCE_PAYLOAD_PATH');
}

function handoffBindingFor(consumerId)
{
    return bindingFor(consumerId).replace(/_EVIDENCE_PATH$/u, '_EVIDENCE_HANDOFF_PATH');
}

function hookedProducerCommandFor(consumerId, producerExecutable)
{
    const consumer = `FSUSBLOG_CURRENT_RUN_EVIDENCE_CONSUMER=${consumerId}`;
    if (producerExecutable.startsWith('node '))
    {
        return `${consumer} node --import ./tools/test/current-run-evidence-producer-hook.mjs ${producerExecutable.slice(5)}`;
    }
    if (producerExecutable.startsWith('bash '))
    {
        return `${consumer} BASH_ENV=tools/test/current-run-evidence-producer-hook.bash ${producerExecutable}`;
    }
    throw new Error(`unsupported canonical evidence producer command: ${producerExecutable}`);
}

function checkpointCommandFor(consumerId)
{
    return `node tools/test/attach-current-run-evidence-checkpoint.mjs --consumer ${consumerId}`;
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
        const producer = canonicalProducerFor(file);
        const embeddedPublication = file === 'tools/release/check-release-final.mjs';
        return {
            consumerId,
            authorityId: `${consumerId}.current-run`,
            producerId: `${consumerId}.producer`,
            receiptSchema: 'fsusblog.current-run-evidence-reference.v1',
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
            publicationMode: embeddedPublication ? 'embedded' : 'hooked',
            ...producer,
            producerCommand: embeddedPublication
                ? producer.producerExecutable
                : hookedProducerCommandFor(consumerId, producer.producerExecutable),
            outputBindingKey: bindingFor(consumerId),
            handoffBindingKey: handoffBindingFor(consumerId),
            ...(embeddedPublication ? {} : { payloadBindingKey: payloadBindingFor(consumerId) }),
            checkpointCommand: checkpointCommandFor(consumerId)
        };
    });
    const directReleaseInputs = [
        ['behavior-consistency', 'behavior-document-consistency-final', 'node tools/docs/behavior-document-consistency-final.mjs'],
        ['behavior-post-runtime', 'behavior-evidence-post-runtime', 'node tools/test-matrix/behavior-evidence-post-runtime.mjs'],
        ['browser-contract', 'browser-contract', 'node tests/browser-contract/run.mjs'],
        ['browserless-correctness', 'browserless-correctness', 'node tools/release/test-evidence-receipts-cli.mjs create-correctness'],
        ['production-build', 'ci-production-build', 'node tools/ci/production-build-artifacts.mjs'],
        ['public-preview', 'public-preview-release-evidence', 'bash tools/docs/run-public-preview-capture.sh']
    ];
    for (const [id, producerId, producerCommand] of directReleaseInputs)
    {
        const consumerId = `evidence-consumer.release-final.direct.${id}`;
        const producerSource = producerCommand.replace(/^(?:bash|node)\s+/u, '').split(/\s+/u)[0];
        const producer = canonicalProducerFor(producerSource);
        registryEntries.push({
            consumerId,
            authorityId: `${consumerId}.current-run`,
            producerId,
            receiptSchema: 'fsusblog.current-run-evidence-reference.v1',
            locatorMode: 'explicit-run-path',
            requiredIdentityFields: [
                'attemptId', 'buildIdentity', 'candidateIdentity', 'schedulerRunId',
                'sourceCommit', 'worktreeFingerprint'
            ],
            requiredDigestFields: ['contentDigest', 'producerReceiptDigest'],
            expectedCardinality: 'exact-one',
            allowedRoots: ['artifacts/current-run'],
            publicationMode: 'hooked',
            ...producer,
            producerCommand: hookedProducerCommandFor(consumerId, producer.producerExecutable),
            outputBindingKey: bindingFor(consumerId),
            handoffBindingKey: handoffBindingFor(consumerId),
            payloadBindingKey: payloadBindingFor(consumerId),
            checkpointCommand: checkpointCommandFor(consumerId)
        });
    }
    const parentConsumerId = 'evidence-consumer.release.release-final-domain-evidence';
    registryEntries.push({
        consumerId: parentConsumerId,
        authorityId: `${parentConsumerId}.current-run`,
        producerId: 'release-final-domain-evidence-parent',
        receiptSchema: 'fsusblog.current-run-evidence-parent.v1',
        locatorMode: 'explicit-run-path',
        requiredIdentityFields: [
            'attemptId', 'buildIdentity', 'candidateIdentity', 'schedulerRunId',
            'sourceCommit', 'worktreeFingerprint'
        ],
        requiredDigestFields: ['contentDigest', 'producerReceiptDigest'],
        expectedCardinality: 'exact-one',
        allowedRoots: ['artifacts/current-run'],
        publicationMode: 'parent',
        producerSource: 'tools/test/publish-release-final-evidence-parent.mjs',
        producerCallsite: 'tools/test/publish-release-final-evidence-parent.mjs',
        producerExecutable: 'node tools/test/publish-release-final-evidence-parent.mjs',
        producerBindingClass: 'cli',
        producerCommand: 'node tools/test/publish-release-final-evidence-parent.mjs',
        outputBindingKey: bindingFor(parentConsumerId),
        handoffBindingKey: handoffBindingFor(parentConsumerId),
        checkpointCommand: checkpointCommandFor(parentConsumerId)
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
