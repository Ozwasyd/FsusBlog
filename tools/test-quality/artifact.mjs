import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { verifyConformanceArtifact } from './conformance.mjs';
import { buildOracleFacts } from './oracle-facts.mjs';
import { evaluateQuality, loadQualityPolicy } from './policy.mjs';
import { contentDigest, QUALITY_ARTIFACT_SCHEMA } from './schema.mjs';

export const QUALITY_PRODUCER_ID = 'tools/ci/check-test-quality.mjs';

function fileDigest(root, relative)
{
    return `sha256:${createHash('sha256').update(readFileSync(path.join(root, relative))).digest('hex')}`;
}

function countBy(values)
{
    const result = {};
    for (const value of values)
    {
        result[value] = (result[value] ?? 0) + 1;
    }
    return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)));
}

function riskTags(testCase)
{
    const explicit = (testCase.traits ?? [])
        .filter((trait) => trait.name === 'Risk')
        .map((trait) => trait.value);
    if (explicit.length > 0)
    {
        return explicit;
    }
    return /(?:security|auth|permission|contract|binary|release)/iu.test(testCase.ownerFile)
        ? ['critical']
        : ['ordinary'];
}

export function buildQualityArtifact({
    root,
    inventory,
    conformance,
    runtimeEvidenceByTestId = new Map(),
    sourceReader = undefined,
    oracleFacts: suppliedOracleFacts = null
})
{
    const policy = loadQualityPolicy(root);
    const oracleOptions = { root, runtimeEvidenceByTestId };
    if (sourceReader)
    {
        oracleOptions.sourceReader = sourceReader;
    }
    const oracleFacts = suppliedOracleFacts ?? buildOracleFacts(inventory, oracleOptions);
    if (oracleFacts.inventoryDigest !== inventory.inventoryDigest)
    {
        throw new Error('supplied oracle facts are stale for the canonical inventory');
    }
    const result = evaluateQuality({ inventory, oracleFacts, policy });
    const inventoryById = new Map(inventory.testCases.map((testCase) => [testCase.id, testCase]));
    const factsById = new Map(oracleFacts.cases.map((item) => [item.testId, item]));
    const cases = result.cases.map((item) =>
    {
        const inventoryCase = inventoryById.get(item.testId);
        const fact = factsById.get(item.testId);
        const owner = {
            sourceFile: inventoryCase.ownerFile,
            productionSymbols: (fact.calls.production ?? []).map((call) => (
                `${call.containingType ?? ''}.${call.methodName}`.replace(/^\./u, '')
            )).sort(),
            coverageIds: (inventoryCase.traits ?? [])
                .filter((trait) => trait.name === 'Coverage')
                .map((trait) => trait.value)
                .sort(),
            requirementIds: (inventoryCase.traits ?? [])
                .filter((trait) => trait.name === 'Requirement')
                .map((trait) => trait.value)
                .sort()
        };
        return {
            testId: item.testId,
            framework: inventoryCase.adapter,
            risk: riskTags(inventoryCase).sort(),
            outcome: item.outcome,
            violations: item.violations.map((violation) => ({ ...violation, owner })),
            waived: item.waived,
            diagnostics: item.diagnostics
        };
    });
    const violations = cases.flatMap((item) => item.violations);
    const firstFailure = violations[0] ?? null;
    const dynamicObligations = oracleFacts.cases
        .filter((item) => item.controlFlow.dynamicObligation !== null)
        .map((item) => ({ testId: item.testId, obligation: item.controlFlow.dynamicObligation }));
    const status = cases.some((item) => item.outcome === 'failed' || item.outcome === 'unresolved-failed')
        ? 'failed'
        : 'passed';
    const artifact = {
        schema: QUALITY_ARTIFACT_SCHEMA,
        status,
        producer: {
            id: QUALITY_PRODUCER_ID,
            engineVersion: result.engineVersion,
            analyzerVersion: oracleFacts.analyzerVersion
        },
        sourceState: inventory.sourceState,
        bindings: {
            inventoryDigest: inventory.inventoryDigest,
            adapterVersion: inventory.adapterVersion,
            oracleFactsDigest: oracleFacts.contentDigest,
            policyVersion: result.policyVersion,
            policyDigest: result.policyDigest,
            conformanceDigest: conformance.contentDigest,
            matrixDigest: fileDigest(root, 'tests/matrix.yml'),
            coverageCatalogDigest: fileDigest(root, 'tests/coverage-registry.json'),
            requirementCatalogDigest: fileDigest(root, 'tests/backend/Fixtures/backend-test-requirements.json')
        },
        counts: {
            planned: inventory.testCases.length,
            analyzed: oracleFacts.cases.length,
            ...result.counts,
            byFramework: countBy(cases.map((item) => item.framework)),
            byRule: countBy(violations.map((item) => item.ruleId)),
            byRisk: countBy(cases.flatMap((item) => item.risk))
        },
        cases,
        violations,
        dynamicObligations,
        firstFailure,
        conformance: {
            schema: conformance.schema,
            corpusVersion: conformance.corpusVersion,
            caseCount: conformance.cases.length,
            killedMutations: conformance.killedMutations
        },
        contentDigest: ''
    };
    artifact.contentDigest = contentDigest(artifact);
    return { artifact, oracleFacts, result };
}

export function renderQualitySummary(artifact)
{
    validateQualityArtifact(artifact);
    const ruleRows = Object.entries(artifact.counts.byRule)
        .map(([rule, count]) => `| \`${rule}\` | ${count} |`);
    const frameworkRows = Object.entries(artifact.counts.byFramework)
        .map(([framework, count]) => `| \`${framework}\` | ${count} |`);
    return [
        '# Generated Test Quality Summary',
        '',
        '<!-- generated from fsusblog.test-quality.v2; do not edit by hand -->',
        '',
        `Artifact digest: \`${artifact.contentDigest}\``,
        '',
        `Status: \`${artifact.status}\`; planned=${artifact.counts.planned}; analyzed=${artifact.counts.analyzed}; failed=${artifact.counts.failed ?? 0}; unresolved=${artifact.counts['unresolved-failed'] ?? 0}.`,
        '',
        '## Framework coverage',
        '',
        '| Framework | Cases |',
        '|---|---:|',
        ...frameworkRows,
        '',
        '## Rule violations',
        '',
        '| Rule | Violations |',
        '|---|---:|',
        ...(ruleRows.length > 0 ? ruleRows : ['| _none_ | 0 |']),
        ''
    ].join('\n');
}

export function validateQualityArtifact(artifact, { inventory = null } = {})
{
    const keys = new Set([
        'schema',
        'status',
        'producer',
        'sourceState',
        'bindings',
        'counts',
        'cases',
        'violations',
        'dynamicObligations',
        'firstFailure',
        'conformance',
        'contentDigest'
    ]);
    if (artifact === null || typeof artifact !== 'object' || Array.isArray(artifact))
    {
        throw new Error('test-quality artifact must be an object');
    }
    for (const key of Object.keys(artifact))
    {
        if (!keys.has(key))
        {
            throw new Error(`test-quality artifact contains unknown field ${key}`);
        }
    }
    if (artifact.schema !== QUALITY_ARTIFACT_SCHEMA)
    {
        throw new Error(`test-quality artifact schema must be ${QUALITY_ARTIFACT_SCHEMA}`);
    }
    if (!['passed', 'failed'].includes(artifact.status))
    {
        throw new Error('test-quality artifact status is invalid');
    }
    if (artifact.producer?.id !== QUALITY_PRODUCER_ID)
    {
        throw new Error('test-quality artifact producer identity is invalid');
    }
    if (!Array.isArray(artifact.cases) || !Array.isArray(artifact.violations))
    {
        throw new Error('test-quality artifact cases/violations are missing');
    }
    const caseIds = artifact.cases.map((item) => item.testId);
    if (new Set(caseIds).size !== caseIds.length)
    {
        throw new Error('test-quality artifact contains duplicate case outcomes');
    }
    if (inventory)
    {
        const inventoryIds = inventory.testCases.map((item) => item.id).toSorted();
        if (JSON.stringify(caseIds.toSorted()) !== JSON.stringify(inventoryIds))
        {
            throw new Error('test-quality artifact does not give every inventory case exactly one terminal outcome');
        }
        if (artifact.bindings.inventoryDigest !== inventory.inventoryDigest)
        {
            throw new Error('test-quality artifact inventory digest is stale');
        }
    }
    const terminal = new Set(['passed', 'failed', 'not-applicable', 'unresolved-failed']);
    if (artifact.cases.some((item) => !terminal.has(item.outcome)))
    {
        throw new Error('test-quality artifact contains a non-terminal case outcome');
    }
    const expectedStatus = artifact.cases.some((item) => item.outcome === 'failed' || item.outcome === 'unresolved-failed')
        ? 'failed'
        : 'passed';
    if (artifact.status !== expectedStatus)
    {
        throw new Error('test-quality artifact status does not match terminal case outcomes');
    }
    const projectedViolations = artifact.cases.flatMap((item) => item.violations);
    if (JSON.stringify(projectedViolations) !== JSON.stringify(artifact.violations))
    {
        throw new Error('test-quality artifact violation summary was deleted or reordered');
    }
    if (JSON.stringify(artifact.firstFailure) !== JSON.stringify(artifact.violations[0] ?? null))
    {
        throw new Error('test-quality artifact first failure was overwritten');
    }
    const counted = countBy(artifact.cases.map((item) => item.outcome));
    for (const outcome of terminal)
    {
        if (Number(artifact.counts[outcome] ?? 0) !== Number(counted[outcome] ?? 0))
        {
            throw new Error(`test-quality artifact ${outcome} count is inconsistent`);
        }
    }
    if (artifact.counts.planned !== artifact.cases.length || artifact.counts.analyzed !== artifact.cases.length)
    {
        throw new Error('test-quality artifact planned/analyzed counts are inconsistent');
    }
    if (contentDigest(artifact) !== artifact.contentDigest)
    {
        throw new Error('test-quality artifact content digest is invalid');
    }
    return artifact;
}

export function verifyQualityArtifact({
    root,
    inventory,
    conformance,
    artifact,
    runtimeEvidenceByTestId = new Map(),
    sourceReader = undefined,
    oracleFacts = null
})
{
    validateQualityArtifact(artifact, { inventory });
    if (oracleFacts)
    {
        const oracleOptions = { root, runtimeEvidenceByTestId };
        if (sourceReader)
        {
            oracleOptions.sourceReader = sourceReader;
        }
        const recomputedOracleFacts = buildOracleFacts(inventory, oracleOptions);
        if (JSON.stringify(recomputedOracleFacts) !== JSON.stringify(oracleFacts))
        {
            throw new Error('oracle facts artifact differs from independently recomputed adapter/source facts');
        }
    }
    const recomputed = buildQualityArtifact({
        root,
        inventory,
        conformance,
        runtimeEvidenceByTestId,
        sourceReader
    }).artifact;
    if (JSON.stringify(recomputed) !== JSON.stringify(artifact))
    {
        throw new Error('test-quality artifact differs from independently recomputed inventory/facts/policy outcome');
    }
    return artifact;
}

const { loadCanonicalInventory } = await import(new URL('../test-inventory/api.mjs', import.meta.url));
export const requiredEvidenceVerifier = Object.freeze({
    version: 1, successStatuses: Object.freeze(['success']), describe: async (receipt) => (await import(new URL('../release/required-evidence-owner-contract.mjs', import.meta.url))).describeJobEvidence(receipt),
    async verify({ domainInputs, repositoryRoot, context })
    {
        const { readOwnerEvidenceReference } = await import(new URL('../release/required-evidence-owner-input.mjs', import.meta.url));
        const { verifiedOwnerResult } = await import(new URL('../release/required-evidence-owner-contract.mjs', import.meta.url));
        const refs = Object.fromEntries(['artifact', 'oracleFacts', 'conformance', 'inventory'].map((key) =>
            [key, readOwnerEvidenceReference(domainInputs?.[key], { repositoryRoot, context })]));
        const inventory = loadCanonicalInventory(repositoryRoot, {
            artifactPath: refs.inventory.file, requireArtifact: true, runAdapters: false
        });
        const conformance = verifyConformanceArtifact(repositoryRoot, refs.conformance.receipt);
        verifyQualityArtifact({ root: repositoryRoot, inventory, conformance,
            artifact: refs.artifact.receipt, oracleFacts: refs.oracleFacts.receipt });
        return verifiedOwnerResult({ artifactDigest: refs.artifact.digest,
            inventoryDigest: refs.inventory.digest, conformanceDigest: refs.conformance.digest });
    }
});
