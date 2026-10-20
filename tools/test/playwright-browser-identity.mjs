/**
 * @typedef {'chromium' | 'firefox' | 'webkit'} CorrectnessBrowserName
 * @typedef {'correctness' | 'browser-contract'} BrowserEvidenceClass
 * @typedef {{ fontSetDigest: string; localeDataDigest: string; locale: string; deviceScaleFactor: number; renderingMode: 'headless'; colorScheme: 'light'; gpuMode: 'software'; }} BrowserRenderingIdentity
 * @typedef {{ locale: string; deviceScaleFactor: number; colorScheme: 'light' | 'dark'; renderer: string; }} BrowserRenderingObservation
 * @typedef {{ schema: string; correctness: { managedOnly: true; allowedEvidenceClasses: BrowserEvidenceClass[]; browserNames: CorrectnessBrowserName[]; forbiddenExecutableEnvironment: string[]; launch: Record<CorrectnessBrowserName, { headless: true; args: string[]; gpuMode: 'software'; firefoxUserPrefs?: Record<string, string | number | boolean>; }>; rendering: { renderingMode: 'headless'; deviceScaleFactor: number; colorScheme: 'light'; }; fontSourceFiles: string[]; fontPackages: string[]; localeSourceRoot: string; }; diagnostic: { qualificationEligible: false; hostBrowserAllowed: true; }; }} PlaywrightBrowserIdentityPolicy
 * @typedef {{ schema: 'fsusblog.playwright-browser-identity.v1'; executionClass: 'correctness'; evidenceClass: BrowserEvidenceClass; qualificationEligible: true; managedExecutable: true; browserName: CorrectnessBrowserName; browserVersion: string; revision: string; executablePath: string; executableSha256: string; playwright: { package: string; version: string; packageDigest: string; browserCatalogDigest: string; }; launchOptions: import('@playwright/test').LaunchOptions & { args: string[]; }; rendering: BrowserRenderingIdentity; contentDigest: string; browserType: import('@playwright/test').BrowserType; }} CorrectnessBrowserPlan
 * @typedef {Omit<CorrectnessBrowserPlan, 'browserType'>} SerializableBrowserPlan
 * @typedef {Omit<SerializableBrowserPlan, 'schema'> & { schema: 'fsusblog.playwright-browser-actual.v1'; planDigest: string; renderingObservation?: BrowserRenderingObservation; }} CorrectnessBrowserActual
 * @typedef {{ browserName?: CorrectnessBrowserName; evidenceClass?: BrowserEvidenceClass; locale?: string; additionalLaunchArgs?: string[]; repoRoot?: string; frontendRoot?: string; env?: Record<string, string | undefined>; fileSystem?: typeof import('node:fs'); requireFactory?: typeof import('node:module').createRequire; policy?: PlaywrightBrowserIdentityPolicy; }} CorrectnessBrowserPlanOptions
 */

/* global document, devicePixelRatio, matchMedia */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const policyFile = path.join(repositoryRoot, 'config/testing/playwright-browser-identity-policy.json');
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const browserNames = new Set(['chromium', 'firefox', 'webkit']);
const evidenceClasses = new Set(['correctness', 'browser-contract']);

function canonicalJson(value)
{
    if (Array.isArray(value))
    {
        return `[${value.map(canonicalJson).join(',')}]`;
    }
    if (value && typeof value === 'object')
    {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function digest(value)
{
    return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function sha256File(file, fileSystem = fs)
{
    return digest(fileSystem.readFileSync(file));
}

function sortedFiles(root, fileSystem = fs)
{
    if (!fileSystem.existsSync(root))
    {
        throw new Error(`browser identity input is missing: ${root}`);
    }
    const files = [];
    const visit = (current) =>
    {
        const stat = fileSystem.lstatSync(current);
        if (stat.isSymbolicLink())
        {
            throw new Error(`browser identity input must not be a symlink: ${current}`);
        }
        if (stat.isFile())
        {
            files.push(current);
            return;
        }
        if (!stat.isDirectory())
        {
            throw new Error(`browser identity input is not a regular file or directory: ${current}`);
        }
        for (const name of fileSystem.readdirSync(current).sort())
        {
            visit(path.join(current, name));
        }
    };
    visit(root);
    return files;
}

function digestInputs(inputs, base, fileSystem = fs)
{
    const entries = [];
    for (const input of inputs)
    {
        const absolute = path.resolve(typeof input === 'string' ? input : input.file);
        for (const file of sortedFiles(absolute, fileSystem))
        {
            const suffix = path.relative(absolute, file).replaceAll(path.sep, '/');
            const key = typeof input === 'string'
                ? path.relative(base, file).replaceAll(path.sep, '/')
                : [input.key, suffix].filter(Boolean).join('/');
            entries.push({ path: key, sha256: sha256File(file, fileSystem) });
        }
    }
    entries.sort((left, right) => left.path.localeCompare(right.path));
    return { digest: digest(canonicalJson(entries)), entries };
}

function loadPolicy(file = policyFile, fileSystem = fs)
{
    const policy = JSON.parse(fileSystem.readFileSync(file, 'utf8'));
    return validatePlaywrightBrowserIdentityPolicy(policy);
}

function exactStrings(values, expected)
{
    return Array.isArray(values)
        && values.length === expected.length
        && values.every((value, index) => value === expected[index]);
}

function safeRelativeFiles(values)
{
    return Array.isArray(values)
        && values.length > 0
        && new Set(values).size === values.length
        && values.every((value) => typeof value === 'string'
            && value.trim() === value
            && value.length > 0
            && !path.isAbsolute(value)
            && !value.split(/[\\/]/u).includes('..'));
}

/**
 * @param {unknown} policy
 * @returns {PlaywrightBrowserIdentityPolicy}
 */
export function validatePlaywrightBrowserIdentityPolicy(policy)
{
    const correctness = policy?.correctness;
    const launchNames = Object.keys(correctness?.launch ?? {});
    if (policy?.schema !== 'fsusblog.playwright-browser-identity-policy.v1'
        || correctness?.managedOnly !== true
        || !exactStrings(correctness.allowedEvidenceClasses, ['correctness', 'browser-contract'])
        || !exactStrings(correctness.browserNames, ['chromium', 'firefox', 'webkit'])
        || !exactStrings(launchNames, ['chromium', 'firefox', 'webkit'])
        || !safeRelativeFiles(correctness.fontSourceFiles)
        || !safeRelativeFiles([correctness.localeSourceRoot])
        || !Array.isArray(correctness.fontPackages)
        || correctness.fontPackages.length === 0
        || new Set(correctness.fontPackages).size !== correctness.fontPackages.length
        || !Array.isArray(correctness.forbiddenExecutableEnvironment)
        || correctness.forbiddenExecutableEnvironment.length === 0
        || policy?.diagnostic?.qualificationEligible !== false
        || policy.diagnostic.hostBrowserAllowed !== true)
    {
        throw new Error('Playwright browser identity policy is incomplete');
    }
    for (const browserName of correctness.browserNames)
    {
        const launch = correctness.launch[browserName];
        if (launch?.headless !== true
            || launch.gpuMode !== 'software'
            || !Array.isArray(launch.args)
            || new Set(launch.args).size !== launch.args.length)
        {
            throw new Error(`Playwright browser launch policy is incomplete: ${browserName}`);
        }
    }
    if (correctness.rendering?.renderingMode !== 'headless'
        || correctness.rendering.colorScheme !== 'light'
        || !(Number.isFinite(correctness.rendering.deviceScaleFactor)
            && correctness.rendering.deviceScaleFactor > 0))
    {
        throw new Error('Playwright rendering policy is incomplete');
    }
    return policy;
}

function packageResolution(frontendRoot, browserName, requireFactory = createRequire, fileSystem = fs)
{
    const require = requireFactory(path.join(frontendRoot, 'package.json'));
    const packageFile = require.resolve('@playwright/test/package.json', { paths: [frontendRoot] });
    const packageJson = JSON.parse(fileSystem.readFileSync(packageFile, 'utf8'));
    const corePackageFile = require.resolve('playwright-core/package.json', { paths: [path.dirname(packageFile)] });
    const browsersFile = path.join(path.dirname(corePackageFile), 'browsers.json');
    const browsers = JSON.parse(fileSystem.readFileSync(browsersFile, 'utf8')).browsers;
    const catalogName = browserName === 'chromium' ? 'chromium' : browserName;
    const catalog = browsers.find((entry) => entry.name === catalogName);
    if (!catalog || !catalog.revision || !catalog.browserVersion)
    {
        throw new Error(`managed Playwright browser catalog entry is incomplete: ${browserName}`);
    }
    const playwright = require(require.resolve('@playwright/test', { paths: [frontendRoot] }));
    const browserType = playwright[browserName];
    if (!browserType || typeof browserType.executablePath !== 'function')
    {
        throw new Error(`managed Playwright browser type is unavailable: ${browserName}`);
    }
    return { browserType, packageFile, packageJson, browsersFile, catalog };
}

function executableIdentity(executablePath, allowedRevisions, fileSystem = fs)
{
    if (!path.isAbsolute(executablePath))
    {
        throw new Error('managed browser executable path must be absolute');
    }
    if (!fileSystem.existsSync(executablePath))
    {
        throw new Error(`managed browser is missing: ${executablePath}`);
    }
    const stat = fileSystem.lstatSync(executablePath);
    if (!stat.isFile() || stat.isSymbolicLink())
    {
        throw new Error(`managed browser executable is unsafe: ${executablePath}`);
    }
    const real = fileSystem.realpathSync(executablePath);
    if (real !== path.resolve(executablePath))
    {
        throw new Error(`managed browser executable path is not canonical: ${executablePath}`);
    }
    const revisionMatch = executablePath.match(/(?:chromium|chromium_headless_shell|firefox|webkit)-([0-9]+)/u);
    const revision = revisionMatch?.[1] ?? '';
    if (!revision || !allowedRevisions.has(revision))
    {
        throw new Error(`managed browser revision does not match Playwright catalog: ${revision || 'unknown'}`);
    }
    return { executablePath: real, executableSha256: sha256File(real, fileSystem), revision };
}

function assertRenderingIdentity(rendering)
{
    const required = [
        'fontSetDigest', 'localeDataDigest', 'locale', 'deviceScaleFactor',
        'renderingMode', 'colorScheme', 'gpuMode'
    ];
    for (const key of required)
    {
        if (rendering?.[key] === undefined || rendering[key] === null || rendering[key] === '')
        {
            throw new Error(`correctness browser rendering identity is missing: ${key}`);
        }
    }
    if (!digestPattern.test(rendering.fontSetDigest) || !digestPattern.test(rendering.localeDataDigest))
    {
        throw new Error('correctness browser rendering digests are invalid');
    }
    if (!(Number.isFinite(rendering.deviceScaleFactor) && rendering.deviceScaleFactor > 0))
    {
        throw new Error('correctness browser deviceScaleFactor must be positive');
    }
}

/**
 * @param {CorrectnessBrowserPlanOptions} [options]
 * @returns {CorrectnessBrowserPlan}
 */
export function createCorrectnessBrowserPlan({
    browserName = 'chromium',
    evidenceClass = 'correctness',
    locale,
    additionalLaunchArgs = [],
    repoRoot = repositoryRoot,
    frontendRoot = path.join(repositoryRoot, 'src/frontend'),
    env = process.env,
    fileSystem = fs,
    requireFactory = createRequire,
    policy = loadPolicy(policyFile, fileSystem)
} = {})
{
    policy = validatePlaywrightBrowserIdentityPolicy(policy);
    if (!browserNames.has(browserName))
    {
        throw new Error(`unsupported correctness browser: ${browserName}`);
    }
    if (!evidenceClasses.has(evidenceClass))
    {
        throw new Error(`invalid correctness browser evidence class: ${evidenceClass}`);
    }
    if (typeof locale !== 'string' || !locale.trim())
    {
        throw new Error('correctness browser locale is required');
    }
    for (const name of policy.correctness.forbiddenExecutableEnvironment)
    {
        if (String(env[name] ?? '').trim())
        {
            throw new Error(`correctness browser forbids host executable override: ${name}`);
        }
    }

    const resolved = packageResolution(frontendRoot, browserName, requireFactory, fileSystem);
    const executablePath = resolved.browserType.executablePath();
    const allowedRevisions = new Set([
        String(resolved.catalog.revision),
        ...Object.values(resolved.catalog.revisionOverrides ?? {}).map(String)
    ]);
    const executable = executableIdentity(executablePath, allowedRevisions, fileSystem);
    const packageRequire = requireFactory(path.join(frontendRoot, 'package.json'));
    const fontPackageFiles = policy.correctness.fontPackages.map((name) => ({
        file: packageRequire.resolve(`${name}/package.json`, { paths: [frontendRoot] }),
        key: `managed-font-package/${name}/package.json`
    }));
    const fontInputs = [
        ...policy.correctness.fontSourceFiles.map((file) => path.join(repoRoot, file)),
        ...fontPackageFiles,
        path.join(frontendRoot, 'package-lock.json')
    ];
    const fontIdentity = digestInputs(fontInputs, repoRoot, fileSystem);
    const localeIdentity = digestInputs(
        [path.join(repoRoot, policy.correctness.localeSourceRoot)],
        repoRoot,
        fileSystem
    );
    const launchPolicy = policy.correctness.launch[browserName];
    const rendering = {
        fontSetDigest: fontIdentity.digest,
        localeDataDigest: localeIdentity.digest,
        locale: locale.trim(),
        deviceScaleFactor: policy.correctness.rendering.deviceScaleFactor,
        renderingMode: policy.correctness.rendering.renderingMode,
        colorScheme: policy.correctness.rendering.colorScheme,
        gpuMode: launchPolicy.gpuMode
    };
    assertRenderingIdentity(rendering);
    if (!Array.isArray(additionalLaunchArgs)
        || additionalLaunchArgs.some((value) => typeof value !== 'string' || !value.trim()))
    {
        throw new Error('additional correctness browser launch arguments must be non-empty strings');
    }
    const launchOptions = {
        headless: launchPolicy.headless,
        executablePath: executable.executablePath,
        args: [...new Set([...launchPolicy.args, ...additionalLaunchArgs])],
        ...(launchPolicy.firefoxUserPrefs ? { firefoxUserPrefs: { ...launchPolicy.firefoxUserPrefs } } : {})
    };
    const plan = {
        schema: 'fsusblog.playwright-browser-identity.v1',
        executionClass: 'correctness',
        evidenceClass,
        qualificationEligible: true,
        managedExecutable: true,
        browserName,
        browserVersion: String(resolved.catalog.browserVersion),
        revision: executable.revision,
        executablePath: executable.executablePath,
        executableSha256: executable.executableSha256,
        playwright: {
            package: '@playwright/test',
            version: String(resolved.packageJson.version),
            packageDigest: sha256File(resolved.packageFile, fileSystem),
            browserCatalogDigest: sha256File(resolved.browsersFile, fileSystem)
        },
        launchOptions,
        rendering
    };
    return { ...plan, contentDigest: digest(canonicalJson(plan)), browserType: resolved.browserType };
}

/**
 * @param {CorrectnessBrowserPlan} plan
 * @returns {{ browserName: CorrectnessBrowserName; launchOptions: CorrectnessBrowserPlan['launchOptions']; locale: string; deviceScaleFactor: number; colorScheme: 'light'; }}
 */
export function correctnessProjectUse(plan)
{
    validateBrowserIdentityPlan(plan);
    return {
        browserName: plan.browserName,
        launchOptions: structuredClone(plan.launchOptions),
        locale: plan.rendering.locale,
        deviceScaleFactor: plan.rendering.deviceScaleFactor,
        colorScheme: plan.rendering.colorScheme
    };
}

/**
 * @param {CorrectnessBrowserPlan} plan
 * @returns {SerializableBrowserPlan}
 */
export function serializableBrowserPlan(plan)
{
    validateBrowserIdentityPlan(plan);
    const serializable = { ...plan };
    delete serializable.browserType;
    return structuredClone(serializable);
}

/**
 * @param {{ plans: readonly SerializableBrowserPlan[]; frontendRoot: string; env?: Record<string, string | undefined>; }} [options]
 * @returns {Promise<CorrectnessBrowserActual[]>}
 */
export async function verifyCorrectnessBrowserPlans({ plans, frontendRoot, env = process.env } = {})
{
    if (!Array.isArray(plans) || plans.length === 0)
    {
        throw new Error('correctness Playwright requires at least one browser identity plan');
    }
    const receipts = [];
    for (const suppliedPlan of plans)
    {
        validateBrowserIdentityPlan(suppliedPlan);
        const currentPlan = createCorrectnessBrowserPlan({
            browserName: suppliedPlan.browserName,
            evidenceClass: suppliedPlan.evidenceClass,
            locale: suppliedPlan.rendering.locale,
            frontendRoot,
            env
        });
        const baselineLaunchArgs = new Set(currentPlan.launchOptions.args);
        const additionalLaunchArgs = suppliedPlan.launchOptions.args.filter(
            (argument) => !baselineLaunchArgs.has(argument)
        );
        const sealedCurrentPlan = createCorrectnessBrowserPlan({
            browserName: suppliedPlan.browserName,
            evidenceClass: suppliedPlan.evidenceClass,
            locale: suppliedPlan.rendering.locale,
            additionalLaunchArgs,
            frontendRoot,
            env
        });
        assertBrowserPlanActualMatch(suppliedPlan, {
            ...serializableBrowserPlan(sealedCurrentPlan),
            planDigest: suppliedPlan.contentDigest
        });
        let browser;
        try
        {
            browser = await sealedCurrentPlan.browserType.launch(structuredClone(suppliedPlan.launchOptions));
            const context = await browser.newContext({
                locale: suppliedPlan.rendering.locale,
                deviceScaleFactor: suppliedPlan.rendering.deviceScaleFactor,
                colorScheme: suppliedPlan.rendering.colorScheme
            });
            const page = await context.newPage();
            const observation = await observeBrowserRendering(page);
            assertBrowserRenderingObservation(suppliedPlan, observation);
            await context.close();
            const actual = bindBrowserRenderingObservation(suppliedPlan, observeCorrectnessBrowser({
                plan: suppliedPlan,
                browser,
                launchOptions: suppliedPlan.launchOptions,
                rendering: suppliedPlan.rendering
            }), observation);
            receipts.push(actual);
        }
        finally
        {
            await browser?.close().catch(() =>
            {});
        }
    }
    return receipts;
}

/**
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<BrowserRenderingObservation>}
 */
export async function observeBrowserRendering(page)
{
    return page.evaluate(() =>
    {
        const canvas = document.createElement('canvas');
        const webgl = canvas.getContext('webgl');
        const extension = webgl?.getExtension('WEBGL_debug_renderer_info');
        return {
            locale: navigator.language,
            deviceScaleFactor: devicePixelRatio,
            colorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
            renderer: extension ? String(webgl.getParameter(extension.UNMASKED_RENDERER_WEBGL)) : 'webgl-unavailable'
        };
    });
}

/**
 * @param {CorrectnessBrowserPlan} plan
 * @param {BrowserRenderingObservation} observation
 * @returns {true}
 */
export function assertBrowserRenderingObservation(plan, observation)
{
    validateBrowserIdentityPlan(plan);
    if (observation?.locale !== plan.rendering.locale
        || observation?.deviceScaleFactor !== plan.rendering.deviceScaleFactor
        || observation?.colorScheme !== plan.rendering.colorScheme
        || typeof observation?.renderer !== 'string'
        || !observation.renderer)
    {
        throw new Error(`correctness browser rendering observation mismatch: ${canonicalJson(observation)}`);
    }
    if (plan.browserName === 'chromium'
        && plan.rendering.gpuMode === 'software'
        && !/(?:swiftshader|llvmpipe|software|webgl-unavailable)/iu.test(observation.renderer))
    {
        throw new Error(`correctness browser GPU mode is not software: ${observation.renderer}`);
    }
    return true;
}

/**
 * @param {CorrectnessBrowserPlan} plan
 * @param {CorrectnessBrowserActual} actual
 * @param {BrowserRenderingObservation} observation
 * @returns {CorrectnessBrowserActual}
 */
export function bindBrowserRenderingObservation(plan, actual, observation)
{
    assertBrowserPlanActualMatch(plan, actual);
    assertBrowserRenderingObservation(plan, observation);
    const content = { ...actual, renderingObservation: structuredClone(observation) };
    delete content.contentDigest;
    return { ...content, contentDigest: digest(canonicalJson(content)) };
}

/**
 * @param {unknown} plan
 * @returns {SerializableBrowserPlan}
 */
export function validateBrowserIdentityPlan(plan)
{
    if (plan?.schema !== 'fsusblog.playwright-browser-identity.v1'
        || plan.executionClass !== 'correctness'
        || !evidenceClasses.has(plan.evidenceClass)
        || plan.qualificationEligible !== true
        || plan.managedExecutable !== true
        || !browserNames.has(plan.browserName))
    {
        throw new Error('correctness browser plan classification is invalid');
    }
    for (const key of ['browserVersion', 'revision', 'executablePath', 'executableSha256', 'contentDigest'])
    {
        if (!plan[key])
        {
            throw new Error(`correctness browser plan is missing: ${key}`);
        }
    }
    if (!path.isAbsolute(plan.executablePath) || !digestPattern.test(plan.executableSha256))
    {
        throw new Error('correctness browser executable identity is invalid');
    }
    assertRenderingIdentity(plan.rendering);
    const { contentDigest, ...content } = plan;
    delete content.browserType;
    delete content.browserType;
    if (contentDigest !== digest(canonicalJson(content)))
    {
        throw new Error('correctness browser plan digest mismatch');
    }
    return plan;
}

/**
 * @param {{ plan: CorrectnessBrowserPlan; browser: Pick<import('@playwright/test').Browser, 'version'>; launchOptions?: CorrectnessBrowserPlan['launchOptions']; rendering?: BrowserRenderingIdentity; fileSystem?: typeof import('node:fs'); }} options
 * @returns {CorrectnessBrowserActual}
 */
export function observeCorrectnessBrowser({ plan, browser, launchOptions = plan?.launchOptions, rendering = plan?.rendering, fileSystem = fs })
{
    validateBrowserIdentityPlan(plan);
    const actual = {
        schema: 'fsusblog.playwright-browser-actual.v1',
        executionClass: 'correctness',
        evidenceClass: plan.evidenceClass,
        qualificationEligible: true,
        managedExecutable: true,
        browserName: plan.browserName,
        browserVersion: String(browser?.version?.() ?? ''),
        revision: plan.revision,
        executablePath: plan.executablePath,
        executableSha256: sha256File(plan.executablePath, fileSystem),
        playwright: structuredClone(plan.playwright),
        launchOptions: structuredClone(launchOptions),
        rendering: structuredClone(rendering),
        planDigest: plan.contentDigest
    };
    assertBrowserPlanActualMatch(plan, actual);
    return { ...actual, contentDigest: digest(canonicalJson(actual)) };
}

/**
 * @param {CorrectnessBrowserPlan} plan
 * @param {CorrectnessBrowserActual} actual
 * @returns {true}
 */
export function assertBrowserPlanActualMatch(plan, actual)
{
    validateBrowserIdentityPlan(plan);
    if (actual?.executionClass !== 'correctness'
        || actual.evidenceClass !== plan.evidenceClass
        || actual.qualificationEligible !== true
        || actual.managedExecutable !== true)
    {
        throw new Error('diagnostic browser identity cannot satisfy correctness');
    }
    const comparisons = [
        'browserName', 'browserVersion', 'revision', 'executablePath', 'executableSha256', 'playwright', 'launchOptions', 'rendering'
    ];
    for (const key of comparisons)
    {
        if (canonicalJson(actual[key]) !== canonicalJson(plan[key]))
        {
            throw new Error(`correctness browser planned/actual mismatch: ${key}`);
        }
    }
    if (actual.planDigest !== plan.contentDigest)
    {
        throw new Error('correctness browser actual plan digest mismatch');
    }
    return true;
}

/**
 * @param {{ browserName: string; executablePath: string; browserVersion: string; }} options
 * @returns {{ schema: 'fsusblog.playwright-browser-diagnostic.v1'; executionClass: 'diagnostic'; evidenceClass: 'diagnostic'; qualificationEligible: false; managedExecutable: false; browserName: string; browserVersion: string; executablePath: string; }}
 */
export function diagnosticBrowserIdentity({ browserName, executablePath, browserVersion })
{
    return {
        schema: 'fsusblog.playwright-browser-diagnostic.v1',
        executionClass: 'diagnostic',
        evidenceClass: 'diagnostic',
        qualificationEligible: false,
        managedExecutable: false,
        browserName,
        browserVersion,
        executablePath
    };
}

export const playwrightBrowserIdentityPolicyFile = policyFile;
