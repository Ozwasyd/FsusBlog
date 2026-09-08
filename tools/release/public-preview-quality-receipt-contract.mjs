import crypto from 'node:crypto';
import path from 'node:path';

export const publicPreviewQualityReportSchema = 'fsusblog.public-preview-quality-report.v1';
export const publicPreviewQualityMatrixSchema = 'fsusblog.public-preview-quality-matrix.v1';

const allowedStatuses = new Set(['pass', 'fail', 'needs-design-review']);

export function stableJson(value)
{
    return `${JSON.stringify(value, null, 4)}\n`;
}

export function finiteNumber(value, fallback = 0)
{
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

export function qualitySidecarFile(directory, screenshotFile)
{
    return path.join(directory, `${screenshotFile}.quality.json`);
}

export function validatePublicPreviewQualityReport(report, expected, policy)
{
    const errors = [];
    const expectedSurfaceRole = String(expected?.surfaceRole ?? (expected?.scope === 'admin' ? 'task' : 'public'));
    const expectedViewport = {
        width: finiteNumber(expected?.viewport?.width ?? expected?.viewportWidth ?? 0),
        height: finiteNumber(expected?.viewport?.height ?? expected?.viewportHeight ?? 0)
    };
    if (report?.schema !== publicPreviewQualityReportSchema) errors.push('schema');
    for (const field of ['id', 'route', 'theme', 'locale'])
    {
        if (report?.[field] !== expected?.[field]) errors.push(`${field} mismatch`);
    }
    if (report?.surfaceRole !== expectedSurfaceRole) errors.push('surfaceRole mismatch');
    if (Number(report?.zoom) !== Number(expected?.zoom)) errors.push('zoom mismatch');
    if (Number(report?.viewport?.width) !== expectedViewport.width
        || Number(report?.viewport?.height) !== expectedViewport.height) errors.push('viewport mismatch');
    if (!allowedStatuses.has(report?.status)) errors.push('status');
    if (report?.reviewer?.classification !== report?.status) errors.push('reviewer classification');
    if (!Array.isArray(report?.reviewer?.reasons)) errors.push('reviewer reasons');
    if (!Array.isArray(report?.linkedIssues)) errors.push('linkedIssues');
    for (const check of ['overflow', 'overlaps', 'clippedText', 'hitTargets', 'focusClipping', 'localeCoherence', 'headerStability', 'primaryTask'])
    {
        if (!['pass', 'fail'].includes(report?.machine?.[check]?.status)) errors.push(`machine.${check}`);
    }
    if (policy?.reviewerStatuses && !policy.reviewerStatuses.includes(report?.status)) errors.push('policy status');
    return errors;
}

export function createPublicPreviewQualityMatrix(reports, policyDigest = null)
{
    const sorted = [...reports].sort((left, right) => left.id.localeCompare(right.id));
    return {
        schema: publicPreviewQualityMatrixSchema,
        status: sorted.some((report) => report.status === 'fail')
            ? 'fail'
            : sorted.some((report) => report.status === 'needs-design-review')
                ? 'needs-design-review'
                : 'pass',
        policyDigest,
        scenarioCount: sorted.length,
        reports: sorted
    };
}

export function validatePublicPreviewQualityMatrix(document, scenarios, policy)
{
    const errors = [];
    if (document?.schema !== publicPreviewQualityMatrixSchema) errors.push('matrix schema');
    if (!allowedStatuses.has(document?.status)) errors.push('matrix status');
    if (!Array.isArray(document?.reports)) return [...errors, 'matrix reports'];
    const expectedById = new Map((scenarios ?? []).map((scenario) => [scenario.id, scenario]));
    const actualIds = document.reports.map((report) => report.id);
    if (new Set(actualIds).size !== actualIds.length) errors.push('duplicate matrix report id');
    if (actualIds.length !== expectedById.size) errors.push('matrix scenario count');
    for (const report of document.reports)
    {
        const expected = expectedById.get(report.id);
        if (!expected) errors.push(`unknown matrix report ${report.id}`);
        else errors.push(...validatePublicPreviewQualityReport(report, expected, policy).map((error) => `${report.id}: ${error}`));
    }
    return errors;
}


export const publicPreviewQualityManifestSchema = 'fsusblog.public-preview-quality-manifest.v1';

export function projectPublicPreviewQualityRegistry(registry, policy, scenarioDocuments) {
  if (registry.schema !== 'fsusblog.public-preview-screenshot-registry.v1') {
    throw new Error(`unexpected screenshot registry schema: ${registry.schema ?? 'missing'}`)
  }
  if (policy.schema !== 'fsusblog.public-preview-quality-policy.v1') {
    throw new Error(`unexpected public-preview quality policy schema: ${policy.schema ?? 'missing'}`)
  }
  if (scenarioDocuments.length === 0 || scenarioDocuments.some((document) => document.schema !== 'fsusblog.public-preview-quality-scenarios.v1')) {
    throw new Error('unexpected public-preview quality scenarios schema')
  }
  const profiles = policy.screenshotProfiles && typeof policy.screenshotProfiles === 'object'
    ? policy.screenshotProfiles
    : {}
  const screenshots = registry.screenshots.map((entry) => {
    const profile = profiles[entry.id]
    if (!profile) throw new Error(`public-preview quality profile missing: ${entry.id}`)
    return { ...entry, ...profile }
  })
  const profileIds = Object.keys(profiles).sort()
  const screenshotIds = screenshots.map((entry) => entry.id).sort()
  if (JSON.stringify(profileIds) !== JSON.stringify(screenshotIds)) {
    throw new Error('public-preview quality profile ids must match screenshot ids')
  }
  if (!policy.qualityPolicy || typeof policy.qualityPolicy !== 'object') {
    throw new Error('public-preview quality policy is missing')
  }
  const qualityScenarios = scenarioDocuments.flatMap((document) => document.qualityScenarios ?? [])
  if (qualityScenarios.length === 0) throw new Error('public-preview quality scenarios are missing')
  const scenarioIds = qualityScenarios.map((entry) => entry.id)
  if (new Set(scenarioIds).size !== scenarioIds.length) throw new Error('public-preview quality scenario ids must be unique')
  return {
    ...registry,
    screenshots,
    qualityPolicy: policy.qualityPolicy,
    qualityScenarios
  }
}

export function qualityPolicyDigest(registry) {
  return crypto.createHash('sha256').update(stableJson({ policy: registry.qualityPolicy, scenarios: registry.qualityScenarios })).digest('hex')
}

export function validatePublicPreviewQualityManifestValue(manifest, registry, { requirePass = true } = {}) {
  const errors = []
  if (manifest.schema !== publicPreviewQualityManifestSchema) errors.push('public-preview quality manifest schema')
  if (!/^[a-f0-9]{40}$/u.test(String(manifest.sourceCommit ?? ''))) errors.push('public-preview quality source commit')
  if (manifest.policyDigest !== qualityPolicyDigest(registry)) errors.push('public-preview quality policy digest')
  const screenshotIds = Object.keys(manifest.screenshots ?? {}).sort()
  const expectedScreenshotIds = registry.screenshots.map((entry) => entry.id).sort()
  if (JSON.stringify(screenshotIds) !== JSON.stringify(expectedScreenshotIds)) errors.push('public-preview quality screenshot ids')
  for (const entry of registry.screenshots) {
    errors.push(...validatePublicPreviewQualityReport(
      manifest.screenshots?.[entry.id],
      { ...entry, viewport: entry.qualityViewport },
      registry.qualityPolicy
    ).map((error) => `${entry.id}: ${error}`))
  }
  errors.push(...validatePublicPreviewQualityMatrix(manifest.matrix, registry.qualityScenarios, registry.qualityPolicy))
  if (manifest.matrix?.policyDigest !== manifest.policyDigest) errors.push('public-preview quality matrix policy digest')
  if (requirePass && manifest.status !== 'pass') errors.push(`public-preview quality manifest status=${manifest.status}`)
  return errors
}
