import { execFileSync } from 'node:child_process';

import { distributionCatalog, validateDistributionCatalog } from './distribution-catalog.mjs';
import { assertDigest, canonicalDigest, deepFreeze, exactKeys } from './distribution-contract.mjs';

const { canonicalJson } = await import(new URL('../test-fixtures/receipt/canonical.mjs', import.meta.url));

const sourceSchema = 'fsusblog.distribution-article-writer-source-reference.v1';
const requestSchema = 'fsusblog.distribution-article-writer-capability-request.v1';
const sourceLimit = 1024 * 1024;
const serializedLimit = 256 * 1024;
const sourceReferences = new WeakSet();
const fullCommit = /^[0-9a-f]{40}$/u;
const namespacePattern = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/u;
const sourceDirectory = 'src/backend/Services/Fixtures/DataScale/';
const sourcePaths = Object.freeze([
    'ArticleScalePlan.cs', 'CanonicalArticleGraphFactory.cs',
    'CanonicalArticleGraphModels.cs', 'CanonicalArticleGraphVerifier.cs',
    'ArticleScaleGraphIdentityBindings.cs', 'DataScaleArticlePhysicalProjection.cs',
    'DataScaleProviderBulkTransport.cs', 'DataScalePhysicalBatchReadback.cs'
].map((file) => `${sourceDirectory}${file}`));

function requireCondition(condition, code)
{
    if (!condition)
    {
        throw new Error(code);
    }
}

function git(repositoryRoot, args, maximum = sourceLimit)
{
    return execFileSync('git', ['--no-replace-objects', '-C', repositoryRoot, ...args], {
        maxBuffer: maximum,
        stdio: ['ignore', 'pipe', 'pipe']
    });
}

/**
 * Read actual immutable Git blobs; no network, writer invocation or build admission.
 * A present source file is a reference, never a native allocator/factory capability.
 * Missing unpublished paths remain missing, including on the merged Blog baseline.
 */
export function readArticleBulkWriterSourceReference(options)
{
    exactKeys(options, ['repositoryRoot', 'sourceCommit'], 'distribution_writer_source_options');
    requireCondition(typeof options.repositoryRoot === 'string' && options.repositoryRoot.length > 0,
        'distribution_writer_repository_missing');
    requireCondition(fullCommit.test(options.sourceCommit), 'distribution_writer_commit_invalid');
    requireCondition(git(options.repositoryRoot, ['cat-file', '-t', options.sourceCommit]).toString('utf8').trim() === 'commit',
        'distribution_writer_commit_not_commit');
    const files = [];
    let physicalBatchGraphLimit = null;
    for (const sourcePath of sourcePaths)
    {
        const entry = git(options.repositoryRoot, ['ls-tree', options.sourceCommit, '--', sourcePath]).toString('utf8').trim();
        if (!entry)
        {
            files.push({ path: sourcePath, status: 'missing', gitBlob: null, sourceDigest: null });
            continue;
        }
        const match = entry.match(/^100644 blob ([0-9a-f]{40})\t(.+)$/u);
        requireCondition(match && match[2] === sourcePath, 'distribution_writer_source_not_regular_blob');
        const bytes = git(options.repositoryRoot, ['cat-file', 'blob', match[1]]);
        const source = bytes.toString('utf8');
        requireCondition(Buffer.from(source, 'utf8').equals(bytes), 'distribution_writer_source_not_utf8');
        files.push({ path: sourcePath, status: 'present', gitBlob: match[1], sourceDigest: canonicalDigest({ source }) });
        if (sourcePath.endsWith('/DataScaleArticlePhysicalProjection.cs'))
        {
            const bound = source.match(/graphs\.Count\s*>\s*([1-9][0-9]*)/u);
            if (bound && Number.isSafeInteger(Number(bound[1])))
            {
                physicalBatchGraphLimit = Number(bound[1]);
            }
        }
    }
    const body = {
        schema: sourceSchema,
        purpose: 'source-reference-only',
        repository: 'Ozwasyd/FsusBlog',
        sourceCommit: options.sourceCommit,
        files,
        physicalBatchGraphLimit,
        executionCapability: false
    };
    const reference = deepFreeze({ ...body, contentDigest: canonicalDigest(body) });
    sourceReferences.add(reference);
    return reference;
}

function validateSource(reference)
{
    requireCondition(sourceReferences.has(reference), 'distribution_writer_source_reference_not_observed');
    const plan = reference.files.find((file) => file.path.endsWith('/ArticleScalePlan.cs'));
    requireCondition(plan.status === 'present'
        && plan.sourceDigest === distributionCatalog.authorities.article.sourceDigest,
    'distribution_writer_article_plan_source_drift');
}

function validatePlanReference(reference, scenario, namespace)
{
    if (reference === null)
    {
        return;
    }
    exactKeys(reference, ['schema', 'ownerSourceCommit', 'contentDigest', 'scaleTier', 'articleCount', 'namespace'],
        'distribution_writer_article_plan_reference');
    requireCondition(reference.schema === distributionCatalog.authorities.article.schema,
        'distribution_writer_article_plan_schema');
    requireCondition(fullCommit.test(reference.ownerSourceCommit), 'distribution_writer_plan_owner_commit_invalid');
    assertDigest(reference.contentDigest, 'articlePlanReference.contentDigest');
    requireCondition(reference.scaleTier === scenario.counts.article.tier
        && reference.articleCount === scenario.counts.article.count
        && reference.namespace === namespace, 'distribution_writer_article_plan_scope_mismatch');
    // Preserve the original C# digest as an opaque reference. JS canonical JSON is
    // not ArticleScalePlanDigest.Compute and cannot validate or admit that plan.
}

function requestBody(options)
{
    exactKeys(options, ['scenarioId', 'namespace', 'articlePlanReference', 'batchSize', 'sourceReference'],
        'distribution_writer_request_options');
    validateSource(options.sourceReference);
    requireCondition(typeof options.namespace === 'string' && namespacePattern.test(options.namespace),
        'distribution_writer_namespace_invalid');
    const scenario = distributionCatalog.scenarios.find((row) => row.id === options.scenarioId);
    requireCondition(scenario, 'distribution_writer_scenario_unknown');
    const catalogResult = validateDistributionCatalog();
    requireCondition(catalogResult.status !== 'invalid', `distribution_writer_catalog_invalid:${catalogResult.errors.join('|')}`);
    validatePlanReference(options.articlePlanReference, scenario, options.namespace);
    const limit = options.sourceReference.physicalBatchGraphLimit;
    requireCondition(limit === null ? options.batchSize === null
        : Number.isSafeInteger(options.batchSize) && options.batchSize > 0 && options.batchSize <= limit,
    'distribution_writer_batch_bound_invalid');
    const blockers = [
        ...catalogResult.blockers,
        'article_writer_semantic_assignment_input_missing',
        'article_writer_complete_plan_admission_host_missing',
        ...options.sourceReference.files.filter((file) => file.status === 'missing')
            .map((file) => `article_writer_source_path_missing:${file.path}`)
    ];
    if (options.articlePlanReference === null)
    {
        blockers.push('article_writer_owner_plan_reference_missing');
    }
    if (scenario.id === 'uniform-baseline')
    {
        blockers.push('uniform_baseline_release_evidence_forbidden');
    }
    return {
        schema: requestSchema,
        purpose: 'owner-capability-request-only',
        status: 'blocked',
        executionEligible: false,
        releaseEvidenceEligible: false,
        identity: {
            catalogDigest: distributionCatalog.contentDigest,
            scenarioId: scenario.id,
            scenarioDigest: scenario.contentDigest,
            namespace: options.namespace,
            articleCount: scenario.counts.article.count,
            scaleTier: scenario.counts.article.tier,
            metricContractsDigest: canonicalDigest(scenario.expectedStatistics)
        },
        shapeReferences: scenario.shapes,
        metricContracts: scenario.expectedStatistics,
        articlePlanReference: options.articlePlanReference,
        articlePlanValidation: 'not-owner-validated',
        sourceReference: options.sourceReference,
        batchSize: options.batchSize,
        ownerRequest: {
            ownerIssue: 2542,
            existingProjection: 'DataScaleArticlePhysicalProjection.Compile',
            existingProjectionArguments: ['plan', 'graphs', 'identities', 'schema', 'externalIdentities'],
            proposedAssignmentIdentityFields: [
                'catalogDigest', 'scenarioId', 'scenarioDigest', 'assignmentDigest',
                'entityOrdinalCoverage', 'producerAuthorityReferences'
            ],
            requiredFactoryInputsBeforeSealing: [
                'content', 'media', 'taxonomy', 'resolvedTemporalRoles',
                'lifecycleVariant', 'hotness', 'nativeIdentityBinding'
            ],
            proposedContractStatus: 'owner-definition-required'
        },
        blockers
    };
}

/**
 * Map real catalog/metric identities to a bounded, explicitly non-executable owner
 * request. This defines an adapter proposal, not an existing writer wire contract.
 * No assignments, graph rows, database IDs, SQL or acceptance receipts are created.
 */
export function createDistributionArticleWriterRequest(options)
{
    const body = requestBody(options);
    return deepFreeze({ ...body, contentDigest: canonicalDigest(body) });
}

/** Rebuild every field from current authorities; an out-of-band expected digest is required. */
export function validateDistributionArticleWriterRequest(request, sourceReference, expectedDigest)
{
    assertDigest(expectedDigest, 'expectedRequestDigest');
    exactKeys(request, [
        'schema', 'purpose', 'status', 'executionEligible', 'releaseEvidenceEligible',
        'identity', 'shapeReferences', 'metricContracts', 'articlePlanReference',
        'articlePlanValidation', 'sourceReference', 'batchSize', 'ownerRequest', 'blockers', 'contentDigest'
    ], 'distribution_writer_request');
    exactKeys(request.identity, [
        'catalogDigest', 'scenarioId', 'scenarioDigest', 'namespace',
        'articleCount', 'scaleTier', 'metricContractsDigest'
    ], 'distribution_writer_identity');
    const body = requestBody({
        scenarioId: request.identity.scenarioId,
        namespace: request.identity.namespace,
        articlePlanReference: request.articlePlanReference,
        batchSize: request.batchSize,
        sourceReference
    });
    const { contentDigest, ...candidateBody } = request;
    assertDigest(contentDigest, 'request.contentDigest');
    requireCondition(contentDigest === expectedDigest && canonicalDigest(candidateBody) === contentDigest
        && canonicalDigest(body) === contentDigest, 'distribution_writer_request_identity_mismatch');
    return true;
}

/** Only reference JSON is emitted; its size does not grow with article count. */
export function serializeDistributionArticleWriterRequest(request, sourceReference, expectedDigest)
{
    validateDistributionArticleWriterRequest(request, sourceReference, expectedDigest);
    const serialized = canonicalJson(request);
    requireCondition(Buffer.byteLength(serialized, 'utf8') <= serializedLimit,
        'distribution_writer_request_serialization_bound');
    return serialized;
}

/**
 * Refusal boundary, not a second compiler/writer. The published factory has no
 * distribution assignment importer or complete-plan admission host. Refuse the
 * entire request before obtaining an assignment iterator or yielding any batch.
 */
export function prepareDistributionArticleWriterBatches(request, sourceReference, expectedDigest, assignments)
{
    validateDistributionArticleWriterRequest(request, sourceReference, expectedDigest);
    // Keep the prospective iterable opaque until the canonical owner supplies admission.
    void assignments;
    throw new Error('article_writer_semantic_assignment_input_missing');
}
