#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const { createEvidenceProducerReceipt } = await import(pathToFileURL(
    path.join(repositoryRoot, 'tools/test-matrix/evidence-projection.mjs')).href);
const {
    releaseBuildIdentity,
    releasePolicyIdentity,
    sha256File,
    validateAssertionReport,
    validateCatalogAgainstLedger,
    validateDispositionLedger
} = await import(pathToFileURL(path.join(repositoryRoot, 'tools/test-matrix/release-domain-evidence.mjs')).href);

function option(name, fallback = null) {
    const index = process.argv.indexOf(`--${name}`);
    return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
function requiredEnvironment(name) {
    const value = String(process.env[name] ?? '').trim().replace(/^sha256:/u, '');
    if (!value) throw new Error(`${name} is required`);
    return value;
}

try {
    const root = path.resolve(option('root', repositoryRoot));
    const producerId = option('producer');
    if (!producerId) throw new Error('--producer is required');
    const runId = requiredEnvironment('FSUSBLOG_TEST_RUN_ID');
    const namespace = requiredEnvironment('FSUSBLOG_TEST_NAMESPACE');
    const sourceState = {
        commit: requiredEnvironment('FSUSBLOG_TEST_SOURCE_COMMIT'),
        worktreeFingerprint: requiredEnvironment('FSUSBLOG_TEST_SOURCE_FINGERPRINT')
    };
    const ledgerPath = path.resolve(root, option('ledger', 'config/testing/release-domain-assertion-dispositions.json'));
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    const producerEntries = validateDispositionLedger(ledger).filter((entry) => entry.canonicalProducer === producerId);
    const catalogDirectory = path.resolve(root, option('catalog-directory', 'tests/fixtures/evidence-projection'));
    const catalogs = fs.readdirSync(catalogDirectory).filter((file) => file.startsWith('release-') && file.endsWith('.json'))
        .map((file) => JSON.parse(fs.readFileSync(path.join(catalogDirectory, file), 'utf8')))
        .filter((catalog) => catalog.projectFrom === producerId)
        .sort((left, right) => left.tierId.localeCompare(right.tierId));
    if (catalogs.length === 0) throw new Error(`no release-domain catalog belongs to ${producerId}`);
    const testResultsRoot = process.env.FSUSBLOG_TEST_RESULTS_ROOT ?? '.tmp/test-results';
    const reportPath = path.resolve(root, option('report',
        path.join(testResultsRoot, 'release-domain-assertions', producerId, `${runId}.json`)));
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    const policyIdentity = releasePolicyIdentity(ledgerPath);
    const buildIdentities = [...new Set(catalogs.map((catalog) => releaseBuildIdentity(root, catalog)))];
    if (buildIdentities.length !== 1) throw new Error(`${producerId} catalogs do not share one build identity`);
    validateAssertionReport({
        report,
        producerId,
        entries: producerEntries,
        sourceState,
        runId,
        namespace,
        buildIdentity: buildIdentities[0],
        policyIdentity,
        repositoryRoot: root
    });
    for (const catalog of catalogs) {
        const entries = validateCatalogAgainstLedger(catalog, ledger);
        const artifacts = catalog.requiredArtifactDeclarations.map((declaration) => {
            const absolute = path.resolve(root, declaration.path);
            if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
                throw new Error(`required producer artifact is missing: ${declaration.path}`);
            }
            return { ...declaration, digest: sha256File(absolute) };
        });
        const assertions = entries.map((entry) => {
            const actual = report.assertions.find((assertion) => assertion.id === entry.requiredTestId);
            return {
                id: actual.id,
                outcome: actual.outcome,
                sourceTestIds: actual.sourceTestIds,
                coverageIds: catalog.requiredCoverageIds,
                artifactIds: entry.requiredArtifactIds
            };
        });
        const receipt = createEvidenceProducerReceipt({
            producerId,
            logicalTierId: catalog.tierId,
            sourceState,
            runId,
            namespace,
            buildIdentity: buildIdentities[0],
            policyIdentity,
            assertionReport: {
                path: path.relative(root, reportPath).replaceAll(path.sep, '/'),
                digest: sha256File(reportPath)
            },
            assertions,
            artifacts
        });
        const output = path.resolve(root, option('output-directory',
            path.join(testResultsRoot, 'evidence-producers')),
            producerId, runId, `${catalog.tierId}.json`);
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
        process.stdout.write(`[release-domain-producer] producer=${producerId} tier=${catalog.tierId} output=${path.relative(root, output)}\n`);
    }
} catch (error) {
    process.stderr.write(`[release-domain-producer] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
}
