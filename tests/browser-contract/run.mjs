#!/usr/bin/env node
// fixture-catalog: consumer browser-contract-run acceptance-representative

import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { chmod, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* eslint-disable import-x/no-relative-parent-imports */
import { verifyProductionBuildReceipt } from '../../tools/ci/production-build-artifacts.mjs';
import { requireCleanAttemptConsumerAdmission } from '../../tools/release/browser-release-clean-attempt-consumers.mjs';
import {
    sealBrowserContractReceipt,
    sha256File,
    validateBrowserContractReceipt
} from '../../tools/release/test-evidence-receipts.mjs';
import {
    bindBrowserRenderingObservation,
    createCorrectnessBrowserPlan,
    observeBrowserRendering,
    observeCorrectnessBrowser,
    serializableBrowserPlan
} from '../../tools/test/playwright-browser-identity.mjs';
import { loadTemporalContext } from '../../tools/test/temporal-context.mjs';
import {
    bindCorrectnessProducerTemporalArtifacts,
    observeBrowserTemporalContext
} from '../../tools/test/temporal-producer-bindings.mjs';

import {
    BrowserContractFailure,
    classifyBrowserContractFailure,
    createBrowserContractReceipt,
    finalizeBrowserContractReceipt,
    persistFinalBrowserContractReceipt,
    selectBrowserContractScenarios,
    serializeBrowserContractError,
    writeBrowserContractReceipt
} from './contract.mjs';
import { fixtureReceiptView, loadBrowserContractFixture } from './fixture.mjs';
import {
    cleanupSingleBrowserContractFixture,
    prepareSingleBrowserContractFixture,
    resolveBrowserContractRunIdentity
} from './prepare-fixture.mjs';
import { capturePublicPreviewGallery } from './public-preview-gallery.mjs';
import { admitPublicShellLocaleHarness, observePublicShellLocaleProbe } from './public-shell-locale-harness.mjs';
import { createPublicShellLocaleMatrix } from './public-shell-locale-matrix.mjs';
import {
    browserContractAppReadyTimeoutMs,
    browserContractScenarioRunners,
    createPageAudit
} from './scenarios.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const frontendRoot = path.join(root, 'src/frontend');
const outputRoot = path.resolve(process.env.FSUSBLOG_BROWSER_CONTRACT_OUTPUT || path.join(root, '.tmp/browser-contract'));
const receiptFile = path.resolve(process.env.FSUSBLOG_BROWSER_CONTRACT_RECEIPT || path.join(outputRoot, 'receipt.json'));
let traceRoot = null;
let screenshotRoot = null;
const buildReceiptFile = path.resolve(
    process.env.FSUSBLOG_BROWSER_CONTRACT_BUILD_RECEIPT || path.join(root, '.tmp/ci-production-build/receipt.json')
);
const startedAtEpochMs = Date.now();
const startedAtMonotonicMs = performance.now();
let browser = null;
let browserDisconnected = false;
let closingBrowser = false;
let receivedSignal = null;
let activeScenario = null;
let preparedFixture = null;
let verifiedBuild = null;
let plannedRunIdentity = null;
let outputValidated = false;
let browserTemporalObservation = null;
let temporalContext = null;
const terminationController = new AbortController();

function relative(value)
{
    return path.relative(root, value).replaceAll(path.sep, '/');
}

function snapshotReceiptEvidence(value)
{
    return value === null || value === undefined ? null : JSON.parse(JSON.stringify(value));
}

async function writeAuditedBrowserContractReceipt(file, receipt)
{
    if (file !== receiptFile)
    {
        throw new BrowserContractFailure('browser contract receipt target changed during sealing', 'contract');
    }
    const sealed = sealBrowserContractReceipt(receipt);
    if (sealed.status !== 'running')
    {
        const errors = validateBrowserContractReceipt(sealed, { requireSuccess: false });
        if (errors.length > 0)
        {
            throw new BrowserContractFailure(
                `browser contract produced an invalid receipt: ${errors.join('; ')}`,
                'contract',
                { errors }
            );
        }
    }
    Object.assign(receipt, sealed);
    await writeBrowserContractReceipt(receiptFile, receipt);
}

async function preparePrivateDirectory(directory)
{
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(directory) !== directory)
    {
        throw new BrowserContractFailure(`browser contract private directory is unsafe: ${relative(directory)}`, 'contract');
    }
    await chmod(directory, 0o700);
}

function assertRunOwnedPath(value, label)
{
    const canonicalRoot = path.join(root, '.tmp', 'browser-contract');
    const resolved = path.resolve(value);
    if (resolved !== canonicalRoot && !resolved.startsWith(`${canonicalRoot}${path.sep}`))
    {
        throw new BrowserContractFailure(`${label} must stay under .tmp/browser-contract`, 'contract');
    }
    let current = root;
    for (const segment of path.relative(root, resolved).split(path.sep))
    {
        current = path.join(current, segment);
        if (!existsSync(current))
        {
            continue;
        }
        const stat = lstatSync(current);
        if (stat.isSymbolicLink())
        {
            throw new BrowserContractFailure(`${label} contains a symlink`, 'contract');
        }
    }
    return resolved;
}

async function resetRunOutput()
{
    const ownedOutputRoot = assertRunOwnedPath(outputRoot, 'browser contract output root');
    const ownedReceiptFile = assertRunOwnedPath(receiptFile, 'browser contract receipt');
    if (existsSync(ownedOutputRoot) && !lstatSync(ownedOutputRoot).isDirectory())
    {
        throw new BrowserContractFailure('browser contract output root must be a directory', 'contract');
    }
    if (existsSync(ownedReceiptFile) && !lstatSync(ownedReceiptFile).isFile())
    {
        throw new BrowserContractFailure('browser contract receipt must be a regular file', 'contract');
    }
    await preparePrivateDirectory(ownedOutputRoot);
    await rm(ownedReceiptFile, { force: true });
    outputValidated = true;
}

function expectedSourceState()
{
    const commit = String(process.env.FSUSBLOG_TEST_SOURCE_COMMIT || '').trim();
    const worktreeFingerprint = String(process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT || '').trim();
    if (!/^[a-f0-9]{40}$/u.test(commit) || !/^(?:sha256:)?[a-f0-9]{64}$/u.test(worktreeFingerprint))
    {
        throw new BrowserContractFailure(
            'Browser Contract requires complete FSUSBLOG_TEST_SOURCE_COMMIT and FSUSBLOG_TEST_SOURCE_FINGERPRINT identity',
            'contract'
        );
    }
    return { commit, worktreeFingerprint };
}

function enforceConfiguredCleanAttemptAdmission()
{
    try
    {
        requireCleanAttemptConsumerAdmission({
            consumerId: 'browser-contract',
            repositoryRoot: root
        });
    }
    catch (error)
    {
        throw new BrowserContractFailure(error.message, 'contract');
    }
}

async function verifyImmutableBuild(sourceState)
{
    if (!existsSync(buildReceiptFile))
    {
        throw new BrowserContractFailure(`immutable production build receipt is missing: ${relative(buildReceiptFile)}`, 'contract');
    }
    const result = verifyProductionBuildReceipt({
        artifactRoot: path.dirname(buildReceiptFile),
        receiptFile: path.basename(buildReceiptFile),
        expectedSourceState: sourceState
    });
    const requiredDomains = ['backend-runtime', 'frontend-dist', 'generated-contracts', 'wasm'];
    const domains = new Set(result.receipt.domains.map((domain) => domain.name));
    const missingDomains = requiredDomains.filter((domain) => !domains.has(domain));
    if (missingDomains.length > 0)
    {
        throw new BrowserContractFailure(
            `immutable production build is missing browser contract domains: ${missingDomains.join(', ')}`,
            'contract'
        );
    }
    return {
        receipt: relative(buildReceiptFile),
        receiptContentDigest: result.receipt.contentDigest,
        sourceState: result.receipt.sourceState,
        profile: result.receipt.build?.profile ?? null,
        domains: requiredDomains,
        artifactCount: result.evidence.artifactCount,
        artifactBytes: result.evidence.artifactBytes,
        verifiedAt: result.evidence.verifiedAt
    };
}

async function loadManagedPlaywright()
{
    const plan = createCorrectnessBrowserPlan({
        browserName: 'chromium',
        evidenceClass: 'browser-contract',
        locale: temporalContext.uiLocale,
        frontendRoot,
        env: process.env
    });
    return {
        chromium: plan.browserType,
        plan,
        metadata: {
            package: '@playwright/test',
            version: plan.playwright.version,
            chromiumRevision: plan.revision,
            chromiumVersion: null,
            executableName: path.basename(plan.executablePath),
            managedExecutable: true,
            browserIdentity: {
                plan: serializableBrowserPlan(plan),
                actual: null
            }
        }
    };
}

function contextOptions(scenario, fixture, rendering)
{
    const storageState = scenario.role === 'user'
        ? fixture.user.storageState
        : scenario.role === 'admin' ? fixture.admin.storageState : undefined;
    return {
        baseURL: fixture.baseUrl,
        ...(storageState ? { storageState } : {}),
        serviceWorkers: scenario.serviceWorkers,
        viewport: { width: 1280, height: 800 },
        colorScheme: rendering.colorScheme,
        locale: rendering.locale,
        deviceScaleFactor: rendering.deviceScaleFactor,
        timezoneId: temporalContext.timezone,
        userAgent: `FsusBlog-Release-Browser-Contract/${scenario.id}`,
        extraHTTPHeaders: fixture.testSession
            ? { 'X-Fsus-Test-Session': fixture.testSession }
            : {}
    };
}

async function captureFailureScreenshot(page, scenarioId)
{
    const file = path.join(screenshotRoot, `${scenarioId}.png`);
    await preparePrivateDirectory(path.dirname(file));
    await page.screenshot({ path: file, fullPage: false, timeout: 5_000 });
    await chmod(file, 0o600);
    return relative(file);
}

function requestTermination(signal)
{
    if (receivedSignal)
    {
        return;
    }
    receivedSignal = signal;
    browserDisconnected = true;
    terminationController.abort(new Error(`browser contract terminated by ${signal}`));
    browser?.close().catch(() =>
    {});
}

process.once('SIGTERM', () => requestTermination('SIGTERM'));
process.once('SIGINT', () => requestTermination('SIGINT'));

async function main()
{
    const sourceState = expectedSourceState();
    const build = await verifyImmutableBuild(sourceState);
    temporalContext = loadTemporalContext();
    await resetRunOutput();
    if (process.env.FSUSBLOG_PLAYWRIGHT_SESSION_MODE !== 'browser-contract')
    {
        throw new BrowserContractFailure(
            'Browser Contract requires FSUSBLOG_PLAYWRIGHT_SESSION_MODE=browser-contract',
            'contract'
        );
    }
    verifiedBuild = build;
    const plannedIdentity = resolveBrowserContractRunIdentity({
        env: process.env,
        sourceState: build.sourceState,
        repoRoot: root,
        now: startedAtEpochMs
    });
    plannedRunIdentity = plannedIdentity;
    const runningReceipt = createBrowserContractReceipt({
        sourceState: build.sourceState,
        build,
        fixture: {
            namespace: plannedIdentity.namespace,
            lifecycle: {
                identity: {
                    commit: plannedIdentity.commit,
                    runId: plannedIdentity.runId,
                    laneId: plannedIdentity.laneId,
                    namespace: plannedIdentity.namespace
                },
                status: 'preparing'
            }
        },
        startedAt: new Date(startedAtEpochMs).toISOString()
    });
    await writeAuditedBrowserContractReceipt(receiptFile, runningReceipt);
    preparedFixture = await prepareSingleBrowserContractFixture({
        env: process.env,
        repoRoot: root,
        sourceState: build.sourceState,
        build,
        signal: terminationController.signal,
        now: startedAtEpochMs
    });
    const runOutputRoot = path.join(outputRoot, 'runs', preparedFixture.identity.namespace);
    traceRoot = path.join(runOutputRoot, 'traces');
    screenshotRoot = path.join(runOutputRoot, 'screenshots');
    await preparePrivateDirectory(traceRoot);
    await preparePrivateDirectory(screenshotRoot);
    const fixtureEnv = {
        ...process.env,
        FSUSBLOG_FIXTURE_ROOT: preparedFixture.root,
        FSUSBLOG_TEST_NAMESPACE: preparedFixture.identity.namespace,
        FSUSBLOG_TEST_SESSION: preparedFixture.identity.namespace
    };
    const fixture = await loadBrowserContractFixture({
        env: fixtureEnv,
        repoRoot: root,
        fixtureRoot: preparedFixture.root,
        lifecycle: preparedFixture.lifecycle,
        expectedSourceState: build.sourceState,
        expectedBuild: build
    });
    const localeMatrix = await createPublicShellLocaleMatrix(root);
    const localeHarness = await admitPublicShellLocaleHarness({
        root,
        matrix: localeMatrix,
        prepared: preparedFixture,
        buildReceiptFile,
        env: fixtureEnv
    });
    const selectedScenarios = selectBrowserContractScenarios(fixture.capabilities);
    const managed = await loadManagedPlaywright();
    const receipt = createBrowserContractReceipt({
        sourceState: build.sourceState,
        build,
        fixture: fixtureReceiptView(fixture, root),
        playwright: managed.metadata,
        scenarios: selectedScenarios
    });
    const productFailures = [];
    let primaryOutcome = null;

    try
    {
        receipt.topology.browserLaunchCount = 1;
        browser = await managed.chromium.launch(structuredClone(managed.plan.launchOptions));
        receipt.topology.maxConcurrentBrowserRoots = 1;
        receipt.playwright.chromiumVersion = browser.version();
        receipt.playwright.browserIdentity.actual = observeCorrectnessBrowser({
            plan: managed.plan,
            browser,
            launchOptions: managed.plan.launchOptions,
            rendering: managed.plan.rendering
        });
        browser.on('disconnected', () =>
        {
            if (!closingBrowser)
            {
                browserDisconnected = true;
            }
        });

        for (const scenario of selectedScenarios)
        {
            if (receivedSignal)
            {
                throw new BrowserContractFailure(`browser contract terminated by ${receivedSignal}`, 'infra');
            }
            const runner = browserContractScenarioRunners[scenario.id];
            if (typeof runner !== 'function')
            {
                throw new BrowserContractFailure(`browser contract scenario runner is missing: ${scenario.id}`, 'contract');
            }

            const scenarioReceipt = receipt.scenarios.find((entry) => entry.id === scenario.id);
            const scenarioStartedAtMs = performance.now();
            scenarioReceipt.status = 'running';
            scenarioReceipt.startedAt = new Date().toISOString();
            activeScenario = scenarioReceipt;
            let context = null;
            let page = null;
            let audit = null;
            let localeProbe = null;
            // Playwright traces serialize BrowserContext options and raw network
            // headers. Only the explicit anonymous allowlist may retain that raw
            // evidence; every authenticated or future role remains fail closed.
            const mayRetainRawTrace = scenario.role === 'anonymous';
            const traceFile = path.join(traceRoot, `${scenario.id}.zip`);
            try
            {
                context = await browser.newContext(contextOptions(scenario, fixture, managed.plan.rendering));
                receipt.topology.contextCount += 1;
                if (mayRetainRawTrace)
                {
                    await context.tracing.start({ screenshots: true, snapshots: true, sources: false, title: scenario.id });
                }
                page = await context.newPage();
                if (browserTemporalObservation === null)
                {
                    const renderingObservation = await observeBrowserRendering(page);
                    receipt.playwright.browserIdentity.actual = bindBrowserRenderingObservation(
                        managed.plan,
                        receipt.playwright.browserIdentity.actual,
                        renderingObservation
                    );
                    const browserObservation = await page.evaluate(() => ({
                        locale: navigator.language,
                        timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone
                    }));
                    const runtimeObservation =
                        preparedFixture.lifecycle?.runtime?.temporalObservation;
                    if (!runtimeObservation)
                    {
                        throw new BrowserContractFailure(
                            'browser contract backend/PostgreSQL temporal observation is missing',
                            'contract'
                        );
                    }
                    browserTemporalObservation = observeBrowserTemporalContext(
                        temporalContext,
                        {
                            ...runtimeObservation,
                            locale: browserObservation.locale,
                            timezoneId: browserObservation.timezoneId,
                            nodeTimezone: process.env.TZ
                        }
                    );
                }
                page.setDefaultTimeout(browserContractAppReadyTimeoutMs);
                page.setDefaultNavigationTimeout(browserContractAppReadyTimeoutMs);
                audit = createPageAudit(page);
                if (scenario.id === 'public-hydration-history-reload')
                {
                    localeProbe = observePublicShellLocaleProbe(page, localeHarness.identity, {
                        signal: terminationController.signal,
                        matrix: localeMatrix
                    });
                }
                await runner({ browser, context, page, fixture, audit, scenario, outputRoot });
                if (localeProbe)
                {
                    const observation = await localeProbe.finish();
                    const probeFile = path.join(runOutputRoot, 'public-shell-locale-probe.json');
                    const probeBindingFile = path.join(runOutputRoot, 'public-shell-locale-probe-binding.json');
                    await writeBrowserContractReceipt(probeFile, observation);
                    await writeBrowserContractReceipt(probeBindingFile, {
                        schema: 'fsusblog.public-shell-locale-probe-binding.v1',
                        evidenceKind: 'diagnostic-probe',
                        qualificationEligible: false,
                        identity: localeHarness.identity,
                        artifact: relative(probeFile),
                        digest: sha256File(probeFile)
                    });
                    scenarioReceipt.artifacts.push(relative(probeFile), relative(probeBindingFile));
                }
                if (browserDisconnected)
                {
                    throw new BrowserContractFailure('Chromium disconnected during the release browser contract', 'infra');
                }
                scenarioReceipt.status = 'success';
                scenarioReceipt.classification = 'clean';
            }
            catch (error)
            {
                scenarioReceipt.status = 'failure';
                scenarioReceipt.classification = classifyBrowserContractFailure(error, { browserDisconnected });
                scenarioReceipt.error = {
                    ...serializeBrowserContractError(error),
                    failureClass: scenarioReceipt.classification
                };
                if (page && !page.isClosed())
                {
                    const screenshot = await captureFailureScreenshot(page, scenario.id).catch(() => null);
                    if (screenshot)
                    {
                        scenarioReceipt.artifacts.push(screenshot);
                    }
                }
                if (scenarioReceipt.classification === 'product')
                {
                    productFailures.push({
                        scenario: scenario.id,
                        error: scenarioReceipt.error
                    });
                }
                else
                {
                    throw error;
                }
            }
            finally
            {
                localeProbe?.dispose();
                scenarioReceipt.issues = audit?.issues ?? [];
                if (context)
                {
                    if (mayRetainRawTrace)
                    {
                        const traced = await context.tracing.stop({ path: traceFile }).then(() => true).catch(() => false);
                        if (traced)
                        {
                            await chmod(traceFile, 0o600);
                            scenarioReceipt.artifacts.push(relative(traceFile));
                        }
                    }
                    await context.close().catch(() =>
                    {});
                }
                scenarioReceipt.finishedAt = new Date().toISOString();
                scenarioReceipt.durationMs = performance.now() - scenarioStartedAtMs;
                activeScenario = null;
            }
        }

        if (productFailures.length > 0)
        {
            throw new BrowserContractFailure(
                `${productFailures.length} browser contract product scenario(s) failed`,
                'product',
                { failures: productFailures }
            );
        }

        const publicPreviewStaging = path.join(runOutputRoot, 'public-preview-docs');
        const publicPreviewOperations = await import(pathToFileURL(
            path.join(root, 'tools/docs/public-preview-screenshots.mjs')
        ).href);
        const publicPreviewEvidenceFile = path.join(root, '.tmp/release-evidence/public-preview-screenshots.json');
        const publicPreview = await capturePublicPreviewGallery({
            browser,
            fixture,
            sourceCommit: build.sourceState.commit,
            stagingDirectory: publicPreviewStaging,
            evidenceFile: publicPreviewEvidenceFile,
            timeoutMs: browserContractAppReadyTimeoutMs,
            operations: publicPreviewOperations
        });
        receipt.publicPreview = {
            ...publicPreview,
            captureContextCount: Object.keys(publicPreview.images).length,
            evidencePath: relative(publicPreviewEvidenceFile),
            evidenceFileDigest: sha256File(publicPreviewEvidenceFile)
        };

        enforceConfiguredCleanAttemptAdmission();

        closingBrowser = true;
        await browser.close();
        browser = null;
        if (browserDisconnected && !receivedSignal)
        {
            throw new BrowserContractFailure('Chromium disconnected before contract completion', 'infra');
        }
        primaryOutcome = { status: 'success', classification: 'clean', error: null };
    }
    catch (error)
    {
        const classification = classifyBrowserContractFailure(error, { browserDisconnected });
        primaryOutcome = {
            status: 'failure',
            classification,
            error: {
                ...serializeBrowserContractError(error),
                failureClass: classification,
                activeScenario: activeScenario?.id ?? null,
                signal: receivedSignal
            }
        };
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), { receipt });
    }
    finally
    {
        if (browser)
        {
            closingBrowser = true;
            await browser.close().catch(() =>
            {});
            browser = null;
        }
        const cleanup = await cleanupSingleBrowserContractFixture(preparedFixture, {
            reason: receivedSignal
                ? `signal:${receivedSignal}`
                : receipt.status === 'success' ? 'success' : 'failure'
        });
        finalizeBrowserContractReceipt(receipt, {
            primary: primaryOutcome ?? {
                status: 'failure',
                classification: 'contract',
                error: {
                    name: 'BrowserContractFailure',
                    message: 'browser contract ended without a primary outcome',
                    failureClass: 'contract',
                    details: null,
                    stack: null,
                    activeScenario: activeScenario?.id ?? null,
                    signal: receivedSignal
                }
            },
            cleanup,
            signal: receivedSignal,
            finishedAt: new Date().toISOString(),
            wallClockMs: performance.now() - startedAtMonotonicMs
        });
        if (browserTemporalObservation)
        {
            const temporal = bindCorrectnessProducerTemporalArtifacts({
                producerId: 'comment-moderation',
                contextInput: temporalContext,
                observations: browserTemporalObservation,
                outcome: receipt,
                generatedAt: receipt.finishedAt
            });
            receipt.temporalBinding = {
                plan: temporal.plan,
                actual: temporal.actual,
                receipt: temporal.receipt,
                bindingDigest: temporal.bindingDigest
            };
        }
        await persistFinalBrowserContractReceipt(
            receipt,
            (terminalReceipt) => writeAuditedBrowserContractReceipt(receiptFile, terminalReceipt)
        );
    }
    if (receipt.status !== 'success')
    {
        throw Object.assign(new BrowserContractFailure(
            receipt.error?.message ?? 'browser contract failed',
            receipt.classification ?? 'contract',
            receipt.error?.details ?? null
        ), { receipt });
    }
    return receipt;
}

main()
    .then((receipt) =>
    {
        console.log(
            `[browser-contract] ok scenarios=${receipt.scenarios.length} browserLaunches=${receipt.topology.browserLaunchCount} contexts=${receipt.topology.contextCount} wallMs=${receipt.wallClockMs} receipt=${relative(receiptFile)}`
        );
    })
    .catch(async (error) =>
    {
        const receipt = error?.receipt;
        if (!receipt)
        {
            const primaryClassification = classifyBrowserContractFailure(error, { browserDisconnected });
            const primaryError = serializeBrowserContractError(error);
            const startupPreparedFixture = preparedFixture ?? error?.preparedFixture ?? null;
            const cleanupAttempts = [];
            let cleanup = error?.cleanup ?? null;
            if (cleanup)
            {
                cleanupAttempts.push(snapshotReceiptEvidence(cleanup));
            }
            if (!cleanup && startupPreparedFixture)
            {
                cleanup = await cleanupSingleBrowserContractFixture(startupPreparedFixture, {
                    reason: receivedSignal ? `signal:${receivedSignal}` : 'startup-failure'
                });
                cleanupAttempts.push(snapshotReceiptEvidence(cleanup));
            }
            if (cleanup?.status === 'failure' && startupPreparedFixture)
            {
                cleanup = await cleanupSingleBrowserContractFixture(startupPreparedFixture, {
                    reason: receivedSignal ? `signal:${receivedSignal}:retry` : 'startup-failure-retry'
                });
                cleanupAttempts.push(snapshotReceiptEvidence(cleanup));
            }
            const lifecycle = startupPreparedFixture?.lifecycle
        ?? error?.fixtureLifecycle
        ?? (plannedRunIdentity
            ? {
              status: 'startup-failure',
              identity: {
                commit: plannedRunIdentity.commit,
                runId: plannedRunIdentity.runId,
                laneId: plannedRunIdentity.laneId,
                namespace: plannedRunIdentity.namespace
              }
            }
            : null);
            const fallbackFixture = {
                namespace: lifecycle?.identity?.namespace ?? null,
                lifecycle,
                cleanup,
                cleanupAttempts
            };
            const fallback = createBrowserContractReceipt({
                sourceState: verifiedBuild?.sourceState ?? null,
                build: verifiedBuild,
                fixture: fallbackFixture,
                startedAt: new Date(startedAtEpochMs).toISOString()
            });
            finalizeBrowserContractReceipt(fallback, {
                primary: {
                    status: 'failure',
                    classification: primaryClassification,
                    error: {
                        ...primaryError,
                        failureClass: primaryClassification,
                        signal: receivedSignal
                    }
                },
                cleanup,
                cleanupAttempts,
                signal: receivedSignal,
                finishedAt: new Date().toISOString(),
                wallClockMs: performance.now() - startedAtMonotonicMs
            });
            if (outputValidated)
            {
                await persistFinalBrowserContractReceipt(
                    fallback,
                    (terminalReceipt) => writeAuditedBrowserContractReceipt(receiptFile, terminalReceipt)
                ).catch((persistenceError) =>
                {
                    console.error(`[browser-contract] contract failure: ${persistenceError.message}`);
                });
            }
        }
        console.error(`[browser-contract] ${classifyBrowserContractFailure(error, { browserDisconnected })} failure: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    });
