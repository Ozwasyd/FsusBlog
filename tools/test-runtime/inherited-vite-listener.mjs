import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const fields = ['FSUSBLOG_RUNTIME_LISTEN_FD', 'FSUSBLOG_RUNTIME_LISTEN_SOCKET',
    'FSUSBLOG_RUNTIME_PORT_LEASE_ID', 'FSUSBLOG_RUNTIME_LISTEN_ATTEMPT_ID',
    'FSUSBLOG_RUNTIME_LISTEN_PORT', 'FSUSBLOG_TEST_RUN_ID', 'FSUSBLOG_TEST_NAMESPACE'];

/**
 * Validate canonical managed-test admission against the live inherited socket.
 * Observation never binds or listens and does not issue readiness qualification.
 * The reservation owner retains its descriptor until actual application adoption.
 */
export function readInheritedListenerBinding(env = process.env)
{
    if (env.FSUSBLOG_MANAGED_TEST_LISTENER !== '1' || fields.some(key => !env[key]?.trim()))
    {
        throw new Error('managed test listener requires complete run/namespace/lease/attempt binding');
    }
    if (process.platform !== 'linux')
    {
        throw new Error('inherited listener requires Linux');
    }
    const fd = Number(env.FSUSBLOG_RUNTIME_LISTEN_FD);
    const port = Number(env.FSUSBLOG_RUNTIME_LISTEN_PORT);
    if (!Number.isInteger(fd) || fd < 3 || !Number.isInteger(port) || port < 1 || port > 65535 ||
      !/^socket:\[\d+\]$/.test(env.FSUSBLOG_RUNTIME_LISTEN_SOCKET))
    {
        throw new Error('invalid inherited listener descriptor binding');
    }
    const inode = env.FSUSBLOG_RUNTIME_LISTEN_SOCKET;
    if (fs.readlinkSync(`/proc/self/fd/${fd}`) !== inode)
    {
        throw new Error('inherited listener socket identity mismatch');
    }
    // Public Node APIs cannot inspect an unadopted socket's address. This observer duplicates
    // the same descriptor and reads kernel state; it never binds or starts listening.
    const observed = spawnSync(env.FSUSBLOG_PYTHON || 'python3', ['-c',
        'import socket,json,os; s=socket.socket(fileno=3); print(json.dumps({"family":s.family,"type":s.type,"address":s.getsockname(),"listening":s.getsockopt(socket.SOL_SOCKET,socket.SO_ACCEPTCONN),"reuse":s.getsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR),"inode":os.readlink("/proc/self/fd/3")}))'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', fd] });
    if (observed.status !== 0)
    {
        throw new Error(`inherited listener kernel observation failed: ${observed.stderr}`);
    }
    const state = JSON.parse(observed.stdout);
    if (state.family !== 2 || state.type !== 1 || state.address[0] !== '127.0.0.1' || state.address[1] !== port ||
      state.listening !== 0 || state.reuse !== 0 || state.inode !== inode)
    {
        throw new Error('inherited listener kernel state mismatch');
    }
    return Object.freeze({ fd, port, inode, runId: env.FSUSBLOG_TEST_RUN_ID, namespace: env.FSUSBLOG_TEST_NAMESPACE,
        leaseId: env.FSUSBLOG_RUNTIME_PORT_LEASE_ID, attemptId: env.FSUSBLOG_RUNTIME_LISTEN_ATTEMPT_ID });
}

/**
 * Adopt one previously verified socket through Vite's public server hooks.
 * Repeated adoption, restart and numeric rebind are rejected for this attempt.
 */
export function createInheritedListenerPlugin(binding)
{
    let adopted = false;
    function configure(server)
    {
        if (!server.httpServer)
        {
            throw new Error('managed Vite listener requires an HTTP server');
        }
        const listen = server.httpServer.listen.bind(server.httpServer);
        server.httpServer.listen = (port, host, ...args) =>
        {
            if (adopted || port !== binding.port || host !== '127.0.0.1' || args.length)
            {
                throw new Error('managed Vite listener refuses rebind or mismatched listen arguments');
            }
            if (fs.readlinkSync(`/proc/self/fd/${binding.fd}`) !== binding.inode)
            {
                throw new Error('listener socket changed before adoption');
            }
            adopted = true;
            return listen({ fd: binding.fd });
        };
    }
    return { name: 'fsus-managed-inherited-listener', configureServer: configure, configurePreviewServer: configure };
}

/**
 * Start the locked Vite runtime using a fully admitted inherited descriptor.
 * Configuration remains owned by the selected frontend root; the caller owns cleanup.
 */
export async function startInheritedViteListener({ mode, root, configFile, hmr } = {})
{
    if (!['dev', 'preview'].includes(mode))
    {
        throw new Error('managed Vite listener mode must be dev or preview');
    }
    const binding = readInheritedListenerBinding();
    const require = createRequire(path.join(root, 'package.json'));
    if (JSON.parse(fs.readFileSync(require.resolve('vite/package.json'), 'utf8')).version !== '8.0.16')
    {
        throw new Error('managed Vite listener requires qualification against the locked Vite 8.0.16 hooks');
    }
    const vite = await import(pathToFileURL(require.resolve('vite')).href);
    const config = { root, configFile, plugins: [createInheritedListenerPlugin(binding)],
        server: { host: '127.0.0.1', port: binding.port, strictPort: true, ...(hmr === undefined ? {} : { hmr }) },
        preview: { host: '127.0.0.1', port: binding.port, strictPort: true } };
    const server = mode === 'dev' ? await vite.createServer(config) : await vite.preview(config);
    if (mode === 'dev')
    {
        try
        {
            await server.listen();
        }
        catch (error)
        {
            await server.close();
            throw error;
        }
    }
    const address = server.httpServer.address();
    if (address?.address !== '127.0.0.1' || address.port !== binding.port ||
      fs.readlinkSync(`/proc/self/fd/${binding.fd}`) !== binding.inode)
    {
        await server.close();
        throw new Error('managed Vite listener identity changed after adoption');
    }
    return { server, binding };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
{
    const args = process.argv.slice(2);
    const get = key => args[args.indexOf(key) + 1];
    const { server, binding } = await startInheritedViteListener({ mode: get('--mode'), root: path.resolve(get('--root')) });
    console.log(JSON.stringify({ event: 'managed-listener-adopted', pid: process.pid, ...binding }));
    process.on('SIGTERM', async () =>
    {
        await server.close();
        process.exit(0);
    });
}
