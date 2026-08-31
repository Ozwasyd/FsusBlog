#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const {
    createAssertionReport,
    evidenceSelectorDigest,
    releaseBuildIdentity,
    releasePolicyIdentity,
    sha256File,
    validateCatalogAgainstLedger,
    validateDispositionLedger,
    validateNativeAssertionEvidence
} = await import(pathToFileURL(path.join(repositoryRoot, 'tools/test-matrix/release-domain-evidence.mjs')).href);

function option(name, fallback = null)
{
    const index = process.argv.indexOf(`--${name}`);
    return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function requiredEnvironment(name)
{
    const value = String(process.env[name] ?? '').trim().replace(/^sha256:/u, '');
    if (!value)
    {
        throw new Error(`${name} is required`);
    }
    return value;
}

function relative(root, file)
{
    return path.relative(root, file).replaceAll(path.sep, '/');
}

function readJson(file)
{
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function visitJsonFiles(directory, files)
{
    if (!fs.existsSync(directory))
    {
        return;
    }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name)))
    {
        const candidate = path.join(directory, entry.name);
        if (entry.isDirectory())
        {
            visitJsonFiles(candidate, files);
        }
        else if (entry.isFile() && entry.name.endsWith('.json'))
        {
            files.push(candidate);
        }
    }
}

function collectStructuredDocuments(root)
{
    const files = [];
    const testResultsRoot = path.resolve(process.env.FSUSBLOG_TEST_RESULTS_ROOT
        ?? path.join(root, '.tmp/test-results'));
    const directories = [
        path.join(testResultsRoot, 'vitest'),
        path.join(testResultsRoot, 'live-grant')
    ];
    const transport = String(process.env.FSUSBLOG_EVIDENCE_TRANSPORT_MANIFEST ?? '').trim();
    if (transport)
    {
        const manifest = JSON.parse(fs.readFileSync(path.resolve(root, transport), 'utf8'));
        for (const entry of (manifest.objects ?? []).flatMap((object) => object.archiveEntries ?? []))
        {
            files.push(path.resolve(root, entry.extractedPath));
        }
    }
    for (const directory of directories)
    {
        visitJsonFiles(directory, files);
    }
    const uniqueFiles = [...new Set(files.map((file) => path.resolve(file)))].sort();
    const documents = [];
    for (const file of uniqueFiles)
    {
        try
        {
            const value = readJson(file);
            if (Array.isArray(value?.testResults) || value?.schema === 'fsusblog.live-grant-execution.v1')
            {
                documents.push({ path: relative(root, file), value });
            }
        }
        catch
        {
            // An unrelated or incomplete JSON file is not structured producer evidence.
        }
    }
    return documents;
}

function normalizeTestResultPath(root, value)
{
    const absolute = path.isAbsolute(String(value ?? ''))
        ? path.resolve(String(value))
        : path.resolve(root, String(value ?? ''));
    const normalized = relative(root, absolute);
    return normalized.startsWith('../') ? String(value ?? '').replaceAll('\\', '/') : normalized;
}

function sourceArtifactPaths(root, entry, documents)
{
    const selector = entry.producerEvidence;
    if (selector.kind === 'vitest-file' || selector.kind === 'vitest-file-set')
    {
        const targets = selector.kind === 'vitest-file' ? [selector.file] : selector.files;
        const paths = documents.filter((document) => Array.isArray(document.value?.testResults)
            && document.value.testResults.some((result) => targets.includes(normalizeTestResultPath(root, result?.name))))
            .map((document) => document.path)
            .sort();
        if (paths.length === 0)
        {
            throw new Error(`${entry.id} has no native Vitest JSON result`);
        }
        return paths;
    }
    if (selector.kind === 'live-grant-child')
    {
        const workflowRunId = String(process.env.GITHUB_RUN_ID ?? '').trim();
        const workflowRunAttempt = String(process.env.GITHUB_RUN_ATTEMPT ?? '1');
        const matches = documents.filter((document) => document.value?.schema === 'fsusblog.live-grant-execution.v1'
            && document.value.lane === selector.lane
            && (document.value.schedulerRunId === requiredEnvironment('FSUSBLOG_TEST_RUN_ID')
                || (workflowRunId && document.value.workflowRunId === workflowRunId
                    && document.value.workflowRunAttempt === workflowRunAttempt))
            && document.value.children?.some((child) => child?.id === selector.childId));
        if (matches.length !== 1)
        {
            throw new Error(`${entry.id} expected exactly one current-run live-grant artifact, found ${matches.length}`);
        }
        return [matches[0].path];
    }
    if (selector.kind === 'browser-diagnostics-release-assertion')
    {
        return [selector.assertionArtifactPath, selector.receiptPath].sort();
    }
    throw new Error(`${entry.id} has an unsupported producer evidence selector`);
}

function writeJsonAtomic(file, value)
{
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
}

try
{
    const root = path.resolve(option('root', repositoryRoot));
    const producerId = option('producer');
    if (!producerId)
    {
        throw new Error('--producer is required');
    }
    const ledgerPath = path.resolve(root, option('ledger', 'config/testing/release-domain-assertion-dispositions.json'));
    const ledger = readJson(ledgerPath);
    const entries = validateDispositionLedger(ledger).filter((entry) => entry.canonicalProducer === producerId);
    if (entries.length === 0)
    {
        throw new Error(`no assertion dispositions belong to ${producerId}`);
    }
    const catalogDirectory = path.resolve(root, option('catalog-directory', 'tests/fixtures/evidence-projection'));
    const catalogs = fs.readdirSync(catalogDirectory).filter((file) => file.startsWith('release-') && file.endsWith('.json'))
        .map((file) => readJson(path.join(catalogDirectory, file)))
        .filter((catalog) => catalog.projectFrom === producerId);
    for (const catalog of catalogs)
    {
        validateCatalogAgainstLedger(catalog, ledger);
    }
    const buildIdentities = [...new Set(catalogs.map((catalog) => releaseBuildIdentity(root, catalog)))];
    if (buildIdentities.length !== 1)
    {
        throw new Error(`${producerId} catalogs do not share one build identity`);
    }
    const sourceState = {
        commit: requiredEnvironment('FSUSBLOG_TEST_SOURCE_COMMIT'),
        worktreeFingerprint: requiredEnvironment('FSUSBLOG_TEST_SOURCE_FINGERPRINT')
    };
    const runId = requiredEnvironment('FSUSBLOG_TEST_RUN_ID');
    const namespace = requiredEnvironment('FSUSBLOG_TEST_NAMESPACE');
    const documents = collectStructuredDocuments(root);
    const assertions = entries.map((entry) =>
    {
        const paths = sourceArtifactPaths(root, entry, documents);
        const validatedPaths = validateNativeAssertionEvidence({
            repositoryRoot: root,
            entry,
            sourceArtifactPaths: paths,
            sourceState,
            runId,
            namespace,
            policyIdentity: releasePolicyIdentity(ledgerPath)
        });
        return {
            id: entry.requiredTestId,
            dispositionId: entry.id,
            executed: true,
            outcome: 'Passed',
            sourceTestIds: entry.sourceTestIds,
            producerEvidenceDigest: evidenceSelectorDigest(entry.producerEvidence),
            sourceArtifactPaths: validatedPaths
        };
    });
    const referencedSourcePaths = [];
    for (const assertion of assertions)
    {
        referencedSourcePaths.push(...assertion.sourceArtifactPaths);
    }
    const allSourcePaths = [...new Set(referencedSourcePaths)].sort();
    const report = createAssertionReport({
        producerId,
        sourceState,
        runId,
        namespace,
        buildIdentity: buildIdentities[0],
        policyIdentity: releasePolicyIdentity(ledgerPath),
        assertions,
        sourceArtifacts: allSourcePaths.map((relativePath) => ({
            path: relativePath,
            digest: sha256File(path.resolve(root, relativePath))
        })),
        status: 'success'
    });
    const output = path.resolve(root, option('output',
        path.join(process.env.FSUSBLOG_TEST_RESULTS_ROOT ?? '.tmp/test-results',
            'release-domain-assertions', producerId, `${runId}.json`)));
    writeJsonAtomic(output, report);
    process.stdout.write(`[release-domain-assertions] producer=${producerId} assertions=${assertions.length} sources=${allSourcePaths.length} output=${relative(root, output)}\n`);
}
catch (error)
{
    process.stderr.write(`[release-domain-assertions] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
}
