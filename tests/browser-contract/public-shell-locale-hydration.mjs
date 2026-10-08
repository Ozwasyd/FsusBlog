import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex');
const stages = Object.freeze(['first-html', 'hydration-start', 'interactive-ready', 'selector-open']);

function equal(actual, expected, label)
{
    assert.ok(actual === expected, `hydration ${label} mismatch`);
}

function exactKeys(value, allowed, label)
{
    assert.deepEqual(Object.keys(value ?? {}).sort(), [...allowed].sort(), `hydration ${label} has an unregistered field`);
}

function box(value, label)
{
    exactKeys(value, ['x', 'y', 'width', 'height', 'overflow'], label);
    for (const key of ['x', 'y', 'width', 'height'])
    {
        assert.equal(typeof value[key], 'number', `hydration ${label}.${key} must be a number`);
        assert.ok(Number.isFinite(value[key]), `hydration ${label}.${key} must be finite`);
    }
    assert.equal(typeof value.overflow, 'boolean', `hydration ${label}.overflow must be boolean`);
    assert.equal(value.overflow, false, `hydration ${label} overflowed`);
    assert.ok(value.width > 0 && value.height > 0, `hydration ${label} was hidden to pass layout`);
}

function overlaps(left, right)
{
    return left.x < right.x + right.width
        && left.x + left.width > right.x
        && left.y < right.y + right.height
        && left.y + left.height > right.y;
}

function minHit(viewport)
{
    return viewport.width <= 390 ? 44 : 40;
}

function digestCopy(copy)
{
    return Object.fromEntries(Object.entries(copy).map(([key, value]) => [key, sha256(value)]));
}

/** Compare first HTML through interactive ready without OCR, sleep, or internal phase hooks. */
export function assertPublicShellLocaleHydration({ scene, copy, snapshots, consoleIssues = [] })
{
    assert.ok(scene.issue === 2084, 'hydration requires its matrix scene');
    assert.ok(stages.includes(scene.stage), 'hydration requires a first-frame stage');
    exactKeys(snapshots, stages, 'snapshots');
    const expectedUi = scene.transition?.expectedUiLocale ?? scene.locale;
    const minimum = minHit(scene.viewport);
    const names = [];
    const order = [];
    let previousGeometry = null;
    for (const stage of stages)
    {
        const snapshot = snapshots[stage];
        exactKeys(snapshot, [
            'language', 'direction', 'copy', 'metadata', 'selector', 'authAction',
            'geometry', 'accessibleNames', 'sourceOrder', 'mixedLanguage', 'selectorHidden'
        ], `${stage} snapshot`);
        equal(snapshot.language, scene.document.language, `${stage} html lang`);
        equal(snapshot.direction, scene.document.direction, `${stage} html direction`);
        equal(snapshot.mixedLanguage, false, `${stage} mixed language`);
        equal(snapshot.selectorHidden, false, `${stage} selector visibility`);
        exactKeys(snapshot.metadata, ['title', 'description', 'openGraphLocale'], `${stage} metadata`);
        equal(snapshot.metadata.openGraphLocale, scene.document.openGraphLocale, `${stage} OG locale`);
        assert.deepEqual(snapshot.metadata, snapshots['first-html'].metadata, `hydration ${stage} metadata changed`);
        exactKeys(snapshot.copy, Object.keys(copy), `${stage} typed copy`);
        for (const [key, value] of Object.entries(copy))
        {
            equal(snapshot.copy[key], value, `${stage} typed copy ${key}`);
        }
        exactKeys(snapshot.selector, ['active', 'disabled', 'items'], `${stage} selector`);
        equal(snapshot.selector.active, expectedUi, `${stage} selector active`);
        assert.equal(typeof snapshot.selector.disabled, 'boolean', `hydration ${stage} selector disabled must be boolean`);
        equal(snapshot.selector.disabled, snapshots['first-html'].selector.disabled, `${stage} selector disabled changed`);
        assert.ok(Array.isArray(snapshot.selector.items), `hydration ${stage} selector items must be an array`);
        equal(snapshot.selector.items.length, scene.selectorItems.length, `${stage} selector count`);
        for (const [index, item] of snapshot.selector.items.entries())
        {
            const projected = scene.selectorItems[index];
            exactKeys(item, ['code', 'selected', 'hidden', 'nativeName', 'englishName', 'direction', 'disabled'],
                `${stage} selector item`);
            equal(item.code, projected.code, `${stage} selector order`);
            equal(item.selected, projected.selected, `${stage} selector selected`);
            equal(item.nativeName, projected.nativeName, `${stage} selector native label`);
            equal(item.englishName, projected.englishName !== projected.nativeName ? projected.englishName : null,
                `${stage} selector English label`);
            equal(item.direction, projected.direction, `${stage} selector direction`);
            equal(item.disabled, snapshot.selector.disabled, `${stage} selector item disabled projection`);
            equal(item.hidden, false, `${stage} selector item hidden`);
        }
        const authKey = scene.authActionContext === 'anonymous' ? 'login'
            : scene.authActionContext === 'admin' ? 'dashboard' : 'account';
        equal(snapshot.authAction.key, `public.shell.${authKey}`, `${stage} auth action key`);
        equal(snapshot.authAction.text, copy[`public.shell.${authKey}`], `${stage} auth action copy`);
        exactKeys(snapshot.geometry, ['header', 'brand', 'nav', 'auth', 'selector', 'hitTargets'], `${stage} geometry`);
        for (const name of ['header', 'brand', 'nav', 'auth', 'selector'])
        {
            box(snapshot.geometry[name], `${stage}.${name}`);
        }
        // Header is the enclosing layout, not a sibling control. Its legitimate
        // intersection with descendants cannot establish a collision (#2084).
        const boxes = ['brand', 'nav', 'auth', 'selector'].map((name) => snapshot.geometry[name]);
        for (let index = 0; index < boxes.length; index += 1)
        {
            for (let other = index + 1; other < boxes.length; other += 1)
            {
                assert.equal(overlaps(boxes[index], boxes[other]), false, `hydration ${stage} geometry overlap`);
            }
        }
        assert.ok(Array.isArray(snapshot.geometry.hitTargets) && snapshot.geometry.hitTargets.length > 0,
            `hydration ${stage} hit targets missing`);
        for (const target of snapshot.geometry.hitTargets)
        {
            exactKeys(target, ['name', 'width', 'height', 'hidden'], `${stage} hit target`);
            equal(target.hidden, false, `${stage} hit target hidden`);
            assert.ok(target.width >= minimum && target.height >= minimum, `hydration ${stage} hit target below ${minimum}px`);
        }
        if (previousGeometry)
        {
            assert.deepEqual(snapshot.geometry.header, previousGeometry.header, `hydration ${stage} header shifted`);
            assert.deepEqual(snapshot.geometry.selector, previousGeometry.selector, `hydration ${stage} selector shifted`);
        }
        previousGeometry = snapshot.geometry;
        names.push(snapshot.accessibleNames);
        order.push(snapshot.sourceOrder);
    }
    for (const value of names.slice(1))
    {
        assert.deepEqual(value, names[0], 'hydration accessible names changed');
    }
    for (const value of order.slice(1))
    {
        assert.deepEqual(value, order[0], 'hydration source order changed');
    }
    assert.ok(Array.isArray(consoleIssues), 'hydration console issues must be an array');
    assert.equal(consoleIssues.length, 0, 'hydration console errors cannot be filtered');
    return {
        schema: 'fsusblog.public-shell-locale-hydration.v1',
        evidenceKind: 'diagnostic-probe',
        qualificationEligible: false,
        observed: {
            locale: expectedUi,
            stages: [...stages],
            copyDigests: digestCopy(copy),
            consoleErrors: 0
        }
    };
}
