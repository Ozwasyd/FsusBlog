import {
    finiteNumber,
    publicPreviewQualityReportSchema,
    validatePublicPreviewQualityReport
} from './public-preview-quality-contract.mjs';
import { collectPublicPreviewQualityDom } from './public-preview-quality-dom.mjs';

export async function applyPublicPreviewZoom(page, zoom)
{
    const factor = finiteNumber(zoom, 1);
    if (factor <= 0)
    {
        throw new Error(`public-preview zoom must be positive: ${zoom}`);
    }
    await page.evaluate((value) =>
    {
        const root = document.documentElement;
        root.style.zoom = value === 1 ? '' : String(value);
        root.dataset.publicPreviewZoom = String(value);
    }, factor);
}

export async function measurePublicPreviewHeader(page, phase)
{
    return await page.evaluate((samplePhase) =>
    {
        const selectors = [
            '[data-public-sticky-geometry-owner]',
            '[data-public-shell-header]',
            '.site-chrome-header',
            'header'
        ];
        const element = selectors.map((selector) => document.querySelector(selector))
            .find((candidate) => candidate instanceof HTMLElement);
        if (!(element instanceof HTMLElement))
        {
            return { phase: samplePhase, rect: null };
        }
        const rect = element.getBoundingClientRect();
        return {
            phase: samplePhase,
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        };
    }, String(phase));
}

function headerStability(samples, maximumDifference)
{
    const measured = (samples ?? []).filter((sample) => sample?.rect);
    if (measured.length < 2)
    {
        return {
            status: 'fail',
            maximumDifferencePx: null,
            samples: measured,
            findings: ['fewer than two measurable header lifecycle samples']
        };
    }
    const first = measured[0].rect;
    let delta = 0;
    for (const sample of measured.slice(1))
    {
        delta = Math.max(delta,
            Math.abs(sample.rect.x - first.x),
            Math.abs(sample.rect.y - first.y),
            Math.abs(sample.rect.width - first.width),
            Math.abs(sample.rect.height - first.height));
    }
    return {
        status: delta <= maximumDifference ? 'pass' : 'fail',
        maximumDifferencePx: delta,
        samples: measured,
        findings: delta <= maximumDifference
            ? []
            : [`header lifecycle geometry moved ${delta.toFixed(2)}px; budget=${maximumDifference}px`]
    };
}

export async function auditPublicPreviewPage(page, scenario, policy, { headerSamples = [] } = {})
{
    const normalizedScenario = {
        id: String(scenario.id),
        route: String(scenario.route),
        viewport: {
            width: finiteNumber(scenario.viewport?.width ?? scenario.viewportWidth ?? 0),
            height: finiteNumber(scenario.viewport?.height ?? scenario.viewportHeight ?? 0)
        },
        theme: String(scenario.theme),
        locale: String(scenario.locale),
        zoom: finiteNumber(scenario.zoom, 1),
        surfaceRole: String(scenario.surfaceRole ?? (scenario.scope === 'admin' ? 'task' : 'public')),
        linkedIssues: [...new Set((scenario.linkedIssues ?? []).map((value) => Number(value)).filter(Number.isInteger))].sort((a, b) => a - b),
        primaryTaskSelectors: [...new Set((scenario.primaryTaskSelectors ?? []).map(String).filter(Boolean))]
    };
    const lifecycle = headerStability(headerSamples, finiteNumber(policy.layoutShiftMaxPx, 1));
    const browserResult = await collectPublicPreviewQualityDom(page, normalizedScenario, policy);
    const machine = {
        overflow: browserResult.overflow,
        overlaps: browserResult.overlaps,
        clippedText: browserResult.clippedText,
        hitTargets: browserResult.hitTargets,
        focusClipping: browserResult.focusClipping,
        localeCoherence: browserResult.localeCoherence,
        headerStability: lifecycle,
        primaryTask: browserResult.primaryTask
    };
    const machineFailures = Object.entries(machine)
        .filter(([, result]) => result.status !== 'pass')
        .map(([name]) => name);
    const reviewerReasons = browserResult.reviewer.findings;
    const status = machineFailures.length > 0
        ? 'fail'
        : reviewerReasons.length > 0
            ? 'needs-design-review'
            : 'pass';
    const report = {
        schema: publicPreviewQualityReportSchema,
        id: normalizedScenario.id,
        route: normalizedScenario.route,
        viewport: normalizedScenario.viewport,
        theme: normalizedScenario.theme,
        locale: normalizedScenario.locale,
        zoom: normalizedScenario.zoom,
        surfaceRole: normalizedScenario.surfaceRole,
        linkedIssues: normalizedScenario.linkedIssues,
        status,
        machine,
        reviewer: {
            classification: status,
            reasons: reviewerReasons,
            metrics: browserResult.reviewer.metrics
        }
    };
    const errors = validatePublicPreviewQualityReport(report, normalizedScenario, policy);
    if (errors.length > 0)
    {
        throw new Error(`invalid public-preview quality report ${normalizedScenario.id}: ${errors.join('; ')}`);
    }
    return report;
}
