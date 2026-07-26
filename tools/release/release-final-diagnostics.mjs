import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { readEvidenceDocument } from '../test-matrix/content-addressed-evidence-store.mjs';

export function failReleaseFinal(errors)
{
    for (const error of errors)
    {
        console.error(`[release-final] ${error}`);
    }
    process.exit(1);
}

function artifactPath(manifestFile, artifact)
{
    if (!artifact || artifact === 'null')
    {
        return null;
    }
    return path.resolve(path.dirname(manifestFile), artifact);
}

function isFiniteNumber(value)
{
    return typeof value === 'number' && Number.isFinite(value);
}

export function isNonBlockingDiagnosticEvidence(summary)
{
    return summary?.evidenceClass === 'diagnostic'
    && summary.affectsCorrectness === false;
}

export function isNonBlockingDiagnosticVisualGateSkip(manifest, manifestFile)
{
    const artifact = manifest.artifacts?.visualGateSkip;
    const summaryArtifact = manifest.evidenceSummary?.gates?.visualGateSkip;
    if (typeof artifact !== 'string'
        || artifact.length === 0
        || summaryArtifact !== artifact)
    {
        return false;
    }
    const file = artifactPath(manifestFile, artifact);
    if (!file)
    {
        return false;
    }
    try
    {
        if (!fs.existsSync(file) || !fs.statSync(file).isFile())
        {
            return false;
        }
        const evidence = readEvidenceDocument(file);
        return evidence.schema === 'fsusblog.visual-gate-skip.v1'
        && evidence.status === 'visual-gate-skipped'
        && evidence.executionBoundary === 'real-browser-screenshot-diagnostics'
        && isNonBlockingDiagnosticEvidence(evidence);
    }
    catch
    {
        return false;
    }
}

export function validateReleaseResourceSummary(summary, artifactKey)
{
    const errors = [];
    if (!summary || typeof summary !== 'object')
    {
        return [`${artifactKey} release resource summary is missing`];
    }

    if (summary.status !== 'ok')
    {
        errors.push(`${artifactKey}.status must be ok, got ${summary.status}`);
    }

    if (!Array.isArray(summary.metrics) || summary.metrics.length === 0)
    {
        errors.push(`${artifactKey}.metrics must be non-empty`);
    }

    const unavailable = Array.isArray(summary.unavailableMetrics)
        ? summary.unavailableMetrics
        : [];
    for (const [index, item] of unavailable.entries())
    {
        if (!item || typeof item.reason !== 'string' || item.reason.length === 0)
        {
            errors.push(
                `${artifactKey}.unavailableMetrics[${index}].reason missing`
            );
        }
    }

    let okMetricCount = 0;
    for (const [index, metric] of (summary.metrics ?? []).entries())
    {
        const label = `${artifactKey}.metrics[${index}]`;
        if (!metric || typeof metric !== 'object')
        {
            errors.push(`${label} must be an object`);
            continue;
        }
        if (typeof metric.name !== 'string' || metric.name.length === 0)
        {
            errors.push(`${label}.name missing`);
        }
        for (const field of [
            'startValue',
            'endValue',
            'maxValue',
            'delta',
            'threshold'
        ])
        {
            if (!isFiniteNumber(metric[field]))
            {
                errors.push(`${label}.${field} must be a finite number`);
            }
        }
        if (metric.status !== 'ok')
        {
            errors.push(`${label}.status must be ok, got ${metric.status}`);
        }
        else
        {
            okMetricCount += 1;
        }
        if (metric.thresholdOperator !== '<=')
        {
            errors.push(`${label}.thresholdOperator must be <=`);
        }
        if (metric.thresholdField !== 'delta')
        {
            errors.push(`${label}.thresholdField must be delta`);
        }
        if (isFiniteNumber(metric.delta)
            && isFiniteNumber(metric.threshold)
            && metric.delta > metric.threshold)
        {
            errors.push(
                `${label}.delta ${metric.delta} exceeds threshold ${metric.threshold}`
            );
        }
    }

    if (okMetricCount === 0)
    {
        errors.push(
            `${artifactKey} must include at least one passing resource metric`
        );
    }

    return errors;
}
