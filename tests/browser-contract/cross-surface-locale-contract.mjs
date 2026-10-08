import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export const crossSurfaceLocaleContractSchema = 'fsusblog.cross-surface-locale-contract.v1';

function digest(value)
{
    return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

/** Risk rules consume descriptors, never a second enabled-locale list or observed layout. */
export function projectCrossSurfaceLocaleRisks(descriptors)
{
    assert.ok(Array.isArray(descriptors) && descriptors.length === 10, 'cross-surface requires the exact enabled catalog');
    const codes = new Set();
    const entries = descriptors.map((descriptor) =>
    {
        assert.equal(descriptor.status, 'enabled', 'cross-surface disabled locale');
        assert.equal(typeof descriptor.code, 'string', 'cross-surface locale code');
        assert.equal(codes.has(descriptor.code), false, 'cross-surface duplicate locale');
        codes.add(descriptor.code);
        const language = new Intl.Locale(descriptor.intlLocale).language;
        let group;
        switch (descriptor.script)
        {
            case 'Hans':
            case 'Hant':
            case 'Jpan':
            case 'Kore':
                group = 'cjk';
                break;
            case 'Cyrl':
                group = 'cyrillic-plural';
                break;
            case 'Latn':
                group = language === 'en' ? 'baseline-latin' : 'long-latin';
                break;
            default:
                assert.fail('cross-surface unknown descriptor script');
        }
        const narrow = language === 'de' || descriptor.script === 'Cyrl';
        const regionalCjk = ['Hant', 'Jpan', 'Kore'].includes(descriptor.script);
        const zoom = ['fr', 'es', 'pt'].includes(language);
        return {
            locale: descriptor.code,
            group,
            viewports: narrow ? [320, 375, 390, 768, 1440]
                : regionalCjk ? [375, 390, 768, 1440] : [390, 1440],
            zoomAt390: zoom ? [1, 1.5] : [1],
            selectorViewports: [320, 390, 1440],
            fontStages: regionalCjk ? ['before', 'preparing', 'commit'] : [],
            pluralCounts: descriptor.script === 'Cyrl' ? [0, 1, 2, 5, 21, 22] : [],
            accountContexts: ['user', 'admin']
        };
    });
    const body = {
        schema: crossSurfaceLocaleContractSchema,
        evidenceKind: 'plan',
        qualificationEligible: false,
        coverageStage: 'risk-rules-only',
        descriptorDigest: digest(descriptors),
        entries
    };
    return { ...body, contentDigest: digest(body) };
}

/** A descriptor or risk-rule change invalidates the entire projection, including its digest. */
export function validateCrossSurfaceLocaleRisks(plan, descriptors)
{
    assert.ok(isDeepStrictEqual(plan, projectCrossSurfaceLocaleRisks(descriptors)),
        'cross-surface risk projection differs from current descriptors/rules');
    return plan;
}
