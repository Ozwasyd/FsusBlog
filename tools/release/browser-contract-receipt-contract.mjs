import crypto from 'node:crypto';
import path from 'node:path';

// The independent reader requires a statically closed, I/O-free import graph.

const { verifyProducerTemporalArtifacts } = await import(new URL('../test/temporal-context-contract.mjs', import.meta.url));

export const browserContractReceiptSchema = 'fsusblog.browser-contract-receipt.v2';
export const productionBuildReceiptSchema = 'fsusblog.ci-production-build-receipt.v1';

export function productionBuildBinding(receipt, receiptPath)
{
    if (receipt?.schema !== productionBuildReceiptSchema)
    {
        throw new Error(`unexpected production build receipt schema: ${receipt?.schema ?? 'missing'}`);
    }
    if (receipt.status !== 'complete')
    {
        throw new Error(`production build receipt is not complete: ${receipt.status}`);
    }
    if (receipt.contentDigest !== digestValue(receipt))
    {
        throw new Error('production build receipt content digest mismatch');
    }
    const sourceErrors = sourceStateErrors(receipt.sourceState, 'production build receipt sourceState');
    if (sourceErrors.length > 0)
    {
        throw new Error(sourceErrors.join('; '));
    }
    return {
        schema: productionBuildReceiptSchema,
        receipt: String(receiptPath).replaceAll(path.sep, '/'),
        receiptContentDigest: receipt.contentDigest,
        sourceState: receipt.sourceState,
        profile: receipt.build?.profile ?? null,
        producer: receipt.producer ?? null
    };
}

export function canonicalize(value)
{
    if (Array.isArray(value))
    {
        return value.map(canonicalize);
    }
    if (!value || typeof value !== 'object')
    {
        return value;
    }
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

export function digestValue(value)
{
    const content = { ...value };
    delete content.contentDigest;
    return `sha256:${crypto.createHash('sha256').update(JSON.stringify(canonicalize(content))).digest('hex')}`;
}

export function sortedUnique(values)
{
    return [...new Set((values ?? [])
        .filter((value) => value !== null && value !== undefined)
        .map((value) => String(value).trim())
        .filter(Boolean))].sort();
}

export function normalizeFingerprint(value)
{
    return String(value ?? '').trim().replace(/^sha256:/u, '');
}

export function isDigest(value)
{
    return /^sha256:[a-f0-9]{64}$/u.test(String(value ?? ''));
}

export function validatePublicPreviewBinding(binding, sourceCommit, requireSuccess)
{
    const errors = [];
    if (!binding || typeof binding !== 'object' || Array.isArray(binding))
    {
        return requireSuccess ? ['Browser Contract public-preview evidence is required'] : errors;
    }
    if (binding.schema !== 'fsusblog.public-preview-screenshot-verification.v1')
    {
        errors.push(`Browser Contract public-preview schema is invalid: ${binding.schema ?? 'missing'}`);
    }
    if (binding.status !== 'ok')
    {
        errors.push(`Browser Contract public-preview status must be ok, got ${binding.status ?? 'missing'}`);
    }
    if (binding.sourceCommit !== sourceCommit)
    {
        errors.push('Browser Contract public-preview source commit mismatch');
    }
    if (binding.manifestSchema !== 'fsusblog.public-preview-screenshot-manifest.v1')
    {
        errors.push('Browser Contract public-preview manifest schema is invalid');
    }
    if (!/^\d{14}-[a-f0-9]{12}$/u.test(String(binding.releaseId ?? '')))
    {
        errors.push('Browser Contract public-preview releaseId is invalid');
    }
    for (const field of ['visualInputDigest', 'commandVersion'])
    {
        if (!/^[a-f0-9]{64}$/u.test(String(binding[field] ?? '')))
        {
            errors.push(`Browser Contract public-preview ${field} must be SHA-256`);
        }
    }
    for (const field of ['runtimeAudit', 'layoutAudit', 'sanitizationCheck'])
    {
        if (binding[field] !== true)
        {
            errors.push(`Browser Contract public-preview ${field} must be true`);
        }
    }
    const images = binding.images && typeof binding.images === 'object' && !Array.isArray(binding.images)
        ? binding.images
        : {};
    if (Object.keys(images).length !== 9 || Object.values(images).some((value) => !/^[a-f0-9]{64}$/u.test(String(value))))
    {
        errors.push('Browser Contract public-preview must bind exactly nine image SHA-256 values');
    }
    if (binding.captureContextCount !== 9)
    {
        errors.push('Browser Contract public-preview capture context count must be 9');
    }
    if (!Array.isArray(binding.differences) || binding.differences.length !== 0)
    {
        errors.push('Browser Contract public-preview differences must be empty');
    }
    if (binding.evidencePath !== '.tmp/release-evidence/public-preview-screenshots.json')
    {
        errors.push('Browser Contract public-preview evidence path is invalid');
    }
    if (!isDigest(binding.evidenceFileDigest))
    {
        errors.push('Browser Contract public-preview evidence file digest is invalid');
    }
    return errors;
}

export function validatePublicPreviewEvidenceBinding(binding, evidence, {
    expectedCommit = null,
    evidenceFileDigest = null
} = {})
{
    const errors = validatePublicPreviewBinding(binding, expectedCommit ?? evidence?.sourceCommit, true);
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence))
    {
        errors.push('public-preview screenshot evidence document is required');
        return errors;
    }
    for (const [key, value] of Object.entries(evidence))
    {
        if (JSON.stringify(binding?.[key]) !== JSON.stringify(value))
        {
            errors.push(`public-preview screenshot evidence ${key} does not match Browser Contract`);
        }
    }
    if (evidenceFileDigest && binding?.evidenceFileDigest !== evidenceFileDigest)
    {
        errors.push('public-preview screenshot evidence file digest does not match Browser Contract');
    }
    return errors;
}

export function sourceStateErrors(sourceState, label)
{
    const errors = [];
    if (!/^[a-f0-9]{40}$/u.test(String(sourceState?.commit ?? '')))
    {
        errors.push(`${label}.commit must be a full lowercase commit SHA`);
    }
    if (!/^[a-f0-9]{64}$/u.test(normalizeFingerprint(sourceState?.worktreeFingerprint)))
    {
        errors.push(`${label}.worktreeFingerprint must be SHA-256`);
    }
    return errors;
}

export function sameSourceState(left, right)
{
    return left?.commit === right?.commit
    && normalizeFingerprint(left?.worktreeFingerprint) === normalizeFingerprint(right?.worktreeFingerprint);
}

export function sortedUniqueErrors(values, label, { allowEmpty = false } = {})
{
    const errors = [];
    if (!Array.isArray(values) || (!allowEmpty && values.length === 0))
    {
        errors.push(`${label} must be ${allowEmpty ? 'an' : 'a non-empty'} array`);
        return errors;
    }
    if (values.some((value) => typeof value !== 'string' || !value.trim()))
    {
        errors.push(`${label} must contain non-empty strings`);
    }
    if (JSON.stringify(values) !== JSON.stringify(sortedUnique(values)))
    {
        errors.push(`${label} must be sorted and unique`);
    }
    return errors;
}

/** Project actual fixture leases; the required roster comes only from the admitted matrix. */
export function projectBrowserContractLocaleTopology({ matrix, bindings, expectedOwner })
{
    const reject = (message) =>
    {
        throw new Error(`Browser Contract locale topology ${message}`);
    };
    const requiredSceneIds = matrix?.scenes?.map((scene) => scene.id);
    if (typeof matrix?.contentDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(matrix.contentDigest)
        || !Array.isArray(requiredSceneIds) || requiredSceneIds.length === 0
        || requiredSceneIds.some((id) => typeof id !== 'string' || !id)
        || new Set(requiredSceneIds).size !== requiredSceneIds.length
        || sourceStateErrors(expectedOwner?.sourceState, 'locale owner source').length > 0
        || !isDigest(expectedOwner?.buildDigest) || !expectedOwner?.preparation?.id
        || !expectedOwner?.identity?.namespace || !path.isAbsolute(expectedOwner?.fixtureRoot ?? '')
        || !sameSourceState(expectedOwner?.sourceState, {
            commit: matrix?.identity?.sourceCommit, worktreeFingerprint: matrix?.identity?.worktreeFingerprint
        }))
    {
        reject('matrix or current owner identity is invalid');
    }
    const ownerFields = ['identity', 'sourceState', 'buildDigest', 'preparation', 'fixtureRoot', 'resources'];
    const sameOwner = (owner) => ownerFields.every((field) => JSON.stringify(canonicalize(owner?.[field]))
        === JSON.stringify(canonicalize(expectedOwner?.[field])));
    if (bindings && (!sameOwner(bindings.owner) || !Array.isArray(bindings.leases) || !Array.isArray(bindings.blocked)
        || !/^[a-f0-9]{64}$/u.test(bindings.contentDigest ?? '')))
    {
        reject('fixture binding belongs to another owner');
    }
    const contexts = (bindings?.leases ?? []).map((lease) =>
    {
        if (!lease || !sameOwner(lease.owner) || lease.authority?.matrixDigest !== matrix.contentDigest
            || !requiredSceneIds.includes(lease.sceneId)
            || typeof lease.contextId !== 'string' || !lease.contextId
            || typeof lease.leaseId !== 'string' || !lease.leaseId
            || ![0, 1].includes(lease.entered) || ![0, 1].includes(lease.ended) || lease.ended > lease.entered)
        {
            reject('scene context has invalid identity or counters');
        }
        return {
            sceneId: lease.sceneId, contextId: lease.contextId, leaseId: lease.leaseId,
            status: lease.status, entered: lease.entered, ended: lease.ended,
            firstFailureRetained: lease.firstFailure !== null && lease.firstFailure !== undefined
        };
    });
    for (const field of ['sceneId', 'contextId', 'leaseId'])
    {
        if (new Set(contexts.map((context) => context[field])).size !== contexts.length)
        {
            reject(`duplicate ${field}`);
        }
    }
    const blockedSceneIds = (bindings?.blocked ?? []).map((blocked) => blocked?.sceneId);
    if (new Set(blockedSceneIds).size !== blockedSceneIds.length
        || blockedSceneIds.some((id) => !requiredSceneIds.includes(id) || contexts.some((context) => context.sceneId === id)))
    {
        reject('blocked scene roster is invalid');
    }
    const topology = {
        schema: 'fsusblog.browser-contract-locale-topology.v1',
        matrixDigest: `sha256:${matrix.contentDigest}`,
        requiredSceneIds,
        bindingDigest: bindings ? `sha256:${bindings.contentDigest}` : null,
        contextCount: contexts.reduce((total, context) => total + context.entered, 0),
        endedContextCount: contexts.reduce((total, context) => total + context.ended, 0),
        blockedSceneIds,
        contexts
    };
    if (validateBrowserContractLocaleTopology(topology).length > 0)
    {
        reject('fixture observation is invalid');
    }
    return topology;
}

/** Separate exact locale accounting never changes the original product-context equation. */
export function validateBrowserContractLocaleTopology(topology, { requireSuccess = false } = {})
{
    const errors = [];
    const required = topology?.requiredSceneIds;
    const contexts = topology?.contexts;
    const topologyFields = ['schema', 'matrixDigest', 'requiredSceneIds', 'bindingDigest', 'contextCount',
        'endedContextCount', 'blockedSceneIds', 'contexts'];
    const contextFields = ['sceneId', 'contextId', 'leaseId', 'status', 'entered', 'ended', 'firstFailureRetained'];
    const statusCounts = { prepared: [0, 0], reserved: [0, 0], entered: [1, 0], finished: [1, 1],
        abandoned: [0, 0], 'creation-failed': [0, 0] };
    if (topology?.schema !== 'fsusblog.browser-contract-locale-topology.v1' || !isDigest(topology?.matrixDigest)
        || !Array.isArray(required) || required.length === 0 || new Set(required).size !== required.length
        || required.some((id) => typeof id !== 'string' || !id) || !Array.isArray(contexts)
        || !Array.isArray(topology.blockedSceneIds)
        || Object.keys(topology).length !== topologyFields.length
        || Object.keys(topology).some((field) => !topologyFields.includes(field))
        || contexts.some((context) => !context || typeof context !== 'object' || Array.isArray(context)
            || Object.keys(context).length !== contextFields.length
            || Object.keys(context).some((field) => !contextFields.includes(field))
            || typeof context.status !== 'string'
            || ![0, 1].includes(context.entered) || ![0, 1].includes(context.ended)))
    {
        return ['Browser Contract locale topology is invalid'];
    }
    for (const field of ['sceneId', 'contextId', 'leaseId'])
    {
        if (contexts.some((context) => typeof context[field] !== 'string' || !context[field])
            || new Set(contexts.map((context) => context[field])).size !== contexts.length)
        {
            errors.push(`Browser Contract locale topology ${field} is invalid or duplicate`);
        }
    }
    if (!Array.isArray(topology.blockedSceneIds)
        || new Set(topology.blockedSceneIds).size !== topology.blockedSceneIds.length
        || topology.blockedSceneIds.some((id) => !required.includes(id) || contexts.some((context) => context.sceneId === id))
        || contexts.some((context) => !required.includes(context.sceneId)
            || ![0, 1].includes(context.entered) || ![0, 1].includes(context.ended) || context.ended > context.entered
            || !Object.hasOwn(statusCounts, context.status)
            || context.entered !== statusCounts[context.status]?.[0] || context.ended !== statusCounts[context.status]?.[1]
            || typeof context.firstFailureRetained !== 'boolean'))
    {
        errors.push('Browser Contract locale topology observations are invalid');
    }
    if (topology.contextCount !== contexts.reduce((total, context) => total + context.entered, 0)
        || topology.endedContextCount !== contexts.reduce((total, context) => total + context.ended, 0))
    {
        errors.push('Browser Contract locale topology counters do not match actual leases');
    }
    if ((topology.bindingDigest !== null && !isDigest(topology.bindingDigest))
        || ((contexts.length > 0 || topology.blockedSceneIds.length > 0) && !isDigest(topology.bindingDigest)))
    {
        errors.push('Browser Contract locale topology fixture binding digest is missing');
    }
    if (requireSuccess && (contexts.length !== required.length || topology.blockedSceneIds.length > 0
        || contexts.some((context) => context.status !== 'finished' || context.entered !== 1
            || context.ended !== 1 || context.firstFailureRetained)))
    {
        errors.push('Browser Contract locale success requires every required scene to enter and finish exactly once without failure');
    }
    return errors;
}

function validateBrowserTemporalBinding(receipt, temporalAuthority)
{
    const binding = receipt?.temporalBinding;
    if (binding == null)
    {
        return receipt?.status === 'success'
            ? ['Browser Contract success requires an actual temporal binding']
            : [];
    }
    try
    {
        const { context } = verifyProducerTemporalArtifacts({
            producerId: 'comment-moderation',
            binding
        }, temporalAuthority);
        const errors = [];
        if (binding.actual.observations.observationBoundary !== 'browser-runtime'
            || binding.actual.observations.monotonicClockSource !== 'performance-now')
        {
            errors.push('Browser Contract temporal binding requires actual browser-runtime observations and a live performance clock');
        }
        for (const source of [
            { commit: context.sourceCommit, worktreeFingerprint: context.sourceFingerprint },
            { commit: binding.plan.source.commit, worktreeFingerprint: binding.plan.source.fingerprint }
        ])
        {
            if (!sameSourceState(source, receipt.sourceState))
            {
                errors.push('Browser Contract temporal source identity mismatch');
            }
        }
        if (context.schedulerRunId !== receipt.runIdentity?.runId
            || binding.plan.run.schedulerRunId !== receipt.runIdentity?.runId)
        {
            errors.push('Browser Contract temporal runId mismatch');
        }
        if (context.uiLocale !== receipt.playwright?.browserIdentity?.plan?.rendering?.locale)
        {
            errors.push('Browser Contract temporal locale does not match the browser rendering plan');
        }
        return errors;
    }
    catch (error)
    {
        return [`Browser Contract temporal binding is invalid: ${error.message}`];
    }
}

export function validateBrowserContractReceipt(receipt, {
    expectedCommit = null,
    expectedFingerprint = null,
    expectedBuildReceiptDigest = null,
    temporalAuthority = null,
    requireSuccess = true
} = {})
{
    const errors = [];
    if (receipt?.schema !== browserContractReceiptSchema)
    {
        errors.push(`unexpected Browser Contract receipt schema: ${receipt?.schema ?? 'missing'}`);
    }
    if (!['success', 'failure'].includes(receipt?.status))
    {
        errors.push(`Browser Contract receipt status is invalid: ${receipt?.status}`);
    }
    if (requireSuccess && receipt?.status !== 'success')
    {
        errors.push(`Browser Contract receipt status must be success, got ${receipt?.status}`);
    }
    if (receipt?.evidenceClass !== 'browser-contract' || receipt?.affectsCorrectness !== true)
    {
        errors.push('Browser Contract receipt classification is invalid');
    }
    errors.push(...sourceStateErrors(receipt?.sourceState, 'Browser Contract sourceState'));
    if (receipt?.contentDigest !== digestValue(receipt ?? {}))
    {
        errors.push('Browser Contract receipt content digest mismatch');
    }
    if (!sameSourceState(receipt?.sourceState, receipt?.buildBinding?.sourceState))
    {
        errors.push('Browser Contract source/build identity mismatch');
    }
    if (receipt?.buildBinding?.receiptContentDigest !== receipt?.build?.receiptContentDigest)
    {
        errors.push('Browser Contract build binding digest mismatch');
    }
    if (!isDigest(receipt?.buildBinding?.receiptContentDigest))
    {
        errors.push('Browser Contract build receipt digest is invalid');
    }
    const startupFailure = receipt?.status === 'failure'
    && receipt?.topology?.browserLaunchCount === 0
    && receipt?.topology?.maxConcurrentBrowserRoots === 0;
    errors.push(...validateBrowserTemporalBinding(receipt, temporalAuthority));
    if (!startupFailure && (typeof receipt?.playwright?.chromiumRevision !== 'string' || !receipt.playwright.chromiumRevision.trim()))
    {
        errors.push('Browser Contract Chromium revision is missing');
    }
    if (!startupFailure)
    {
        const plan = receipt?.playwright?.browserIdentity?.plan;
        const actual = receipt?.playwright?.browserIdentity?.actual;
        if (plan?.schema !== 'fsusblog.playwright-browser-identity.v1'
            || plan.executionClass !== 'correctness'
            || plan.evidenceClass !== 'browser-contract'
            || plan.qualificationEligible !== true
            || plan.managedExecutable !== true)
        {
            errors.push('Browser Contract planned browser identity is missing or non-qualifying');
        }
        if (actual?.schema !== 'fsusblog.playwright-browser-actual.v1'
            || actual.executionClass !== 'correctness'
            || actual.evidenceClass !== 'browser-contract'
            || actual.qualificationEligible !== true
            || actual.managedExecutable !== true)
        {
            errors.push('Browser Contract actual browser identity is missing or non-qualifying');
        }
        for (const field of ['browserName', 'browserVersion', 'revision', 'executablePath', 'executableSha256', 'playwright', 'launchOptions', 'rendering'])
        {
            if (JSON.stringify(canonicalize(plan?.[field])) !== JSON.stringify(canonicalize(actual?.[field])))
            {
                errors.push(`Browser Contract planned/actual browser ${field} mismatch`);
            }
        }
        if (!path.isAbsolute(String(plan?.executablePath ?? ''))
            || !isDigest(plan?.executableSha256)
            || actual?.planDigest !== plan?.contentDigest)
        {
            errors.push('Browser Contract executable or plan digest binding is invalid');
        }
        if (plan?.contentDigest !== digestValue(plan) || actual?.contentDigest !== digestValue(actual))
        {
            errors.push('Browser Contract browser identity content digest is invalid');
        }
        for (const field of ['fontSetDigest', 'localeDataDigest'])
        {
            if (!isDigest(plan?.rendering?.[field]))
            {
                errors.push(`Browser Contract ${field} is invalid`);
            }
        }
        for (const field of ['locale', 'renderingMode', 'colorScheme', 'gpuMode'])
        {
            if (typeof plan?.rendering?.[field] !== 'string' || !plan.rendering[field].trim())
            {
                errors.push(`Browser Contract rendering ${field} is missing`);
            }
        }
        if (!(Number.isFinite(plan?.rendering?.deviceScaleFactor) && plan.rendering.deviceScaleFactor > 0))
        {
            errors.push('Browser Contract rendering deviceScaleFactor is invalid');
        }
        const observation = actual?.renderingObservation;
        if (receipt.status === 'success'
            && (observation?.locale !== plan?.rendering?.locale
                || observation?.deviceScaleFactor !== plan?.rendering?.deviceScaleFactor
                || observation?.colorScheme !== plan?.rendering?.colorScheme
                || typeof observation?.renderer !== 'string'
                || !observation.renderer.trim()))
        {
            errors.push('Browser Contract rendering observation does not match the plan');
        }
        if (receipt.status === 'success'
            && plan?.browserName === 'chromium'
            && plan?.rendering?.gpuMode === 'software'
            && !/(?:swiftshader|llvmpipe|software|webgl-unavailable)/iu.test(String(observation?.renderer ?? '')))
        {
            errors.push('Browser Contract Chromium software renderer observation is invalid');
        }
    }
    if (![0, 1].includes(receipt?.topology?.browserLaunchCount) || (!startupFailure && receipt?.topology?.browserLaunchCount !== 1))
    {
        errors.push('Browser Contract browser launch count must be 1 after startup');
    }
    if (![0, 1].includes(receipt?.topology?.maxConcurrentBrowserRoots) || (!startupFailure && receipt?.topology?.maxConcurrentBrowserRoots !== 1))
    {
        errors.push('Browser Contract max concurrent browser roots must be 1 after startup');
    }
    if (receipt?.topology?.retries !== 0)
    {
        errors.push('Browser Contract retries must be 0');
    }
    const scenarioIds = receipt?.scenarioIds;
    if (!Array.isArray(scenarioIds) || scenarioIds.length === 0
    || scenarioIds.some((value) => typeof value !== 'string' || !value.trim())
    || new Set(scenarioIds).size !== scenarioIds.length)
    {
        errors.push('Browser Contract scenario IDs must be unique non-empty strings');
    }
    const scenarioRecordIds = Array.isArray(receipt?.scenarios)
        ? receipt.scenarios.map((scenario) => scenario.id)
        : [];
    if (JSON.stringify(scenarioIds) !== JSON.stringify(scenarioRecordIds))
    {
        errors.push('Browser Contract scenario IDs do not match scenario records');
    }
    if (!Number.isInteger(receipt?.topology?.contextCount) || receipt.topology.contextCount < 0)
    {
        errors.push('Browser Contract context count is invalid');
    }
    if (receipt?.topology?.publicShellLocale !== undefined)
    {
        errors.push(...validateBrowserContractLocaleTopology(receipt.topology.publicShellLocale, {
            requireSuccess: receipt.status === 'success'
        }));
    }
    if (typeof receipt?.fixtureNamespace !== 'string' || !receipt.fixtureNamespace.trim())
    {
        errors.push('Browser Contract fixture namespace is missing');
    }
    if (!Number.isFinite(receipt?.wallClockMs) || receipt.wallClockMs < 0)
    {
        errors.push('Browser Contract wall clock is invalid');
    }
    for (const key of ['totalIssueCount', 'expectedIssueCount', 'unexpectedIssueCount', 'consoleIssueCount', 'pageErrorCount', 'requestFailureCount', 'responseErrorCount'])
    {
        if (!Number.isInteger(receipt?.diagnostics?.[key]) || receipt.diagnostics[key] < 0)
        {
            errors.push(`Browser Contract diagnostics.${key} is invalid`);
        }
    }
    const allowedFailureClasses = ['clean', 'product', 'contract', 'infra', 'infra-failure'];
    if (!allowedFailureClasses.includes(receipt?.failureClass))
    {
        errors.push(`Browser Contract failureClass is invalid: ${receipt?.failureClass}`);
    }
    const scenarios = Array.isArray(receipt?.scenarios) ? receipt.scenarios : [];
    for (const [index, scenario] of scenarios.entries())
    {
        const label = `Browser Contract scenarios[${index}]`;
        if (!['pending', 'success', 'failure'].includes(scenario?.status))
        {
            errors.push(`${label}.status is invalid`);
        }
        if (scenario?.status === 'pending' && scenario?.classification !== null)
        {
            errors.push(`${label} pending classification must be null`);
        }
        if (scenario?.status === 'success' && scenario?.classification !== 'clean')
        {
            errors.push(`${label} success classification must be clean`);
        }
        if (scenario?.status === 'failure' && !allowedFailureClasses.slice(1).includes(scenario?.classification))
        {
            errors.push(`${label} failure classification is invalid`);
        }
    }
    if (receipt?.status === 'success')
    {
        if (receipt?.failureClass !== 'clean')
        {
            errors.push(`Browser Contract success failureClass must be clean, got ${receipt?.failureClass}`);
        }
        if (scenarios.some((scenario) => scenario?.status !== 'success' || scenario?.classification !== 'clean'))
        {
            errors.push('Browser Contract success requires every scenario to be success/clean');
        }
        if (receipt?.topology?.contextCount !== scenarioIds?.length)
        {
            errors.push('Browser Contract success context count must match scenario count');
        }
        if (receipt?.diagnostics?.unexpectedIssueCount !== 0)
        {
            errors.push('Browser Contract success cannot contain unexpected diagnostics');
        }
        errors.push(...validatePublicPreviewBinding(receipt?.publicPreview, receipt?.sourceState?.commit, true));
    }
    if (receipt?.status === 'failure')
    {
        if (!allowedFailureClasses.slice(1).includes(receipt?.failureClass))
        {
            errors.push('Browser Contract failure requires a product/contract/infra failureClass');
        }
        if (!scenarios.some((scenario) => scenario?.status === 'failure') && (!receipt?.error || typeof receipt.error !== 'object'))
        {
            errors.push('Browser Contract failure requires a failed scenario or top-level error');
        }
        if (receipt?.error?.failureClass && receipt.error.failureClass !== receipt?.failureClass)
        {
            errors.push('Browser Contract top-level error failureClass must match receipt failureClass');
        }
    }
    if (receipt?.finalization)
    {
        if (receipt.finalization.state !== 'complete')
        {
            errors.push('Browser Contract finalization state must be complete');
        }
        if (receipt.finalization.primary?.status === 'failure' && receipt?.status !== 'failure')
        {
            errors.push('Browser Contract primary failure must determine a failed receipt');
        }
        if (receipt.finalization.primary?.status === 'failure'
      && receipt.finalization.primary?.classification !== receipt?.failureClass)
        {
            errors.push('Browser Contract primary failure classification must match the receipt');
        }
        if (receipt.finalization.cleanup?.status === 'failure' && receipt?.status !== 'failure')
        {
            errors.push('Browser Contract cleanup failure must determine a failed receipt');
        }
        if (!Number.isInteger(receipt.finalization.persistence?.attemptCount)
      || receipt.finalization.persistence.attemptCount < 1)
        {
            errors.push('Browser Contract final receipt persistence attempt count is invalid');
        }
    }
    errors.push(...sortedUniqueErrors(receipt?.artifacts, 'Browser Contract artifacts', { allowEmpty: true }));
    if (expectedCommit && receipt?.sourceState?.commit !== expectedCommit)
    {
        errors.push('Browser Contract commit does not match release commit');
    }
    if (expectedFingerprint && normalizeFingerprint(receipt?.sourceState?.worktreeFingerprint) !== normalizeFingerprint(expectedFingerprint))
    {
        errors.push('Browser Contract source fingerprint mismatch');
    }
    if (expectedBuildReceiptDigest && receipt?.buildBinding?.receiptContentDigest !== expectedBuildReceiptDigest)
    {
        errors.push('Browser Contract build receipt digest mismatch');
    }
    return errors;
}


export const requiredEvidenceVerifier = Object.freeze({
    version: 1,
    successStatuses: Object.freeze(['success']),
    correctnessClasses: Object.freeze(['browser-contract']),
    describe: async (receipt) => (await import('./required-evidence-owner-contract.mjs')).describeOwnerReceipt(receipt, {
        identity: { namespace: 'fixtureNamespace', runId: 'runIdentity.runId',
            sourceCommit: 'sourceState.commit', worktreeFingerprint: 'sourceState.worktreeFingerprint' },
        status: 'status', contentDigest: 'contentDigest'
    }),
    async verify({ receipt, context, domainInputs })
    {
        const { verifiedOwnerResult, requireOwnerChecks } = await import('./required-evidence-owner-contract.mjs');
        requireOwnerChecks(validateBrowserContractReceipt(receipt, {
            expectedCommit: context.sourceCommit, expectedFingerprint: context.worktreeFingerprint,
            expectedBuildReceiptDigest: domainInputs?.buildReceiptDigest, requireSuccess: true
        }));
        if (!domainInputs?.buildReceiptDigest)
        {
            throw new Error('explicit build receipt digest is required');
        }
        return verifiedOwnerResult({ schema: receipt.schema, contentDigest: receipt.contentDigest });
    }
});
