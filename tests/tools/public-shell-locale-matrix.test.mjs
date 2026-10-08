import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

import {
    createPublicShellLocaleMatrix,
    publicShellLocaleContentDigest,
    resolvePublicShellLocaleCopy,
    validatePublicShellLocaleMatrix
// eslint-disable-next-line import-x/no-relative-parent-imports -- Exercise the canonical Browser Contract matrix facade.
} from '../browser-contract/public-shell-locale-matrix.mjs';

const root = new URL('../../', import.meta.url);
const matrix = await createPublicShellLocaleMatrix();

function reseal(value)
{
    const body = { ...value };
    delete body.contentDigest;
    return { ...body, contentDigest: publicShellLocaleContentDigest(body) };
}

test('matrix derives ten locales, aliases, selector order, and exact typed artifact copy', async () =>
{
    await validatePublicShellLocaleMatrix(matrix);
    const catalog = JSON.parse(await readFile(new URL('src/shared/Contracts/Localization/locale-catalog.json', root)));
    assert.deepEqual(matrix.locales, catalog.locales.filter((item) => item.status === 'enabled'));
    assert.equal(matrix.locales.length, 10);
    assert.equal(matrix.evidenceKind, 'plan');
    assert.equal(matrix.runnerRef, 'tests/browser-contract/run.mjs');
    assert.equal(matrix.fontPlan.schema, 'fsusblog.public-shell-locale-font-plan.v1');
    assert.equal(matrix.fontPlan.entries.length, matrix.locales.length);
    assert.equal(matrix.identity.fontPlanDigest, matrix.fontPlan.digest);
    assert.equal(matrix.fontPlan.catalogDigest, matrix.identity.catalogDigest);
    for (const entry of matrix.fontPlan.entries)
    {
        assert.ok(entry.assetRef.startsWith('src/frontend/src/assets/fonts/'));
        assert.match(entry.assetDigest, /^[a-f0-9]{64}$/u);
        assert.ok(entry.faceIds.length > 0);
        assert.ok(entry.representativeText.length > 0);
    }
    assert.equal(new Set(matrix.scenes.map((item) => item.id)).size, matrix.scenes.length);
    for (const descriptor of matrix.locales)
    {
        for (const alias of descriptor.aliases)
        {
            assert.ok(matrix.negotiationCases.some((item) => item.header === alias && item.locale === descriptor.code));
        }
        const scene = matrix.scenes.find((item) => item.locale === descriptor.code);
        assert.deepEqual(scene.selectorItems.map((item) => item.code), matrix.locales.map((item) => item.code));
        assert.equal(scene.selectorItems.filter((item) => item.selected).length, 1);
        assert.equal(scene.requiredFont.script, descriptor.script);
    }
    const scene = matrix.scenes.find((item) => item.locale === matrix.locales[3].code);
    const copy = await resolvePublicShellLocaleCopy(matrix, scene.id);
    for (const reference of scene.expectedKeys)
    {
        const text = await readFile(new URL(reference.artifactRef, root), 'utf8');
        const module = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(text)).toString('base64')}`);
        const [, ...segments] = reference.key.split('.');
        const name = Object.keys(module).find((key) => key !== 'localeDomainIdentity');
        assert.equal(copy[reference.key], segments.reduce((value, key) => value[key], module[name]));
    }
});

test('matrix covers each issue, viewport, PublicShell auth action and negotiation source', () =>
{
    for (const issue of [2083, 2084, 2085, 2086, 2087])
    {
        for (const locale of matrix.locales)
        {
            for (const width of [390, 1440])
            {
                for (const auth of ['anonymous', 'authenticated', 'admin'])
                {
                    assert.ok(matrix.scenes.some((scene) => scene.issue === issue && scene.locale === locale.code
            && scene.viewport.width === width && scene.authActionContext === auth));
                }
            }
        }
    }
    assert.deepEqual(new Set(matrix.negotiationCases.map((item) => item.source)),
        new Set(['accept-language', 'explicit-cookie', 'default']));
    for (const scene of matrix.scenes)
    {
        assert.equal(scene.surface, 'PublicShell');
        assert.ok(scene.expectedKeys.every((item) => scene.requiredDomains.includes(item.key.split('.')[0])));
        assert.equal(scene.networkPolicy.includeCacheAndPreload, true);
        assert.ok(scene.geometryRef);
        assert.ok(scene.evidenceId);
    }
});

test('negotiation plans bind canonical wildcard and account/device cookie semantics without fabricating disabled locales', () =>
{
    const wildcard = matrix.negotiationCases.find((item) => item.id === 'default/wildcard');
    assert.equal(wildcard.source, 'accept-language');
    assert.equal(wildcard.matchedRange, '*');
    assert.equal(wildcard.locale, matrix.locales[0].code);
    assert.deepEqual(matrix.negotiationCoverage.disabledLocales, []);
    assert.equal(matrix.negotiationCoverage.disabledLocaleGate, 'no-disabled-entry-in-current-catalog');
    for (const kind of ['unknown-cookie', 'corrupt-cookie'])
    {
        const fallback = matrix.negotiationCases.find((item) => item.id === `default/${kind}`);
        assert.equal(fallback.header, null);
        assert.equal(fallback.locale, matrix.defaultLocale);
        assert.equal(fallback.source, 'default');
        assert.equal(fallback.matchedRange, '');
    }
    for (const locale of matrix.locales)
    {
        const cases = matrix.negotiationCases.filter((item) => item.id.startsWith(`${locale.code}/`));
        for (const deviceMode of ['fixed', 'auto'])
        {
            const fixed = cases.find((item) => item.id.endsWith(`account-fixed/device-${deviceMode}`));
            assert.equal(fixed.locale, locale.code);
            assert.equal(fixed.cookie, locale.code);
            assert.equal(fixed.preferencePreparation.fixedLocale, locale.code);
            assert.equal(fixed.preferencePreparation.operation, 'login-refresh');
            const auto = cases.find((item) => item.id.endsWith(`account-auto/device-${deviceMode}`));
            assert.equal(auto.cookie, auto.preferencePreparation.incomingDeviceCookie);
            assert.equal(auto.source, deviceMode === 'fixed' ? 'explicit-cookie' : 'accept-language');
            assert.equal(auto.preferencePreparation.fixedLocale, null);
            assert.ok(matrix.scenes.filter((scene) => scene.negotiationId === auto.id)
                .every((scene) => scene.authActionContext !== 'anonymous'));
        }
        const explicitAuto = cases.find((item) => item.id.endsWith('device-explicit-auto'));
        assert.equal(explicitAuto.cookie, null);
        assert.ok(explicitAuto.preferencePreparation.incomingDeviceCookie);
        assert.equal(cases.find((item) => item.id.endsWith('corrupt-cookie')).source, 'accept-language');
    }
    for (const ref of ['LocaleResolver.cs', 'LocalePreferenceCookieService.cs', 'BinaryEndpoints.Auth.cs', 'UserLocalePreferenceService.cs'])
    {
        assert.ok(matrix.identity.refs.some((item) => item.path.endsWith(ref)));
    }
});

test('transition plans retain old copy during preparation and failure, and enumerate resource fault modes', () =>
{
    for (const scene of matrix.scenes.filter((item) => item.transition))
    {
        const oldUi = scene.stage === 'preparing' || (scene.issue === 2087 && scene.stage !== 'retry');
        const expected = oldUi ? scene.transition.sourceLocale : scene.locale;
        assert.equal(scene.transition.expectedUiLocale, expected);
        assert.notEqual(scene.transition.sourceLocale, scene.locale);
        assert.equal(scene.selectorItems.find((item) => item.selected).code, expected);
        assert.ok(scene.expectedKeys.every((item) => item.artifactRef.includes(`/${expected}/`)));
        assert.equal(matrix.negotiationCases.find((item) => item.id === scene.negotiationId).locale,
            scene.transition.sourceLocale);
    }
    assert.deepEqual(new Set(matrix.scenes.filter((item) => item.stage === 'domain-failure').map((item) => item.transition.failureMode)),
        new Set(['timeout', 'non-2xx', 'invalid-content', 'invalid-schema', 'invalid-digest']));
});

const mutations = {
    'missing locale': (value) => value.locales.pop(),
    'duplicate locale': (value) => value.locales.push(value.locales[0]),
    'old bilingual inventory': (value) =>
    {
        value.locales = value.locales.slice(0, 2);
    },
    'second language list': (value) =>
    {
        value.supportedLocales = value.locales.map((item) => item.code);
    },
    'unknown schema': (value) =>
    {
        value.schema = 'fsusblog.public-shell-locale-matrix.v99';
    },
    'unknown property': (value) =>
    {
        value.scenes[0].waiver = true;
    },
    'handwritten copy': (value) =>
    {
        value.scenes[0].expectedCopy = { title: 'handwritten' };
    },
    'missing typed key': (value) => value.scenes[0].expectedKeys.pop(),
    'unknown typed key': (value) =>
    {
        value.scenes[0].expectedKeys[0].key = 'public.unknown';
    },
    'extra typed key': (value) => value.scenes[0].expectedKeys.push(value.scenes[0].expectedKeys[0]),
    'cross locale fallback': (value) =>
    {
        value.scenes[0].expectedKeys[0].artifactRef = value.scenes.find((item) => item.locale !== value.scenes[0].locale).expectedKeys[0].artifactRef;
    },
    'forged copy digest': (value) =>
    {
        value.scenes[0].expectedKeys[0].valueDigest = '0'.repeat(64);
    },
    'missing route domain': (value) => value.scenes[0].requiredDomains.pop(),
    'unrelated route domain': (value) => value.scenes[0].requiredDomains.push('admin'),
    'unknown domain': (value) => value.scenes[0].requiredDomains.push('invented-domain'),
    'wrong font script': (value) =>
    {
        const scene = value.scenes.find((item) => item.requiredFont.script === 'Hant');
        scene.requiredFont = value.scenes.find((item) => item.requiredFont.script === 'Hans').requiredFont;
    },
    'unknown font face': (value) => value.scenes[0].requiredFont.faceIds.push('invented-face'),
    'selector order': (value) => value.scenes[0].selectorItems.reverse(),
    'selector label': (value) =>
    {
        value.scenes[0].selectorItems[0].nativeName = 'drift';
    },
    'selector active identity': (value) =>
    {
        value.scenes[0].selectorItems[0].selected = false;
    },
    'forged wildcard source': (value) =>
    {
        value.negotiationCases.find((item) => item.id === 'default/wildcard').source = 'default';
    },
    'missing account precondition': (value) =>
    {
        value.negotiationCases.find((item) => item.preferencePreparation).preferencePreparation = null;
    },
    'invented disabled locale': (value) => value.negotiationCoverage.disabledLocales.push('zz-ZZ'),
    'missing alias case': (value) =>
    {
        value.negotiationCases = value.negotiationCases.filter((item) => !item.id.includes('/alias/'));
    },
    'missing negotiation source': (value) =>
    {
        value.negotiationCases = value.negotiationCases.filter((item) => item.source !== 'explicit-cookie');
    },
    'cross surface expansion': (value) =>
    {
        value.scenes[0].surface = 'Account';
    },
    'missing scene': (value) => value.scenes.pop(),
    'duplicate scene': (value) => value.scenes.push(value.scenes[0]),
    'source identity tamper': (value) =>
    {
        value.identity.sourceCommit = '0'.repeat(40);
    },
    'worktree identity tamper': (value) =>
    {
        value.identity.worktree = '/unrelated-worktree';
    },
    'uncommitted source fingerprint tamper': (value) =>
    {
        value.identity.worktreeFingerprint = '0'.repeat(64);
    },
    'schema source digest tamper': (value) =>
    {
        value.identity.refs.find((item) => item.path.endsWith('/contract.mjs')).digest = '0'.repeat(64);
    },
    'plan promoted to observation': (value) =>
    {
        value.evidenceKind = 'verified';
    },
    'second runner': (value) =>
    {
        value.runnerRef = 'tests/another-runner.mjs';
    },
    'font plan digest': (value) =>
    {
        value.fontPlan.digest = '0'.repeat(64);
    },
    'font asset digest': (value) =>
    {
        value.fontPlan.entries[0].assetDigest = '0'.repeat(64);
    }
};

for (const [name, mutate] of Object.entries(mutations))
{
    test(`matrix rejects ${name} even with a recomputed content digest`, async () =>
    {
        const candidate = structuredClone(matrix);
        mutate(candidate);
        await assert.rejects(validatePublicShellLocaleMatrix(reseal(candidate)), /does not match current authority/u);
    });
}

test('matrix identity and scene enumeration are deterministic', async () =>
{
    assert.deepEqual(await createPublicShellLocaleMatrix(), matrix);
    const candidate = structuredClone(matrix);
    candidate.contentDigest = '0'.repeat(64);
    await assert.rejects(validatePublicShellLocaleMatrix(candidate), /does not match current authority/u);
});
