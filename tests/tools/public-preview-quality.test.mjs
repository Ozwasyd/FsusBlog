import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createPublicPreviewQualityMatrix,
    publicPreviewQualityMatrixSchema,
    publicPreviewQualityReportSchema,
    validatePublicPreviewQualityMatrix,
    validatePublicPreviewQualityReport
} from '../../tools/docs/public-preview-quality.mjs';

const policy = {
    reviewerStatuses: ['pass', 'fail', 'needs-design-review']
};

const scenario = {
    id: 'article-detail-mobile-en-us',
    route: 'ArticleDetail',
    viewport: { width: 375, height: 812 },
    theme: 'light',
    locale: 'en-US',
    zoom: 1,
    surfaceRole: 'public',
    linkedIssues: [1462, 1463, 1464, 1473, 1476],
    primaryTaskSelectors: []
};

function machineCheck(status = 'pass')
{
    return { status, findings: [] };
}

function report({ status = 'pass', id = scenario.id } = {})
{
    return {
        schema: publicPreviewQualityReportSchema,
        id,
        route: scenario.route,
        viewport: scenario.viewport,
        theme: scenario.theme,
        locale: scenario.locale,
        zoom: scenario.zoom,
        surfaceRole: scenario.surfaceRole,
        linkedIssues: scenario.linkedIssues,
        status,
        machine: {
            overflow: machineCheck(status === 'fail' ? 'fail' : 'pass'),
            overlaps: machineCheck(),
            clippedText: machineCheck(),
            hitTargets: machineCheck(),
            focusClipping: machineCheck(),
            localeCoherence: machineCheck(),
            headerStability: machineCheck(),
            primaryTask: machineCheck()
        },
        reviewer: {
            classification: status,
            reasons: status === 'needs-design-review' ? ['nested panel count=1'] : [],
            metrics: {}
        }
    };
}

test('public-preview quality report binds route, viewport, locale, zoom, issue links, machine checks and reviewer state', () =>
{
    assert.deepEqual(validatePublicPreviewQualityReport(report(), scenario, policy), []);
    assert.match(
        validatePublicPreviewQualityReport({ ...report(), locale: 'zh-CN' }, scenario, policy).join('; '),
        /locale mismatch/u
    );
    assert.match(
        validatePublicPreviewQualityReport({ ...report(), linkedIssues: null }, scenario, policy).join('; '),
        /linkedIssues/u
    );
    assert.match(
        validatePublicPreviewQualityReport({ ...report(), reviewer: { classification: 'pass', reasons: [] }, status: 'fail' }, scenario, policy).join('; '),
        /reviewer classification/u
    );
});

test('quality matrix is fail closed for machine failures, reviewer review and incomplete scenario coverage', () =>
{
    const passing = createPublicPreviewQualityMatrix([report()]);
    assert.equal(passing.schema, publicPreviewQualityMatrixSchema);
    assert.equal(passing.status, 'pass');
    assert.deepEqual(validatePublicPreviewQualityMatrix(passing, [scenario], policy), []);

    assert.equal(createPublicPreviewQualityMatrix([report({ status: 'needs-design-review' })]).status, 'needs-design-review');
    assert.equal(createPublicPreviewQualityMatrix([report({ status: 'fail' })]).status, 'fail');

    assert.match(
        validatePublicPreviewQualityMatrix({ ...passing, reports: [] }, [scenario], policy).join('; '),
        /scenario count/u
    );
    assert.match(
        validatePublicPreviewQualityMatrix({ ...passing, reports: [report(), report()] }, [scenario], policy).join('; '),
        /duplicate matrix report id/u
    );
});
