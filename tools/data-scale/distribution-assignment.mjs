import { createHash } from 'node:crypto';
import fs from 'node:fs';

import { distributionCatalog, distributionCatalogDigest, distributionScenarioDigest } from './distribution-catalog.mjs';
import { assertDigest, canonicalDigest, deepFreeze, exactKeys } from './distribution-contract.mjs';
import { createDistributionArticleWriterRequest } from './distribution-writer-adapter.mjs';

export const distributionSamplingAlgorithm = deepFreeze({ algorithm: 'sha256-counter-u53', version: '1' });
const samplingSchema = 'fsusblog.distribution-sampling-domain.v1';
const shardSchema = 'fsusblog.distribution-sampling-shard.v1';
const samplingLimit = 1000000;
const maximumShardSize = 4096;
const identifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/u;
const kernelCapabilities = new WeakSet();
const articleCompilers = new WeakMap();
const partialSchema = 'fsusblog.distribution-article-body-lifecycle-assignments.v1';
const partialShardSchema = 'fsusblog.distribution-article-body-lifecycle-shard.v1';

function requireCondition(condition, code)
{
    if (!condition)
    {
        throw new Error(code);
    }
}

function assertIdentifier(value, label)
{
    if (typeof value !== 'string' || !identifierPattern.test(value))
    {
        throw new Error(`${label}_invalid`);
    }
}

function assertOrdinal(value)
{
    if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0))
    {
        throw new Error('distribution_sampling_ordinal_invalid');
    }
}

function counterStream(domainDigest, stream)
{
    assertIdentifier(stream, 'distribution_sampling_stream');
    const prefix = createHash('sha256')
        .update('fsusblog.distribution-sha256-counter-u53.v1\0', 'utf8')
        .update(domainDigest.slice(7), 'ascii')
        .update('\0', 'ascii')
        .update(stream, 'utf8')
        .update('\0', 'ascii');
    return (ordinal) =>
    {
        assertOrdinal(ordinal);
        const bytes = prefix.copy().update(String(ordinal), 'ascii').digest();
        // The first 53 big-endian bits are exact in Node and .NET double precision.
        const numerator = bytes.readUIntBE(0, 6) * 32 + (bytes[6] >>> 3);
        return numerator / 9007199254740992;
    };
}

/**
 * Algorithm primitive only: indices have no semantic meaning or authority. Production
 * scenario parameters must come from the catalog; this API cannot create a plan.
 */
export function createWeightedIndexSampler(weights)
{
    if (!Array.isArray(weights) || Object.getPrototypeOf(weights) !== Array.prototype
        || weights.length === 0 || weights.length > maximumShardSize)
    {
        throw new Error('distribution_sampling_weights_invalid');
    }
    canonicalDigest(weights);
    let total = 0;
    const cumulative = weights.map((weight) =>
    {
        if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0)
        {
            throw new Error('distribution_sampling_weight_invalid');
        }
        const next = total + weight;
        if (!Number.isFinite(next) || next <= total)
        {
            throw new Error('distribution_sampling_weight_precision_invalid');
        }
        total = next;
        return total;
    });
    const boundaries = cumulative.map((value) => value / total);
    if (boundaries.some((value, index) => value <= (index === 0 ? 0 : boundaries[index - 1])))
    {
        throw new Error('distribution_sampling_weight_precision_invalid');
    }
    return (unitInterval) =>
    {
        if (!Number.isFinite(unitInterval) || unitInterval < 0 || unitInterval >= 1)
        {
            throw new Error('distribution_sampling_unit_interval_invalid');
        }
        let lower = 0;
        let upper = boundaries.length - 1;
        while (lower < upper)
        {
            const middle = lower + Math.floor((upper - lower) / 2);
            if (unitInterval < boundaries[middle])
            {
                upper = middle;
            }
            else
            {
                lower = middle + 1;
            }
        }
        return lower;
    };
}

/**
 * Bind the real catalog seed and PRNG to a sampling domain. This is deliberately
 * not an article/comment compiler: absent producer authorities remain absent.
 */
export function createDistributionSamplingKernel(options)
{
    exactKeys(options, ['scenarioId', 'namespace', 'sourceIdentityDigest', 'roleSetDigest'], 'distribution_sampling_options');
    assertIdentifier(options.namespace, 'distribution_sampling_namespace');
    assertDigest(options.sourceIdentityDigest, 'sourceIdentityDigest');
    assertDigest(options.roleSetDigest, 'roleSetDigest');
    const scenario = distributionCatalog.scenarios.find((candidate) => candidate.id === options.scenarioId);
    if (!scenario)
    {
        throw new Error('distribution_sampling_scenario_unknown');
    }
    exactKeys(scenario.prng, ['algorithm', 'version'], 'distribution_sampling_prng');
    if (scenario.prng.algorithm !== distributionSamplingAlgorithm.algorithm
        || scenario.prng.version !== distributionSamplingAlgorithm.version)
    {
        throw new Error('distribution_sampling_prng_unsupported');
    }
    if (typeof scenario.fixedSeed !== 'string' || scenario.fixedSeed.length === 0)
    {
        throw new Error('distribution_sampling_seed_missing');
    }
    const body = {
        schema: samplingSchema,
        purpose: 'sampling-kernel-only',
        releaseEvidenceEligible: false,
        catalogDigest: distributionCatalogDigest(distributionCatalog),
        scenarioDigest: distributionScenarioDigest(scenario),
        scenarioId: scenario.id,
        seed: scenario.fixedSeed,
        prng: distributionSamplingAlgorithm,
        namespace: options.namespace,
        sourceIdentityDigest: options.sourceIdentityDigest,
        roleSetDigest: options.roleSetDigest
    };
    const metadata = deepFreeze({ ...body, contentDigest: canonicalDigest(body) });
    const kernel = Object.freeze({
        metadata,
        unitInterval: (stream, ordinal) => counterStream(metadata.contentDigest, stream)(ordinal)
    });
    kernelCapabilities.add(kernel);
    return kernel;
}

function validateSamplingRequest(kernel, options)
{
    if (!kernelCapabilities.has(kernel))
    {
        throw new Error('distribution_sampling_kernel_invalid');
    }
    exactKeys(options, ['stream', 'startOrdinal', 'count', 'shardSize'], 'distribution_sampling_request');
    assertIdentifier(options.stream, 'distribution_sampling_stream');
    assertOrdinal(options.startOrdinal);
    if (!Number.isSafeInteger(options.count) || options.count < 1 || options.count > samplingLimit
        || options.count - 1 > Number.MAX_SAFE_INTEGER - options.startOrdinal)
    {
        throw new Error('distribution_sampling_count_invalid');
    }
    if (!Number.isSafeInteger(options.shardSize) || options.shardSize < 1 || options.shardSize > maximumShardSize)
    {
        throw new Error('distribution_sampling_shard_size_invalid');
    }
}

/**
 * Yield bounded, content-addressed numerical sample shards. No role assignments,
 * database IDs, graph objects, compiler receipts or release eligibility are emitted.
 */
export function* createDistributionSamplingShards(kernel, options)
{
    validateSamplingRequest(kernel, options);
    const request = { ...options };
    const sample = counterStream(kernel.metadata.contentDigest, request.stream);
    let generated = 0;
    while (generated < request.count)
    {
        const length = Math.min(request.shardSize, request.count - generated);
        const startOrdinal = request.startOrdinal + generated;
        const samples = Array.from({ length }, (_, index) => sample(startOrdinal + index));
        const body = { schema: shardSchema, kernelDigest: kernel.metadata.contentDigest, stream: request.stream, startOrdinal, samples };
        yield deepFreeze({ ...body, contentDigest: canonicalDigest(body) });
        generated += length;
    }
}

/** Independently replay every counter and enforce contiguous shard coverage. */
export function verifyDistributionSamplingShards(kernel, options, shards)
{
    validateSamplingRequest(kernel, options);
    const request = { ...options };
    if (!shards || typeof shards[Symbol.iterator] !== 'function')
    {
        throw new Error('distribution_sampling_shards_invalid');
    }
    const sample = counterStream(kernel.metadata.contentDigest, request.stream);
    const shardDigests = createHash('sha256');
    let verified = 0;
    let shardCount = 0;
    for (const shard of shards)
    {
        exactKeys(shard, ['schema', 'kernelDigest', 'stream', 'startOrdinal', 'samples', 'contentDigest'], 'distribution_sampling_shard');
        const { contentDigest, ...body } = shard;
        assertDigest(contentDigest, 'shard.contentDigest');
        if (shard.schema !== shardSchema || shard.kernelDigest !== kernel.metadata.contentDigest
            || shard.stream !== request.stream || shard.startOrdinal !== request.startOrdinal + verified
            || !Array.isArray(shard.samples) || shard.samples.length !== Math.min(request.shardSize, request.count - verified)
            || shard.samples.length === 0)
        {
            throw new Error('distribution_sampling_shard_coverage_invalid');
        }
        if (canonicalDigest(body) !== contentDigest)
        {
            throw new Error('distribution_sampling_shard_digest_mismatch');
        }
        for (let index = 0; index < shard.samples.length; index += 1)
        {
            if (shard.samples[index] !== sample(shard.startOrdinal + index))
            {
                throw new Error('distribution_sampling_shard_replay_mismatch');
            }
        }
        verified += shard.samples.length;
        shardCount += 1;
        shardDigests.update(contentDigest.slice(7), 'ascii');
    }
    if (verified !== request.count)
    {
        throw new Error('distribution_sampling_shard_count_mismatch');
    }
    return deepFreeze({
        purpose: 'sampling-replay-only',
        releaseEvidenceEligible: false,
        kernelDigest: kernel.metadata.contentDigest,
        stream: request.stream,
        startOrdinal: request.startOrdinal,
        sampleCount: verified,
        shardCount,
        shardSequenceDigest: `sha256:${shardDigests.digest('hex')}`
    });
}

function validatePlanProjection(input, options, scenario)
{
    exactKeys(input, ['schema', 'purpose', 'ownerPlanDigest', 'scaleTier', 'namespace', 'articleCount',
        'articleOrdinalBase', 'variantAllocations', 'artifactBindings'], 'distribution_compiler_plan_input');
    requireCondition(Buffer.byteLength(JSON.stringify(input), 'utf8') <= 256 * 1024,
        'distribution_compiler_plan_input_bound');
    requireCondition(input.schema === 'fsusblog.distribution-article-plan-compiler-input.v1'
        && input.purpose === 'owner-plan-reference-projection-only', 'distribution_compiler_plan_schema');
    assertDigest(input.ownerPlanDigest, 'ownerPlanDigest');
    assertDigest(options.expectedInputDigest, 'expectedInputDigest');
    assertDigest(options.expectedOwnerPlanDigest, 'expectedOwnerPlanDigest');
    requireCondition(input.ownerPlanDigest === options.expectedOwnerPlanDigest
        && canonicalDigest(input) === options.expectedInputDigest, 'distribution_compiler_plan_identity_mismatch');
    assertIdentifier(input.namespace, 'distribution_compiler_namespace');
    assertOrdinal(input.articleOrdinalBase);
    requireCondition(input.scaleTier === scenario.counts.article.tier
        && input.articleCount === scenario.counts.article.count
        && Number.isSafeInteger(input.articleOrdinalBase + input.articleCount - 1), 'distribution_compiler_plan_scope');
    const variants = scenario.shapes.lifecycle.variantRefs.map((reference) => reference.id);
    requireCondition(Array.isArray(input.variantAllocations) && input.variantAllocations.length === variants.length,
        'distribution_compiler_lifecycle_coverage');
    const seen = new Set();
    let total = 0;
    for (const allocation of input.variantAllocations)
    {
        exactKeys(allocation, ['variant', 'count'], 'distribution_compiler_allocation');
        requireCondition(variants.includes(allocation.variant) && !seen.has(allocation.variant)
            && Number.isSafeInteger(allocation.count) && allocation.count >= 0,
        'distribution_compiler_lifecycle_allocation');
        seen.add(allocation.variant);
        total += allocation.count;
    }
    requireCondition(total === input.articleCount, 'distribution_compiler_lifecycle_count_mismatch');
    exactKeys(input.artifactBindings, ['temporal', 'distribution', 'content', 'media', 'taxonomy'],
        'distribution_compiler_artifact_bindings');
    // These are the existing ArticleScaleContractIds artifact schemas, not new
    // producer contracts or qualification for their unresolved dimensions.
    const groups = [
        [[input.artifactBindings.temporal], 'fsusblog.resolved-temporal-roles.v1'],
        [[input.artifactBindings.distribution], distributionCatalog.authorities.variants.schema],
        [input.artifactBindings.content, distributionCatalog.authorities.content.schema],
        [input.artifactBindings.media, distributionCatalog.authorities.media.schema],
        [input.artifactBindings.taxonomy, distributionCatalog.authorities.variants.schema]
    ];
    for (const [references, schema] of groups)
    {
        requireCondition(Array.isArray(references) && references.length > 0 && references.length <= maximumShardSize,
            'distribution_compiler_artifact_bound');
        for (const reference of references)
        {
            exactKeys(reference, ['schema', 'authorityId', 'shapeId', 'contentDigest'], 'distribution_compiler_artifact');
            requireCondition(reference.schema === schema, 'distribution_compiler_artifact_schema');
            requireCondition(typeof reference.authorityId === 'string' && reference.authorityId.length > 0
                && reference.authorityId.length <= 192,
            'distribution_compiler_artifact_authority');
            assertIdentifier(reference.shapeId, 'distribution_compiler_artifact_shape');
            assertDigest(reference.contentDigest, 'artifact.contentDigest');
        }
    }
}

function contentScriptPairs(input, scenario)
{
    const source = fs.readFileSync(new URL('../../config/testing/content-shape-catalog.json', import.meta.url), 'utf8');
    requireCondition(canonicalDigest({ source }) === distributionCatalog.authorities.content.sourceDigest,
        'distribution_compiler_content_source_drift');
    const catalog = JSON.parse(source);
    requireCondition(input.artifactBindings.content.length === scenario.shapes.content.weights.length,
        'distribution_compiler_plan_content_binding_missing');
    const seenScripts = new Set();
    const pairs = scenario.shapes.content.weights.map((weight) =>
    {
        const shape = catalog.shapes.find((candidate) => candidate.id === weight.id);
        requireCondition(shape?.eligibility === 'positive' && shape.contentDigest === weight.contentDigest
            && shape.applicableFields.includes('article.body') && shape.scriptClasses.length === 1,
        'distribution_compiler_body_shape_unavailable');
        const scriptId = shape.scriptClasses[0];
        const script = scenario.shapes.locale.weights.find((candidate) => candidate.id === scriptId);
        requireCondition(script && !seenScripts.has(scriptId) && Math.abs(script.weight - weight.weight) <= 1e-12,
            'distribution_compiler_content_locale_joint_unavailable');
        seenScripts.add(scriptId);
        const references = input.artifactBindings.content.filter((reference) => reference.shapeId === weight.id);
        requireCondition(references.length === 1 && references[0].schema === catalog.schema
            && references[0].contentDigest === weight.contentDigest, 'distribution_compiler_plan_content_binding_missing');
        return {
            weight: weight.weight,
            contentReference: references[0],
            scriptReference: { id: script.id, contentDigest: script.contentDigest },
            generationVersion: catalog.generationVersion
        };
    });
    requireCondition(seenScripts.size === scenario.shapes.locale.weights.length,
        'distribution_compiler_content_locale_joint_unavailable');
    return pairs;
}

function rankLifecycleOrdinals(kernel, input)
{
    const sample = counterStream(kernel.metadata.contentDigest, 'article.lifecycle-rank');
    const ranks = Array.from({ length: input.articleCount }, (_, offset) =>
        ({ offset, score: sample(input.articleOrdinalBase + offset) }));
    ranks.sort((left, right) => left.score - right.score || left.offset - right.offset);
    const variants = [...input.variantAllocations].sort((left, right) =>
        left.variant < right.variant ? -1 : left.variant > right.variant ? 1 : 0);
    const assignments = new Uint8Array(input.articleCount);
    let cursor = 0;
    for (let variantIndex = 0; variantIndex < variants.length; variantIndex += 1)
    {
        for (let assigned = 0; assigned < variants[variantIndex].count; assigned += 1)
        {
            assignments[ranks[cursor].offset] = variantIndex;
            cursor += 1;
        }
    }
    return { assignments, variants };
}

/**
 * The next stage of the sole scenario compiler: real owner-plan ordinal/lifecycle
 * references and catalog body/script requests. The typed projector independently
 * validates the original plan; JSON intake here remains structural reference-only.
 * Other dimensions and resolved payload hashes are absent, never fabricated.
 */
export function createDistributionArticleCompiler(input, options)
{
    exactKeys(options, ['scenarioId', 'sourceReference', 'expectedInputDigest', 'expectedOwnerPlanDigest'],
        'distribution_compiler_options');
    const scenario = distributionCatalog.scenarios.find((candidate) => candidate.id === options.scenarioId);
    requireCondition(scenario, 'distribution_compiler_scenario_unknown');
    validatePlanProjection(input, options, scenario);
    const plan = deepFreeze(structuredClone(input));
    // Existing source admission proves actual Git observation and current plan
    // source compatibility. It does not validate an opaque C# plan digest in JS.
    createDistributionArticleWriterRequest({
        scenarioId: scenario.id, namespace: plan.namespace, batchSize: 1000, sourceReference: options.sourceReference,
        articlePlanReference: {
            schema: distributionCatalog.authorities.article.schema, ownerSourceCommit: options.sourceReference.sourceCommit,
            contentDigest: plan.ownerPlanDigest, scaleTier: plan.scaleTier,
            articleCount: plan.articleCount, namespace: plan.namespace
        }
    });
    requireCondition(options.sourceReference.resolvedSourceReviewed, 'distribution_compiler_reviewed_owner_source_required');
    const pairs = contentScriptPairs(plan, scenario);
    const kernel = createDistributionSamplingKernel({
        scenarioId: scenario.id, namespace: plan.namespace,
        sourceIdentityDigest: options.sourceReference.contentDigest, roleSetDigest: options.expectedInputDigest
    });
    const lifecycle = rankLifecycleOrdinals(kernel, plan);
    const body = {
        schema: partialSchema, purpose: 'partial-article-body-lifecycle-assignment', status: 'partial',
        inputValidation: 'structural-reference-only-in-js-original-plan-validation-required',
        completeAssignmentPlan: false, executionEligible: false, releaseEvidenceEligible: false,
        catalogDigest: distributionCatalog.contentDigest, scenarioDigest: scenario.contentDigest, scenarioId: scenario.id,
        seed: scenario.fixedSeed, prng: distributionSamplingAlgorithm, kernelDigest: kernel.metadata.contentDigest,
        ownerSourceCommit: options.sourceReference.sourceCommit, ownerSourceDigest: options.sourceReference.contentDigest,
        ownerPlanDigest: plan.ownerPlanDigest, planInputDigest: options.expectedInputDigest,
        namespace: plan.namespace, scaleTier: plan.scaleTier,
        articleCount: plan.articleCount, articleOrdinalBase: plan.articleOrdinalBase, commentCount: null,
        assignedDimensions: ['lifecycle', 'content', 'locale'],
        unresolvedDimensions: ['hotness', 'taxonomy', 'thread', 'moderation', 'media', 'time', 'id', 'deleteGap'],
        lifecycleAlgorithm: 'sha256-counter-u53-rank-owner-quota-v1',
        contentLocaleAlgorithm: 'sha256-counter-u53-existing-joint-weight-v1',
        variantAllocations: plan.variantAllocations, artifactBindings: plan.artifactBindings
    };
    const compiler = Object.freeze({ metadata: deepFreeze({ ...body, contentDigest: canonicalDigest(body) }) });
    articleCompilers.set(compiler, {
        plan, scenario, pairs, kernel, lifecycle,
        selectContent: createWeightedIndexSampler(pairs.map((pair) => pair.weight)),
        sampleContent: counterStream(kernel.metadata.contentDigest, 'article.body-shape')
    });
    return compiler;
}

function articleAssignment(state, offset)
{
    const articleOrdinal = state.plan.articleOrdinalBase + offset;
    const pair = state.pairs[state.selectContent(state.sampleContent(articleOrdinal))];
    return {
        articleOrdinal,
        lifecycleVariant: state.lifecycle.variants[state.lifecycle.assignments[offset]].variant,
        contentReference: pair.contentReference,
        scriptReference: pair.scriptReference,
        bodyGenerationRequest: {
            shapeId: pair.contentReference.shapeId, fieldId: 'article.body', boundaryCaseId: null,
            generationVersion: pair.generationVersion, fixedSeed: `${state.scenario.fixedSeed}:${articleOrdinal}`
        }
    };
}

function articleShardRequest(compiler, options)
{
    const state = articleCompilers.get(compiler);
    requireCondition(state, 'distribution_compiler_capability_invalid');
    exactKeys(options, ['shardSize'], 'distribution_compiler_shard_options');
    requireCondition(Number.isSafeInteger(options.shardSize) && options.shardSize >= 1 && options.shardSize <= 1000,
        'distribution_compiler_shard_bound');
    return state;
}

/** Emit the entire original ordinal range in bounded, immutable reference shards. */
export function* createDistributionArticleAssignmentShards(compiler, options)
{
    const state = articleShardRequest(compiler, options);
    const shardSize = options.shardSize;
    for (let offset = 0; offset < state.plan.articleCount; offset += shardSize)
    {
        const assignments = Array.from({ length: Math.min(shardSize, state.plan.articleCount - offset) },
            (_, index) => articleAssignment(state, offset + index));
        const body = {
            schema: partialShardSchema, compilerDigest: compiler.metadata.contentDigest,
            startOrdinal: state.plan.articleOrdinalBase + offset, assignments
        };
        yield deepFreeze({ ...body, contentDigest: canonicalDigest(body) });
    }
}

/** Replay each assignment and exact quota; the result is a partial-source check only. */
export function verifyDistributionArticleAssignmentShards(compiler, options, shards)
{
    const state = articleShardRequest(compiler, options);
    requireCondition(shards && typeof shards[Symbol.iterator] === 'function', 'distribution_compiler_shards_invalid');
    const shardSize = options.shardSize;
    const counts = new Map(state.plan.variantAllocations.map((allocation) => [allocation.variant, 0]));
    const digest = createHash('sha256');
    // Recompute the deterministic quota map and PRNG stream, rather than trusting
    // the compiler's previously prepared ordinal-to-variant assignments.
    const replayState = {
        ...state, lifecycle: rankLifecycleOrdinals(state.kernel, state.plan),
        selectContent: createWeightedIndexSampler(state.pairs.map((pair) => pair.weight)),
        sampleContent: counterStream(state.kernel.metadata.contentDigest, 'article.body-shape')
    };
    let verified = 0;
    let shardCount = 0;
    for (const shard of shards)
    {
        exactKeys(shard, ['schema', 'compilerDigest', 'startOrdinal', 'assignments', 'contentDigest'],
            'distribution_compiler_shard');
        const { contentDigest, ...body } = shard;
        requireCondition(shard.schema === partialShardSchema && shard.compilerDigest === compiler.metadata.contentDigest
            && shard.startOrdinal === state.plan.articleOrdinalBase + verified && Array.isArray(shard.assignments)
            && shard.assignments.length === Math.min(shardSize, state.plan.articleCount - verified)
            && shard.assignments.length > 0, 'distribution_compiler_shard_coverage');
        requireCondition(canonicalDigest(body) === contentDigest, 'distribution_compiler_shard_digest');
        for (const assignment of shard.assignments)
        {
            requireCondition(canonicalDigest(assignment) === canonicalDigest(articleAssignment(replayState, verified)),
                'distribution_compiler_assignment_replay');
            counts.set(assignment.lifecycleVariant, counts.get(assignment.lifecycleVariant) + 1);
            digest.update(canonicalDigest(assignment).slice(7), 'ascii');
            verified += 1;
        }
        shardCount += 1;
    }
    requireCondition(verified === state.plan.articleCount, 'distribution_compiler_assignment_count');
    requireCondition(state.plan.variantAllocations.every((allocation) => counts.get(allocation.variant) === allocation.count),
        'distribution_compiler_lifecycle_count_mismatch');
    return deepFreeze({
        purpose: 'partial-article-assignment-replay-only', compilerDigest: compiler.metadata.contentDigest,
        articleCount: verified, commentCount: null, shardCount,
        assignmentDigest: `sha256:${digest.digest('hex')}`, completeAssignmentPlan: false,
        executionEligible: false, releaseEvidenceEligible: false
    });
}
