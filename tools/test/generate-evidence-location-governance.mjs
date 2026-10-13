#!/usr/bin/env node
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const { loadCanonicalRequiredEvidenceCatalog } = await import(new URL('../test-matrix/required-evidence-catalog.mjs', import.meta.url));

const { validateJsonSchema } = await import(new URL('../test-matrix/schema-validator/validate.mjs', import.meta.url));

import {
    governanceContentDigest,
    validateEvidenceLocatorRegistry,
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
// These exact findings select fixture entities inside an import-only verifier;
// they do not select evidence locations. Pin the complete scanner identity and
// source excerpt so a new or repurposed selector cannot inherit the exception.
const nonEvidenceFindingOverrides = new Map([
    {
        findingId: '4ad3e50e7a86fd77',
        ruleId: 'evidence-selection.latest-newest',
        file: 'tools/test-fixtures/receipt/postconditions.mjs',
        line: 160,
        column: 66,
        function: 'verifyArticlePaginationDeep',
        excerpt: "if (fields.route !== 'article/list/home' || fields.sort !== 'latest' || fields.pageSize !== 10)",
        indirectVia: null
    },
    {
        findingId: 'd20d5764a604254c',
        ruleId: 'evidence-selection.latest-newest',
        file: 'tools/test-fixtures/receipt/postconditions.mjs',
        line: 162,
        column: 91,
        function: 'verifyArticlePaginationDeep',
        excerpt: "return fail(id, 'pagination route/sort/page-size binding is not article/list/home latest size=10');",
        indirectVia: null
    },
    {
        findingId: 'ab7806efdc13f126',
        ruleId: 'evidence-selection.first-match',
        file: 'tools/test-fixtures/receipt/postconditions.mjs',
        line: 1100,
        column: 32,
        function: 'verifyCommentMatrix',
        excerpt: 'const fields = matches[0].fields ?? {};',
        indirectVia: null
    },
    {
        findingId: '3832625c19cc6921',
        ruleId: 'evidence-selection.first-match',
        file: 'tools/test-fixtures/receipt/postconditions.mjs',
        line: 1162,
        column: 38,
        function: 'verifyCommentMatrix',
        excerpt: "|| spam.signalEvidence.some((evidence) => String(evidence?.commentId) !== String(one('spam')[0].id)",
        indirectVia: null
    },
    {
        findingId: '6e2820ee117b50ea',
        ruleId: 'evidence-selection.first-match',
        file: 'tools/test-fixtures/receipt/postconditions.mjs',
        line: 1215,
        column: 19,
        function: 'verifyCommentMatrix',
        excerpt: "const root = one('approved-root')[0];",
        indirectVia: null
    },
    {
        findingId: 'd0b3d067d8933150',
        ruleId: 'evidence-selection.first-match',
        file: 'tools/test-fixtures/receipt/postconditions.mjs',
        line: 1258,
        column: 30,
        function: 'verifyCommentMatrix',
        excerpt: "if (one('deleted-root-child')[0]?.fields?.publicVisible !== true)",
        indirectVia: null
    },
    {
        findingId: '28ef7c5a1d96bc06',
        ruleId: 'evidence-selection.first-match',
        file: 'tools/test-fixtures/receipt/postconditions.mjs',
        line: 1262,
        column: 46,
        function: 'verifyCommentMatrix',
        excerpt: "const deletedRoot = one('deleted-root')[0];",
        indirectVia: null
    },
    {
        findingId: 'ed3fb82f674ea7ff',
        ruleId: 'evidence-selection.first-match',
        file: 'tools/test-fixtures/receipt/postconditions.mjs',
        line: 1263,
        column: 47,
        function: 'verifyCommentMatrix',
        excerpt: "const deletedChild = one('deleted-root-child')[0];",
        indirectVia: null
    }
].map((finding) => [finding.findingId, Object.freeze(finding)]));
const nonEvidenceOverrideFiles = new Set([...nonEvidenceFindingOverrides.values()]
    .map((finding) => finding.file));
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

export function validateEvidenceLocationClassificationOverrides(scan)
{
    const errors = [];
    const findingsById = new Map(scan.findings.map((finding) => [finding.findingId, finding]));
    for (const [findingId, expected] of nonEvidenceFindingOverrides)
    {
        const actual = findingsById.get(findingId);
        if (!actual)
        {
            errors.push(`non-evidence finding override is missing: ${findingId}`);
            continue;
        }
        for (const field of ['ruleId', 'file', 'line', 'column', 'function', 'excerpt', 'indirectVia'])
        {
            if (actual[field] !== expected[field])
            {
                errors.push(`non-evidence finding override ${findingId} changed ${field}`);
            }
        }
    }
    for (const finding of scan.findings)
    {
        if (nonEvidenceOverrideFiles.has(finding.file)
            && !nonEvidenceFindingOverrides.has(finding.findingId))
        {
            errors.push(`unreviewed evidence selector in import-only module: ${finding.findingId} ${finding.file}:${finding.line}`);
        }
    }
    if (errors.length > 0)
    {
        throw new Error(errors.join('\n'));
    }
}

function findingClassification(finding)
{
    if (nonEvidenceFindingOverrides.has(finding.findingId))
    {
        return 'not-evidence';
    }
    return programClassification(finding.file);
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
    if (file.startsWith('.github/') || file.startsWith('tools/ci/'))
    {
        return 'ci-governance';
    }
    if (file.startsWith('tools/release/'))
    {
        return 'release-final-governance';
    }
    if (file.startsWith('tools/operations/'))
    {
        return 'operations-governance';
    }
    if (file.startsWith('tools/docs/'))
    {
        return 'documentation-governance';
    }
    if (file.startsWith('tools/frontend/'))
    {
        return 'frontend-build-governance';
    }
    if (file.startsWith('tools/test-matrix/'))
    {
        return 'test-matrix-governance';
    }
    return 'test-evidence-governance';
}


function producerCommandFor(file)
{
    if (file === 'tools/ci/summarize-quality-gate.mjs')
    {
        return 'node tools/ci/summarize-quality-gate.mjs';
    }
    if (file === 'tools/release/public-preview-release-evidence.mjs')
    {
        return 'bash tools/docs/run-public-preview-capture.sh';
    }
    if (file === 'tools/release/check-release-final.mjs')
    {
        return 'bash tools/operations/collect-release-evidence.sh --require-ok';
    }
    if (file === 'tools/release/release-final-domain-evidence.mjs')
    {
        return 'node tools/test/publish-release-final-evidence-parent.mjs';
    }
    if (file === '.github/workflows/browser-diagnostics.yml')
    {
        return 'bash tools/test/lanes/browser-diagnostics.sh manual --workers 1';
    }
    if (file === '.github/workflows/quality-gate.yml')
    {
        return 'node tools/ci/summarize-quality-gate.mjs';
    }
    if (file.endsWith('.sh'))
    {
        return `bash ${file}`;
    }
    if (file.endsWith('.mjs') || file.endsWith('.js'))
    {
        return `node ${file}`;
    }
    throw new Error(`evidence producer has no canonical command: ${file}`);
}

const canonicalCallerOverrides = new Map(Object.entries({
    'tools/test-fixtures/receipt/private-io.mjs': ['tools/test-fixtures/cli.mjs',
        'node tools/test-fixtures/cli.mjs'],
    'tools/test-fixtures/receipt/projection.mjs': ['tools/test-fixtures/cli.mjs',
        'node tools/test-fixtures/cli.mjs'],
    'tools/test-matrix/public-shell-locale-evidence.mjs': ['tools/test-matrix/aggregate-public-shell-locale.mjs',
        'node tools/test-matrix/aggregate-public-shell-locale.mjs'],
    'tools/test/native-test-receipt.mjs': ['tools/test/native-test-governance.mjs',
        'node tools/test/run-native-tests.mjs --profile fuzz-sanitizer'],
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
    if (!file)
    {
        throw new Error(`canonical evidence producer has no executable file: ${command}`);
    }
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
    {
        throw new Error(`canonical evidence producer executable is missing: ${producer.producerExecutable}`);
    }
    if (!fs.existsSync(path.join(repositoryRoot, producer.producerCallsite)))
    {
        throw new Error(`canonical evidence producer callsite is missing: ${producer.producerCallsite}`);
    }
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

// Finite source/export recognition only. The producer owns the requested row;
// parsing it never imports its runtime, publishes evidence or grants admission.
const requireRegistrationParser = createRequire(new URL('../governance/javascript-format-parser/package.json', import.meta.url));
const registrationParser = requireRegistrationParser('espree');
const registrationParserLock = JSON.parse(fs.readFileSync(new URL('../governance/javascript-format-parser/package-lock.json', import.meta.url), 'utf8'));
if (registrationParser.version !== registrationParserLock.packages['node_modules/espree'].version)
{
    throw new Error('embedded registration requires the locked JavaScript parser');
}
const embeddedRegistrationSources = new Map([
    ['tools/release/publish-release-final-bindings.mjs', 'releaseFinalBindingOutputRegistration']
]);

export function parseEmbeddedEvidenceRegistration(source, producerSource, exportName)
{
    if (embeddedRegistrationSources.get(producerSource) !== exportName)
    {
        throw new Error('unrecognized embedded registration source/export');
    }
    const ast = registrationParser.parse(source, { ecmaVersion: 2025, sourceType: 'module' });
    function bindsObject(pattern)
    {
        if (!pattern)
        {
            return false;
        }
        if (pattern.type === 'Identifier')
        {
            return pattern.name === 'Object';
        }
        if (pattern.type === 'ObjectPattern')
        {
            return pattern.properties.some((property) => bindsObject(property.type === 'RestElement'
                ? property.argument : property.value));
        }
        if (pattern.type === 'ArrayPattern')
        {
            return pattern.elements.some(bindsObject);
        }
        if (pattern.type === 'AssignmentPattern')
        {
            return bindsObject(pattern.left);
        }
        return pattern.type === 'RestElement' && bindsObject(pattern.argument);
    }
    function rejectModuleObjectBinding(node)
    {
        if (!node || typeof node !== 'object')
        {
            return;
        }
        if ((['FunctionDeclaration', 'ClassDeclaration'].includes(node.type) && bindsObject(node.id))
            || (node.type === 'ImportDeclaration' && node.specifiers.some((item) => bindsObject(item.local)))
            || (node.type === 'VariableDeclaration' && node.declarations.some((item) => bindsObject(item.id))))
        {
            throw new Error('embedded registration cannot shadow Object');
        }
        // Function parameters/bodies and class bodies have their own scopes.
        // At module level also inspect nested blocks, conservatively refusing
        // lexical bindings there as well as var bindings hoisted to the module.
        if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression',
            'ClassDeclaration', 'ClassExpression'].includes(node.type))
        {
            return;
        }
        for (const child of Object.values(node))
        {
            if (Array.isArray(child))
            {
                child.forEach(rejectModuleObjectBinding);
            }
            else if (child?.type)
            {
                rejectModuleObjectBinding(child);
            }
        }
    }
    rejectModuleObjectBinding(ast);
    const declarations = new Map();
    const exported = [];
    for (const statement of ast.body)
    {
        const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
        if (declaration?.type === 'VariableDeclaration')
        {
            for (const item of declaration.declarations)
            {
                if (item.id.type === 'Identifier')
                {
                    declarations.set(item.id.name, { kind: declaration.kind, init: item.init });
                    if (statement.type === 'ExportNamedDeclaration' && item.id.name === exportName)
                    {
                        exported.push(item);
                    }
                }
            }
        }
    }
    if (exported.length !== 1 || declarations.get(exportName)?.kind !== 'const')
    {
        throw new Error('embedded registration requires one direct exported const');
    }
    const resolving = new Set();
    function read(node)
    {
        if (node?.type === 'Literal' && typeof node.value === 'string')
        {
            return node.value;
        }
        if (node?.type === 'Identifier' && ['consumerId', 'producerSource'].includes(node.name))
        {
            const declaration = declarations.get(node.name);
            if (declaration?.kind !== 'const' || resolving.has(node.name))
            {
                throw new Error('embedded registration requires finite local constants');
            }
            resolving.add(node.name);
            const value = read(declaration.init);
            resolving.delete(node.name);
            return value;
        }
        if (node?.type === 'TemplateLiteral')
        {
            return node.quasis.reduce((value, quasi, index) =>
                value + quasi.value.cooked + (index < node.expressions.length ? read(node.expressions[index]) : ''), '');
        }
        if (node?.type === 'ArrayExpression')
        {
            return node.elements.map(read);
        }
        if (node?.type === 'ObjectExpression')
        {
            const value = {};
            for (const property of node.properties)
            {
                if (property.type !== 'Property' || property.computed || property.method || property.kind !== 'init')
                {
                    throw new Error('embedded registration rejects spread, computed properties and accessors');
                }
                const key = property.key.type === 'Identifier' ? property.key.name : property.key.value;
                if (typeof key !== 'string' || Object.hasOwn(value, key))
                {
                    throw new Error('embedded registration rejects duplicate or non-string fields');
                }
                Object.defineProperty(value, key, { value: read(property.value), enumerable: true });
            }
            return value;
        }
        if (node?.type === 'CallExpression' && node.arguments.length === 1
            && node.callee.type === 'MemberExpression' && !node.callee.computed
            && node.callee.object.type === 'Identifier' && node.callee.object.name === 'Object'
            && node.callee.property.name === 'freeze')
        {
            return read(node.arguments[0]);
        }
        throw new Error('embedded registration contains an unsupported expression');
    }
    const entry = read(exported[0].init);
    const payload = { schema: 'fsusblog.evidence-locator-registry.v1', version: 1, entries: [entry] };
    const registry = { ...payload, contentDigest: governanceContentDigest(payload) };
    const schema = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'config/testing/evidence-locator-registry.schema.json'), 'utf8'));
    const errors = validateJsonSchema(registry, schema);
    if (errors.length > 0)
    {
        throw new Error(`embedded registration schema rejected: ${errors.join('; ')}`);
    }
    validateEvidenceLocatorRegistry(registry);
    const consumerId = consumerIdFor(producerSource);
    const expected = {
        consumerId, authorityId: `${consumerId}.current-run`, producerId: `${consumerId}.producer`,
        receiptSchema: 'fsusblog.current-run-evidence-reference.v1', locatorMode: 'explicit-run-path',
        requiredIdentityFields: ['attemptId', 'buildIdentity', 'candidateIdentity', 'schedulerRunId', 'sourceCommit', 'worktreeFingerprint'],
        requiredDigestFields: ['contentDigest', 'producerReceiptDigest'], expectedCardinality: 'exact-one',
        allowedRoots: ['artifacts/current-run'], publicationMode: 'embedded', producerSource, producerCallsite: producerSource,
        producerExecutable: `node ${producerSource}`, producerCommand: `node ${producerSource}`, producerBindingClass: 'cli',
        outputBindingKey: bindingFor(consumerId), handoffBindingKey: handoffBindingFor(consumerId),
        checkpointCommand: checkpointCommandFor(consumerId)
    };
    if (governanceContentDigest({ entry }) !== governanceContentDigest({ entry: expected }))
    {
        throw new Error('embedded registration differs from canonical source identity and required bindings');
    }
    return entry;
}

function buildGovernance(scan, root)
{
    const entries = scan.findings.map((finding) =>
    {
        const classification = findingClassification(finding);
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
        .filter((finding) => findingClassification(finding) !== 'not-evidence')
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
    // The catalog owns these authorities. Register their existing producer
    // entrypoints in this sole locator registry rather than maintaining another
    // release authority list. Job-result bytes are written by the canonical
    // matrix runner; a lane exit status is not a job-result producer receipt.
    for (const authority of loadCanonicalRequiredEvidenceCatalog().entries)
    {
        const consumerId = `evidence-consumer.required-evidence.${authority.authorityId}`;
        const producerExecutable = authority.receiptSchema === 'fsusblog.ci.job-result.v1'
            ? `node tools/run-test-matrix.mjs ci-tier ${authority.authorityId}`
            : authority.localProducerCommand.replace(/^(tools\/[^\s]+\.sh)(?=\s|$)/u, 'bash $1');
        const producerSource = producerExecutableFile(producerExecutable);
        if (!fs.existsSync(path.join(repositoryRoot, producerSource)))
        {
            throw new Error(`required authority producer is missing: ${producerSource}`);
        }
        registryEntries.push({
            consumerId,
            authorityId: authority.locatorBindingKey,
            producerId: authority.canonicalOwner,
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
            producerSource,
            producerCallsite: producerSource,
            producerExecutable,
            producerBindingClass: 'cli',
            producerCommand: hookedProducerCommandFor(consumerId, producerExecutable),
            outputBindingKey: bindingFor(consumerId),
            handoffBindingKey: handoffBindingFor(consumerId),
            payloadBindingKey: payloadBindingFor(consumerId),
            checkpointCommand: checkpointCommandFor(consumerId)
        });
    }
    for (const [producerSource, exportName] of embeddedRegistrationSources)
    {
        const source = fs.readFileSync(path.join(root, producerSource), 'utf8');
        const entry = parseEmbeddedEvidenceRegistration(source, producerSource, exportName);
        if (registryEntries.some((registered) => registered.consumerId === entry.consumerId
            || registered.authorityId === entry.authorityId))
        {
            throw new Error('embedded registration duplicates an existing consumer or authority');
        }
        registryEntries.push(entry);
    }
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
    validateEvidenceLocationClassificationOverrides(scan);
    const { registry, ledger } = buildGovernance(scan, root);
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
