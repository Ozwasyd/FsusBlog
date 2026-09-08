import crypto from 'node:crypto';
import path from 'node:path';

export const browserContractReceiptSchema = 'fsusblog.browser-contract-receipt.v2';
export const productionBuildReceiptSchema = 'fsusblog.ci-production-build-receipt.v1';

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

export function validateBrowserContractReceipt(receipt, {
    expectedCommit = null,
    expectedFingerprint = null,
    expectedBuildReceiptDigest = null,
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
            if (!isDigest(plan?.rendering?.[field])) errors.push(`Browser Contract ${field} is invalid`);
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
    if (JSON.stringify(scenarioIds) !== JSON.stringify(receipt?.scenarios?.map((scenario) => scenario.id) ?? []))
    {
        errors.push('Browser Contract scenario IDs do not match scenario records');
    }
    if (!Number.isInteger(receipt?.topology?.contextCount) || receipt.topology.contextCount < 0)
    {
        errors.push('Browser Contract context count is invalid');
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
