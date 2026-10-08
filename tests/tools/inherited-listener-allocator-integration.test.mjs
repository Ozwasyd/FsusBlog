import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const allocatorRoot = process.env.FSUSBLOG_NATIVE_LISTENER_ALLOCATOR_ROOT || repositoryRoot;
const allocatorFile = path.join(allocatorRoot, 'tools/test-matrix/production-fresh-port-lease.mjs');
const allocatorFileDigest = crypto.createHash('sha256').update(fs.readFileSync(allocatorFile)).digest('hex');
const allocatorCommit = process.env.FSUSBLOG_NATIVE_LISTENER_ALLOCATOR_COMMIT || spawnSync('git', ['rev-parse', 'HEAD'], { cwd: allocatorRoot, encoding: 'utf8' }).stdout.trim();
assert.match(allocatorCommit, /^[a-f0-9]{40}$/u, 'Allocator requires an exact source commit');
const committedAllocator = spawnSync('git', ['show', `${allocatorCommit}:tools/test-matrix/production-fresh-port-lease.mjs`], { cwd: repositoryRoot });
assert.equal(committedAllocator.status, 0, 'Allocator source commit must be available for verification');
assert.equal(crypto.createHash('sha256').update(committedAllocator.stdout).digest('hex'), allocatorFileDigest, 'Loaded allocator must match its exact committed source');
const { createPortLeaseAllocator, defaultRoleCatalog } = await import(pathToFileURL(allocatorFile).href);

async function competingBind(port, host)
{
    const server = net.createServer();
    try
    {
        await new Promise((resolve, reject) =>
        {
            server.once('error', reject);
            server.listen({ port, host, ipv6Only: host === '::1' }, resolve);
        });
    }
    finally
    {
        if (server.listening)
        {
            await new Promise(resolve => server.close(resolve));
        }
    }
}

async function waitForListening(logFile)
{
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline)
    {
        const text = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
        for (const line of text.split('\n'))
        {
            try
            {
                const event = JSON.parse(line);
                if (event.event === 'listening')
                {
                    return event;
                }
            }
            catch
            { /* Runtime logs also contain ordinary non-JSON diagnostics. */ }
        }
        if (/identity mismatch|binding missing|requires complete|activation denied|InvalidOperationException|Error:/.test(text))
        {
            throw new Error(`Managed listener failed:\n${text}`);
        }
        await delay(10);
    }
    throw new Error(`Managed listener deadline exceeded; see ${logFile}`);
}

async function businessCanary(port, role)
{
    return new Promise((resolve, reject) =>
    {
        const agent = new http.Agent({ keepAlive: true });
        const request = http.get({ host: '127.0.0.1', port, path: role === 'kestrel' ? '/canary' : '/', agent }, response =>
        {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', chunk =>
            {
                body += chunk;
            });
            response.once('end', () =>
            {
                agent.destroy();
                resolve({ status: response.statusCode, body });
            });
            response.once('error', error =>
            {
                agent.destroy();
                reject(error);
            });
        });
        request.setTimeout(5000, () => request.destroy(new Error('canary timeout')));
        request.once('error', error =>
        {
            agent.destroy();
            reject(error);
        });
    });
}

async function waitForConnectionDrain(port)
{
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline)
    {
        const rows = fs.readFileSync('/proc/net/tcp', 'utf8').split('\n').slice(1).filter(Boolean);
        if (!rows.some(row =>
        {
            const fields = row.trim().split(/\s+/u);
            return fields[1].endsWith(`:${port.toString(16).toUpperCase().padStart(4, '0')}`) && fields[3] !== '0A';
        }))
        {
            return;
        }
        await delay(10);
    }
    throw new Error('Client canary connection did not drain before cancellation');
}

test('actual allocator supplies canonical run identity to Vite and Kestrel adapters', { timeout: 120_000 }, async () =>
{
    const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-native-allocator-test-'));
    const frontend = process.env.FSUSBLOG_NATIVE_LISTENER_FRONTEND || path.join(repositoryRoot, 'src/frontend');
    const dotnet = process.env.FSUSBLOG_NATIVE_LISTENER_DOTNET || 'dotnet';
    const site = path.join(evidenceRoot, 'site');
    fs.mkdirSync(path.join(site, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(site, 'package.json'), '{}');
    fs.symlinkSync(path.join(frontend, 'node_modules'), path.join(site, 'node_modules'), 'dir');
    const fixtureRoot = path.join(repositoryRoot, 'tests/tools/fixtures/managed-listener');
    const projectRoot = path.join(evidenceRoot, 'kestrel');
    fs.mkdirSync(projectRoot);
    fs.copyFileSync(path.join(fixtureRoot, 'Program.cs'), path.join(projectRoot, 'Program.cs'));
    fs.writeFileSync(path.join(projectRoot, 'Prototype.csproj'), `<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net10.0</TargetFramework><Nullable>enable</Nullable><ImplicitUsings>enable</ImplicitUsings></PropertyGroup><ItemGroup><Compile Include="${path.join(repositoryRoot, 'src/backend/Infrastructure/Bootstrap/FsusManagedTestListener.cs')}" /></ItemGroup></Project>`);
    const build = spawnSync(dotnet, ['build', '-c', 'Release', '--nologo'], { cwd: projectRoot, encoding: 'utf8', env: { ...process.env, DOTNET_CLI_HOME: path.join(evidenceRoot, 'dotnet-home'), DOTNET_CLI_TELEMETRY_OPTOUT: '1' } });
    fs.writeFileSync(path.join(evidenceRoot, 'build.log'), `${build.stdout}\n${build.stderr}`);
    assert.equal(build.status, 0, `Fixture build failed; see ${evidenceRoot}/build.log`);
    const cases = [];
    for (const role of ['vite-dev', 'vite-preview', 'kestrel'])
    {
        const nonce = crypto.randomUUID();
        const runId = `allocator-${nonce}`;
        const namespace = `native-${nonce}`;
        const catalogRole = role === 'kestrel' ? 'debug-backend' : role === 'vite-dev' ? 'debug-frontend' : 'release-preview';
        const allocator = createPortLeaseAllocator({ runId, namespace, continuousHandoff: true, roles: defaultRoleCatalog().filter(entry => entry.role === catalogRole) });
        assert.equal(typeof allocator.launchNative, 'function', 'Canonical continuous allocator capability is required; source-only fallback is forbidden');
        let port;
        try
        {
            const [lease] = await allocator.allocate();
            port = lease.port;
            const logFile = path.join(evidenceRoot, `${role}.log`);
            const html = `<!doctype html><html><body>${nonce}</body></html>\n`;
            fs.writeFileSync(path.join(site, 'index.html'), html);
            fs.writeFileSync(path.join(site, 'dist/index.html'), html);
            const env = { FSUSBLOG_ADAPTER_REPO: repositoryRoot, FSUSBLOG_ADAPTER_SITE: site, FSUSBLOG_ADAPTER_ALLOCATOR_MODE: '1', ROLE: role, CANARY: nonce,
                ASPNETCORE_URLS: `http://127.0.0.1:${port}`, FSUSBLOG_TEST_RUN_ID: 'untrusted-spec-run', FSUSBLOG_TEST_NAMESPACE: 'untrusted-spec-namespace', FSUS_TEST_RUN_ID: 'unverified-alias-run', TEST_NAMESPACE: 'unverified-alias-namespace' };
            const argv = role === 'kestrel' ? [dotnet, path.join(projectRoot, 'bin/Release/net10.0/Prototype.dll')] : [process.execPath, path.join(fixtureRoot, 'vite-child.mjs')];
            const launched = await allocator.launchNative(lease.role, { argv, cwd: evidenceRoot, logFile, env });
            const actual = launched.handoffOwnerIdentity;
            const observed = await waitForListening(logFile);
            assert.equal(observed.pid, actual.pid);
            assert.equal(observed.inode, actual.socketIdentity);
            assert.equal(observed.binding.runId, runId);
            assert.equal(observed.binding.namespace, namespace);
            assert.equal(observed.binding.leaseId, lease.portLeaseId);
            assert.equal(observed.binding.attemptId, actual.attemptId);
            for (const host of ['127.0.0.1', '::1'])
            {
                await assert.rejects(competingBind(port, host), { code: 'EADDRINUSE' });
            }
            const canary = await businessCanary(port, role);
            assert.equal(canary.status, 200);
            assert.ok(canary.body.includes(nonce));
            await waitForConnectionDrain(port);
            const completed = await allocator.completeHandoff(lease.role, `pid:${actual.pid}`);
            assert.equal(completed.handoffState, 'bound');
            cases.push({ role, runId, namespace, port, pid: actual.pid, socketIdentity: actual.socketIdentity, attemptId: actual.attemptId, passed: true });
        }
        finally
        {
            await allocator.releaseAll('integration-test-terminal', { cancelBound: true });
        }
        for (const host of ['127.0.0.1', '::1'])
        {
            await competingBind(port, host);
        }
    }
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(allocatorFile)).digest('hex'), allocatorFileDigest, 'Allocator source changed during the integration run');
    const receipt = { adapterCommit: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).stdout.trim(), allocatorCommit, allocatorFileDigest, passed: true, cases, limits: 'Actual allocator and native adapter integration only; no five-role AEDS/image/native/product readiness qualification.' };
    fs.writeFileSync(path.join(evidenceRoot, 'report.json'), `${JSON.stringify(receipt, null, 2)}\n`);
    console.log(`Allocator-native integration evidence: ${evidenceRoot}`);
});
