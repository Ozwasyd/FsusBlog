import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import vm from 'node:vm';

import {canonicalize, createPortLeaseAllocator, defaultRoleCatalog, observeBoundPortLease, sealPortLeaseManifest}
    from '@fsusblog/governance-tools/test-matrix/production-fresh-port-lease';

const {probeBootstrapBinaryRoute} = await import(new URL('../../tools/test/probe-release-reliability-runtime-smoke.mjs', import.meta.url));
const {assertProductionFreshReadiness} = await import(new URL('../../tools/test/bundles/runtime-environment.mjs', import.meta.url));
const {encodeAedsFrame} = await import(new URL('../frontend/support/aeds-envelope.mjs', import.meta.url));
const repository = path.resolve(import.meta.dirname, '../..');
const hash = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const payload = new Uint8Array(16).fill(23);
const valid = () => Buffer.from(encodeAedsFrame(13, payload));

async function eventually(probe)
{
    const deadline = Date.now() + 10000;
    while (true)
    {
        try
        {
            return await probe();
        }
        catch (error)
        {
            if (Date.now() >= deadline)
            {
                throw error;
            }
            await delay(20);
        }
    }
}

async function serverFixture(t, handler)
{
    const server = http.createServer(handler);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () =>
    {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    });
    return `http://127.0.0.1:${server.address().port}`;
}

test('real HTTP binary probe binds managed listener around a canonical frame and fixed payload', async (t) =>
{
    const url = await serverFixture(t, (_request, response) =>
    {
        response.writeHead(200, {'content-type': 'application/octet-stream'});
        response.end(valid());
    });
    const result = await probeBootstrapBinaryRoute({url: `${url}/api/binary/system/seo`,
        managedPid: process.pid, expectedPayloadDigest: hash(payload)});
    assert.equal(result.frame.crcValidated, true);
    assert.equal(result.processIdentity.pid, process.pid);
    assert.equal(result.payloadDigest, hash(payload));
    assert.equal(result.qualifiedReadiness, false, 'wire and lifecycle evidence cannot qualify product readiness');
    await assert.rejects(probeBootstrapBinaryRoute({url: `${url}/api/binary/system/seo`,
        managedPid: process.pid, expectedPayloadDigest: hash(new Uint8Array(16))}), /payload\/generation mismatch/u);
    await assert.rejects(probeBootstrapBinaryRoute({url: `${url}/api/binary/system/seo`,
        managedPid: 0}), /exact managed process identity/u);
});

test('real HTTP probe refuses HTML, redirect, wrong frame, truncation, CRC drift, oversize and timeout', async (t) =>
{
    let reply;
    let requests = 0;
    const url = await serverFixture(t, (_request, response) =>
    {
        requests++;
        if (reply.delay)
        {
            return;
        }
        response.writeHead(reply.status ?? 200, {'content-type': reply.contentType ?? 'application/octet-stream',
            ...(reply.location ? {location: reply.location} : {})});
        response.end(reply.body);
    });
    const corrupt = valid();
    corrupt[corrupt.length - 1] ^= 1;
    for (const scenario of [
        {label: 'HTML fallback', contentType: 'text/html', body: '<!doctype html><html></html>'},
        {label: 'redirect', status: 302, location: '/api/binary/system/seo', body: valid()},
        {label: 'wrong frame', body: Buffer.from(encodeAedsFrame(30, payload))},
        {label: 'truncation', body: valid().subarray(0, 20)},
        {label: 'CRC drift', body: corrupt},
        {label: 'body bound', body: Buffer.from(encodeAedsFrame(13, new Uint8Array(70000)))},
        {label: 'timeout', delay: true}
    ])
    {
        reply = scenario;
        const before = requests;
        await assert.rejects(probeBootstrapBinaryRoute({url: `${url}/api/binary/system/seo`, timeoutMs: 300}),
            undefined, scenario.label);
        assert.equal(requests, before + 1, `${scenario.label}: exactly one request and no redirect/retry`);
    }
});

test('PoW probe enforces the canonical no-store policy and refuses unadmitted targets', async (t) =>
{
    let cache = false;
    let requests = 0;
    const url = await serverFixture(t, (_request, response) =>
    {
        requests++;
        response.writeHead(200, {'content-type': 'application/octet-stream', ...(cache ? {'cache-control': 'no-store'} : {})});
        response.end(Buffer.from(encodeAedsFrame(30, new Uint8Array(204))));
    });
    await assert.rejects(probeBootstrapBinaryRoute({url: `${url}/api/binary/auth/pow-challenge`}), /cache policy mismatch/u);
    cache = true;
    assert.equal((await probeBootstrapBinaryRoute({url: `${url}/api/binary/auth/pow-challenge`})).frame.frameType, 30);
    for (const target of [`${url}/`, `${url}/api/binary/system/seo?run=other`, url.replace('127.0.0.1', 'localhost') + '/api/binary/system/seo'])
    {
        await assert.rejects(probeBootstrapBinaryRoute({url: target}), /admitted loopback canonical route/u);
    }
    assert.equal(requests, 2);
});

const nativeSource = [
    'import http.server,os,socket',
    'class Handler(http.server.BaseHTTPRequestHandler):',
    ' def do_GET(self):',
    "  body=open('body.bin','rb').read()",
    "  self.send_response(200);self.send_header('Content-Type','application/octet-stream');self.end_headers()",
    "  if os.path.exists('close-listener'): self.server.socket.close()",
    '  self.wfile.write(body);self.wfile.flush()',
    ' def log_message(self,*args): pass',
    "server=http.server.HTTPServer(('127.0.0.1',int(os.environ['FSUSBLOG_RUNTIME_LISTEN_PORT'])),Handler,bind_and_activate=False)",
    'server.socket.close()',
    "server.socket=socket.socket(fileno=int(os.environ['FSUSBLOG_RUNTIME_LISTEN_FD']))",
    'server.server_activate()',
    "print('ready',flush=True)",
    'server.serve_forever()'
].join('\n');

async function boundFixture(t)
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-readiness-bound-'));
    const allocator = createPortLeaseAllocator({runId: 'readiness-run', namespace: 'readiness-namespace',
        continuousHandoff: true, roles: defaultRoleCatalog().filter((entry) => entry.role === 'debug-backend')});
    t.after(async () =>
    {
        await allocator.releaseAll('test-terminal', {cancelBound: true});
        fs.rmSync(directory, {recursive: true, force: true});
    });
    const [lease] = await allocator.allocate();
    fs.writeFileSync(path.join(directory, 'body.bin'), valid());
    const launched = await allocator.launchNative(lease.role, {argv: ['python3', '-c', nativeSource],
        cwd: directory, logFile: path.join(directory, 'runtime.log'), env: {}});
    await eventually(() => assert.match(fs.readFileSync(path.join(directory, 'runtime.log'), 'utf8'), /ready/u));
    await allocator.completeHandoff(lease.role, `pid:${launched.handoffOwnerIdentity.pid}`);
    const manifest = sealPortLeaseManifest({runId: 'readiness-run', namespace: 'readiness-namespace',
        reservationOwnerIdentity: lease.reservationOwnerIdentity, createdAt: lease.createdAt,
        controlSocketPath: path.join(directory, 'control.sock'), tokenFilePath: path.join(directory, 'token'),
        pidFilePath: path.join(directory, 'pid'), terminalReceiptPath: path.join(directory, 'terminal.json'),
        leases: allocator.snapshot()});
    return {allocator, directory, lease, manifest, options: {manifest, role: lease.role,
        runId: manifest.runId, namespace: manifest.namespace}};
}

test('bound listener observation and AEDS probe consume the same exact native lease attempt', async (t) =>
{
    const {lease, options, manifest} = await boundFixture(t);
    const bound = await observeBoundPortLease(options);
    assert.equal(bound.identity.portLeaseId, lease.portLeaseId);
    const result = await probeBootstrapBinaryRoute({...options, url: `http://127.0.0.1:${lease.port}/api/binary/system/seo`,
        expectedPayloadDigest: hash(payload)});
    assert.deepEqual(result.bound, bound);
    for (const altered of [{runId: 'other-run'}, {namespace: 'other-namespace'}, {role: 'release-preview'}])
    {
        await assert.rejects(observeBoundPortLease({...options, ...altered}));
    }
    const modified = structuredClone(manifest);
    modified.leases[0].handoffOwnerIdentity.processStartIdentity += '-drift';
    const fields = {...modified.leases[0]};
    delete fields.contentDigest;
    modified.leases[0].contentDigest = hash(JSON.stringify(canonicalize(fields)));
    // Digest-valid statements cannot overwrite the actual listener's start identity.
    await assert.rejects(observeBoundPortLease({...options, manifest: sealPortLeaseManifest(modified)}));
    await assert.rejects(probeBootstrapBinaryRoute({...options,
        url: `http://127.0.0.1:${lease.port + 1}/api/binary/system/seo`}), /differs from its bound listener receipt/u);
});

test('closing the bound listener during the canary fails the same-attempt post-observation', async (t) =>
{
    const {directory, lease, options} = await boundFixture(t);
    fs.writeFileSync(path.join(directory, 'close-listener'), 'close');
    await assert.rejects(probeBootstrapBinaryRoute({...options,
        url: `http://127.0.0.1:${lease.port}/api/binary/system/seo`}), /listener identity drift|bound native listener drift/u);
});

test('Fresh consumer refuses absent, substituted or non-private manifest without accepting diagnostics', async (t) =>
{
    const {directory, manifest} = await boundFixture(t);
    const file = path.join(directory, 'manifest.json');
    fs.writeFileSync(file, JSON.stringify(manifest), {mode: 0o600});
    const options = {environment: {FSUSBLOG_PORT_LEASE_MANIFEST_FILE: file},
        runId: manifest.runId, namespace: manifest.namespace};
    await assert.rejects(assertProductionFreshReadiness({...options, environment: {}}), /explicit current-run/u);
    await assert.rejects(assertProductionFreshReadiness({...options, runId: 'other-run'}), /current run/u);
    await assert.rejects(assertProductionFreshReadiness(options), /bound listener receipt is missing for postgres/u);
    fs.chmodSync(file, 0o644);
    await assert.rejects(assertProductionFreshReadiness(options), /task-private regular file/u);
    fs.chmodSync(file, 0o600);
    const link = path.join(directory, 'link.json');
    fs.symlinkSync(file, link);
    await assert.rejects(assertProductionFreshReadiness({...options, environment: {FSUSBLOG_PORT_LEASE_MANIFEST_FILE: link}}), {code: 'ELOOP'});
});

test('canonical bundle executeStep refuses its first consumer before spawning when current-run authority is missing', async (t) =>
{
    const {directory, manifest} = await boundFixture(t);
    const file = path.join(directory, 'manifest.json');
    fs.writeFileSync(file, JSON.stringify(manifest), {mode: 0o600});
    const source = fs.readFileSync(path.join(repository, 'tools/test/bundles/run-bundle.mjs'), 'utf8');
    const body = source.match(/^async function executeStep\(step\)\n\{\n[\s\S]*?^\}/mu)?.[0];
    assert.ok(body);
    let spawns = 0;
    // Execute the canonical admission boundary with the real verifier; the unavailable
    // downstream scheduler context cannot be reached or used as a qualification double.
    const execute = new vm.Script(`${body}\nexecuteStep`).runInNewContext({
        assertProductionFreshReadiness, productionFreshLayout: {runId: manifest.runId},
        runtimeChildEnvironment: {FSUSBLOG_TEST_NAMESPACE: manifest.namespace, FSUSBLOG_PORT_LEASE_MANIFEST_FILE: file},
        schedulerRunId: () => manifest.runId, process: {env: {FSUSBLOG_TEST_NAMESPACE: manifest.namespace}},
        spawn: () =>
        {
            spawns++;
        }
    });
    await assert.rejects(execute({id: 'runtime-consumer'}), /bound listener receipt is missing for postgres/u);
    assert.equal(spawns, 0);
});

function shellFunction(source, name)
{
    const body = source.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}`, 'mu'))?.[0];
    assert.ok(body, `canonical bootstrap function is present: ${name}`);
    return body;
}

test('actual wrong-run Vite 200 cannot be borrowed or terminated by canonical Fresh bootstrap', async (t) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-readiness-vite-'));
    fs.writeFileSync(path.join(directory, 'index.html'), '<!doctype html><html><body>other run</body></html>');
    const childSource = [
        `const {createServer}=await import(${JSON.stringify(path.join(repository, 'src/frontend/node_modules/vite/dist/node/index.js'))});`,
        `const server=await createServer({root:${JSON.stringify(directory)},configFile:false,server:{host:'127.0.0.1',port:0,hmr:false}});`,
        "await server.listen();console.log(server.httpServer.address().port);process.on('SIGTERM',async()=>{await server.close();process.exit(0)});"
    ].join('\n');
    const child = spawn(process.execPath, ['--input-type=module', '-e', childSource], {
        env: {...process.env, FSUSBLOG_TEST_RUN_ID: 'other-run', FSUSBLOG_TEST_NAMESPACE: 'other-namespace'},
        stdio: ['ignore', 'pipe', 'pipe']});
    let output = '';
    let errors = '';
    child.stdout.on('data', (bytes) =>
    {
        output += bytes;
    });
    child.stderr.on('data', (bytes) =>
    {
        errors += bytes;
    });
    t.after(async () =>
    {
        const exited = child.exitCode !== null ? Promise.resolve() : new Promise((resolve) => child.once('exit', resolve));
        child.kill('SIGTERM');
        await exited;
        fs.rmSync(directory, {recursive: true, force: true});
    });
    const port = await eventually(() =>
    {
        assert.equal(child.exitCode, null, errors);
        const value = Number(output.trim().split('\n').at(-1));
        assert.ok(value > 0 && value < 65536, `${output}\n${errors}`);
        return value;
    });
    assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
    const functions = ['ReadPidFile', 'FindPortPid', 'PortIsListening', 'PortLeaseCli', 'ProbeUrl',
        'AdmitDedicatedRuntimePort', 'EnsureDebugFrontend'];
    const source = fs.readFileSync(path.join(repository, 'tools/bootstrap-acceptance-env.sh'), 'utf8');
    // Mutation controls run the actual bootstrap shell functions with only unrelated lifecycle effects observed.
    const execute = (bootstrap) =>
    {
        const script = [
            ...functions.map((name) => shellFunction(bootstrap, name)),
            'Log() { printf "%s\\n" "$*" >&2; }',
            'CanReuseProcesses() { return 0; }',
            'CompletePortLeaseHandoff() { echo borrowed; }',
            'KillRuntimePidIfOwned() { echo terminated; return 1; }',
            `TMP_DIR=${quote(directory)}`,
            `PORT_LEASE_SCRIPT=${quote(path.join(repository, 'tools/test-matrix/production-fresh-port-lease.mjs'))}`,
            `PORT_LEASE_MANIFEST_FILE=${quote(path.join(directory, 'missing-manifest.json'))}`,
            `FSUSBLOG_NODE=${quote(process.execPath)}`,
            `FSUSBLOG_PRODUCTION_FRESH_OUTPUT_ROOT=${quote(directory)}`,
            'FSUSBLOG_TEST_RUN_ID=current-run',
            'FSUSBLOG_TEST_NAMESPACE=current-namespace',
            'FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME=0',
            `DEBUG_FRONTEND_PORT=${port}`,
            `DEBUG_FRONTEND_URL=http://127.0.0.1:${port}`,
            'EnsureDebugFrontend 9999999999999'
        ].join('\n');
        return spawnSync('bash', ['-c', script], {cwd: repository, encoding: 'utf8', timeout: 10000});
    };
    const current = execute(source);
    assert.equal(current.status, 1, `${current.stdout}\n${current.stderr}`);
    assert.doesNotMatch(current.stdout, /borrowed|terminated/u);
    process.kill(child.pid, 0);
    assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
    const killBoundary = spawnSync('bash', ['-c', [
        shellFunction(source, 'KillRuntimePidIfOwned'), shellFunction(source, 'PortLeaseCli'),
        'Log() { printf "%s\\n" "$*" >&2; }',
        'KillPidIfRunning() { echo terminated; }',
        `PORT_LEASE_SCRIPT=${quote(path.join(repository, 'tools/test-matrix/production-fresh-port-lease.mjs'))}`,
        `PORT_LEASE_MANIFEST_FILE=${quote(path.join(directory, 'missing-manifest.json'))}`,
        `FSUSBLOG_NODE=${quote(process.execPath)}`,
        `FSUSBLOG_PRODUCTION_FRESH_OUTPUT_ROOT=${quote(directory)}`,
        'FSUSBLOG_TEST_RUN_ID=current-run', 'FSUSBLOG_TEST_NAMESPACE=current-namespace',
        'FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME=0',
        `KillRuntimePidIfOwned debug-frontend ${quote(path.join(directory, 'missing.pid'))} ${child.pid} 9999999999999`
    ].join('\n')], {cwd: repository, encoding: 'utf8', timeout: 10000});
    assert.equal(killBoundary.status, 1, `${killBoundary.stdout}\n${killBoundary.stderr}`);
    assert.doesNotMatch(killBoundary.stdout, /terminated/u);
    process.kill(child.pid, 0);
    const old = spawnSync('git', ['show', '8b1c739cacef47995f441f096835863d377dc347:tools/bootstrap-acceptance-env.sh'],
        {cwd: repository, encoding: 'utf8'});
    assert.equal(old.status, 0, old.stderr);
    const mutation = execute(old.stdout);
    assert.equal(mutation.status, 0, mutation.stderr);
    assert.match(mutation.stdout, /borrowed/u, 'negative control reproduces the actual old HTTP-200 admission');
    process.kill(child.pid, 0);
});
