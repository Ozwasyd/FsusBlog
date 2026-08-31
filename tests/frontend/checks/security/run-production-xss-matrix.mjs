#!/usr/bin/env node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

import { verifyProductionBuildReceipt } from '../../../../tools/ci/production-build-artifacts.mjs';
import {
    bindBrowserRenderingObservation,
    createCorrectnessBrowserPlan,
    observeBrowserRendering,
    observeCorrectnessBrowser,
    serializableBrowserPlan
} from '../../../../tools/test/playwright-browser-identity.mjs';
import { deriveLocalPublicContentFixtureSecret } from '../../../browser-contract/default-fixture-provider.mjs';
import { loadBrowserContractFixture } from '../../../browser-contract/fixture.mjs';
import {
    cleanupSingleBrowserContractFixture,
    prepareSingleBrowserContractFixture
} from '../../../browser-contract/prepare-fixture.mjs';
import { navigateThroughRetryablePublicAot } from '../../support/playwright/publicAotNavigationRetry.mjs';
import {
    loadProductionXssCorpus,
    markdownForCorpusCase,
    persistenceSafeMarkdownForCorpusCase,
    resolveMetadataProbe,
    resolveProductionFeatureGatewayAsset,
    selectProductionXssCases
} from '../../support/security/productionXssCorpus.mjs';
import {
    evaluateSecurityObservation,
    isSecurityRelevantConsoleMessage,
    productionXssRelevantCspDirectives,
    recordMainFrameNavigation
} from '../../support/security/productionXssObserver.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '../../../..');
const frontendRoot = path.join(repositoryRoot, 'src', 'frontend');
const require = createRequire(import.meta.url);
const playwright = require(require.resolve('@playwright/test', { paths: [frontendRoot] }));
const mode = process.argv.includes('--release') ? 'release' : 'fast';
let baseUrl = String(process.env.PLAYWRIGHT_BASE_URL ?? process.env.FSUSBLOG_PUBLIC_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/u, '');
let featureGatewayAssetUrl = null;
let adminStorageState = null;
let browserBusinessEpochUtc = null;
const outputRoot = path.join(frontendRoot, 'test-results', 'playwright', `production-xss-${mode}`);
const reportPath = path.join(outputRoot, 'matrix.json');
const startedAt = new Date().toISOString();
const started = performance.now();
const spaNavigationTimeoutMs = 30_000;
const productionLocale = 'zh-CN';

function expectedSourceState()
{
    const commit = String(process.env.FSUSBLOG_TEST_SOURCE_COMMIT ?? '').trim();
    const worktreeFingerprint = String(process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT ?? '').trim();
    if (!/^[a-f0-9]{40}$/u.test(commit) || !/^(?:sha256:)?[a-f0-9]{64}$/u.test(worktreeFingerprint))
    {
        throw new Error('production XSS matrix requires complete source commit and worktree fingerprint identity');
    }
    return { commit, worktreeFingerprint };
}

function verifyImmutableBuild(sourceState)
{
    const receiptFile = path.resolve(
        process.env.FSUSBLOG_BROWSER_CONTRACT_BUILD_RECEIPT
      ?? path.join(repositoryRoot, '.tmp', 'ci-production-build', 'receipt.json')
    );
    const result = verifyProductionBuildReceipt({
        artifactRoot: path.dirname(receiptFile),
        receiptFile: path.basename(receiptFile),
        expectedSourceState: sourceState
    });
    const requiredDomains = ['backend-runtime', 'frontend-dist', 'generated-contracts', 'wasm'];
    const domains = new Set(result.receipt.domains.map((domain) => domain.name));
    const missing = requiredDomains.filter((domain) => !domains.has(domain));
    if (missing.length)
    {
        throw new Error(`immutable production build is missing XSS matrix domains: ${missing.join(', ')}`);
    }
    const manifestFile = path.join(path.dirname(receiptFile), 'payload', 'frontend-dist', '.vite', 'manifest.json');
    const featureGateway = resolveProductionFeatureGatewayAsset(
        JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
    );
    return {
        receipt: path.relative(repositoryRoot, receiptFile).replaceAll(path.sep, '/'),
        receiptContentDigest: result.receipt.contentDigest,
        sourceState: result.receipt.sourceState,
        profile: result.receipt.build?.profile ?? null,
        domains: requiredDomains,
        artifactCount: result.evidence.artifactCount,
        artifactBytes: result.evidence.artifactBytes,
        featureGateway,
        verifiedAt: result.evidence.verifiedAt
    };
}

async function prepareProductionRuntime()
{
    const sourceState = expectedSourceState();
    const build = verifyImmutableBuild(sourceState);
    const env = {
        ...process.env,
        FSUSBLOG_PLAYWRIGHT_SESSION_MODE: 'browser-contract',
        FSUSBLOG_BROWSER_CONTRACT_SESSIONS: '1',
        FSUSBLOG_BROWSER_CONTRACT_CONCURRENCY: '1',
        FSUSBLOG_BROWSER_CONTRACT_RUN_ID: `${process.env.FSUSBLOG_BROWSER_CONTRACT_RUN_ID ?? `local-${process.pid}`}-production-xss-${mode}`
    };
    const prepared = await prepareSingleBrowserContractFixture({
        env,
        repoRoot: repositoryRoot,
        sourceState: build.sourceState,
        build
    });
    const providerState = JSON.parse(await readFile(path.join(prepared.root, 'provider-state.json'), 'utf8'));
    const businessEpochUtc = String(
        providerState.runtime?.temporalObservation?.businessEpochUtc ?? ''
    ).trim();
    if (!businessEpochUtc || !Number.isFinite(Date.parse(businessEpochUtc)))
    {
        throw new Error('browser contract runtime omitted its business epoch');
    }
    const fixture = await loadBrowserContractFixture({
        env: {
            ...env,
            FSUSBLOG_FIXTURE_ROOT: prepared.root,
            FSUSBLOG_TEST_NAMESPACE: prepared.identity.namespace
        },
        repoRoot: repositoryRoot,
        fixtureRoot: prepared.root,
        lifecycle: prepared.lifecycle,
        expectedSourceState: build.sourceState,
        expectedBuild: build
    });
    const secret = deriveLocalPublicContentFixtureSecret({
        identity: prepared.identity,
        preparation: prepared.preparation,
        sourceState: prepared.sourceState
    }, providerState.runtimeRunId);
    baseUrl = prepared.manifest.baseUrl.replace(/\/+$/u, '');
    featureGatewayAssetUrl = build.featureGateway;
    adminStorageState = fixture.admin.storageState;
    browserBusinessEpochUtc = businessEpochUtc;
    process.env.PLAYWRIGHT_BASE_URL = baseUrl;
    process.env.FSUSBLOG_TEST_NAMESPACE = prepared.identity.namespace;
    process.env.FSUSBLOG_TEST_RUN_ID = providerState.runtimeRunId;
    process.env.FSUSBLOG_LOCAL_PUBLIC_CONTENT_FIXTURE_SECRET = secret;
    return { prepared, build };
}

function sha256(value)
{
    return createHash('sha256').update(value).digest('hex');
}

function representativeCategoryCases(cases)
{
    const representatives = new Map();
    for (const entry of cases)
    {
        if (!representatives.has(entry.category)
      || entry.id === 'mxss-resource-code-fence')
        {
            representatives.set(entry.category, entry);
        }
    }
    return [...representatives.values()];
}

function aboutSurfaceCases(cases)
{
    const safeControlCase = cases.find((entry) => entry.id === 'mxss-url-safe-relative-control');
    return safeControlCase ? [safeControlCase] : cases.slice(0, 1);
}

async function seed(cases, metadataText)
{
    const secret = process.env.FSUSBLOG_LOCAL_PUBLIC_CONTENT_FIXTURE_SECRET;
    if (!secret)
    {
        throw new Error('FSUSBLOG_LOCAL_PUBLIC_CONTENT_FIXTURE_SECRET is required');
    }
    const namespace = process.env.FSUSBLOG_TEST_NAMESPACE ?? process.env.FSUSBLOG_TEST_RUN_ID ?? 'production-xss-local';
    const aboutCases = aboutSurfaceCases(cases);
    const body = JSON.stringify({
        capabilities: ['public.article.published'],
        namespace,
        runId: 'production-xss',
        securityMatrix: {
            cases: cases.map((entry) => ({
                id: entry.id,
                category: entry.category,
                markdown: persistenceSafeMarkdownForCorpusCase(entry)
            })),
            aboutMarkdown: aboutCases.map((entry) => `<!-- ${entry.id} -->\n${persistenceSafeMarkdownForCorpusCase(entry)}`).join('\n\n'),
            metadataText
        }
    });
    const { status, text } = await new Promise((resolve, reject) =>
    {
        const target = new URL('/api/local/public-content-fixture/prepare', baseUrl);
        if (target.protocol !== 'http:')
        {
            reject(new Error(`security matrix fixture requires local HTTP runtime: ${target.origin}`));
            return;
        }
        const request = httpRequest(target, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
                'X-Fsus-Local-Public-Content-Fixture-Secret': secret,
                'X-Fsus-Test-Namespace': namespace,
                'X-Fsus-Test-Run-Id': process.env.FSUSBLOG_TEST_RUN_ID ?? namespace
            }
        }, (response) =>
        {
            const chunks = [];
            let responseBytes = 0;
            response.on('data', (chunk) =>
            {
                responseBytes += chunk.length;
                if (responseBytes > 1024 * 1024)
                {
                    request.destroy(new Error('security matrix fixture response exceeded 1 MiB'));
                    return;
                }
                chunks.push(chunk);
            });
            response.on('end', () => resolve({
                status: response.statusCode ?? 0,
                text: Buffer.concat(chunks).toString('utf8')
            }));
        });
        request.setTimeout(7 * 60_000, () =>
        {
            request.destroy(new Error('security matrix fixture did not respond within 7 minutes'));
        });
        request.on('error', reject);
        request.end(body);
    });
    if (status < 200 || status >= 300)
    {
        throw new Error(`security matrix seed failed HTTP ${status}: ${text.slice(0, 800)}`);
    }
    const payload = JSON.parse(text);
    const identities = payload.entityIdentities ?? payload.EntityIdentities ?? [];
    const articles = new Map();
    for (const item of identities)
    {
        const kind = item.kind ?? item.Kind;
        const handle = item.handle ?? item.Handle ?? '';
        if (kind === 'article' && handle.endsWith(':article'))
        {
            articles.set(handle.slice(0, -':article'.length), Number(item.id ?? item.Id));
        }
    }
    for (const entry of cases)
    {
        if (!Number.isInteger(articles.get(entry.id)))
        {
            throw new Error(`seed response missing article for ${entry.id}`);
        }
    }
    return { payload, articles };
}

const seededPublicRouteReadiness = new Map();

function waitForSeededPublicRoute(caseId, route)
{
    const existing = seededPublicRouteReadiness.get(route);
    if (existing)
    {
        return existing;
    }

    const readiness = (async () =>
    {
        const deadlineAt = Date.now() + (mode === 'release' ? 180_000 : 60_000);
        let lastStatus = null;
        while (Date.now() < deadlineAt)
        {
            const response = await fetch(`${baseUrl}${route}`, {
                headers: {
                    Accept: 'text/html',
                    'Accept-Language': productionLocale
                },
                redirect: 'manual'
            });
            lastStatus = response.status;
            if (response.status === 200)
            {
                return;
            }
            if (response.status !== 410 && response.status !== 503)
            {
                throw new Error(
                    `seeded public route readiness failed: case=${caseId} `
          + `route=${route} status=${response.status}`
                );
            }
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
        throw new Error(
            `seeded public route did not become readable before deadline: `
      + `case=${caseId} route=${route} status=${lastStatus ?? '<none>'}`
        );
    })();
    seededPublicRouteReadiness.set(route, readiness);
    return readiness;
}

function createObservation()
{
    return {
        dialogs: [],
        popups: [],
        downloads: [],
        externalRequests: [],
        unexpectedNavigations: [],
        cspViolations: [],
        trustedTypesErrors: [],
        dangerousDom: [],
        missingText: [],
        missingSelectors: [],
        executionSentinel: 0
    };
}

function allowNavigation(observation, url)
{
    observation.allowedNavigations ??= new Map();
    observation.allowedNavigations.set(url, (observation.allowedNavigations.get(url) ?? 0) + 1);
}

async function installObservers(context, page, observationRef)
{
    const observation = () => observationRef.current ?? observationRef;
    await context.route('**/*', async (route) =>
    {
        const url = route.request().url();
        if (/^(?:data|blob|about):/u.test(url) || new URL(url).origin === new URL(baseUrl).origin)
        {
            await route.continue();
            return;
        }
        observation().externalRequests.push(url);
        await route.abort('blockedbyclient');
    });
    page.on('dialog', async (dialog) =>
    {
        observation().dialogs.push(dialog.type());
        await dialog.dismiss();
    });
    page.on('popup', (popup) =>
    {
        observation().popups.push(popup.url());
        void popup.close();
    });
    page.on('download', (download) => observation().downloads.push(download.suggestedFilename()));
    page.on('framenavigated', (frame) =>
    {
        if (frame !== page.mainFrame() || frame.url() === 'about:blank')
        {
            return;
        }
        recordMainFrameNavigation(observation(), frame.url());
    });
    page.on('console', (message) =>
    {
        if (isSecurityRelevantConsoleMessage(message.text()))
        {
            observation().trustedTypesErrors.push(message.text());
        }
    });
    await page.addInitScript((relevantCspDirectives) =>
    {
        globalThis.__FSUSBLOG_XSS_EXECUTION_SENTINEL__ = 0;
        globalThis.__FSUSBLOG_XSS_CSP_VIOLATIONS__ = [];
        globalThis.__FSUSBLOG_XSS_TELEMETRY__ = [];
        globalThis.addEventListener('fsus:telemetry', (event) =>
        {
            const entries = globalThis.__FSUSBLOG_XSS_TELEMETRY__;
            entries.push({
                name: event.detail?.name ?? '<missing>',
                level: event.detail?.level ?? 'info',
                detail: event.detail?.detail ?? null
            });
            if (entries.length > 64)
            {
                entries.splice(0, entries.length - 64);
            }
        });
        globalThis.document.addEventListener('securitypolicyviolation', (event) =>
        {
            if (!relevantCspDirectives.includes(event.effectiveDirective))
            {
                return;
            }
            globalThis.__FSUSBLOG_XSS_CSP_VIOLATIONS__.push({
                blockedURI: event.blockedURI,
                directive: event.effectiveDirective
            });
        });
        for (const name of ['alert', 'confirm', 'prompt', 'open'])
        {
            globalThis[name] = () =>
            {
                globalThis.__FSUSBLOG_XSS_EXECUTION_SENTINEL__ += 1;
                return null;
            };
        }
    }, productionXssRelevantCspDirectives);
}

async function audit(page, entry, rootSelector, observation, {
    preserveSelectors = typeof entry.source === 'string'
} = {})
{
    const locator = page.locator(rootSelector).first();
    try
    {
        await locator.waitFor({ state: 'attached', timeout: 20_000 });
    }
    catch (error)
    {
        const rootSummary = await page.locator('body').evaluate((body) =>
            [...body.children].slice(0, 12).map((element) => ({
                tag: element.tagName.toLowerCase(),
                id: element.id || null,
                classes: [...element.classList].slice(0, 8)
            }))
        ).catch(() => []);
        throw new Error(
            `security audit root missing: selector=${rootSelector} url=${page.url()} `
      + `title=${JSON.stringify(await page.title().catch(() => ''))} roots=${JSON.stringify(rootSummary)}`,
            { cause: error }
        );
    }
    const dom = await locator.evaluate((root, invariants) =>
    {
        const failures = [];
        for (const selector of invariants.forbidSelectors ?? [])
        {
            try
            {
                if (root.matches(selector) || root.querySelector(selector))
                {
                    failures.push(`forbidden-selector:${selector}`);
                }
            }
            catch
            {
                failures.push(`invalid-forbidden-selector:${selector}`);
            }
        }
        for (const element of [root, ...root.querySelectorAll('*')])
        {
            if (!(invariants.allowedNamespaces ?? []).includes(element.namespaceURI))
            {
                failures.push(`namespace:${element.namespaceURI}`);
            }
            for (const attribute of element.attributes)
            {
                if (/^on/iu.test(attribute.name))
                {
                    failures.push(`event-attribute:${attribute.name}`);
                }
                if (/^(?:href|src|xlink:href|action|formaction|poster)$/iu.test(attribute.name))
                {
                    const value = attribute.value.trim();
                    if (/^(?:javascript|vbscript|data):/iu.test(value))
                    {
                        failures.push(`dangerous-url:${attribute.name}`);
                    }
                    else if (invariants.forbidExternalUrls === true && /^https?:/iu.test(value)
            && new URL(value, globalThis.location.href).origin !== globalThis.location.origin)
                    {
                        failures.push(`external-url:${attribute.name}`);
                    }
                }
            }
        }
        const text = root.textContent ?? '';
        return {
            dangerousDom: failures,
            missingSelectors: (invariants.preserveSelectors ?? []).filter((selector) =>
                !root.matches(selector) && !root.querySelector(selector)),
            missingText: (invariants.preserveText ?? []).filter((value) => !text.includes(value)),
            executionSentinel: globalThis.__FSUSBLOG_XSS_EXECUTION_SENTINEL__ ?? 0,
            cspViolations: globalThis.__FSUSBLOG_XSS_CSP_VIOLATIONS__ ?? []
        };
    }, {
        ...entry.invariants,
        preserveSelectors: preserveSelectors ? entry.preserve?.selectors ?? [] : [],
        preserveText: entry.preserve?.text ?? []
    });
    observation.dangerousDom.push(...dom.dangerousDom);
    observation.missingSelectors.push(...dom.missingSelectors);
    observation.missingText.push(...dom.missingText);
    observation.executionSentinel += dom.executionSentinel;
    observation.cspViolations.push(...dom.cspViolations);
    const failures = evaluateSecurityObservation(observation);
    if (failures.length)
    {
        throw new Error(`${entry.id} ${rootSelector}: ${failures.join(' | ')}`);
    }
}

function aboutAggregateCase(cases)
{
    const preservedSelectors = cases
        .filter((entry) => typeof entry.source === 'string')
        .flatMap((entry) => entry.preserve?.selectors ?? []);
    const broadPreservedTags = new Set(
        preservedSelectors
            .map((selector) => selector.match(/^[a-z][a-z0-9-]*/iu)?.[0])
            .filter(Boolean)
    );
    return {
        id: 'production-xss-about-aggregate',
        invariants: {
            forbidSelectors: [...new Set(cases.flatMap((entry) => entry.invariants.forbidSelectors))]
                .filter((selector) => !broadPreservedTags.has(selector)),
            forbidExternalUrls: true,
            allowedNamespaces: [...new Set(cases.flatMap((entry) => entry.invariants.allowedNamespaces))]
        },
        preserve: {
            text: [...new Set(cases.flatMap((entry) => entry.preserve?.text ?? []))],
            selectors: [...new Set(preservedSelectors)]
        }
    };
}

async function activateFeatureOutput(page, entry, rootSelector)
{
    if (!entry.featureOutput || !featureGatewayAssetUrl)
    {
        return null;
    }
    const root = page.locator(rootSelector).first();
    await root.evaluate(async (element, { assetUrl, caseId, output }) =>
    {
        const gateway = await import(assetUrl);
        if (typeof gateway.commitMarkdownFeatureOutput !== 'function')
        {
            throw new Error('production feature gateway export is missing');
        }
        const target = output.kind === 'code-highlight'
            ? Object.assign(globalThis.document.createElement('pre'), { className: 'shiki' })
            : globalThis.document.createElement('div');
        element.appendChild(target);
        const committed = gateway.commitMarkdownFeatureOutput(target, output, {
            mode: output.kind === 'code-highlight' ? 'replace-element' : undefined,
            nonce: globalThis.document.querySelector('meta[property="csp-nonce"], script[nonce], style[nonce]')?.nonce ?? null
        });
        committed.setAttribute('data-fsusblog-xss-feature-case', caseId);
    }, {
        assetUrl: featureGatewayAssetUrl,
        caseId: entry.id,
        output: entry.featureOutput
    });
    return `[data-fsusblog-xss-feature-case="${entry.id}"]`;
}

async function navigatePublicAot(page, url, observation)
{
    const response = await navigateThroughRetryablePublicAot({
        navigate: () =>
        {
            allowNavigation(observation, url);
            return page.goto(url, { waitUntil: 'domcontentloaded' });
        },
        sleep: (delayMs) => delay(delayMs),
        deadlineAtMs: Date.now() + 30_000
    });
    const status = response?.status();
    if (status !== 200)
    {
        const headers = await response?.allHeaders();
        throw new Error(
            `public AOT navigation failed: status=${status ?? '<none>'} url=${page.url()} `
      + `source=${headers?.['x-fsus-public-aot-source'] ?? '<missing>'} `
      + `state=${headers?.['x-fsus-public-aot-state'] ?? '<missing>'} `
      + `backfill=${headers?.['x-fsus-public-aot-backfill'] ?? '<missing>'}`
        );
    }
    return response;
}

async function runCasePhase({ browser, entry, phase, surface, route, entityId }, action)
{
    try
    {
        return await action();
    }
    catch (error)
    {
        const reproduction = `./tools/test.sh ci-tier production-xss-${mode} --fresh`;
        throw new Error(
            `production XSS case failed: browser=${browser} case=${entry.id} surface=${surface} `
      + `route=${route} entity=${entityId ?? '<none>'} phase=${phase} reproduce=${reproduction}`,
            { cause: error }
        );
    }
}

async function newBusinessClockPage(context)
{
    if (!browserBusinessEpochUtc)
    {
        throw new Error('browser business epoch was not prepared');
    }
    const page = await context.newPage();
    await page.clock.setFixedTime(new Date(browserBusinessEpochUtc));
    return page;
}

async function navigateFullAppRouter(page, target)
{
    await page.evaluate((nextTarget) =>
    {
        const app = globalThis.document.getElementById('app');
        const router = app?.__vue_app__?.config.globalProperties.$router;
        if (!router)
        {
            throw new Error('FullApp login route omitted its Vue Router');
        }
        globalThis.__FSUSBLOG_XSS_SPA_NAVIGATION_ERROR__ = null;
        globalThis.__FSUSBLOG_XSS_SPA_NAVIGATION_STAGE__ = 'push-started';
        const removeBeforeEach = router.beforeEach((to, from) =>
        {
            globalThis.__FSUSBLOG_XSS_SPA_NAVIGATION_STAGE__ = 'downstream-before-each';
            globalThis.__FSUSBLOG_XSS_SPA_NAVIGATION_ROUTE__ = {
                from: from.fullPath,
                to: to.fullPath
            };
        });
        const removeAfterEach = router.afterEach((to, from, failure) =>
        {
            globalThis.__FSUSBLOG_XSS_SPA_NAVIGATION_STAGE__ = failure
                ? 'after-each-failure'
                : 'after-each-success';
            globalThis.__FSUSBLOG_XSS_SPA_NAVIGATION_ROUTE__ = {
                from: from.fullPath,
                to: to.fullPath
            };
        });
        const removeOnError = router.onError((error) =>
        {
            globalThis.__FSUSBLOG_XSS_SPA_NAVIGATION_STAGE__ = 'router-error';
            globalThis.__FSUSBLOG_XSS_SPA_NAVIGATION_ERROR__ = error instanceof Error
                ? (error.stack ?? error.message)
                : String(error);
        });
        void router.push(nextTarget).then(() =>
        {
            globalThis.__FSUSBLOG_XSS_SPA_NAVIGATION_STAGE__ = 'push-resolved';
        }).catch((error) =>
        {
            globalThis.__FSUSBLOG_XSS_SPA_NAVIGATION_STAGE__ = 'push-rejected';
            globalThis.__FSUSBLOG_XSS_SPA_NAVIGATION_ERROR__ = error instanceof Error
                ? (error.stack ?? error.message)
                : String(error);
        }).finally(() =>
        {
            removeBeforeEach();
            removeAfterEach();
            removeOnError();
        });
    }, target);
    try
    {
        await page.waitForFunction(
            (expectedPath) => globalThis.location.pathname === expectedPath
        || typeof globalThis.__FSUSBLOG_XSS_SPA_NAVIGATION_ERROR__ === 'string',
            target,
            { timeout: spaNavigationTimeoutMs }
        );
    }
    catch (error)
    {
        const diagnostic = await page.evaluate(() =>
        {
            const app = globalThis.document.getElementById('app');
            const properties = app?.__vue_app__?.config.globalProperties;
            const router = properties?.$router;
            const piniaState = properties?.$pinia?.state?.value ?? {};
            return {
                stage: globalThis.__FSUSBLOG_XSS_SPA_NAVIGATION_STAGE__ ?? '<missing>',
                attemptedRoute: globalThis.__FSUSBLOG_XSS_SPA_NAVIGATION_ROUTE__ ?? null,
                currentRoute: router?.currentRoute?.value
                    ? {
              fullPath: router.currentRoute.value.fullPath,
              name: String(router.currentRoute.value.name ?? ''),
              matched: router.currentRoute.value.matched.map((entry) => String(entry.name ?? entry.path))
            }
                    : null,
                location: `${globalThis.location.pathname}${globalThis.location.search}${globalThis.location.hash}`,
                documentReadyState: globalThis.document.readyState,
                appShell: piniaState['app-shell'] ?? null,
                site: piniaState.site
                    ? {
              isLoaded: piniaState.site.isLoaded,
              title: piniaState.site.siteInfo?.title ?? null
            }
                    : null,
                telemetry: (globalThis.__FSUSBLOG_XSS_TELEMETRY__ ?? []).slice(-32),
                resources: performance.getEntriesByType('resource').slice(-32).map((entry) => ({
                    name: new URL(entry.name, globalThis.location.href).pathname,
                    initiatorType: entry.initiatorType,
                    duration: Math.round(entry.duration),
                    responseEnd: Math.round(entry.responseEnd)
                }))
            };
        }).catch((diagnosticError) => ({
            diagnosticError: diagnosticError instanceof Error
                ? diagnosticError.message
                : String(diagnosticError)
        }));
        throw new Error(
            `FullApp Router did not reach ${target} before ${spaNavigationTimeoutMs}ms: `
      + JSON.stringify(diagnostic),
            { cause: error }
        );
    }
    const navigationError = await page.evaluate(
        () => globalThis.__FSUSBLOG_XSS_SPA_NAVIGATION_ERROR__
    );
    if (navigationError)
    {
        throw new Error(`FullApp Router rejected ${target}: ${navigationError}`);
    }
    await page.waitForURL(`**${target}`, { timeout: spaNavigationTimeoutMs });
}

async function waitForFullAppRouterReady(page, expectedPath)
{
    await page.waitForFunction(
        (path) =>
        {
            const app = globalThis.document.getElementById('app');
            const router = app?.__vue_app__?.config.globalProperties.$router;
            return router?.currentRoute?.value.fullPath === path
        && router.currentRoute.value.matched.length > 0;
        },
        expectedPath,
        { timeout: spaNavigationTimeoutMs }
    );
}

async function runBrowser(browserName, browserType, identityPlan, cases, articles, results, browserIdentities)
{
    const launchOptions = identityPlan ? structuredClone(identityPlan.launchOptions) : { headless: true };
    const browser = await browserType.launch(launchOptions);
    try
    {
        let browserIdentity = null;
        if (identityPlan)
        {
            browserIdentity = {
                plan: serializableBrowserPlan(identityPlan),
                actual: observeCorrectnessBrowser({
                    plan: identityPlan,
                    browser,
                    launchOptions,
                    rendering: identityPlan.rendering
                })
            };
            browserIdentities.push(browserIdentity);
        }
        const renderingContext = identityPlan
            ? {
                locale: identityPlan.rendering.locale,
                deviceScaleFactor: identityPlan.rendering.deviceScaleFactor,
                colorScheme: identityPlan.rendering.colorScheme
            }
            : { locale: productionLocale };
        const surfaceCases = representativeCategoryCases(cases);
        const surfaceCaseIds = new Set(surfaceCases.map((entry) => entry.id));
        const noScript = await browser.newContext({
            javaScriptEnabled: false,
            ...renderingContext,
            serviceWorkers: 'block'
        });
        const noScriptPage = await newBusinessClockPage(noScript);
        const noScriptObservationRef = { current: createObservation() };
        await installObservers(noScript, noScriptPage, noScriptObservationRef);
        const context = await browser.newContext({
            ...renderingContext,
            serviceWorkers: 'block'
        });
        const page = await newBusinessClockPage(context);
        if (identityPlan)
        {
            browserIdentity.actual = bindBrowserRenderingObservation(
                identityPlan,
                browserIdentity.actual,
                await observeBrowserRendering(page)
            );
        }
        const observationRef = { current: createObservation() };
        await installObservers(context, page, observationRef);
        for (const entry of cases)
        {
            const articleId = articles.get(entry.id);
            const articleRoute = `/article/${articleId}`;
            await waitForSeededPublicRoute(entry.id, articleRoute);
            noScriptObservationRef.current = createObservation();
            const noScriptObservation = noScriptObservationRef.current;
            await runCasePhase({
                browser: browserName,
                entry,
                phase: 'aot-before-hydration',
                surface: 'public-article',
                route: articleRoute,
                entityId: articleId
            }, async () =>
            {
                await navigatePublicAot(noScriptPage, `${baseUrl}${articleRoute}`, noScriptObservation);
                await audit(noScriptPage, entry, '.markdown-body, [data-markdown-root], article', noScriptObservation, {
                    preserveSelectors: entry.surfaces.includes('ssr-no-dom')
                });
            });

            observationRef.current = createObservation();
            const observation = observationRef.current;
            await runCasePhase({
                browser: browserName,
                entry,
                phase: 'hydrated',
                surface: 'public-article',
                route: articleRoute,
                entityId: articleId
            }, async () =>
            {
                await navigatePublicAot(page, `${baseUrl}${articleRoute}`, observation);
                await page.locator('.markdown-body, [data-markdown-root], article').first().waitFor({
                    state: 'attached',
                    timeout: 30_000
                });
                await audit(page, entry, '.markdown-body, [data-markdown-root], article', observation);
                const featureRoot = await activateFeatureOutput(
                    page,
                    entry,
                    '.markdown-body, [data-markdown-root], article'
                );
                if (featureRoot)
                {
                    await audit(page, entry, featureRoot, observation, { preserveSelectors: true });
                }
            });
            results.push({ browser: browserName, caseId: entry.id, phase: 'aot-before-hydration', surface: 'public-article', status: 'ok', entityId: articleId });
            results.push({ browser: browserName, caseId: entry.id, phase: 'hydrated', surface: 'public-article', status: 'ok', entityId: articleId });
            if (entry.featureOutput)
            {
                results.push({
                    browser: browserName,
                    caseId: entry.id,
                    phase: 'feature-activation',
                    surface: 'markdown-feature-gateway',
                    status: 'ok',
                    entityId: articleId
                });
            }
            if (surfaceCaseIds.has(entry.id))
            {
                allowNavigation(observation, page.url());
                await page.reload({ waitUntil: 'domcontentloaded' });
                await page.locator(`#fsus-comments-island[data-article-id="${articleId}"]`).waitFor({
                    state: 'attached',
                    timeout: 30_000
                });
                await audit(page, entry, '[aria-label*="评论"], .comment-list, main', observation);
                const toggle = page.getByRole('button', { name: /回复|展开|折叠/u }).first();
                if (await toggle.count())
                {
                    await toggle.click();
                }
                await audit(page, entry, '[aria-label*="评论"], .comment-list, main', observation);
                results.push({ browser: browserName, caseId: entry.id, phase: 'persisted-reload', surface: 'comment-thread', status: 'ok', entityId: articleId });
            }
        }
        await noScript.close();
        await context.close();

        const aboutContext = await browser.newContext({
            ...renderingContext,
            serviceWorkers: 'block'
        });
        const aboutPage = await newBusinessClockPage(aboutContext);
        const aboutObservation = createObservation();
        await installObservers(aboutContext, aboutPage, aboutObservation);
        const aboutCases = aboutSurfaceCases(cases);
        const aboutCase = aboutAggregateCase(aboutCases);
        await navigatePublicAot(aboutPage, `${baseUrl}/about`, aboutObservation);
        await aboutPage.locator('.markdown-body, [data-markdown-root], main').first().waitFor({
            state: 'attached',
            timeout: 30_000
        });
        const aboutReadinessText = aboutCase.preserve.text.at(-1);
        if (aboutReadinessText)
        {
            await aboutPage.waitForFunction((expected) =>
            {
                const root = globalThis.document.querySelector('.markdown-body, [data-markdown-root], main');
                return root?.textContent?.includes(expected) === true;
            }, aboutReadinessText, { timeout: 30_000 });
        }
        await audit(
            aboutPage,
            aboutCase,
            '.markdown-body, [data-markdown-root], main',
            aboutObservation,
            { preserveSelectors: true }
        );
        for (const entry of aboutCases)
        {
            results.push({ browser: browserName, caseId: entry.id, phase: 'hydrated', surface: 'about-page', status: 'ok' });
        }
        await aboutContext.close();

        const spaContext = await browser.newContext({
            ...renderingContext,
            serviceWorkers: 'block'
        });
        const spaPage = await newBusinessClockPage(spaContext);
        const spaObservation = createObservation();
        await installObservers(spaContext, spaPage, spaObservation);
        allowNavigation(spaObservation, `${baseUrl}/login`);
        await spaPage.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded' });
        await spaPage.waitForFunction(() => globalThis.document.getElementById('app')?.__vue_app__ != null, {
            timeout: 30_000
        });
        await waitForFullAppRouterReady(spaPage, '/login');
        const spaDocumentSentinel = await spaPage.evaluate(() =>
        {
            globalThis.__FSUSBLOG_XSS_SPA_DOCUMENT_SENTINEL__ = crypto.randomUUID();
            return globalThis.__FSUSBLOG_XSS_SPA_DOCUMENT_SENTINEL__;
        });
        const [firstSpaCase, ...remainingSpaCases] = surfaceCases;
        const firstSpaArticleId = articles.get(firstSpaCase.id);
        const firstSpaTarget = `/article/${firstSpaArticleId}`;
        allowNavigation(spaObservation, `${baseUrl}${firstSpaTarget}`);
        await navigateFullAppRouter(spaPage, firstSpaTarget);
        await spaPage.locator(`#fsus-comments-island[data-article-id="${firstSpaArticleId}"]`).waitFor({
            state: 'attached',
            timeout: 30_000
        });
        if (await spaPage.evaluate(() => globalThis.__FSUSBLOG_XSS_SPA_DOCUMENT_SENTINEL__) !== spaDocumentSentinel)
        {
            throw new Error('FullApp login-to-article navigation replaced the browser document');
        }
        await audit(spaPage, firstSpaCase, '.markdown-body, [data-markdown-root], article', spaObservation);
        results.push({
            browser: browserName,
            caseId: firstSpaCase.id,
            phase: 'spa-navigation',
            surface: 'public-article',
            status: 'ok',
            entityId: firstSpaArticleId
        });
        for (const entry of remainingSpaCases)
        {
            const articleId = articles.get(entry.id);
            const target = `/article/${articleId}`;
            allowNavigation(spaObservation, `${baseUrl}${target}`);
            const spaNavProbe = spaPage.locator('#fsus-aot-shell a[data-public-nav]').first();
            await spaNavProbe.evaluate((anchor, url) => anchor.setAttribute('href', url), target);
            await spaNavProbe.click();
            await spaPage.waitForURL(`**${target}`, { timeout: spaNavigationTimeoutMs });
            await spaPage.locator(`#fsus-comments-island[data-article-id="${articleId}"]`).waitFor({
                state: 'attached',
                timeout: 30_000
            });
            if (await spaPage.evaluate(() => globalThis.__FSUSBLOG_XSS_SPA_DOCUMENT_SENTINEL__) !== spaDocumentSentinel)
            {
                throw new Error(`SPA navigation replaced the browser document: ${target}`);
            }
            await audit(spaPage, entry, '.markdown-body, [data-markdown-root], article', spaObservation);
            results.push({ browser: browserName, caseId: entry.id, phase: 'spa-navigation', surface: 'public-article', status: 'ok', entityId: articleId });
        }
        await spaContext.close();

        if (!adminStorageState)
        {
            throw new Error('portable admin storage state was not prepared');
        }
        const previewContext = await browser.newContext({
            ...renderingContext,
            storageState: adminStorageState,
            serviceWorkers: 'block'
        });
        const previewPage = await newBusinessClockPage(previewContext);
        const previewObservation = createObservation();
        await installObservers(previewContext, previewPage, previewObservation);
        allowNavigation(previewObservation, `${baseUrl}/user/manage/article/write?preview=private`);
        await previewPage.goto(`${baseUrl}/user/manage/article/write?preview=private`, { waitUntil: 'domcontentloaded' });
        const title = previewPage.getByPlaceholder('写下文章标题');
        const body = previewPage.locator('#article-content');
        const publishInspector = previewPage.locator(
            '.article-write-inspector-rail--desktop button[aria-label="发布"]'
        );
        const previewInspector = previewPage.locator(
            '.article-write-inspector-rail--desktop button[aria-label="预览"]'
        );
        const summary = previewPage.locator('textarea[name="articleSummary"]:visible');
        await previewPage.locator('#article-content:not([disabled])').waitFor({
            state: 'visible',
            timeout: 45_000
        });
        for (const entry of surfaceCases)
        {
            await runCasePhase({
                browser: browserName,
                entry,
                phase: 'authoring-preview',
                surface: 'private-preview',
                route: '/user/manage/article/write?preview=private'
            }, async () =>
            {
                await title.fill(`XSS ${entry.id}`);
                await body.fill(markdownForCorpusCase(entry));
                await publishInspector.click();
                await summary.fill(entry.id);
                await previewInspector.click();
                const previewArticle = previewPage.locator('.author-preview');
                const previousPreviewIdentity = await previewArticle.count() > 0
                    ? await previewArticle.getAttribute('data-preview-source-identity')
                    : null;
                await previewPage.getByRole('button', { name: '生成私有预览', exact: true }).click();
                await previewPage.waitForFunction((previousIdentity) =>
                {
                    const article = globalThis.document.querySelector('.author-preview');
                    const sourceIdentity = article?.getAttribute('data-preview-source-identity');
                    return Boolean(
                        sourceIdentity
            && sourceIdentity !== previousIdentity
            && article?.getAttribute('data-preview-render-complete') === sourceIdentity
                    );
                }, previousPreviewIdentity, { timeout: 45_000 });
                await audit(previewPage, entry, '.author-preview', previewObservation);
            });
            results.push({ browser: browserName, caseId: entry.id, phase: 'authoring-preview', surface: 'private-preview', status: 'ok' });
        }
        await previewContext.close();
    }
    finally
    {
        await browser.close();
    }
}

await mkdir(outputRoot, { recursive: true });
const results = [];
const browserIdentities = [];
let report;
let runtime = null;
let cleanup;
let failure = null;
let warmedStartedAt = null;
let warmedStarted = null;
let warmedDurationMs = null;
function serializeError(error)
{
    if (!(error instanceof Error))
    {
        return String(error);
    }
    const values = [];
    let current = error;
    while (current instanceof Error)
    {
        values.push(current.stack ?? current.message);
        current = current.cause;
    }
    return values.join('\nCaused by:\n');
}

try
{
    runtime = await prepareProductionRuntime();
    const corpusContract = await loadProductionXssCorpus();
    const cases = selectProductionXssCases(corpusContract.corpus, mode);
    const seeded = await seed(cases, resolveMetadataProbe(cases));
    const browsers = mode === 'release'
        ? ['chromium', 'firefox', 'webkit'].map((name) =>
{
            const plan = createCorrectnessBrowserPlan({
                browserName: name,
                evidenceClass: 'browser-contract',
                locale: productionLocale,
                frontendRoot,
                env: process.env
            });
            return [name, plan.browserType, plan];
        })
        : [['chromium', playwright.chromium, null]];
    warmedStartedAt = new Date().toISOString();
    warmedStarted = performance.now();
    try
    {
        await Promise.all(browsers.map(([name, type, plan]) =>
            runBrowser(name, type, plan, cases, seeded.articles, results, browserIdentities)));
    }
    finally
    {
        warmedDurationMs = Math.round(performance.now() - warmedStarted);
    }
    report = {
        schema: 'fsusblog.production-xss-browser-matrix.v1',
        status: 'ok',
        mode,
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Math.round(performance.now() - started),
        warmedStartedAt,
        warmedDurationMs,
        source: {
            corpus: corpusContract.source,
            corpusDigest: `sha256:${corpusContract.digest}`,
            corpusManifest: corpusContract.manifest,
            fsusUiRootDigest: sha256(corpusContract.fsusUiRoot),
            testOnlyContractPath: path.relative(repositoryRoot, corpusContract.contractPath)
        },
        browsers: browsers.map(([name]) => name),
        browserIdentities,
        caseCount: cases.length,
        entries: results,
        runtime: {
            namespace: runtime.prepared.identity.namespace,
            baseUrl,
            backendUrl: runtime.prepared.manifest.backendUrl,
            businessEpochUtc: browserBusinessEpochUtc,
            build: runtime.build
        }
    };
}
catch (error)
{
    failure = error;
    report = {
        schema: 'fsusblog.production-xss-browser-matrix.v1',
        status: 'failed',
        mode,
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Math.round(performance.now() - started),
        warmedStartedAt,
        warmedDurationMs: warmedStarted === null
            ? null
            : warmedDurationMs ?? Math.round(performance.now() - warmedStarted),
        error: serializeError(error),
        entries: results
    };
}
finally
{
    cleanup = await cleanupSingleBrowserContractFixture(runtime?.prepared, {
        reason: failure ? 'production-xss-failure' : 'completed'
    });
    for (let retry = 1; cleanup.status !== 'success' && runtime?.prepared && retry <= 4; retry += 1)
    {
        await new Promise((resolve) => setTimeout(resolve, 1_000 * retry));
        cleanup = await cleanupSingleBrowserContractFixture(runtime.prepared, {
            reason: `production-xss-cleanup-retry-${retry}`
        });
    }
    report.cleanup = cleanup;
    if (cleanup.status !== 'success')
    {
        report.status = 'failed';
        failure ??= new Error(`production XSS cleanup failed: ${cleanup.error?.message ?? cleanup.status}`);
    }
}
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
if (failure)
{
    throw failure;
}
console.log(`[production-xss] ${mode} OK cases=${report.caseCount} browsers=${report.browsers.join(',')} duration=${(report.durationMs / 1000).toFixed(2)}s report=${reportPath}`);
