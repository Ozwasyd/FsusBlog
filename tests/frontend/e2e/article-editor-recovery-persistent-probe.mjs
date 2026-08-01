#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const requireFromFrontend = createRequire(resolve(repoRoot, 'src/frontend/package.json'));
const { chromium } = requireFromFrontend('@playwright/test');
const requestedBaseUrl = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3000';
const parsedBaseUrl = new URL(requestedBaseUrl);
if (!['http:', 'https:'].includes(parsedBaseUrl.protocol)
|| parsedBaseUrl.username
|| parsedBaseUrl.password
|| parsedBaseUrl.pathname !== '/'
|| parsedBaseUrl.search
|| parsedBaseUrl.hash)
{
    throw new Error('article_recovery_probe_base_url_invalid');
}
const baseUrl = parsedBaseUrl.origin;
const baseOrigin = parsedBaseUrl.origin;
const chromePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || '/usr/bin/google-chrome';
const probeMode = process.env.FSUSBLOG_ARTICLE_RECOVERY_PROBE_MODE || 'process-restart';
const supportedProbeModes = new Set([
    'process-restart',
    'boot-identity-contract',
    'os-restart-prepare',
    'os-restart-verify',
    'os-restart-cleanup'
]);
if (!supportedProbeModes.has(probeMode))
{
    throw new Error(`article_recovery_probe_mode_invalid:${probeMode}`);
}
if (!['process-restart', 'boot-identity-contract'].includes(probeMode)
&& !process.env.FSUSBLOG_ARTICLE_RECOVERY_EVIDENCE_DIR)
{
    throw new Error('article_recovery_os_restart_evidence_dir_required');
}
const evidenceDir = resolve(
    process.env.FSUSBLOG_ARTICLE_RECOVERY_EVIDENCE_DIR
    || `/tmp/fsusblog-article-recovery-1813-${Date.now()}`
);
const profileDir = resolve(evidenceDir, 'persistent-profile');
const osRestartHandoffPath = resolve(evidenceDir, 'os-restart-handoff.json');
const fixtureModule = `/@fs/${resolve(
    repoRoot,
    'tests/frontend/fixtures/articleEditorProductionVisual.ts'
).replaceAll('\\', '/')}`;
const recoveryIdentity = 'fixture-admin-1813';
const processTabId = 'probe-tab-process-1813';
const processClientRevision = 'probe-client-process-1813';
const processContent = '进程级恢复证据 1813 🧭\nCJK + emoji + fixed client revision';

if (probeMode === 'process-restart' || probeMode === 'os-restart-prepare')
{
    try
    {
        await mkdir(evidenceDir);
    }
    catch (error)
    {
        if (error?.code !== 'EEXIST' || (await readdir(evidenceDir)).length > 0)
        {
            throw error;
        }
    }
    await mkdir(profileDir);
}

async function launchChrome(label)
{
    const logPath = resolve(evidenceDir, `chrome-${label}.log`);
    await writeFile(logPath, `playwright persistent context: ${label}\n`, { flag: 'wx' });
    const context = await chromium.launchPersistentContext(profileDir, {
        executablePath: chromePath,
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--disable-background-networking',
            '--no-first-run',
            '--no-default-browser-check'
        ]
    });
    return { context, label, logPath, pid: null };
}

async function terminateChromeProcess(runtime, signal = 'SIGTERM')
{
    await runtime.context.close();
    return { code: 0, signal };
}

function fixtureHtml()
{
    return `<!doctype html>
    <html>
      <head><meta charset="utf-8"><title>文章恢复持久 profile probe</title></head>
      <body>
        <div id="article-editor-production-fixture"></div>
        <script type="module" src="/@vite/client"></script>
        <script type="module">
          const fixture = await import(${JSON.stringify(`${fixtureModule}?persistent-probe=1813`)})
          await fixture.mountArticleEditorProductionFixture()
        </script>
      </body>
    </html>`;
}

async function openRecoveryPage(context, coordinates)
{
    const page = await context.newPage();
    await page.route('**/__article-editor-production-fixture**', route => route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: fixtureHtml()
    }));
    const search = new URLSearchParams({
        title: 'short',
        theme: 'light',
        surface: 'recovery',
        tabId: coordinates.tabId,
        clientRevision: coordinates.clientRevision
    });
    await page.goto(`${baseUrl}/__article-editor-production-fixture?${search}`, {
        waitUntil: 'domcontentloaded'
    });
    await page.waitForFunction(() => (
        globalThis.document.documentElement.dataset.articleEditorFixtureReady === 'true'
    ), undefined, { timeout: 90_000 });
    return page;
}

async function clearRecovery(page)
{
    await page.evaluate(async () =>
    {
        await globalThis.window.__articleEditorFixtureClearRecovery?.();
    });
}

async function writeRecovery(page, content)
{
    const result = await page.evaluate(async value => (
        await globalThis.window.__articleEditorFixtureWriteRecovery?.(value)
    ), content);
    if (result?.status !== 'stored')
    {
        throw new Error(`browser_probe_recovery_write_failed:${result?.status}`);
    }
}

async function readJournal(page)
{
    return page.evaluate(async expectedContent =>
    {
        const database = await new Promise((resolvePromise, reject) =>
        {
            const request = globalThis.indexedDB.open('fsusblog-article-recovery-journal', 1);
            request.onsuccess = () => resolvePromise(request.result);
            request.onerror = () => reject(request.error);
        });
        try
        {
            return await new Promise((resolvePromise, reject) =>
            {
                const request = database.transaction('entries', 'readonly').objectStore('entries').getAll();
                request.onsuccess = () =>
                {
                    try
                    {
                        resolvePromise(request.result.map(record =>
                        {
                            const serialized = JSON.stringify(record);
                            if (Object.hasOwn(record, 'content')
                            || serialized.includes(expectedContent)
                            || serialized.includes('进程级恢复证据')
                            || serialized.includes('🧭'))
                            {
                                throw new Error('browser_probe_raw_body_persisted');
                            }
                            if (record.payloadCodec !== 'gzip-v1'
                            || !(record.payload instanceof Uint8Array)
                            || record.payload.byteLength !== record.storedBytes)
                            {
                                throw new Error('browser_probe_compressed_payload_contract_mismatch');
                            }
                            return {
                                articleKey: record.articleKey,
                                baseRevisionId: record.baseRevisionId,
                                clientRevision: record.clientRevision,
                                contentBytes: record.contentBytes,
                                identityHash: record.identityHash,
                                payloadBytes: record.payload.byteLength,
                                payloadCodec: record.payloadCodec,
                                schema: record.schema,
                                serverRevision: record.serverRevision,
                                sourceHash: record.sourceHash,
                                storedBytes: record.storedBytes,
                                tabId: record.tabId
                            };
                        }));
                    }
                    catch (error)
                    {
                        reject(error);
                    }
                };
                request.onerror = () => reject(request.error);
            });
        }
        finally
        {
            database.close();
        }
    }, processContent);
}

function sha256(value)
{
    return createHash('sha256').update(value).digest('hex');
}

async function readLinuxBootIdentitySha256()
{
    let bootIdentity;
    try
    {
        bootIdentity = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    }
    catch (error)
    {
        throw new Error('article_recovery_linux_boot_identity_unavailable', { cause: error });
    }
    if (!/^[a-f0-9-]{32,64}$/u.test(bootIdentity))
    {
        throw new Error('article_recovery_linux_boot_identity_invalid');
    }
    return sha256(bootIdentity);
}

function assertBootIdentityChanged(preparedSha256, currentSha256)
{
    if (!/^[a-f0-9]{64}$/u.test(preparedSha256)
    || !/^[a-f0-9]{64}$/u.test(currentSha256))
    {
        throw new Error('article_recovery_os_restart_boot_identity_invalid');
    }
    if (preparedSha256 === currentSha256)
    {
        throw new Error('article_recovery_os_restart_same_boot_rejected');
    }
}

function shellQuote(value)
{
    return `'${String(value).replaceAll("'", "'\\''")}'`;
}

const implementationPaths = [
    'src/frontend/src/services/articleRecoveryJournal.ts',
    'src/frontend/src/composables/useAdminArticleWrite.ts',
    'src/frontend/src/services/privateStorageRegistry.ts',
    'src/frontend/src/views/admin/article/Write.vue',
    'tests/frontend/fixtures/articleEditorProductionVisual.ts',
    'tests/frontend/e2e/article-editor-recovery-persistent-probe.mjs'
];
const implementationSha256 = {};
for (const path of implementationPaths)
{
    implementationSha256[path] = sha256(await readFile(resolve(repoRoot, path)));
}

function osRestartCommand(mode)
{
    return [
        `FSUSBLOG_ARTICLE_RECOVERY_PROBE_MODE=${mode}`,
        `FSUSBLOG_ARTICLE_RECOVERY_EVIDENCE_DIR=${shellQuote(evidenceDir)}`,
        `PLAYWRIGHT_BASE_URL=${shellQuote(baseUrl)}`,
        'node tests/frontend/e2e/article-editor-recovery-persistent-probe.mjs'
    ].join(' ');
}

async function runOsRestartPrepare()
{
    const prepareBootIdentitySha256 = await readLinuxBootIdentitySha256();
    let runtime;
    try
    {
        runtime = await launchChrome('os-restart-prepare');
        const context = runtime.context;
        const page = await openRecoveryPage(context, {
            tabId: processTabId,
            clientRevision: processClientRevision
        });
        await clearRecovery(page);
        await writeRecovery(page, processContent);
        const records = await readJournal(page);
        if (records.length !== 1)
        {
            throw new Error(`browser_probe_os_prepare_record_count:${records.length}`);
        }
        await page.screenshot({
            path: resolve(evidenceDir, 'before-host-reboot.png'),
            fullPage: true
        });
        const handoff = {
            schema: 'fsusblog.article-recovery-os-restart-handoff.v2',
            state: 'prepared-awaiting-user-authorized-host-reboot',
            createdAt: new Date().toISOString(),
            baseUrl,
            origin: baseOrigin,
            browser: chromePath,
            evidenceDir,
            profileDir,
            prepareBootIdentitySha256,
            implementationSha256,
            coordinates: {
                identity: recoveryIdentity,
                articleKey: 'create',
                baseRevisionId: null,
                serverRevision: null,
                clientRevision: processClientRevision,
                tabId: processTabId,
                contentSha256: sha256(processContent)
            },
            preparedRecord: records[0],
            artifactSha256: {
                'before-host-reboot.png': sha256(await readFile(resolve(evidenceDir, 'before-host-reboot.png')))
            },
            limitation: 'Preparation only. No host reboot or OS-restart verification has occurred.',
            verifyCommand: osRestartCommand('os-restart-verify'),
            cleanupCommand: osRestartCommand('os-restart-cleanup')
        };
        await writeFile(osRestartHandoffPath, `${JSON.stringify(handoff, null, 2)}\n`, { flag: 'wx' });
        const closed = await terminateChromeProcess(runtime, 'SIGTERM');
        runtime = null;
        return {
            handoff: osRestartHandoffPath,
            handoffSha256: sha256(await readFile(osRestartHandoffPath)),
            browserCleanup: closed,
            verifyCommand: handoff.verifyCommand,
            cleanupCommand: handoff.cleanupCommand
        };
    }
    finally
    {
        if (runtime)
        {
            await terminateChromeProcess(runtime, 'SIGTERM').catch(() =>
            {});
        }
    }
}

async function readOsRestartHandoff()
{
    const handoff = JSON.parse(await readFile(osRestartHandoffPath, 'utf8'));
    if (handoff?.schema !== 'fsusblog.article-recovery-os-restart-handoff.v2'
    || handoff.state !== 'prepared-awaiting-user-authorized-host-reboot'
    || handoff.baseUrl !== baseUrl
    || handoff.origin !== baseOrigin
    || handoff.profileDir !== profileDir
    || handoff.evidenceDir !== evidenceDir
    || !/^[a-f0-9]{64}$/u.test(handoff.prepareBootIdentitySha256)
    || handoff.coordinates?.contentSha256 !== sha256(processContent)
    || JSON.stringify(handoff.implementationSha256) !== JSON.stringify(implementationSha256))
    {
        throw new Error('article_recovery_os_restart_handoff_mismatch');
    }
    return handoff;
}

async function runOsRestartVerify()
{
    const handoff = await readOsRestartHandoff();
    const currentBootIdentitySha256 = await readLinuxBootIdentitySha256();
    assertBootIdentityChanged(
        handoff.prepareBootIdentitySha256,
        currentBootIdentitySha256
    );
    let runtime;
    try
    {
        runtime = await launchChrome('os-restart-verify');
        const context = runtime.context;
        const page = await openRecoveryPage(context, {
            tabId: processTabId,
            clientRevision: processClientRevision
        });
        const prompt = page.locator('[data-article-recovery-prompt]');
        await prompt.waitFor({ state: 'visible', timeout: 20_000 });
        const records = await readJournal(page);
        if (records.length !== 1
        || JSON.stringify(records[0]) !== JSON.stringify(handoff.preparedRecord))
        {
            throw new Error('article_recovery_os_restart_record_mismatch');
        }
        await page.getByRole('button', { name: '比较所选正文' }).click();
        await page.locator('[data-article-recovery-comparison]').waitFor({
            state: 'visible',
            timeout: 20_000
        });
        await page.screenshot({
            path: resolve(evidenceDir, 'after-host-reboot-prompt.png'),
            fullPage: true
        });
        await page.getByRole('button', { name: '恢复所选正文' }).click();
        await page.waitForFunction(expected => (
            globalThis.document.querySelector('[aria-label="未同步正文编辑区"]')?.value === expected
        ), processContent, { timeout: 20_000 });
        const restoredContent = await page.getByRole('textbox', {
            name: '未同步正文编辑区'
        }).inputValue();
        if (restoredContent !== processContent)
        {
            throw new Error('article_recovery_os_restart_content_mismatch');
        }
        const verification = {
            schema: 'fsusblog.article-recovery-os-restart-verification.v1',
            verifiedAt: new Date().toISOString(),
            handoffSha256: sha256(await readFile(osRestartHandoffPath)),
            baseUrl,
            origin: baseOrigin,
            prepareBootIdentitySha256: handoff.prepareBootIdentitySha256,
            currentBootIdentitySha256,
            implementationSha256,
            coordinates: handoff.coordinates,
            observedRecord: records[0],
            restoredContentSha256: sha256(restoredContent),
            restoredMatches: restoredContent === processContent,
            artifactSha256: {
                'after-host-reboot-prompt.png': sha256(
                    await readFile(resolve(evidenceDir, 'after-host-reboot-prompt.png'))
                )
            },
            cleanupCommand: handoff.cleanupCommand
        };
        const verificationPath = resolve(evidenceDir, 'os-restart-verification.json');
        await writeFile(verificationPath, `${JSON.stringify(verification, null, 2)}\n`, { flag: 'wx' });
        const closed = await terminateChromeProcess(runtime, 'SIGTERM');
        runtime = null;
        return {
            verification: verificationPath,
            verificationSha256: sha256(await readFile(verificationPath)),
            browserCleanup: closed,
            cleanupCommand: handoff.cleanupCommand
        };
    }
    finally
    {
        if (runtime)
        {
            await terminateChromeProcess(runtime, 'SIGTERM').catch(() =>
            {});
        }
    }
}

if (probeMode === 'boot-identity-contract')
{
    const currentBootIdentitySha256 = await readLinuxBootIdentitySha256();
    let sameBootRejected = false;
    try
    {
        assertBootIdentityChanged(currentBootIdentitySha256, currentBootIdentitySha256);
    }
    catch (error)
    {
        if (error instanceof Error
        && error.message === 'article_recovery_os_restart_same_boot_rejected')
        {
            sameBootRejected = true;
        }
        else
        {
            throw error;
        }
    }
    if (!sameBootRejected)
    {
        throw new Error('article_recovery_os_restart_same_boot_contract_failed');
    }
    const changedBootIdentitySha256 = currentBootIdentitySha256 === '0'.repeat(64)
        ? '1'.repeat(64)
        : '0'.repeat(64);
    assertBootIdentityChanged(currentBootIdentitySha256, changedBootIdentitySha256);
    console.log(JSON.stringify({
        schema: 'fsusblog.article-recovery-boot-identity-contract.v1',
        sameBootRejected,
        changedComparisonAccepted: true,
        currentBootIdentitySha256,
        limitation: 'Comparator contract only. No browser launch, host reboot, or OS-restart verification occurred.'
    }, null, 2));
    process.exit(0);
}

if (probeMode === 'os-restart-prepare')
{
    console.log(JSON.stringify(await runOsRestartPrepare(), null, 2));
    process.exit(0);
}
if (probeMode === 'os-restart-verify')
{
    console.log(JSON.stringify(await runOsRestartVerify(), null, 2));
    process.exit(0);
}
if (probeMode === 'os-restart-cleanup')
{
    const handoff = await readOsRestartHandoff();
    if (profileDir !== resolve(evidenceDir, 'persistent-profile'))
    {
        throw new Error('article_recovery_os_restart_cleanup_scope_invalid');
    }
    await rm(profileDir, { recursive: true, force: true });
    console.log(JSON.stringify({
        removedProfileDir: profileDir,
        recoverable: false,
        retainedHandoff: osRestartHandoffPath,
        handoffSha256: sha256(await readFile(osRestartHandoffPath)),
        state: handoff.state
    }, null, 2));
    process.exit(0);
}

const result = {
    schema: 'fsusblog.article-recovery-process-probe.v1',
    baseUrl,
    browser: chromePath,
    evidenceDir,
    profileDir,
    implementationSha256,
    coordinates: {
        identity: recoveryIdentity,
        articleKey: 'create',
        baseRevisionId: null,
        serverRevision: null,
        clientRevision: processClientRevision,
        tabId: processTabId,
        contentSha256: sha256(processContent)
    },
    firstLaunch: {},
    processRestart: {},
    multiTab: {},
    limitation: 'Playwright-governed browser process relaunch with the same profile; this is not an OS restart.'
};

let firstRuntime;
let secondRuntime;
try
{
    firstRuntime = await launchChrome('before-kill');
    const firstContext = firstRuntime.context;
    const firstPage = await openRecoveryPage(firstContext, {
        tabId: processTabId,
        clientRevision: processClientRevision
    });
    await clearRecovery(firstPage);
    await writeRecovery(firstPage, processContent);
    const initialRecords = await readJournal(firstPage);
    if (initialRecords.length !== 1)
    {
        throw new Error(`browser_probe_initial_record_count:${initialRecords.length}`);
    }
    await firstPage.screenshot({
        path: resolve(evidenceDir, 'before-process-kill.png'),
        fullPage: true
    });
    result.firstLaunch = {
        pid: firstRuntime.pid,
        record: initialRecords[0],
        promptVisibleInOwningTab: await firstPage.locator('[data-article-recovery-prompt]').isVisible()
    };

    const killed = await terminateChromeProcess(firstRuntime);
    result.processRestart.kill = {
        pid: firstRuntime.pid,
        signalSent: 'SIGKILL',
        observedExitCode: killed.code,
        observedExitSignal: killed.signal
    };
    firstRuntime = null;

    secondRuntime = await launchChrome('after-kill');
    const secondContext = secondRuntime.context;
    await secondContext.tracing.start({ screenshots: true, snapshots: true, sources: true });
    const reopened = await openRecoveryPage(secondContext, {
        tabId: processTabId,
        clientRevision: processClientRevision
    });
    const prompt = reopened.locator('[data-article-recovery-prompt]');
    await prompt.waitFor({ state: 'visible', timeout: 20_000 });
    const reopenedRecords = await readJournal(reopened);
    await reopened.screenshot({
        path: resolve(evidenceDir, 'after-process-restart-prompt.png'),
        fullPage: true
    });
    const promptText = await prompt.innerText();
    await reopened.getByRole('button', { name: '比较所选正文' }).click();
    const comparisonText = await reopened.locator(
        '[data-article-recovery-comparison]'
    ).innerText();
    await reopened.getByRole('button', { name: '恢复所选正文' }).click();
    await reopened.waitForFunction(expected => (
        globalThis.document.querySelector('[aria-label="未同步正文编辑区"]')?.value === expected
    ), processContent, { timeout: 20_000 });
    const restoredContent = await reopened.getByRole('textbox', {
        name: '未同步正文编辑区'
    }).inputValue();
    if (restoredContent !== processContent)
    {
        throw new Error('browser_probe_restored_content_mismatch');
    }
    result.processRestart.reopen = {
        pid: secondRuntime.pid,
        record: reopenedRecords[0],
        promptText,
        comparisonText,
        restoredContentSha256: sha256(restoredContent),
        restoredMatches: restoredContent === processContent
    };

    await clearRecovery(reopened);
    const multiTabCoordinates = [
        ['probe-tab-a-1813', 'probe-client-a-1813', '多标签页甲：中文正文'],
        ['probe-tab-b-1813', 'probe-client-b-1813', '多标签页乙：emoji 🧪'],
        ['probe-tab-c-1813', 'probe-client-c-1813', 'multi-tab C: independent revision']
    ];
    const writers = [];
    for (const [tabId, clientRevision, content] of multiTabCoordinates)
    {
        const writer = await openRecoveryPage(secondContext, { tabId, clientRevision });
        await writeRecovery(writer, content);
        writers.push(writer);
    }
    const observer = await openRecoveryPage(secondContext, {
        tabId: 'probe-tab-observer-1813',
        clientRevision: 'probe-client-observer-1813'
    });
    const radios = observer.getByRole('radio');
    await radios.nth(2).waitFor({ state: 'visible', timeout: 20_000 });
    const beforeDiscard = await radios.count();
    const candidateText = await observer.locator(
        '.article-editor-production-fixture__recovery-candidate'
    ).allInnerTexts();
    await radios.nth(1).check();
    await observer.getByRole('button', { name: '丢弃所选正文' }).click();
    await observer.waitForFunction(() => (
        globalThis.document.querySelectorAll(
            '.article-editor-production-fixture__recovery-candidate input[type="radio"]'
        ).length === 2
    ));
    await observer.screenshot({
        path: resolve(evidenceDir, 'multi-tab-explicit-choice.png'),
        fullPage: true
    });
    result.multiTab = {
        writerCoordinates: multiTabCoordinates.map(([tabId, clientRevision, content]) => ({
            tabId,
            clientRevision,
            contentSha256: sha256(content)
        })),
        candidateCountBeforeDiscard: beforeDiscard,
        candidateCountAfterDiscard: await observer.getByRole('radio').count(),
        candidateText
    };
    await clearRecovery(observer);
    await secondContext.tracing.stop({
        path: resolve(evidenceDir, 'after-restart-and-multi-tab-trace.zip')
    });
    const closed = await terminateChromeProcess(secondRuntime, 'SIGTERM');
    result.processRestart.normalCleanup = {
        signalSent: 'SIGTERM',
        observedExitCode: closed.code,
        observedExitSignal: closed.signal
    };
    secondRuntime = null;
}
finally
{
    if (firstRuntime)
    {
        await terminateChromeProcess(firstRuntime).catch(() =>
        {});
    }
    if (secondRuntime)
    {
        await terminateChromeProcess(secondRuntime).catch(() =>
        {});
    }
}

const artifactNames = [
    'before-process-kill.png',
    'after-process-restart-prompt.png',
    'multi-tab-explicit-choice.png',
    'after-restart-and-multi-tab-trace.zip',
    'chrome-before-kill.log',
    'chrome-after-kill.log'
];
const hashes = {};
for (const name of artifactNames)
{
    hashes[name] = sha256(await readFile(resolve(evidenceDir, name)));
}
result.artifactSha256 = hashes;
await writeFile(
    resolve(evidenceDir, 'evidence.json'),
    `${JSON.stringify(result, null, 2)}\n`,
    { flag: 'wx' }
);
console.log(JSON.stringify({
    evidenceDir,
    evidenceJson: resolve(evidenceDir, 'evidence.json'),
    artifactSha256: hashes
}, null, 2));
