import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    governanceContentDigest,
    validateEvidenceLocationMigrationLedger,
    verifyEvidenceLocationGovernance
} from '../../tools/test/evidence-location-contract.mjs';
import { generateEvidenceLocationGovernance } from '../../tools/test/generate-evidence-location-governance.mjs';
import {
    evidenceLocationDigest,
    scanEvidenceLocations
} from '../../tools/test/evidence-location-scanner.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const load = (name) => JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'config/testing', name), 'utf8'));
const seal = (value) => ({ ...value, contentDigest: governanceContentDigest(value) });

test('scanner covers JS TS C# shell workflow and config selection families', (context) =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-location-scan-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const fixtures = {
        'tools/sample.mjs': `
            function findEvidenceFiles() { return fs.readdirSync('.tmp/downloaded-artifacts'); }
            const latestReceipt = candidates[0];
            evidenceCandidates.sort((a, b) => b.generatedAt - a.generatedAt);
            const evidenceSelection = preferredCandidates?.[0];
            if (receipt.schema !== expected) continue;
            const pointer = 'latest-receipt.json';
            const evidenceChanged = stat.mtimeMs;
        `,
        'src/sample.ts': 'const receipt = findReceiptFile(schema, candidates);',
        'src/Sample.cs': 'var latestReceipt = evidenceReceipts[0];',
        'tools/sample.sh': 'cp .tmp/downloaded-artifacts/receipt.json artifacts/current-run/',
        'tools/local-priority.mjs': `const evidenceRoots = [
            '.tmp/release-evidence',
            '.tmp/downloaded-artifacts'
        ];`,
        'tools/downloaded-priority.mjs': `const evidenceRoots = [
            '.tmp/downloaded-artifacts',
            '.tmp/release-evidence'
        ];`,
        '.github/workflows/sample.yml': 'path: .tmp/downloaded-artifacts',
        'config/sample.json': '{ "latest-report.json": true }'
    };
    for (const [file, content] of Object.entries(fixtures))
    {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), content);
    }
    const scan = scanEvidenceLocations({ root, files: Object.keys(fixtures) });
    const rules = new Set(scan.findings.map((finding) => finding.ruleId));
    for (const rule of [
        'evidence-selection.mtime-ctime',
        'evidence-selection.timestamp-sort',
        'evidence-selection.latest-newest',
        'evidence-selection.directory-scan',
        'evidence-selection.schema-search',
        'evidence-selection.first-match',
        'evidence-selection.downloaded-artifacts-scan',
        'evidence-selection.fallback-candidates',
        'evidence-selection.pointer-without-identity',
        'evidence-selection.explicit-mismatch-fallback',
        'evidence-selection.local-downloaded-priority'
    ])
    {
        assert(rules.has(rule), `missing scanner rule ${rule}`);
    }
    for (const file of ['tools/local-priority.mjs', 'tools/downloaded-priority.mjs'])
    {
        assert(scan.findings.some((finding) => finding.file === file
            && finding.ruleId === 'evidence-selection.local-downloaded-priority'));
    }
    for (const file of Object.keys(fixtures))
    {
        assert(scan.findings.some((finding) => finding.file === file), `missing language surface ${file}`);
    }
});

test('scanner authority exclusions are exact and cannot become wildcard suppressions', (context) =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-location-authority-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const exact = 'tools/test/evidence-location-scanner.mjs';
    const adjacent = 'tools/test/evidence-location-scanner-copy.mjs';
    for (const file of [exact, adjacent])
    {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), "const latestEvidence = 'latest.json';\n");
    }
    const scan = scanEvidenceLocations({ root, files: [exact, adjacent] });
    assert.equal(scan.findings.some((finding) => finding.file === exact), false);
    assert.equal(scan.findings.some((finding) => finding.file === adjacent), true);
});

test('generated repository registry and unique ledger match a fresh full-repository scan', () =>
{
    const generated = generateEvidenceLocationGovernance();
    const registry = load('evidence-locator-registry.json');
    const ledger = load('evidence-location-migration-ledger.json');
    assert.deepEqual(registry, generated.registry);
    assert.deepEqual(ledger, generated.ledger);
    verifyEvidenceLocationGovernance({ registry, ledger, scan: generated.scan });
    const repeated = generateEvidenceLocationGovernance();
    assert.deepEqual(repeated.scan, generated.scan);
    assert.deepEqual(repeated.registry, generated.registry);
    assert.deepEqual(repeated.ledger, generated.ledger);
});

test('ledger rejects missing duplicate orphan and newly discovered findings', () =>
{
    const generated = generateEvidenceLocationGovernance();
    const base = generated.ledger;
    const missing = seal({ ...base, entries: base.entries.slice(1) });
    assert.throws(() => validateEvidenceLocationMigrationLedger(missing, { scan: generated.scan }), /missing from migration ledger/u);

    const duplicate = seal({ ...base, entries: [...base.entries, base.entries[0]] });
    assert.throws(() => validateEvidenceLocationMigrationLedger(duplicate, { scan: generated.scan }), /duplicates/u);

    const orphanEntry = { ...base.entries[0], findingId: '0000000000000000' };
    const orphan = seal({ ...base, entries: [...base.entries, orphanEntry] });
    assert.throws(() => validateEvidenceLocationMigrationLedger(orphan, { scan: generated.scan }), /orphaned/u);

    const newFinding = { ...generated.scan.findings[0], findingId: 'ffffffffffffffff', line: 999999 };
    const scanPayload = {
        schema: generated.scan.schema,
        rules: generated.scan.rules,
        findings: [...generated.scan.findings, newFinding]
    };
    const changedScan = { ...scanPayload, contentDigest: evidenceLocationDigest(scanPayload) };
    const stale = seal({ ...base, scanDigest: changedScan.contentDigest });
    assert.throws(() => validateEvidenceLocationMigrationLedger(stale, { scan: changedScan }), /missing from migration ledger/u);
});

test('ledger covers remaining selectors and registry owns migrated public preview', () =>
{
    const ledger = load('evidence-location-migration-ledger.json');
    const registry = load('evidence-locator-registry.json');
    const requiredPrograms = [
        '.github/workflows/quality-gate.yml',
        'tools/ci/check-flaky-evidence.mjs',
        'tools/ci/summarize-quality-gate.mjs',
        'tools/operations/check-release-evidence-manifest.mjs',
        'tools/release/check-release-final.mjs',
        'tools/release/test-evidence-receipts-cli.mjs',
        'tools/test/aggregate-data-scale-evidence.mjs',
        'tools/test/aggregate-performance-evidence.mjs'
    ];
    for (const file of requiredPrograms)
    {
        const entries = ledger.entries.filter((entry) => entry.location.startsWith(`${file}:`));
        assert(entries.length > 0, `missing required consumer ${file}`);
        assert(entries.every((entry) => entry.classification === 'correctness-selection'),
            `required consumer ${file} is not classified as correctness selection`);
    }
    assert(registry.entries.some((entry) =>
        entry.consumerId === 'evidence-consumer.release-final.direct.public-preview'
        && entry.receiptSchema === 'fsusblog.current-run-evidence-reference.v1'));
    assert(ledger.entries.some((entry) => entry.oldSelectionRule === 'evidence-selection.downloaded-artifacts-scan'));
    assert(ledger.entries.some((entry) => entry.oldSelectionRule === 'evidence-selection.local-downloaded-priority'));
});

test('false positives and helper calls retain exact rule and actual consumer locations', () =>
{
    const generated = generateEvidenceLocationGovernance();
    const findings = new Map(generated.scan.findings.map((finding) => [finding.findingId, finding]));
    for (const entry of generated.ledger.entries)
    {
        const finding = findings.get(entry.findingId);
        assert(finding);
        assert.equal(entry.location, `${finding.file}:${finding.line}`);
        assert.equal(entry.oldSelectionRule, finding.ruleId);
        assert(!entry.location.includes('*'));
    }
    const indirect = generated.scan.findings.filter((finding) => finding.ruleId === 'evidence-selection.indirect-helper-call');
    assert(indirect.length > 0);
    assert(indirect.every((finding) => finding.function !== '<module>' || finding.file.startsWith('tools/')));
    assert(indirect.some((finding) => finding.file === 'tools/ci/summarize-quality-gate.mjs'
        && ['loadJobSummaries', 'loadFlakyEvidence'].includes(finding.function)));
    assert(new Set(generated.ledger.entries.map((entry) => entry.classification)).size === 3);
    assert(generated.ledger.entries.some((entry) => entry.location.startsWith('src/backend/')
        && entry.classification === 'not-evidence'));
    const diagnostic = generated.ledger.entries.find((entry) => entry.location.startsWith('tests/browser-diagnostics/run.mjs:'));
    assert.equal(diagnostic?.classification, 'diagnostic-only');
    const diagnosticAuthority = generated.registry.entries.find((entry) => entry.consumerId === diagnostic?.consumerId);
    assert.equal(diagnosticAuthority?.locatorMode, 'content-addressed-reference');
});
