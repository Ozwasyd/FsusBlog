import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const {assertBrowserPlanActualMatch, bindBrowserRenderingObservation, createCorrectnessBrowserPlan, diagnosticBrowserIdentity, observeCorrectnessBrowser, serializableBrowserPlan, validateBrowserIdentityPlan, validatePlaywrightBrowserIdentityPolicy} = await import(new URL('../../tools/test/playwright-browser-identity.mjs', import.meta.url));
const policy = {
    schema: 'fsusblog.playwright-browser-identity-policy.v1',
    correctness: {
        managedOnly: true,
        allowedEvidenceClasses: ['correctness', 'browser-contract'],
        browserNames: ['chromium', 'firefox', 'webkit'],
        forbiddenExecutableEnvironment: [
            'PLAYWRIGHT_CHROMIUM_PATH',
            'PLAYWRIGHT_FIREFOX_PATH',
            'PLAYWRIGHT_WEBKIT_PATH'
        ],
        launch: {
            chromium: {
                headless: true,
                args: ['--disable-gpu', '--use-angle=swiftshader'],
                gpuMode: 'software'
            },
            firefox: { headless: true, args: [], gpuMode: 'software' },
            webkit: { headless: true, args: [], gpuMode: 'software' }
        },
        rendering: {
            renderingMode: 'headless',
            deviceScaleFactor: 1,
            colorScheme: 'light'
        },
        fontSourceFiles: ['font-source.css'],
        fontPackages: ['fixture-font'],
        localeSourceRoot: 'locales'
    },
    diagnostic: { qualificationEligible: false, hostBrowserAllowed: true }
};

function fixture()
{
    const root = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-browser-identity-'))
    );
    const frontendRoot = path.join(root, 'src/frontend');
    const executablePath = path.join(root, 'managed/chromium-1217/chrome');
    const packageFile = path.join(frontendRoot, 'node_modules/@playwright/test/package.json');
    const moduleFile = path.join(frontendRoot, 'node_modules/@playwright/test/index.js');
    const corePackageFile = path.join(frontendRoot, 'node_modules/playwright-core/package.json');
    const browsersFile = path.join(frontendRoot, 'node_modules/playwright-core/browsers.json');
    const fontPackageFile = path.join(frontendRoot, 'node_modules/fixture-font/package.json');
    for (const file of [
        executablePath,
        packageFile,
        moduleFile,
        corePackageFile,
        browsersFile,
        fontPackageFile,
        path.join(frontendRoot, 'package-lock.json'),
        path.join(root, 'font-source.css'),
        path.join(root, 'locales/zh-CN.json')
    ])
    {
        fs.mkdirSync(path.dirname(file), { recursive: true });
    }
    fs.writeFileSync(executablePath, 'managed-browser-binary');
    fs.writeFileSync(packageFile, JSON.stringify({ name: '@playwright/test', version: '1.59.1' }));
    fs.writeFileSync(moduleFile, 'fixture module');
    fs.writeFileSync(corePackageFile, JSON.stringify({ name: 'playwright-core', version: '1.59.1' }));
    fs.writeFileSync(browsersFile, JSON.stringify({
        browsers: [{ name: 'chromium', revision: '1217', browserVersion: '147.0.7727.15' }]
    }));
    fs.writeFileSync(fontPackageFile, JSON.stringify({ name: 'fixture-font', version: '1.0.0' }));
    fs.writeFileSync(path.join(frontendRoot, 'package-lock.json'), '{"lockfileVersion":3}\n');
    fs.writeFileSync(path.join(root, 'font-source.css'), '@font-face{}\n');
    fs.writeFileSync(path.join(root, 'locales/zh-CN.json'), '{"hello":"你好"}\n');

    const browserType = { executablePath: () => executablePath };
    const resolved = new Map([
        ['@playwright/test/package.json', packageFile],
        ['@playwright/test', moduleFile],
        ['playwright-core/package.json', corePackageFile],
        ['fixture-font/package.json', fontPackageFile]
    ]);
    const requireFactory = () =>
    {
        const require = (request) =>
        {
            if (request === moduleFile)
            {
                return { chromium: browserType };
            }
            throw new Error(`unexpected fixture require: ${request}`);
        };
        require.resolve = (request) =>
        {
            const result = resolved.get(request);
            if (!result)
            {
                throw new Error(`unexpected fixture resolution: ${request}`);
            }
            return result;
        };
        return require;
    };
    const create = (overrides = {}) => createCorrectnessBrowserPlan({
        browserName: 'chromium',
        evidenceClass: 'browser-contract',
        locale: 'zh-CN',
        repoRoot: root,
        frontendRoot,
        env: {},
        policy,
        requireFactory,
        ...overrides
    });
    return { root, executablePath, create };
}

function actualFrom(plan, overrides = {})
{
    // eslint-disable-next-line no-unused-vars
    const { browserType: _browserType, contentDigest: _contentDigest, ...identity } = plan;
    return {
        ...structuredClone(identity),
        planDigest: plan.contentDigest,
        ...overrides
    };
}

test('correctness rejects automatic host Chrome selection', () =>
{
    const value = fixture();
    assert.throws(
        () => value.create({ env: { PLAYWRIGHT_CHROMIUM_PATH: '/usr/bin/google-chrome' } }),
        /forbids host executable override: PLAYWRIGHT_CHROMIUM_PATH/u
    );
});

test('serialized identity validation preserves portable fields without creating a browser launcher', () =>
{
    const live = fixture().create();
    const serialized = JSON.parse(JSON.stringify(serializableBrowserPlan(live)));
    const originalBytes = JSON.stringify(serialized);
    const validated = validateBrowserIdentityPlan(serialized);

    assert.equal(validated, serialized);
    assert.equal(Object.hasOwn(validated, 'browserType'), false);
    assert.equal(validated.browserType, undefined);
    assert.equal(JSON.stringify(validated), originalBytes);
    assert.equal(validated.contentDigest, live.contentDigest);
    assert.equal(live.browserType.executablePath(), live.executablePath);
    assert.throws(
        () => validateBrowserIdentityPlan({ ...serialized, revision: '1218' }),
        /correctness browser plan digest mismatch/u
    );
});

test('policy rejects an omitted browser launch owner instead of accepting a partial map', () =>
{
    const completePolicy = structuredClone(policy);
    completePolicy.correctness.allowedEvidenceClasses = ['correctness', 'browser-contract'];
    completePolicy.correctness.browserNames = ['chromium', 'firefox', 'webkit'];
    completePolicy.correctness.launch.firefox = { headless: true, args: [], gpuMode: 'software' };
    completePolicy.correctness.launch.webkit = { headless: true, args: [], gpuMode: 'software' };
    assert.equal(validatePlaywrightBrowserIdentityPolicy(completePolicy), completePolicy);
    delete completePolicy.correctness.launch.webkit;
    assert.throws(
        () => validatePlaywrightBrowserIdentityPolicy(completePolicy),
        /policy is incomplete/u
    );
});

test('correctness fails closed when the managed browser is missing', () =>
{
    const value = fixture();
    fs.rmSync(value.executablePath);
    assert.throws(() => value.create(), /managed browser is missing/u);
});

test('same browser version with a different binary digest is rejected', () =>
{
    const value = fixture();
    const plan = value.create();
    fs.writeFileSync(value.executablePath, 'different-binary-same-version');
    assert.throws(
        () => observeCorrectnessBrowser({ plan, browser: { version: () => plan.browserVersion } }),
        /planned\/actual mismatch: executableSha256/u
    );
});

test('revision and launch argument drift are rejected', () =>
{
    const plan = fixture().create();
    assert.throws(
        () => assertBrowserPlanActualMatch(plan, actualFrom(plan, { revision: '1218' })),
        /planned\/actual mismatch: revision/u
    );
    assert.throws(
        () => assertBrowserPlanActualMatch(plan, actualFrom(plan, {
            launchOptions: { ...plan.launchOptions, args: ['--disable-gpu'] }
        })),
        /planned\/actual mismatch: launchOptions/u
    );
});

test('capture-only renderer arguments remain part of the sealed browser identity', () =>
{
    const plan = fixture().create({
        additionalLaunchArgs: ['--disable-gpu-rasterization', '--disable-gpu']
    });
    assert.deepEqual(plan.launchOptions.args, [
        '--disable-gpu',
        '--use-angle=swiftshader',
        '--disable-gpu-rasterization'
    ]);
    assert.equal(assertBrowserPlanActualMatch(plan, actualFrom(plan)), true);
    assert.throws(
        () => fixture().create({ additionalLaunchArgs: [''] }),
        /additional correctness browser launch arguments/u
    );
});

test('font, locale, scale, rendering, color and GPU identity are mandatory', () =>
{
    const plan = fixture().create();
    for (const key of [
        'fontSetDigest', 'localeDataDigest', 'locale', 'deviceScaleFactor',
        'renderingMode', 'colorScheme', 'gpuMode'
    ])
    {
        const missing = { ...plan, rendering: { ...plan.rendering } };
        delete missing.rendering[key];
        assert.throws(() => validateBrowserIdentityPlan(missing), new RegExp(`rendering identity is missing: ${key}`, 'u'));
    }
});

test('diagnostic host-browser identity cannot be projected as correctness', () =>
{
    const plan = fixture().create();
    const diagnostic = diagnosticBrowserIdentity({
        browserName: 'chromium',
        browserVersion: plan.browserVersion,
        executablePath: '/usr/bin/google-chrome'
    });
    assert.throws(
        () => assertBrowserPlanActualMatch(plan, diagnostic),
        /diagnostic browser identity cannot satisfy correctness/u
    );
});

test('planned and actual browser version mismatch fails before evidence admission', () =>
{
    const plan = fixture().create();
    assert.throws(
        () => assertBrowserPlanActualMatch(plan, actualFrom(plan, { browserVersion: '147.0.7727.16' })),
        /planned\/actual mismatch: browserVersion/u
    );
});

test('local and CI cannot select different absolute binaries for one plan', () =>
{
    const local = fixture();
    const ci = fixture();
    const localPlan = local.create();
    const ciPlan = ci.create();
    assert.equal(localPlan.browserVersion, ciPlan.browserVersion);
    assert.equal(localPlan.executableSha256, ciPlan.executableSha256);
    assert.throws(
        () => assertBrowserPlanActualMatch(localPlan, actualFrom(ciPlan, { planDigest: localPlan.contentDigest })),
        /planned\/actual mismatch: executablePath/u
    );
});

test('managed planned and actual identity exact match is accepted', () =>
{
    const plan = fixture().create();
    assert.equal(assertBrowserPlanActualMatch(plan, actualFrom(plan)), true);
    assert.throws(() => bindBrowserRenderingObservation(plan, actualFrom(plan), {
        locale: 'en-US', deviceScaleFactor: 1, colorScheme: 'light', renderer: 'SwiftShader'
    }), /rendering observation mismatch/u);
    const bound = bindBrowserRenderingObservation(plan, actualFrom(plan), {
        locale: 'zh-CN', deviceScaleFactor: 1, colorScheme: 'light', renderer: 'SwiftShader'
    });
    assert.match(bound.contentDigest, /^sha256:[a-f0-9]{64}$/u);
});
