import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { requireExactKeys, requireText } from './contract.mjs';

const requestSchema = 'fsusblog.security-resident-ipc-request.v1';
const cancellationSchema = 'fsusblog.security-resident-ipc-cancel.v1';
const responseSchema = 'fsusblog.security-resident-ipc-response.v1';
const maxRequestBytes = 64 * 1024;
const maxResponseBytes = 16 * 1024 * 1024;

function sourceIdentity(value)
{
    requireExactKeys(value, ['commit', 'worktreeFingerprint', 'runId'], 'resident IPC source identity');
    for (const key of ['commit', 'worktreeFingerprint', 'runId'])
    {
        requireText(value[key], key);
    }
    return Object.freeze({ ...value });
}

function sameIdentity(left, right)
{
    return left?.commit === right.commit && left?.worktreeFingerprint === right.worktreeFingerprint
        && left?.runId === right.runId;
}

function errorObservation(error)
{
    return { name: error?.name ?? 'Error', message: error?.message ?? String(error), stack: error?.stack ?? null };
}

function frames(peer, maximum, onFrame)
{
    let pending = '';
    peer.setEncoding('utf8');
    peer.on('data', (chunk) =>
    {
        pending += chunk;
        if (Buffer.byteLength(pending) > maximum)
        {
            peer.destroy(new Error('resident IPC frame exceeds its transport limit'));
            return;
        }
        let separator;
        while ((separator = pending.indexOf('\n')) >= 0)
        {
            const line = pending.slice(0, separator);
            pending = pending.slice(separator + 1);
            try
            {
                onFrame(JSON.parse(line));
            }
            catch (error)
            {
                peer.destroy(error);
                return;
            }
        }
    });
}

/** Attach local IPC to one existing admitted host session; never start another host. */
export async function serveSecurityScenarioSession({ session, ipcRoot, evidenceRoot: suppliedEvidenceRoot })
{
    if (typeof session?.dispatch !== 'function' || typeof session?.attempts !== 'function'
        || typeof session?.writeResult !== 'function')
    {
        throw new Error('resident IPC requires the original dispatch and result-producer session');
    }
    const identity = sourceIdentity(session.identity);
    const root = path.resolve(requireText(ipcRoot, 'owned IPC root'));
    const stat = fs.lstatSync(root);
    if (stat.isSymbolicLink() || !stat.isDirectory())
    {
        throw new Error('resident IPC root must be an existing regular directory');
    }
    const evidenceRoot = path.resolve(requireText(suppliedEvidenceRoot, 'original result evidence root'));
    const evidenceStat = fs.lstatSync(evidenceRoot);
    if (!evidenceStat.isDirectory() || evidenceStat.isSymbolicLink() || (evidenceStat.mode & 0o077) !== 0
        || evidenceStat.uid !== process.getuid())
    {
        throw new Error('original result evidence must have its own private preserved output directory');
    }
    const directory = fs.mkdtempSync(path.join(root, 'security-dispatch-'));
    fs.chmodSync(directory, 0o700);
    const socketPath = path.join(directory, 'dispatch.sock');
    const pending = new Set();
    const peers = new Set();
    const controllers = new Set();
    let closing;
    const server = net.createServer((peer) =>
    {
        peers.add(peer);
        let request;
        let controller;
        peer.on('error', () => undefined);
        peer.on('close', () =>
        {
            peers.delete(peer);
            controller?.abort(new Error('resident IPC requester disconnected'));
        });
        frames(peer, maxRequestBytes, (message) =>
        {
            if (message.schema === cancellationSchema)
            {
                requireExactKeys(message, ['schema', 'requestId', 'identity', 'reason'], 'resident cancellation');
                if (!request || message.requestId !== request.requestId || !sameIdentity(message.identity, identity))
                {
                    throw new Error('resident cancellation differs from its active request');
                }
                const reason = new Error(requireText(message.reason?.message, 'original cancellation reason'));
                reason.name = message.reason.name;
                reason.stack = message.reason.stack;
                controller.abort(reason);
                return;
            }
            if (closing)
            {
                throw new Error('resident IPC is closing; no new scenario may start');
            }
            requireExactKeys(message, ['schema', 'requestId', 'identity', 'scenarioId', 'attemptNumber'], 'resident request');
            if (request || message.schema !== requestSchema || message.attemptNumber !== 1
                || !sameIdentity(sourceIdentity(message.identity), identity))
            {
                throw new Error('resident request must bind one original source/run and attempt');
            }
            requireText(message.requestId, 'resident request ID');
            requireText(message.scenarioId, 'resident scenario ID');
            request = message;
            controller = new AbortController();
            controllers.add(controller);
            const before = session.attempts().find((item) => item.scenarioId === request.scenarioId);
            const execution = (async () =>
            {
                let dispatchError;
                try
                {
                    await session.dispatch({ scenarioId: request.scenarioId, attemptNumber: 1, signal: controller.signal });
                }
                catch (error)
                {
                    dispatchError = error;
                }
                const attempt = session.attempts().find((item) => item.scenarioId === request.scenarioId);
                const response = { schema: responseSchema, requestId: request.requestId, identity,
                    scenarioId: request.scenarioId, attemptNumber: 1, qualificationEligible: false };
                if (attempt && attempt !== before && attempt.status !== 'running')
                {
                    const result = session.writeResult({ scenarioId: request.scenarioId, evidenceRoot });
                    // Bytes come from the original host producer, including its
                    // original error/scan payload. No attempt sidecar is invented.
                    response.resultBytes = fs.readFileSync(result.file).toString('base64');
                    response.originalResultFile = result.file;
                }
                else
                {
                    response.dispatchError = errorObservation(dispatchError ?? new Error('no original dispatched result'));
                }
                if (!peer.destroyed)
                {
                    peer.end(`${JSON.stringify(response)}\n`);
                }
            })().catch((error) =>
            {
                if (!peer.destroyed)
                {
                    peer.end(`${JSON.stringify({ schema: responseSchema, requestId: request.requestId, identity,
                        scenarioId: request.scenarioId, attemptNumber: 1, qualificationEligible: false,
                        dispatchError: errorObservation(error) })}\n`);
                }
            }).finally(() =>
            {
                pending.delete(execution);
                controllers.delete(controller);
            });
            pending.add(execution);
        });
    });
    try
    {
        await new Promise((resolve, reject) =>
        {
            server.once('error', reject);
            server.listen(socketPath, resolve);
        });
        fs.chmodSync(socketPath, 0o600);
    }
    catch (error)
    {
        server.close();
        fs.rmSync(directory, { recursive: true, force: true });
        throw error;
    }
    return Object.freeze({ socketPath, identity,
        async close()
        {
            closing ??= (async () =>
            {
                // Stop accepting requests, then wait for original dispatch
                // settlement. Session lifetime remains with its original owner.
                const stopped = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
                for (const controller of controllers)
                {
                    controller.abort(new Error('resident IPC owner closing'));
                }
                await Promise.allSettled([...pending]);
                for (const peer of peers)
                {
                    peer.end();
                }
                await stopped;
                fs.rmSync(directory, { recursive: true, force: true });
            })();
            return closing;
        }
    });
}

/** Transport an original scenario result; admission remains inside the original session. */
export function requestSecurityScenarioDispatch({ socketPath, identity: suppliedIdentity, scenarioId, signal })
{
    const identity = sourceIdentity(suppliedIdentity);
    const socketFile = path.resolve(requireText(socketPath, 'resident socket path'));
    const parent = fs.lstatSync(path.dirname(socketFile));
    const socket = fs.lstatSync(socketFile);
    if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0
        || !socket.isSocket() || socket.isSymbolicLink() || (socket.mode & 0o077) !== 0
        || parent.uid !== process.getuid() || socket.uid !== process.getuid())
    {
        throw new Error('resident socket requires the original private local owner');
    }
    requireText(scenarioId, 'resident scenario ID');
    signal?.throwIfAborted();
    const requestId = randomUUID();
    return new Promise((resolve, reject) =>
    {
        const peer = net.createConnection(socketFile);
        let completed = false;
        const cancel = () =>
        {
            peer.write(`${JSON.stringify({ schema: cancellationSchema, requestId, identity,
                reason: errorObservation(signal.reason) })}\n`);
        };
        peer.once('error', reject);
        peer.once('close', () =>
        {
            signal?.removeEventListener('abort', cancel);
            if (!completed)
            {
                reject(new Error('resident IPC closed before the original result was received'));
            }
        });
        peer.once('connect', () =>
        {
            peer.write(`${JSON.stringify({ schema: requestSchema, requestId, identity, scenarioId, attemptNumber: 1 })}\n`);
            signal?.addEventListener('abort', cancel, { once: true });
            if (signal?.aborted)
            {
                cancel();
            }
        });
        frames(peer, maxResponseBytes, (response) =>
        {
            if (completed || response.schema !== responseSchema || response.requestId !== requestId
                || response.scenarioId !== scenarioId || response.attemptNumber !== 1
                || !sameIdentity(response.identity, identity) || response.qualificationEligible !== false)
            {
                throw new Error('resident response differs from its original request');
            }
            completed = true;
            const resultBytes = typeof response.resultBytes === 'string' ? Buffer.from(response.resultBytes, 'base64') : null;
            resolve(Object.freeze({ ...response, resultBytes,
                document: resultBytes ? JSON.parse(resultBytes.toString('utf8')) : null }));
            peer.end();
        });
    });
}
