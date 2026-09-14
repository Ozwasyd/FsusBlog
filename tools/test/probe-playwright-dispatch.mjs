#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function resolvePlaywrightPackage()
{
    const candidates = [
        path.join(root, 'src/frontend/node_modules/@playwright/test/package.json'),
        String(process.env.FSUSBLOG_PLAYWRIGHT_PACKAGE_JSON ?? '').trim()
    ].filter(Boolean);
    const file = candidates.find((candidate) =>
    {
        try
        {
            return JSON.parse(readFileSync(candidate, 'utf8')).name === '@playwright/test';
        }
        catch
        {
            return false;
        }
    });
    if (!file)
    {
        throw new Error('Playwright dispatch probe requires an installed @playwright/test package');
    }
    return file;
}

export function inspectPlaywrightDispatchCapabilities(packageFile = resolvePlaywrightPackage())
{
    const packageDocument = JSON.parse(readFileSync(packageFile, 'utf8'));
    const packageRoot = path.dirname(packageFile);
    const reporterTypes = readFileSync(path.resolve(packageRoot, '../../playwright/types/testReporter.d.ts'), 'utf8');
    const cli = path.join(packageRoot, 'cli.js');
    const help = spawnSync(process.execPath, [cli, 'test', '--help'], { encoding: 'utf8' });
    if (help.status !== 0)
    {
        throw new Error(`Playwright dispatch probe CLI help failed: ${help.stderr}`);
    }
    return {
        version: packageDocument.version,
        exports: Object.keys(packageDocument.exports ?? {}).sort(),
        testListCli: /--test-list <file>/u.test(help.stdout),
        reporterCallbacks: {
            onTestBegin: /onTestBegin\?/u.test(reporterTypes),
            onTestEnd: /onTestEnd\?/u.test(reporterTypes),
            preDispatch: /onTestDispatch\?|onTestGroupDispatch\?|beforeDispatch\?/u.test(reporterTypes)
        },
        workerRestartIdentity: /parallelIndex:\s*number/u.test(reporterTypes)
            && /workerIndex:\s*number/u.test(reporterTypes),
        typeDigest: `sha256:${createHash('sha256').update(reporterTypes).digest('hex')}`,
        cliHelpDigest: `sha256:${createHash('sha256').update(help.stdout).digest('hex')}`
    };
}

export function runRealPlaywrightDispatchProbe(packageFile = resolvePlaywrightPackage())
{
    const packageRoot = path.dirname(packageFile);
    const cli = path.join(packageRoot, 'cli.js');
    const directory = mkdtempSync(path.join(os.tmpdir(), 'fsusblog-playwright-dispatch-probe-'));
    try
    {
        const events = path.join(directory, 'events.ndjson');
        const spec = path.join(directory, 'probe.spec.js');
        const reporter = path.join(directory, 'reporter.cjs');
        const config = path.join(directory, 'playwright.config.cjs');
        writeFileSync(spec, [
            "const { test, expect } = require('@playwright/test')",
            "const fs = require('node:fs')",
            "const events = process.env.FSUSBLOG_PLAYWRIGHT_PROBE_EVENTS",
            "for (const [name, delay] of [['slow', 80], ['fast', 5], ['restart-observer', 20]]) test(name, async ({}, testInfo) => {",
            "  fs.appendFileSync(events, JSON.stringify({kind:'body',name,workerIndex:testInfo.workerIndex,parallelIndex:testInfo.parallelIndex,at:Number(process.hrtime.bigint())})+'\\n')",
            "  await new Promise(resolve => setTimeout(resolve, delay))",
            "  expect(true).toBe(true)",
            "})"
        ].join('\n'));
        writeFileSync(reporter, [
            "const fs = require('node:fs')",
            "module.exports = class Reporter {",
            "  onTestBegin(test, result) { fs.appendFileSync(process.env.FSUSBLOG_PLAYWRIGHT_PROBE_EVENTS, JSON.stringify({kind:'begin',name:test.title,workerIndex:result.workerIndex,parallelIndex:result.parallelIndex,at:Number(process.hrtime.bigint())})+'\\n') }",
            "  onTestEnd(test, result) { fs.appendFileSync(process.env.FSUSBLOG_PLAYWRIGHT_PROBE_EVENTS, JSON.stringify({kind:'end',name:test.title,status:result.status,workerIndex:result.workerIndex,parallelIndex:result.parallelIndex,at:Number(process.hrtime.bigint())})+'\\n') }",
            "}"
        ].join('\n'));
        writeFileSync(config, `module.exports={testDir:${JSON.stringify(directory)},fullyParallel:true,workers:2,retries:0,reporter:${JSON.stringify(reporter)}}\n`);
        const result = spawnSync(process.execPath, [cli, 'test', '--config', config], {
            cwd: directory,
            encoding: 'utf8',
            env: {
                ...process.env,
                NODE_PATH: path.resolve(packageRoot, '../..'),
                FSUSBLOG_PLAYWRIGHT_PROBE_EVENTS: events
            }
        });
        if (result.status !== 0)
        {
            throw new Error(`real Playwright dispatch probe failed: ${result.stderr || result.stdout}`);
        }
        const records = readFileSync(events, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
        const begins = records.filter((entry) => entry.kind === 'begin');
        const bodies = records.filter((entry) => entry.kind === 'body');
        const ends = records.filter((entry) => entry.kind === 'end');
        if (begins.length !== 3 || bodies.length !== 3 || ends.length !== 3)
        {
            throw new Error('real Playwright dispatch probe did not execute all tests');
        }
        if (new Set(bodies.map((entry) => entry.parallelIndex)).size < 2)
        {
            throw new Error('real Playwright dispatch probe did not retain parallel overlap');
        }
        return {
            status: 'observed',
            records,
            completionOrder: ends.sort((left, right) => left.at - right.at).map((entry) => entry.name),
            reporterPreDispatchAvailable: false,
            observationDigest: `sha256:${createHash('sha256').update(JSON.stringify(records.map((record) =>
            {
                const entry = { ...record };
                delete entry.at;
                return entry;
            }))).digest('hex')}`
        };
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href)
{
    const capabilities = inspectPlaywrightDispatchCapabilities();
    const execution = process.argv.includes('--run') ? runRealPlaywrightDispatchProbe() : null;
    process.stdout.write(`${JSON.stringify({ capabilities, execution }, null, 2)}\n`);
}
