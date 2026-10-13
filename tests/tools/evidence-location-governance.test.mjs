import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const {changeContract} = await import(new URL('../../tools/governance/change-contract-registry.mjs', import.meta.url));
const {governanceContentDigest, validateEvidenceLocationMigrationLedger, verifyEvidenceLocationGovernance} = await import(new URL('../../tools/test/evidence-location-contract.mjs', import.meta.url));
const {generateEvidenceLocationGovernance, validateEvidenceLocationClassificationOverrides} = await import(new URL('../../tools/test/generate-evidence-location-governance.mjs', import.meta.url));
const {evidenceLocationDigest, scanEvidenceLocations} = await import(new URL('../../tools/test/evidence-location-scanner.mjs', import.meta.url));
const {generateCurrentRunEvidenceLocationAcceptance} = await import(new URL('../../tools/test/generate-current-run-evidence-location-acceptance.mjs', import.meta.url));
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const load = (name) => JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'config/testing', name), 'utf8'));
const seal = (value) => ({ ...value, contentDigest: governanceContentDigest(value) });
const repairManifestPath = changeContract.generatedOutputRepairDags
    .find((entry) => entry.id === 'evidence-location-governance').manifest;
const repairExternalNamingManifestPath = changeContract.generatedOutputRepairDags
    .find((entry) => entry.id === 'evidence-location-governance').externalNamingManifest;

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
    const pairs = [
        [
            'tools/test/evidence-location-scanner.mjs',
            'tools/test/evidence-location-scanner-copy.mjs'
        ],
        [
            'config/testing/current-run-evidence-location-acceptance.json',
            'config/testing/current-run-evidence-location-acceptance-copy.json'
        ],
        [
            repairManifestPath,
            'artifacts/change-contract/evidence-location-governance-post-merge-repair-copy.json'
        ],
        [
            repairExternalNamingManifestPath,
            'artifacts/change-contract/evidence-location-governance-post-merge-repair-external-naming-copy.json'
        ]
    ];
    for (const file of pairs.flat())
    {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), "const latestEvidence = 'latest.json';\n");
    }
    const scan = scanEvidenceLocations({ root, files: pairs.flat() });
    for (const [exact, adjacent] of pairs)
    {
        assert.equal(scan.findings.some((finding) => finding.file === exact), false);
        assert.equal(scan.findings.some((finding) => finding.file === adjacent), true);
    }
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

test('clean-attempt evidence library keeps its exact scanner finding and canonical source authority', () =>
{
    const generated = generateEvidenceLocationGovernance();
    const finding = generated.scan.findings.find((entry) =>
        entry.file === 'tools/release/clean-attempt-evidence-source.mjs');
    assert.deepEqual(finding, {
        findingId: '0bb0613a313dec54',
        ruleId: 'evidence-selection.first-match',
        file: 'tools/release/clean-attempt-evidence-source.mjs',
        line: 362,
        column: 19,
        function: '<module>',
        excerpt: 'const candidate = authorityReferences.find((item) => item.kind === reference.kind);',
        indirectVia: null
    });

    const authority = generated.registry.entries.find((entry) =>
        entry.producerSource === 'tools/release/clean-attempt-evidence-source.mjs');
    assert.deepEqual({
        producerSource: authority.producerSource,
        producerCallsite: authority.producerCallsite,
        producerExecutable: authority.producerExecutable,
        producerBindingClass: authority.producerBindingClass,
        producerCommand: authority.producerCommand
    }, {
        producerSource: 'tools/release/clean-attempt-evidence-source.mjs',
        producerCallsite: 'tools/release/browser-release-clean-attempt-consumers.mjs',
        producerExecutable: 'node tools/release/test-evidence-receipts-cli.mjs create-correctness',
        producerBindingClass: 'library-caller',
        producerCommand: 'FSUSBLOG_CURRENT_RUN_EVIDENCE_CONSUMER=evidence-consumer.release.clean-attempt-evidence-source node --import ./tools/test/current-run-evidence-producer-hook.mjs tools/release/test-evidence-receipts-cli.mjs create-correctness'
    });
    assert.equal(generated.ledger.entries.find((entry) => entry.findingId === finding.findingId).newAuthorityId,
        authority.authorityId);
});

test('clean-attempt import-only library cannot masquerade as its executable correctness CLI', () =>
{
    const generated = generateEvidenceLocationGovernance();
    const authority = generated.registry.entries.find((entry) =>
        entry.producerSource === 'tools/release/clean-attempt-evidence-source.mjs');
    const source = fs.readFileSync(path.join(repositoryRoot, authority.producerSource), 'utf8');
    const caller = fs.readFileSync(path.join(repositoryRoot, authority.producerCallsite), 'utf8');
    const executable = fs.readFileSync(path.join(repositoryRoot, 'tools/release/test-evidence-receipts-cli.mjs'), 'utf8');

    assert.match(source, /export function readCleanAttemptEvidenceSource/u);
    assert.doesNotMatch(source, /process\.argv\[1\].*fileURLToPath/su);
    assert.match(caller, /from ['"]\.\/clean-attempt-evidence-source\.mjs['"]/u);
    assert.match(caller, /requireCleanAttemptConsumerAdmission\s*\(/u);
    assert.match(executable, /if \(process\.argv\[1\].*fileURLToPath/su);
    assert.match(executable, /options\.command === 'create-correctness'/u);
    assert.doesNotMatch(authority.producerExecutable,
        /clean-attempt-evidence-source\.mjs(?:\s|$)/u);
});

test('fresh governance and acceptance producers reach a byte-identical fixed point', () =>
{
    const firstGovernance = generateEvidenceLocationGovernance();
    const secondGovernance = generateEvidenceLocationGovernance();
    assert.equal(JSON.stringify(secondGovernance.registry), JSON.stringify(firstGovernance.registry));
    assert.equal(JSON.stringify(secondGovernance.ledger), JSON.stringify(firstGovernance.ledger));

    const firstAcceptance = generateCurrentRunEvidenceLocationAcceptance();
    const secondAcceptance = generateCurrentRunEvidenceLocationAcceptance();
    assert.equal(JSON.stringify(secondAcceptance), JSON.stringify(firstAcceptance));
    assert.equal(firstAcceptance.registryDigest, firstGovernance.registry.contentDigest);
    assert.equal(firstAcceptance.ledgerDigest, firstGovernance.ledger.contentDigest);
    assert.equal(firstAcceptance.scannerDigest, firstGovernance.scan.contentDigest);
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

test('every registry authority declares an executable producer and exact publication bindings', () =>
{
    const registry = load('evidence-locator-registry.json');
    assert(registry.entries.length > 0);
    const outputBindings = new Set();
    const payloadBindings = new Set();
    const handoffBindings = new Set();
    const sourceClasses = new Map();
    for (const entry of registry.entries)
    {
        assert.match(entry.outputBindingKey, /^FSUSBLOG_[A-Z0-9_]+_EVIDENCE_PATH$/u);
        assert(!outputBindings.has(entry.outputBindingKey), `duplicate output binding ${entry.outputBindingKey}`);
        outputBindings.add(entry.outputBindingKey);
        assert.match(entry.handoffBindingKey, /^FSUSBLOG_[A-Z0-9_]+_EVIDENCE_HANDOFF_PATH$/u);
        assert(!handoffBindings.has(entry.handoffBindingKey),
            `duplicate handoff binding ${entry.handoffBindingKey}`);
        handoffBindings.add(entry.handoffBindingKey);
        assert.equal(entry.checkpointCommand,
            `node tools/test/attach-current-run-evidence-checkpoint.mjs --consumer ${entry.consumerId}`);
        assert(fs.existsSync(path.join(repositoryRoot, entry.producerSource)),
            `missing producer source ${entry.producerSource}`);
        assert(fs.existsSync(path.join(repositoryRoot, entry.producerCallsite)),
            `missing producer callsite ${entry.producerCallsite}`);
        sourceClasses.set(entry.producerSource, entry.producerBindingClass);
        if (entry.producerSource !== entry.producerCallsite)
        {
            assert(fs.readFileSync(path.join(repositoryRoot, entry.producerCallsite), 'utf8')
                .includes(path.basename(entry.producerSource)),
            `canonical caller does not reference producer source: ${entry.consumerId}`);
        }
        const executableFile = entry.producerExecutable.split(/\s+/u)
            .find((token, index) => index > 0 && !token.startsWith('-') && !token.includes('='));
        assert(executableFile && fs.existsSync(path.join(repositoryRoot, executableFile)),
            `producer executable is not a repository file: ${entry.producerExecutable}`);
        if (entry.publicationMode === 'hooked')
        {
            assert.equal(entry.receiptSchema, 'fsusblog.current-run-evidence-reference.v1');
            assert.match(entry.producerCommand,
                new RegExp(`^FSUSBLOG_CURRENT_RUN_EVIDENCE_CONSUMER=${entry.consumerId.replaceAll('.', '\\.')} `, 'u'));
            assert(entry.producerCommand.includes('current-run-evidence-producer-hook'),
                `producer command lacks in-process terminal hook: ${entry.consumerId}`);
            assert(entry.producerCommand.endsWith(entry.producerExecutable.slice(entry.producerExecutable.indexOf(' ') + 1))
                || entry.producerCommand.endsWith(entry.producerExecutable),
            `producer command does not execute canonical caller: ${entry.consumerId}`);
            assert.match(entry.payloadBindingKey, /^FSUSBLOG_[A-Z0-9_]+_EVIDENCE_PAYLOAD_PATH$/u);
            assert(!payloadBindings.has(entry.payloadBindingKey), `duplicate payload binding ${entry.payloadBindingKey}`);
            payloadBindings.add(entry.payloadBindingKey);
        }
        else
        {
            assert.equal(entry.producerCommand, entry.producerExecutable);
        }
    }
    assert.deepEqual(Object.fromEntries(['cli', 'library-caller', 'workflow'].map((classification) =>
        [classification, [...sourceClasses.values()].filter((value) => value === classification).length])),
    { cli: 74, 'library-caller': 23, workflow: 2 });
});

test('fixture postconditions remain an import-only helper and cannot masquerade as a receipt CLI', (context) =>
{
    const source = 'tools/test-fixtures/receipt/postconditions.mjs';
    const generated = generateEvidenceLocationGovernance();
    const findings = generated.scan.findings.filter((entry) => entry.file === source);
    assert.deepEqual(findings.map((entry) => ({
        findingId: entry.findingId,
        line: entry.line,
        column: entry.column,
        function: entry.function,
        excerpt: entry.excerpt
    })), [
        { findingId: '4ad3e50e7a86fd77', line: 160, column: 66, function: 'verifyArticlePaginationDeep',
            excerpt: "if (fields.route !== 'article/list/home' || fields.sort !== 'latest' || fields.pageSize !== 10)" },
        { findingId: 'd20d5764a604254c', line: 162, column: 91, function: 'verifyArticlePaginationDeep',
            excerpt: "return fail(id, 'pagination route/sort/page-size binding is not article/list/home latest size=10');" },
        { findingId: 'ab7806efdc13f126', line: 1100, column: 32, function: 'verifyCommentMatrix',
            excerpt: 'const fields = matches[0].fields ?? {};' },
        { findingId: '3832625c19cc6921', line: 1162, column: 38, function: 'verifyCommentMatrix',
            excerpt: "|| spam.signalEvidence.some((evidence) => String(evidence?.commentId) !== String(one('spam')[0].id)" },
        { findingId: '6e2820ee117b50ea', line: 1215, column: 19, function: 'verifyCommentMatrix',
            excerpt: "const root = one('approved-root')[0];" },
        { findingId: 'd0b3d067d8933150', line: 1258, column: 30, function: 'verifyCommentMatrix',
            excerpt: "if (one('deleted-root-child')[0]?.fields?.publicVisible !== true)" },
        { findingId: '28ef7c5a1d96bc06', line: 1262, column: 46, function: 'verifyCommentMatrix',
            excerpt: "const deletedRoot = one('deleted-root')[0];" },
        { findingId: 'ed3fb82f674ea7ff', line: 1263, column: 47, function: 'verifyCommentMatrix',
            excerpt: "const deletedChild = one('deleted-root-child')[0];" }
    ]);
    assert(findings.every((entry) => [
        'evidence-selection.first-match',
        'evidence-selection.latest-newest'
    ].includes(entry.ruleId)
        && entry.file === source && entry.indirectVia === null));
    const sourceText = fs.readFileSync(path.join(repositoryRoot, source), 'utf8');
    const mutationRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'postconditions-selector-mutation-'));
    context.after(() => fs.rmSync(mutationRoot, { recursive: true, force: true }));
    fs.mkdirSync(path.dirname(path.join(mutationRoot, source)), { recursive: true });
    fs.writeFileSync(path.join(mutationRoot, source), `${sourceText}\nfunction selectEvidenceMutation() {\n`
        + '  const candidates = [];\n  return candidates[0];\n}\n');
    const addedSelector = scanEvidenceLocations({ root: mutationRoot, files: [source] });
    assert.throws(() => validateEvidenceLocationClassificationOverrides(addedSelector),
        /unreviewed evidence selector in import-only module/u);
    fs.writeFileSync(path.join(mutationRoot, source),
        sourceText.replace('const fields = matches[0].fields ?? {}',
            'const fields = matches.at(0).fields ?? {}'));
    const replacedSelector = scanEvidenceLocations({ root: mutationRoot, files: [source] });
    assert.throws(() => validateEvidenceLocationClassificationOverrides(replacedSelector),
        /non-evidence finding override ab7806efdc13f126 changed (?:column|excerpt)/u);
    // A line-based finding ID can survive a source shift while denoting a
    // different selector. The former deleted-child ID now belongs to root;
    // matching that ID alone must never inherit its old semantic exemption.
    const staleIdentity = structuredClone(generated.scan);
    const rootFinding = staleIdentity.findings.find((entry) => entry.findingId === '6e2820ee117b50ea');
    rootFinding.column = 47;
    rootFinding.excerpt = "const deletedChild = one('deleted-root-child')[0];";
    assert.throws(() => validateEvidenceLocationClassificationOverrides(staleIdentity),
        /non-evidence finding override 6e2820ee117b50ea changed (?:column|excerpt)/u);
    fs.writeFileSync(path.join(mutationRoot, source),
        sourceText.replace("const root = one('approved-root')[0];",
            'const root = evidenceCandidates[0];'));
    const repurposedSelector = scanEvidenceLocations({ root: mutationRoot, files: [source] });
    assert.throws(() => validateEvidenceLocationClassificationOverrides(repurposedSelector),
        /non-evidence finding override 6e2820ee117b50ea changed (?:column|excerpt)/u);
    const findingIds = new Set(findings.map((entry) => entry.findingId));
    const ledgerEntries = generated.ledger.entries.filter((entry) => findingIds.has(entry.findingId));
    assert.equal(ledgerEntries.length, findings.length);
    assert(ledgerEntries.every((entry) => entry.classification === 'not-evidence'
        && entry.newAuthorityId === null
        && entry.locatorMode === 'not-applicable'
        && entry.action === 'close exact location and rule as non-evidence behavior'));
    assert.equal(generated.registry.entries.some((entry) => entry.producerSource === source), false);

    assert.match(sourceText, /export function runPostcondition/u);
    assert.match(sourceText, /export function verifyCapabilityPostconditions/u);
    assert.doesNotMatch(sourceText, /process\.argv\[1\].*fileURLToPath/su);
    const direct = spawnSync(process.execPath, [source], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        timeout: 10000
    });
    assert.ifError(direct.error);
    assert.equal(direct.status, 0);
    assert.equal(direct.stdout, '');
    assert.equal(direct.stderr, '');

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'postconditions-hook-negative-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.cpSync(path.join(repositoryRoot, 'tools'), path.join(root, 'tools'), { recursive: true });
    fs.mkdirSync(path.join(root, 'config/testing'), { recursive: true });
    fs.mkdirSync(path.join(root, 'artifacts/current-run'), { recursive: true });
    const consumerId = 'evidence-consumer.test-fixtures.receipt.postconditions';
    const fakeEntry = {
        ...generated.registry.entries.find((entry) => entry.publicationMode === 'hooked'),
        consumerId,
        authorityId: `${consumerId}.current-run`,
        producerId: `${consumerId}.producer`,
        producerSource: source,
        producerCallsite: source,
        producerExecutable: `node ${source}`,
        producerBindingClass: 'cli',
        producerCommand: `FSUSBLOG_CURRENT_RUN_EVIDENCE_CONSUMER=${consumerId} node --import ./tools/test/current-run-evidence-producer-hook.mjs ${source}`,
        outputBindingKey: 'FSUSBLOG_TEST_FIXTURES_RECEIPT_POSTCONDITIONS_EVIDENCE_PATH',
        handoffBindingKey: 'FSUSBLOG_TEST_FIXTURES_RECEIPT_POSTCONDITIONS_EVIDENCE_HANDOFF_PATH',
        payloadBindingKey: 'FSUSBLOG_TEST_FIXTURES_RECEIPT_POSTCONDITIONS_EVIDENCE_PAYLOAD_PATH',
        checkpointCommand: `node tools/test/attach-current-run-evidence-checkpoint.mjs --consumer ${consumerId}`
    };
    const fakeRegistry = seal({
        schema: 'fsusblog.evidence-locator-registry.v1',
        version: 1,
        entries: [fakeEntry]
    });
    fs.writeFileSync(path.join(root, 'config/testing/evidence-locator-registry.json'),
        `${JSON.stringify(fakeRegistry, null, 4)}\n`);
    const currentRunContext = seal({
        schema: 'fsusblog.current-run-evidence-context.v1',
        schedulerRunId: 'run-postconditions-negative',
        attemptId: 'attempt-postconditions-negative',
        sourceCommit: 'a'.repeat(40),
        worktreeFingerprint: `sha256:${'b'.repeat(64)}`,
        candidateIdentity: { id: 'candidate', digest: `sha256:${'c'.repeat(64)}` },
        buildIdentity: { id: 'build', digest: `sha256:${'d'.repeat(64)}` },
        ownedRoots: ['artifacts/current-run']
    });
    const contextPath = 'context.json';
    const outputPath = 'artifacts/current-run/postconditions-reference.json';
    const payloadPath = 'artifacts/current-run/postconditions-payload.json';
    fs.writeFileSync(path.join(root, contextPath), `${JSON.stringify(currentRunContext, null, 4)}\n`);
    const hooked = spawnSync(process.execPath,
        ['--import', './tools/test/current-run-evidence-producer-hook.mjs', source], {
            cwd: root,
            encoding: 'utf8',
            timeout: 10000,
            env: {
                ...process.env,
                FSUSBLOG_CURRENT_RUN_EVIDENCE_CONSUMER: consumerId,
                FSUSBLOG_CURRENT_RUN_EVIDENCE_CONTEXT: contextPath,
                [fakeEntry.outputBindingKey]: outputPath,
                [fakeEntry.payloadBindingKey]: payloadPath
            }
        });
    assert.ifError(hooked.error);
    assert.equal(hooked.status, 1);
    assert.equal(hooked.stdout, '');
    assert.equal(hooked.stderr,
        '[current-run-evidence-producer] producer payload is missing after terminal success\n');
    assert.equal(fs.existsSync(path.join(root, outputPath)), false);
    assert.equal(fs.existsSync(path.join(root, payloadPath)), false);
    assert.equal(fs.existsSync(path.join(root, `${outputPath}.handoff.json`)), false);
});

test('clean-attempt evidence retains its finding and binds the real CLI through its library caller', () =>
{
    const generated = generateEvidenceLocationGovernance();
    const source = 'tools/release/clean-attempt-evidence-source.mjs';
    const caller = 'tools/release/browser-release-clean-attempt-consumers.mjs';
    const executable = 'tools/release/test-evidence-receipts-cli.mjs';
    const entry = generated.registry.entries.find((item) => item.producerSource === source);
    assert(entry);
    assert.equal(entry.producerBindingClass, 'library-caller');
    assert.equal(entry.producerCallsite, caller);
    assert.equal(entry.producerExecutable, `node ${executable} create-correctness`);
    assert.notEqual(entry.producerCallsite, entry.producerSource);
    const finding = generated.scan.findings.find((item) => item.file === source
        && item.ruleId === 'evidence-selection.first-match');
    assert(finding, 'library evidence access must remain in the scanner inventory');
    const ledgerEntry = generated.ledger.entries.find((item) => item.findingId === finding.findingId);
    assert.equal(ledgerEntry.classification, 'correctness-selection');
    assert.equal(ledgerEntry.newAuthorityId, entry.authorityId);
    assert.equal(ledgerEntry.location, `${source}:${finding.line}`);

    const callerSource = fs.readFileSync(path.join(repositoryRoot, caller), 'utf8');
    assert.match(callerSource, /import \{ loadConfiguredCleanAttemptEvidence \} from '\.\/clean-attempt-evidence-source\.mjs'/u);
    assert.match(callerSource, /loadConfiguredCleanAttemptEvidence\(\{ repositoryRoot, environment \}\)/u);
    const executableSource = fs.readFileSync(path.join(repositoryRoot, executable), 'utf8');
    assert.match(executableSource, /requireCleanAttemptConsumerAdmission\(\{/u);
    assert.match(executableSource,
        /if\s*\(options\.command === 'create-correctness'\)\s*\{\s*createCorrectness\(options\);\s*\}/u);

    // An unsupported command proves the real entry point runs without producing evidence.
    const probeArguments = ['locator-entry-probe'];
    const cli = spawnSync(process.execPath, [executable, ...probeArguments], {
        cwd: repositoryRoot, encoding: 'utf8', timeout: 10000
    });
    assert.ifError(cli.error);
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, /usage: test-evidence-receipts-cli\.mjs create-correctness/u);
    const library = spawnSync(process.execPath, [source, ...probeArguments], {
        cwd: repositoryRoot, encoding: 'utf8', timeout: 10000
    });
    assert.ifError(library.error);
    assert.equal(library.status, 0);
    assert.equal(library.stdout, '');
    assert.equal(library.stderr, '');
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
        && ['loadJobSummaries', 'loadFlakyEvidence', 'readTransportOrDirectoryJson'].includes(finding.function)));
    assert(new Set(generated.ledger.entries.map((entry) => entry.classification)).size === 3);
    assert(generated.ledger.entries.some((entry) => entry.location.startsWith('src/backend/')
        && entry.classification === 'not-evidence'));
    const diagnostic = generated.ledger.entries.find((entry) => entry.location.startsWith('tests/browser-diagnostics/run.mjs:'));
    assert.equal(diagnostic?.classification, 'diagnostic-only');
    const diagnosticAuthority = generated.registry.entries.find((entry) => entry.consumerId === diagnostic?.consumerId);
    assert.equal(diagnosticAuthority?.locatorMode, 'content-addressed-reference');
});
