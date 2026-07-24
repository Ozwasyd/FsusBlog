import { mkdir, writeFile } from 'node:fs/promises';
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

export async function writePublicPreviewQualitySidecar(directory, screenshotFile, report)
{
    const file = qualitySidecarFile(directory, screenshotFile);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, stableJson(report), 'utf8');
    return file;
}

export async function writePublicPreviewQualityMatrix(directory, matrix)
{
    const file = path.join(directory, 'quality-matrix.json');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, stableJson(matrix), 'utf8');
    return file;
}
