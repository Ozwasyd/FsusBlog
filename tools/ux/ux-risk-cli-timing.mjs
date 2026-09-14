const UX_RISK_TIMING_MARKER = '[ux-risk-timing] ';
const UX_RISK_TIMING_SCHEMA = 'fsusblog.ux-viewport-risk-timing.v1';

export function parseUxRiskCliTimingLine(line)
{
    if (typeof line !== 'string')
    {
        throw new TypeError('UX risk CLI timing line must be a string');
    }
    const markerIndex = line.indexOf(UX_RISK_TIMING_MARKER);
    if (markerIndex < 0)
    {
        return null;
    }

    const payload = line.slice(markerIndex + UX_RISK_TIMING_MARKER.length).trim();
    let summary;
    try
    {
        summary = JSON.parse(payload);
    }
    catch (error)
    {
        throw new Error(`invalid UX risk CLI timing JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!summary || typeof summary !== 'object' || Array.isArray(summary))
    {
        throw new Error('UX risk CLI timing payload must be an object');
    }
    if (summary.schema !== UX_RISK_TIMING_SCHEMA)
    {
        throw new Error(`unexpected UX risk CLI timing schema: ${String(summary.schema)}`);
    }
    if (typeof summary.groupId !== 'string' || summary.groupId.length === 0)
    {
        throw new Error('UX risk CLI timing payload requires groupId');
    }
    if (summary.status !== 'passed' && summary.status !== 'failed')
    {
        throw new Error(`unexpected UX risk CLI timing status: ${String(summary.status)}`);
    }
    if (!Number.isFinite(summary.elapsedMs) || summary.elapsedMs < 0)
    {
        throw new Error(`invalid UX risk CLI timing elapsedMs: ${String(summary.elapsedMs)}`);
    }
    if (!summary.phases || typeof summary.phases !== 'object' || Array.isArray(summary.phases))
    {
        throw new Error('UX risk CLI timing payload requires phase measurements');
    }
    return summary;
}
