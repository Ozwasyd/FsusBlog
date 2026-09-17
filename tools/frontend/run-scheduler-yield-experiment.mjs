#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { open, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const frontendRequire = createRequire(resolve(repoRoot, 'src/frontend/package.json'));
const execFileAsync = promisify(execFile);

export const experimentProfiles = Object.freeze([
    Object.freeze({ name: 'desktop-baseline-1x', cpuRate: 1, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, hasTouch: false, isMobile: false }),
    Object.freeze({ name: 'mobile-medium-4x', cpuRate: 4, viewport: { width: 393, height: 851 }, deviceScaleFactor: 2.5, hasTouch: true, isMobile: true }),
    Object.freeze({ name: 'mobile-slow-6x', cpuRate: 6, viewport: { width: 360, height: 800 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true })
]);

export function percentile(values, percentileValue)
{
    if (values.length === 0)
    {
        return null;
    }
    const sorted = [...values].sort((left, right) => left - right);
    const position = (sorted.length - 1) * percentileValue;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    if (lower === upper)
    {
        return sorted[lower];
    }
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function summarizeSamples(samples)
{
    const summarizeValues = values =>
    {
        if (values.length === 0)
        {
            return { p50: null, p75: null, p95: null, mean: null, standardDeviation: null, minimum: null, maximum: null };
        }
        const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
        return {
            p50: percentile(values, 0.5),
            p75: percentile(values, 0.75),
            p95: percentile(values, 0.95),
            mean,
            standardDeviation: Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length),
            minimum: Math.min(...values),
            maximum: Math.max(...values)
        };
    };
    const summarize = key => summarizeValues(samples.map(sample => sample[key]));
    const eventTiming = samples.flatMap(sample => sample.eventTiming ?? []);
    return {
        rounds: samples.length,
        probeInputDelayMs: summarize('probeInputDelayMs'),
        totalDurationMs: summarize('totalDurationMs'),
        longTaskBlockingMs: summarize('longTaskBlockingMs'),
        taskDurationMs: summarize('taskDurationMs'),
        scriptDurationMs: summarize('scriptDurationMs'),
        heapDeltaBytes: summarize('heapDeltaBytes'),
        yieldCount: summarize('yieldCount'),
        eventTiming: {
            samples: eventTiming.length,
            inputDelayMs: summarizeValues(eventTiming.map(entry => entry.inputDelayMs)),
            processingMs: summarizeValues(eventTiming.map(entry => entry.processingMs)),
            presentationMs: summarizeValues(eventTiming.map(entry => entry.presentationMs)),
            durationMs: summarizeValues(eventTiming.map(entry => entry.durationMs))
        }
    };
}

export function classifyProfile(control, candidate)
{
    const inputImproved = candidate.probeInputDelayMs.p75 < control.probeInputDelayMs.p75 * 0.8;
    const blockingImproved = control.longTaskBlockingMs.p75 > 0
    && candidate.longTaskBlockingMs.p75 <= control.longTaskBlockingMs.p75 * 0.8;
    const totalWithinTradeoff = candidate.totalDurationMs.p75 <= control.totalDurationMs.p75 * 1.5;
    return {
        inputImproved,
        blockingImproved,
        totalWithinTradeoff,
        outcome: inputImproved && blockingImproved && totalWithinTradeoff ? 'promising-local-fixture' : 'do-not-enable'
    };
}

export function parseArguments(argv)
{
    const options = {
        rounds: 5,
        output: '/tmp/fsusblog-issue-1180-scheduler-yield.json',
        screenshot: '/tmp/fsusblog-issue-1180-scheduler-yield.png',
        chromiumPath: process.env.PLAYWRIGHT_CHROMIUM_PATH || '/usr/bin/google-chrome'
    };
    for (let index = 0; index < argv.length; index += 1)
    {
        const argument = argv[index];
        if (!['--rounds', '--output', '--screenshot', '--chromium-path'].includes(argument))
        {
            throw new Error(`unknown argument ${argument}`);
        }
        const value = argv[++index];
        if (!value)
        {
            throw new Error(`${argument} requires a value`);
        }
        if (argument === '--rounds')
        {
            options.rounds = Number(value);
        }
        if (argument === '--output')
        {
            options.output = resolve(value);
        }
        if (argument === '--screenshot')
        {
            options.screenshot = resolve(value);
        }
        if (argument === '--chromium-path')
        {
            options.chromiumPath = resolve(value);
        }
    }
    if (!Number.isInteger(options.rounds) || options.rounds < 3 || options.rounds > 20)
    {
        throw new Error('--rounds must be an integer from 3 through 20');
    }
    return options;
}

function metric(metrics, name)
{
    return metrics.metrics.find(entry => entry.name === name)?.value ?? 0;
}

async function gitCommit()
{
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot });
    return stdout.trim();
}

async function runRound({ browser, origin, profile, mode, screenshot })
{
    const context = await browser.newContext({
        viewport: profile.viewport,
        deviceScaleFactor: profile.deviceScaleFactor,
        hasTouch: profile.hasTouch,
        isMobile: profile.isMobile
    });
    const page = await context.newPage();
    const consoleErrors = [];
    page.on('console', message =>
    {
        if (message.type() === 'error' || message.type() === 'warning')
        {
            consoleErrors.push(`${message.type()}: ${message.text()}`);
        }
    });
    page.on('pageerror', error => consoleErrors.push(`pageerror: ${error.message}`));
    const session = await context.newCDPSession(page);

    try
    {
        await session.send('Emulation.setCPUThrottlingRate', { rate: profile.cpuRate });
        await session.send('Performance.enable');
        const url = `${origin}/tests/frontend/fixtures/scheduler-yield/index.html?mode=${mode}`;
        await page.goto(url, { waitUntil: 'networkidle' });
        if (await page.title() !== 'FsusBlog scheduler.yield local experiment')
        {
            throw new Error(`unexpected page title for ${profile.name}/${mode}`);
        }
        if (!await page.locator('h1').isVisible())
        {
            throw new Error(`blank experiment page for ${profile.name}/${mode}`);
        }
        const probe = page.locator('#probe');
        if (!await probe.isVisible())
        {
            throw new Error(`interaction probe is not visible for ${profile.name}/${mode}`);
        }
        const probeBox = await probe.boundingBox();
        if (!probeBox)
        {
            throw new Error(`interaction probe has no bounding box for ${profile.name}/${mode}`);
        }
        const before = await session.send('Performance.getMetrics');

        const probeTargetEpochMs = Date.now() + 16;
        await page.evaluate(targetEpochMs => window.__FSUSBLOG_SCHEDULER_YIELD_EXPERIMENT__?.start(targetEpochMs), probeTargetEpochMs);
        await new Promise(resolve => setTimeout(resolve, Math.max(0, probeTargetEpochMs - Date.now())));
        const x = probeBox.x + probeBox.width / 2;
        const y = probeBox.y + probeBox.height / 2;
        await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
        await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
        await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
        await page.waitForFunction(() => window.__FSUSBLOG_SCHEDULER_YIELD_EXPERIMENT__?.result !== null, null, { timeout: 45_000 });
        const result = await page.evaluate(() => window.__FSUSBLOG_SCHEDULER_YIELD_EXPERIMENT__?.result);
        const after = await session.send('Performance.getMetrics');
        if (!result)
        {
            throw new Error(`experiment result disappeared for ${profile.name}/${mode}`);
        }
        if (screenshot)
        {
            await page.screenshot({ path: screenshot, fullPage: false });
        }
        if (consoleErrors.length > 0)
        {
            throw new Error(`console errors for ${profile.name}/${mode}: ${consoleErrors.join(' | ')}`);
        }
        if (result.itemCount !== 600 || result.probeInputDelayMs === null)
        {
            throw new Error(`incorrect experiment result for ${profile.name}/${mode}: itemCount=${result.itemCount}, probeInputDelayMs=${result.probeInputDelayMs}`);
        }
        if (mode === 'candidate' && result.yieldPaths.native === 0)
        {
            throw new Error(`native scheduler.yield was not exercised for ${profile.name}`);
        }
        if (mode === 'fallback' && result.yieldPaths.fallback === 0)
        {
            throw new Error('fallback path was not exercised');
        }

        return {
            probeInputDelayMs: result.probeInputDelayMs,
            totalDurationMs: result.totalDurationMs,
            longTaskBlockingMs: result.longTasks.reduce((sum, duration) => sum + Math.max(0, duration - 50), 0),
            maxLongTaskMs: Math.max(0, ...result.longTasks),
            longTaskCount: result.longTasks.length,
            taskDurationMs: (metric(after, 'TaskDuration') - metric(before, 'TaskDuration')) * 1000,
            scriptDurationMs: (metric(after, 'ScriptDuration') - metric(before, 'ScriptDuration')) * 1000,
            heapDeltaBytes: result.heapBeforeBytes === null || result.heapAfterBytes === null ? 0 : result.heapAfterBytes - result.heapBeforeBytes,
            itemCount: result.itemCount,
            yieldCount: result.yieldCount,
            yieldPaths: result.yieldPaths,
            eventTimingSamples: result.eventTiming.length,
            eventTiming: result.eventTiming,
            longTaskAttribution: result.longTaskAttribution,
            checksum: result.checksum,
            visibility: result.visibility
        };
    }
    finally
    {
        await session.detach().catch(() =>
        {});
        await context.close();
    }
}

async function main()
{
    const options = parseArguments(process.argv.slice(2));
    const lockPath = '/tmp/fsusblog-issue-1180-scheduler-yield.lock';
    const lock = await open(lockPath, 'wx');
    const { chromium } = frontendRequire('playwright');
    const { createServer } = await import(frontendRequire.resolve('vite'));
    let viteServer;
    let browser;

    try
    {
        await lock.writeFile(`${process.pid}\n`);
        viteServer = await createServer({
            root: repoRoot,
            configFile: false,
            logLevel: 'error',
            server: { host: '127.0.0.1', port: 0, strictPort: false }
        });
        await viteServer.listen();
        const address = viteServer.httpServer.address();
        if (!address || typeof address === 'string')
        {
            throw new Error('Vite did not expose a local TCP port');
        }
        const origin = `http://127.0.0.1:${address.port}`;
        browser = await chromium.launch({ headless: true, executablePath: options.chromiumPath });
        const results = [];

        for (const profile of experimentProfiles)
        {
            const modes = {};
            for (const mode of ['control', 'candidate'])
            {
                const samples = [];
                for (let round = 0; round < options.rounds; round += 1)
                {
                    samples.push(await runRound({
                        browser,
                        origin,
                        profile,
                        mode,
                        screenshot: profile.name === 'mobile-slow-6x' && mode === 'candidate' && round === options.rounds - 1
                            ? options.screenshot
                            : null
                    }));
                }
                modes[mode] = { samples, summary: summarizeSamples(samples) };
            }
            const checksums = new Set([...modes.control.samples, ...modes.candidate.samples].map(sample => sample.checksum));
            if (checksums.size !== 1)
            {
                throw new Error(`control/candidate correctness mismatch for ${profile.name}`);
            }
            results.push({
                profile,
                modes,
                classification: classifyProfile(modes.control.summary, modes.candidate.summary)
            });
        }

        const fallbackSample = await runRound({ browser, origin, profile: experimentProfiles[0], mode: 'fallback', screenshot: null });
        const browserVersion = await browser.version();
        const evidence = {
            schema: 'fsusblog.scheduler-yield-local-experiment.v1',
            generatedAtUtc: new Date().toISOString(),
            commitSha: await gitCommit(),
            environment: {
                browser: browserVersion,
                executablePath: options.chromiumPath,
                playwright: frontendRequire('playwright/package.json').version,
                node: process.version,
                platform: `${os.platform()} ${os.release()} ${os.arch()}`,
                cpu: os.cpus()[0]?.model ?? 'unknown',
                logicalProcessors: os.availableParallelism?.() ?? os.cpus().length,
                totalMemoryBytes: os.totalmem(),
                network: 'local-vite-no-added-latency',
                concurrency: 'exclusive-lock-single-browser-single-page',
                probe: 'shared-host-epoch-target-to-cdp-mouse-handler'
            },
            interpretation: {
                scope: 'local-controlled-relative-evidence-not-real-device-or-rum',
                productionCallSitesEnabled: 0,
                decision: 'adapter-ready-no-production-callsite',
                gcObservation: 'unsupported: no stable per-operation GC count in CDP Performance.getMetrics',
                samplePolicy: 'all-rounds-retained-no-outlier-removal'
            },
            results,
            fallbackSmoke: fallbackSample
        };
        await writeFile(options.output, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
        console.log(JSON.stringify({
            output: options.output,
            screenshot: options.screenshot,
            browser: browserVersion,
            decision: evidence.interpretation.decision,
            profiles: results.map(result => ({ name: result.profile.name, ...result.classification }))
        }, null, 2));
    }
    finally
    {
        await browser?.close().catch(() =>
        {});
        await viteServer?.close().catch(() =>
        {});
        await lock.close().catch(() =>
        {});
        await rm(lockPath, { force: true });
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    main().catch(error =>
    {
        console.error(`[scheduler-yield-experiment] ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    });
}
