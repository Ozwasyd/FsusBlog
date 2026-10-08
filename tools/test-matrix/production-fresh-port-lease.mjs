#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { observeReservedContainerPublisher, recoverReleaseContainerPublisher, reserveContainerPublisher, validateContainerReservationOptions } from './production-fresh-container-reservation.mjs';

export const portLeaseReservationEngine = 'python-bind-without-listen';

const nativeGuardianFile = fileURLToPath(new URL('./production-fresh-native-reservation-guardian.py', import.meta.url));

const reservationPythonScript = String.raw`
import json, os, socket, subprocess, sys
port = int(sys.argv[1])
mode = sys.argv[2] if len(sys.argv) > 2 else 'both'
sockets = []
def bind_one(family, address, v6only=False):
    sock = socket.socket(family, socket.SOCK_STREAM)
    if v6only:
        try:
            sock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
        except (AttributeError, OSError):
            pass
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 0)
    except OSError:
        pass
    sock.bind(address)
    sockets.append(sock)
try:
    if mode in ('both', 'v4'):
        bind_one(socket.AF_INET, ('127.0.0.1', port))
    if mode in ('both', 'v6'):
        bind_one(socket.AF_INET6, ('::1', port), True)
except Exception as exc:
    for sock in sockets:
        try:
            sock.close()
        except Exception:
            pass
    print('bind-failed: %s' % (exc,), file=sys.stderr, flush=True)
    sys.exit(1)
guardian = None
application_identity = None
guardian_directory = None
retained = False
explicit_close = False

def guardian_response():
    response = json.loads(guardian.stdout.readline())
    if not response['ok']:
        raise RuntimeError(response['error'])
    return response['result']

def guardian_command(command):
    guardian.stdin.write(json.dumps({'command': command}) + '\n')
    guardian.stdin.flush()
    return guardian_response()

def stop_guardian():
    if guardian is None:
        return
    if guardian.poll() is None:
        try:
            guardian.stdin.write(json.dumps({'command': 'cancel'}) + '\n')
            guardian.stdin.flush()
        except BrokenPipeError:
            pass
        guardian.wait(timeout=6)
    with open(os.path.join(guardian_directory, 'cleanup.json'), encoding='utf-8') as source:
        observation = json.load(source)
    if not observation['verified']:
        raise RuntimeError('native guardian cleanup was not verified')

print('ready', flush=True)
try:
    for line in sys.stdin:
        request = json.loads(line)
        try:
            if request['command'] == 'launch-native':
                if guardian is not None or mode != 'v4':
                    raise ValueError('native socket handoff is not available')
                specification = request['specification']
                argv = specification['argv']
                if not isinstance(argv, list) or not argv or not all(isinstance(arg, str) for arg in argv):
                    raise ValueError('native launch argv is invalid')
                fd = sockets[0].fileno()
                guardian_directory = specification['logFile'] + '.guardian'
                guardian = subprocess.Popen([sys.executable, '-I', '-B', sys.argv[3]],
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=sys.stderr,
                    pass_fds=(fd,), text=True)
                guardian.stdin.write(json.dumps({'specification': specification, 'descriptor': fd,
                    'token': os.urandom(32).hex()}) + '\n')
                guardian.stdin.flush()
                application_identity = guardian_response()
                result = application_identity
            elif request['command'] == 'retain-native':
                if guardian is None or not guardian_command('observe')['live']:
                    raise ValueError('native handoff child is not live')
                retained = True
                result = {'retained': True}
            elif request['command'] == 'cancel-native':
                retained = False
                stop_guardian()
                result = {'canceled': True}
            elif request['command'] == 'close':
                explicit_close = True
                break
            else:
                raise ValueError('unsupported reservation command')
            print(json.dumps({'id': request['id'], 'ok': True, 'result': result}), flush=True)
        except Exception as exc:
            print(json.dumps({'id': request['id'], 'ok': False, 'error': str(exc)}), flush=True)
finally:
    if guardian is not None:
        if retained and explicit_close:
            guardian_command('transfer')
        else:
            stop_guardian()
    for sock in sockets:
        try:
            sock.close()
        except Exception:
            pass
`;

export const portLeaseSchema = 'fsusblog.production-fresh-port-lease.v1';
export const portLeaseTerminalSchema = 'fsusblog.production-fresh-port-lease-terminal.v1';
export const portLeaseVersion = 1;
export const portLeaseHandoffStates = Object.freeze([
    'reserved',
    'handing-off',
    'bound',
    'released',
    'failed'
]);
export const portLeaseActiveStates = Object.freeze(['reserved', 'handing-off', 'bound']);

export function defaultRoleCatalog()
{
    return [
        {
            role: 'postgres',
            label: 'PostgreSQL host mapping',
            minPort: 20000,
            maxPort: 21999,
            containerPort: 5432,
            outputBindingKey: 'FSUSBLOG_POSTGRES_PORT'
        },
        {
            role: 'redis',
            label: 'Redis host mapping',
            minPort: 22000,
            maxPort: 23999,
            containerPort: 6379,
            outputBindingKey: 'FSUSBLOG_REDIS_PORT'
        },
        {
            role: 'debug-backend',
            label: 'debug backend HTTP',
            minPort: 24000,
            maxPort: 25999,
            containerPort: null,
            outputBindingKey: 'FSUSBLOG_DEBUG_BACKEND_PORT'
        },
        {
            role: 'debug-frontend',
            label: 'debug frontend HTTP',
            minPort: 26000,
            maxPort: 27999,
            containerPort: null,
            outputBindingKey: 'FSUSBLOG_DEBUG_FRONTEND_PORT'
        },
        {
            role: 'release-preview',
            label: 'release preview/backend HTTP',
            minPort: 28000,
            maxPort: 29999,
            containerPort: null,
            outputBindingKey: 'FSUSBLOG_RELEASE_PREVIEW_PORT'
        }
    ];
}

const requiredLeaseFields = Object.freeze([
    'portLeaseId',
    'role',
    'label',
    'protocol',
    'addressFamily',
    'conflictCheckedFamilies',
    'bindAddress',
    'port',
    'containerPort',
    'outputBindingKey',
    'reservationOwnerIdentity',
    'reservationTokenDigest',
    'createdAt',
    'handoffState',
    'boundListenerIdentityRef',
    'handedOffAt',
    'failedReason',
    'contentDigest'
]);

const requiredManifestFields = Object.freeze([
    'schema',
    'version',
    'runId',
    'namespace',
    'reservationOwnerIdentity',
    'createdAt',
    'controlSocketPath',
    'tokenFilePath',
    'pidFilePath',
    'terminalReceiptPath',
    'leases',
    'contentDigest'
]);

const requiredOwnerFields = Object.freeze([
    'runId',
    'namespace',
    'instanceId',
    'pid',
    'processStartIdentity'
]);

export function canonicalize(value)
{
    if (Array.isArray(value))
    {
        return value.map(canonicalize);
    }
    if (value && typeof value === 'object')
    {
        return Object.fromEntries(
            Object.keys(value)
                .sort()
                .map((key) => [key, canonicalize(value[key])])
        );
    }
    return value;
}

export function digest(value)
{
    return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function validDigest(value)
{
    return /^sha256:[a-f0-9]{64}$/u.test(String(value ?? ''));
}

export function validTimestamp(value)
{
    return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

export class PortLeaseAllocationError extends Error
{
    constructor(message, details = {})
    {
        super(message);
        this.name = 'PortLeaseAllocationError';
        this.details = details;
    }
}

function atomicWriteJson(file, value)
{
    const directory = path.dirname(file);
    fs.mkdirSync(directory, { recursive: true });
    const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
}

function atomicWriteText(file, text)
{
    const directory = path.dirname(file);
    fs.mkdirSync(directory, { recursive: true });
    const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
    fs.writeFileSync(temporary, `${text}\n`, { mode: 0o600, flag: 'wx' });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
}

function readPrivateFile(file)
{
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try
    {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > 64 * 1024)
        {
            throw new Error(`private lease file is not 0600: ${file}`);
        }
        return fs.readFileSync(fd, 'utf8');
    }
    finally
    {
        fs.closeSync(fd);
    }
}

function readJsonFile(file)
{
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export async function verifyNativeReservationCleanup(identity, {timeoutMs = 6500} = {})
{
    const guardian = identity?.guardian;
    if (!guardian || !path.isAbsolute(guardian.directory ?? '') ||
        !Number.isInteger(identity.pid) || !/^\d+$/u.test(identity.processStartIdentity ?? '') ||
        !/^[a-f0-9]{64}$/u.test(guardian.token ?? '') ||
        guardian.bootId !== fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim())
    {
        throw new Error('native cleanup requires its exact guardian and application identity');
    }
    const deadline = Date.now() + timeoutMs;
    while (true)
    {
        const directory = fs.lstatSync(guardian.directory);
        if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o777) !== 0o700 ||
            directory.uid !== process.getuid() || directory.dev !== guardian.device || directory.ino !== guardian.inode)
        {
            throw new Error('native guardian cleanup directory identity drift');
        }
        let observation;
        try
        {
            observation = JSON.parse(readPrivateFile(path.join(guardian.directory, 'cleanup.json')));
        }
        catch (error)
        {
            if ((error.code === 'ENOENT' || error instanceof SyntaxError) && Date.now() < deadline)
            {
                await new Promise((resolve) => setTimeout(resolve, 20));
                continue;
            }
            throw new Error('native guardian cleanup receipt unavailable', {cause: error});
        }
        const {contentDigest, ...payload} = observation;
        if (observation.schema !== 'fsusblog.native-reservation-cleanup.v1' || observation.verified !== true ||
            contentDigest !== digest(JSON.stringify(canonicalize(payload))) ||
            JSON.stringify(canonicalize(observation.guardian)) !== JSON.stringify(canonicalize(guardian)) ||
            JSON.stringify(canonicalize(observation.application)) !== JSON.stringify(canonicalize(identity)) ||
            !Array.isArray(observation.members))
        {
            throw new Error('native guardian cleanup receipt does not match its exact application');
        }
        for (const member of [identity, ...observation.members])
        {
            try
            {
                const stat = fs.readFileSync(`/proc/${member.pid}/stat`, 'utf8');
                if (stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u)[19] === member.processStartIdentity)
                {
                    throw new Error(`native application member was not reaped: ${member.pid}`);
                }
            }
            catch (error)
            {
                if (!['ENOENT', 'ESRCH'].includes(error.code))
                {
                    throw error;
                }
            }
        }
        return observation;
    }
}

function shuffledPorts(minPort, maxPort, random = Math.random)
{
    if (!Number.isInteger(minPort) || !Number.isInteger(maxPort) || minPort < 1 || maxPort > 65535 || minPort > maxPort)
    {
        throw new PortLeaseAllocationError(`invalid port range ${minPort}-${maxPort}`);
    }
    const ports = [];
    for (let port = minPort; port <= maxPort; port += 1)
    {
        ports.push(port);
    }
    for (let index = ports.length - 1; index > 0; index -= 1)
    {
        const swap = Math.floor(random() * (index + 1))
    ;[ports[index], ports[swap]] = [ports[swap], ports[index]];
    }
    return ports;
}

function isAddressInUse(error)
{
    return error?.code === 'EADDRINUSE' || error?.code === 'EACCES' || error?.code === 'EADDRNOTAVAIL';
}

export function bindReservationServer({ host, port, timeoutMs = 2000, python = null })
{
    return new Promise((resolve, reject) =>
    {
        const pythonBin = python ?? process.env.FSUSBLOG_PYTHON ?? 'python3';
        const mode = host === '::1' ? 'v6' : host === '127.0.0.1' ? 'v4' : 'both';
        let settled = false;
        let stderr = '';
        let child;
        let nativeIdentity;
        let nativeRetained = false;
        let stdout = '';
        const pending = new Map();
        function request(command, specification)
        {
            return new Promise((resolveRequest, rejectRequest) =>
            {
                const id = randomUUID();
                const deadline = setTimeout(() =>
                {
                    pending.delete(id);
                    rejectRequest(new Error(`reservation ${command} timed out`));
                }, 5000);
                pending.set(id, { resolve: resolveRequest, reject: rejectRequest, deadline });
                child.stdin.write(`${JSON.stringify({ id, command, specification })}\n`);
            });
        }
        try
        {
            child = spawn(pythonBin, ['-c', reservationPythonScript, String(port), mode, nativeGuardianFile], {
                stdio: ['pipe', 'pipe', 'pipe']
            });
        }
        catch (error)
        {
            reject(error);
            return;
        }
        const timer = setTimeout(() =>
        {
            if (settled)
            {
                return;
            }
            settled = true;
            try
            {
                child.kill('SIGKILL');
            }
            catch
            {
                // already exited
            }
            reject(new Error(`reservation bind timed out ${host}:${port}`));
        }, timeoutMs);
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdin.on('error', (error) =>
        {
            for (const entry of pending.values())
            {
                clearTimeout(entry.deadline);
                entry.reject(error);
            }
            pending.clear();
        });
        child.stderr.on('data', (chunk) =>
        {
            stderr += chunk;
        });
        child.stdout.on('data', (chunk) =>
        {
            stdout += chunk;
            while (stdout.includes('\n'))
            {
                const newline = stdout.indexOf('\n');
                const line = stdout.slice(0, newline);
                stdout = stdout.slice(newline + 1);
                if (line === 'ready' && !settled)
                {
                    settled = true;
                    clearTimeout(timer);
                    resolve({
                        host,
                        port,
                        launchNative: async (specification) =>
                        {
                            nativeIdentity = await request('launch-native', specification);
                            return nativeIdentity;
                        },
                        retainNative: async () =>
                        {
                            const result = await request('retain-native');
                            nativeRetained = true;
                            return result;
                        },
                        cancelNative: async () =>
                        {
                            try
                            {
                                if (child.exitCode === null && child.signalCode === null)
                                {
                                    const result = await request('cancel-native');
                                    nativeRetained = false;
                                    if (nativeIdentity)
                                    {
                                        await verifyNativeReservationCleanup(nativeIdentity);
                                    }
                                    return result;
                                }
                            }
                            catch (error)
                            {
                                if (!nativeIdentity)
                                {
                                    throw error;
                                }
                                // EPIPE can arrive before Node publishes the owner's exit.
                                // Only the independently verified guardian receipt and actual
                                // member absence may prove cancellation across that race.
                                const [verification] = await Promise.allSettled([
                                    verifyNativeReservationCleanup(nativeIdentity)
                                ]);
                                if (verification.status === 'rejected')
                                {
                                    throw new AggregateError([error, verification.reason],
                                        'native cancellation cleanup was not verified', {cause: error});
                                }
                                nativeRetained = false;
                                return {canceled: true};
                            }
                            await verifyNativeReservationCleanup(nativeIdentity);
                            nativeRetained = false;
                            return {canceled: true};
                        },
                        close: async () =>
                        {
                            try
                            {
                                await closeReservationChild(child, () => stderr.trim());
                                if (nativeIdentity && !nativeRetained)
                                {
                                    return verifyNativeReservationCleanup(nativeIdentity);
                                }
                            }
                            catch (error)
                            {
                                if (!nativeIdentity)
                                {
                                    throw error;
                                }
                                return verifyNativeReservationCleanup(nativeIdentity);
                            }
                        }
                    });
                    continue;
                }
                let response;
                try
                {
                    response = JSON.parse(line);
                }
                catch
                {
                    continue;
                }
                const entry = pending.get(response.id);
                if (entry)
                {
                    clearTimeout(entry.deadline);
                    pending.delete(response.id);
                    if (response.ok)
                    {
                        entry.resolve(response.result);
                    }
                    else
                    {
                        entry.reject(new Error(response.error));
                    }
                }
            }
        });
        child.once('error', (error) =>
        {
            if (settled)
            {
                return;
            }
            settled = true;
            clearTimeout(timer);
            reject(error);
        });
        child.once('exit', (code) =>
        {
            for (const entry of pending.values())
            {
                clearTimeout(entry.deadline);
                entry.reject(new Error('reservation owner exited during handoff'));
            }
            pending.clear();
            if (settled)
            {
                return;
            }
            settled = true;
            clearTimeout(timer);
            reject(new Error(`reservation bind exited before ready (${host}:${port}) code=${code} ${stderr.trim()}`));
        });
    });
}

function closeReservationChild(child, diagnostics = () => '')
{
    return new Promise((resolve, reject) =>
    {
        if (child.exitCode !== null || child.signalCode !== null)
        {
            if (child.exitCode === 0)
            {
                resolve();
            }
            else
            {
                reject(new Error(`reservation owner exited without verified cleanup (code=${child.exitCode}, signal=${child.signalCode}): ${diagnostics()}`));
            }
            return;
        }
        const timer = setTimeout(() =>
        {
            try
            {
                child.kill('SIGKILL');
            }
            catch
            {
                // already exited
            }
        }, 5000);
        child.once('exit', (code) =>
        {
            clearTimeout(timer);
            if (code === 0)
            {
                resolve();
            }
            else
            {
                reject(new Error(`reservation owner exited without verified cleanup (code=${code}, signal=${child.signalCode}): ${diagnostics()}`));
            }
        });
        try
        {
            child.stdin.end(`${JSON.stringify({ command: 'close' })}\n`);
        }
        catch
        {
            try
            {
                child.kill('SIGTERM');
            }
            catch
            {
                // already exited
            }
        }
    });
}

function ownerIsComplete(owner)
{
    return Boolean(
        owner &&
    requiredOwnerFields.every((field) => Object.hasOwn(owner, field)) &&
    typeof owner.runId === 'string' && owner.runId.length > 0 &&
    typeof owner.namespace === 'string' && owner.namespace.length > 0 &&
    typeof owner.instanceId === 'string' && owner.instanceId.length > 0 &&
    Number.isInteger(owner.pid) && owner.pid > 0 &&
    typeof owner.processStartIdentity === 'string' && owner.processStartIdentity.length > 0
    );
}

function leasePayload(lease)
{
    const payload = { ...lease };
    delete payload.contentDigest;
    return payload;
}

function sealLease(lease)
{
    return {
        ...lease,
        contentDigest: digest(JSON.stringify(canonicalize(leasePayload(lease))))
    };
}

export function sealPortLeaseManifest({ runId, namespace, reservationOwnerIdentity, createdAt, controlSocketPath, tokenFilePath, pidFilePath, terminalReceiptPath, leases })
{
    const payload = {
        schema: portLeaseSchema,
        version: portLeaseVersion,
        runId,
        namespace,
        reservationOwnerIdentity,
        createdAt,
        controlSocketPath,
        tokenFilePath,
        pidFilePath,
        terminalReceiptPath,
        leases
    };
    return {
        ...payload,
        contentDigest: digest(JSON.stringify(canonicalize(payload)))
    };
}

function leaseIsValid(lease)
{
    return Boolean(
        lease &&
    requiredLeaseFields.every((field) => Object.hasOwn(lease, field)) &&
    typeof lease.portLeaseId === 'string' && lease.portLeaseId.length > 0 &&
    typeof lease.role === 'string' && lease.role.length > 0 &&
    typeof lease.label === 'string' &&
    lease.protocol === 'tcp' &&
    lease.addressFamily === 'ipv4' &&
    Array.isArray(lease.conflictCheckedFamilies) &&
    lease.conflictCheckedFamilies.includes('ipv4') &&
    lease.conflictCheckedFamilies.includes('ipv6') &&
    lease.bindAddress === '127.0.0.1' &&
    Number.isInteger(lease.port) && lease.port >= 1 && lease.port <= 65535 &&
    (lease.containerPort === null || (Number.isInteger(lease.containerPort) && lease.containerPort >= 1 && lease.containerPort <= 65535)) &&
    typeof lease.outputBindingKey === 'string' && lease.outputBindingKey.length > 0 &&
    ownerIsComplete(lease.reservationOwnerIdentity) &&
    validDigest(lease.reservationTokenDigest) &&
    validTimestamp(lease.createdAt) &&
    portLeaseHandoffStates.includes(lease.handoffState) &&
    (lease.boundListenerIdentityRef === null || typeof lease.boundListenerIdentityRef === 'string') &&
    (lease.handedOffAt === null || validTimestamp(lease.handedOffAt)) &&
    (lease.failedReason === null || typeof lease.failedReason === 'string') &&
    validDigest(lease.contentDigest) &&
    lease.contentDigest === sealLease(lease).contentDigest
    );
}

export function verifySealedPortLeaseManifest(manifest)
{
    if (!manifest || typeof manifest !== 'object')
    {
        throw new Error('port lease manifest is not an object');
    }
    if (manifest.schema !== portLeaseSchema)
    {
        throw new Error(`port lease manifest schema mismatch: ${manifest.schema ?? 'missing'}`);
    }
    if (manifest.version !== portLeaseVersion)
    {
        throw new Error(`port lease manifest version mismatch: ${manifest.version ?? 'missing'}`);
    }
    for (const field of requiredManifestFields)
    {
        if (!Object.hasOwn(manifest, field))
        {
            throw new Error(`port lease manifest is missing ${field}`);
        }
    }
    if (typeof manifest.runId !== 'string' || manifest.runId.length === 0)
    {
        throw new Error('port lease manifest runId is missing');
    }
    if (typeof manifest.namespace !== 'string' || manifest.namespace.length === 0)
    {
        throw new Error('port lease manifest namespace is missing');
    }
    if (!ownerIsComplete(manifest.reservationOwnerIdentity))
    {
        throw new Error('port lease manifest reservation owner identity is incomplete');
    }
    if (!validTimestamp(manifest.createdAt))
    {
        throw new Error('port lease manifest createdAt is invalid');
    }
    for (const fileField of ['controlSocketPath', 'tokenFilePath', 'pidFilePath', 'terminalReceiptPath'])
    {
        if (typeof manifest[fileField] !== 'string' || manifest[fileField].length === 0)
        {
            throw new Error(`port lease manifest ${fileField} is missing`);
        }
    }
    if (!Array.isArray(manifest.leases) || manifest.leases.length === 0)
    {
        throw new Error('port lease manifest has no leases');
    }
    const seenIds = new Set();
    const seenRoles = new Set();
    const seenPorts = new Set();
    for (const lease of manifest.leases)
    {
        if (!leaseIsValid(lease))
        {
            throw new Error(`port lease is invalid: ${lease?.role ?? 'unknown'}`);
        }
        if (seenIds.has(lease.portLeaseId))
        {
            throw new Error(`duplicate port lease id: ${lease.portLeaseId}`);
        }
        if (seenRoles.has(lease.role))
        {
            throw new Error(`duplicate port lease role: ${lease.role}`);
        }
        if (seenPorts.has(lease.port))
        {
            throw new Error(`duplicate port lease port: ${lease.port}`);
        }
        seenIds.add(lease.portLeaseId);
        seenRoles.add(lease.role);
        seenPorts.add(lease.port);
    }
    const payload = { ...manifest };
    delete payload.contentDigest;
    const expected = digest(JSON.stringify(canonicalize(payload)));
    if (manifest.contentDigest !== expected)
    {
        throw new Error('port lease manifest content digest mismatch (tamper detected)');
    }
    return manifest;
}

function readSealedManifest(manifestPath)
{
    return verifySealedPortLeaseManifest(readJsonFile(manifestPath));
}

export function createPortLeaseAllocator({ runId, namespace, roles = defaultRoleCatalog(), now = () => new Date().toISOString(), random = Math.random, owner = null, reservationToken = null, pins = {}, continuousHandoff = false, containerReservations = {} })
{
    const instanceId = randomUUID();
    const reservationOwnerIdentity = owner ?? {
        runId,
        namespace,
        instanceId,
        pid: process.pid,
        processStartIdentity: currentProcessStartIdentity()
    };
    const sharedToken = reservationToken ?? randomBytes(32).toString('hex');
    const leases = new Map();
    const reservations = new Map();
    const tokens = new Map();
    const roleOperations = new Map();
    let allocationStarted = false;
    let allocationCompleted = false;
    if (continuousHandoff)
    {
        for (const role of roles.filter((entry) => entry.containerPort !== null))
        {
            validateContainerReservationOptions({
                ...containerReservations[role.role], role: role.role, runId, namespace,
                port: role.minPort, containerPort: role.containerPort
            });
        }
    }
    function serializeRole(role, operation)
    {
        const previous = roleOperations.get(role) ?? Promise.resolve();
        const pending = previous.catch(() =>
        {}).then(operation);
        roleOperations.set(role, pending);
        pending.then(() =>
        {
            if (roleOperations.get(role) === pending)
            {
                roleOperations.delete(role);
            }
        }, () =>
        {
            if (roleOperations.get(role) === pending)
            {
                roleOperations.delete(role);
            }
        });
        return pending;
    }

    function currentProcessStartIdentity()
    {
        try
        {
            const stat = fs.readFileSync('/proc/self/stat', 'utf8');
            const tail = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u);
            return tail[19] ?? '';
        }
        catch
        {
            return String(process.pid);
        }
    }

    function roleByName(role)
    {
        return roles.find((candidate) => candidate.role === role);
    }

    async function reserveRoleSockets(definition, port, held)
    {
        if (continuousHandoff && definition.containerPort !== null)
        {
            // Check and retain the other address family before Docker becomes
            // the real IPv4 reservation owner. A publish failure aborts this
            // allocation; it is never retried on another port.
            held.push(await bindReservationServer({ host: '::1', port, ipv6Only: true }));
            const publisher = await reserveContainerPublisher({
                ...containerReservations[definition.role], role: definition.role, runId, namespace,
                port, containerPort: definition.containerPort
            });
            held.push({ host: '127.0.0.1', port, publisher, close: () => publisher.close() });
        }
        else
        {
            held.push(await bindReservationServer({ host: '127.0.0.1', port }));
            held.push(await bindReservationServer({ host: '::1', port, ipv6Only: true }));
        }
    }

    function reservationBinding(held)
    {
        const publisher = held.find((entry) => entry.publisher)?.publisher;
        return {
            reservationKind: continuousHandoff ? publisher ? 'final-docker-publisher' : 'inherited-native-socket' : 'legacy-bind-reservation',
            ...(publisher ? { containerReservation: {
                ownerIdentity: publisher.ownerIdentity, gateDirectory: publisher.gateDirectory
            } } : {})
        };
    }

    async function allocateRole(role)
    {
        const definition = roleByName(role);
        if (!definition)
        {
            throw new PortLeaseAllocationError(`unknown port lease role: ${role}`);
        }
        const pinned = pins[role];
        if (pinned !== undefined && pinned !== null)
        {
            if (!Number.isInteger(pinned) || pinned < 1 || pinned > 65535)
            {
                throw new PortLeaseAllocationError(`pinned port for role ${role} is invalid: ${pinned}`);
            }
            if (pinned < definition.minPort || pinned > definition.maxPort)
            {
                throw new PortLeaseAllocationError(
                    `pinned port ${pinned} for role ${role} is outside ${definition.minPort}-${definition.maxPort}`
                );
            }
            const held = [];
            try
            {
                await reserveRoleSockets(definition, pinned, held);
            }
            catch (error)
            {
                await Promise.all(held.map((reservation) => reservation.close()));
                throw new PortLeaseAllocationError(`pinned port ${pinned} for role ${role} is unavailable`, {
                    role,
                    port: pinned,
                    cause: error?.code ?? error?.message
                });
            }
            const createdAt = now();
            const lease = sealLease({
                portLeaseId: `pfl-${randomBytes(8).toString('hex')}`,
                role,
                label: definition.label,
                protocol: 'tcp',
                addressFamily: 'ipv4',
                conflictCheckedFamilies: ['ipv4', 'ipv6'],
                bindAddress: '127.0.0.1',
                port: pinned,
                containerPort: definition.containerPort ?? null,
                outputBindingKey: definition.outputBindingKey,
                reservationOwnerIdentity,
                ...reservationBinding(held),
                reservationTokenDigest: digest(sharedToken),
                createdAt,
                handoffState: 'reserved',
                boundListenerIdentityRef: null,
                handedOffAt: null,
                failedReason: null
            });
            leases.set(role, lease);
            reservations.set(role, held);
            tokens.set(role, sharedToken);
            return lease;
        }
        for (const port of shuffledPorts(definition.minPort, definition.maxPort, random))
        {
            const held = [];
            try
            {
                await reserveRoleSockets(definition, port, held);
            }
            catch (error)
            {
                await Promise.all(held.map((reservation) => reservation.close()));
                if (isAddressInUse(error) && !(continuousHandoff && definition.containerPort !== null && held.length > 0))
                {
                    continue;
                }
                throw error;
            }
            const createdAt = now();
            const lease = sealLease({
                portLeaseId: `pfl-${randomBytes(8).toString('hex')}`,
                role,
                label: definition.label,
                protocol: 'tcp',
                addressFamily: 'ipv4',
                conflictCheckedFamilies: ['ipv4', 'ipv6'],
                bindAddress: '127.0.0.1',
                port,
                containerPort: definition.containerPort ?? null,
                outputBindingKey: definition.outputBindingKey,
                reservationOwnerIdentity,
                ...reservationBinding(held),
                reservationTokenDigest: digest(sharedToken),
                createdAt,
                handoffState: 'reserved',
                boundListenerIdentityRef: null,
                handedOffAt: null,
                failedReason: null
            });
            leases.set(role, lease);
            reservations.set(role, held);
            tokens.set(role, sharedToken);
            return lease;
        }
        throw new PortLeaseAllocationError(
            `no free port for role ${role} in ${definition.minPort}-${definition.maxPort}`,
            { role, minPort: definition.minPort, maxPort: definition.maxPort }
        );
    }

    async function allocate()
    {
        if (allocationStarted)
        {
            throw new Error('port lease allocation is single-attempt');
        }
        allocationStarted = true;
        const allocated = [];
        try
        {
            for (const role of roles)
            {
                allocated.push(await allocateRole(role.role));
            }
            allocationCompleted = true;
            return snapshot();
        }
        catch (error)
        {
            await releaseAll('allocation-failed');
            throw error;
        }
    }

    async function closeRoleReservations(role, { preserveRuntime = false } = {})
    {
        const observations = await Promise.all((reservations.get(role) ?? []).map((reservation) =>
            preserveRuntime && reservation.publisher ? Promise.resolve() : reservation.close()));
        reservations.delete(role);
        return observations.filter((observation) => observation?.verified === true);
    }

    function updateLease(role, patch)
    {
        const current = leases.get(role);
        if (!current)
        {
            throw new Error(`port lease role is not allocated: ${role}`);
        }
        const next = sealLease({ ...current, ...patch });
        leases.set(role, next);
        return next;
    }

    async function beginHandoff(role)
    {
        const lease = leases.get(role);
        if (!lease)
        {
            throw new Error(`port lease role is not allocated: ${role}`);
        }
        if (lease.handoffState === 'bound')
        {
            return lease;
        }
        if (lease.handoffState !== 'reserved')
        {
            throw new Error(`port lease ${role} cannot begin handoff from ${lease.handoffState}`);
        }
        if (continuousHandoff)
        {
            throw new Error(`port lease ${role} requires continuous socket handoff; release-before-bind is forbidden`);
        }
        await closeRoleReservations(role);
        return updateLease(role, { handoffState: 'handing-off', handedOffAt: now() });
    }

    async function launchNative(role, specification)
    {
        const lease = leases.get(role);
        if (!allocationCompleted || !continuousHandoff || !lease || lease.containerPort !== null || lease.handoffState !== 'reserved')
        {
            throw new Error(`port lease ${role} cannot launch an inherited native socket`);
        }
        if (!specification || !Array.isArray(specification.argv) || specification.argv.length === 0 ||
            !specification.argv.every((argument) => typeof argument === 'string') ||
            !path.isAbsolute(specification.cwd ?? '') || !path.isAbsolute(specification.logFile ?? '') ||
            !specification.env || typeof specification.env !== 'object' || Array.isArray(specification.env) ||
            !Object.values(specification.env).every((value) => typeof value === 'string'))
        {
            throw new Error('native launch requires argv, absolute cwd/logFile, and string environment');
        }
        const attemptId = randomUUID();
        // Reserve the state before awaiting the owner: concurrent control requests
        // must never launch two consumers of one application socket.
        updateLease(role, { handoffState: 'handing-off', handedOffAt: now(), handoffAttemptId: attemptId });
        try
        {
            const reservation = reservations.get(role)?.find((entry) => entry.host === '127.0.0.1');
            const identity = await reservation.launchNative({
                ...specification,
                env: {
                    ...specification.env,
                    FSUSBLOG_TEST_RUN_ID: runId,
                    FSUSBLOG_TEST_NAMESPACE: namespace,
                    FSUSBLOG_RUNTIME_PORT_LEASE_ID: lease.portLeaseId,
                    FSUSBLOG_RUNTIME_LISTEN_ATTEMPT_ID: attemptId,
                    FSUSBLOG_RUNTIME_LISTEN_PORT: String(lease.port),
                    FSUSBLOG_MANAGED_TEST_LISTENER: '1'
                }
            });
            if (leases.get(role).handoffState !== 'handing-off' || leases.get(role).handoffAttemptId !== attemptId)
            {
                throw new Error('native handoff was canceled during launch');
            }
            updateLease(role, {
                handoffOwnerIdentity: { ...identity, runId, namespace, role, portLeaseId: lease.portLeaseId, attemptId },
                launchSpecificationDigest: digest(JSON.stringify(canonicalize(specification)))
            });
            return leases.get(role);
        }
        catch (error)
        {
            await failHandoff(role, 'native-launch-failed');
            throw error;
        }
    }

    async function completeHandoff(role, listenerIdentityRef)
    {
        if (typeof listenerIdentityRef !== 'string' || listenerIdentityRef.length === 0)
        {
            throw new Error(`port lease ${role} handoff listener identity is missing`);
        }
        const lease = leases.get(role);
        if (!lease)
        {
            throw new Error(`port lease role is not allocated: ${role}`);
        }
        if (lease.handoffState === 'released' || lease.handoffState === 'failed')
        {
            throw new Error(`port lease ${role} cannot complete from ${lease.handoffState}`);
        }
        if (continuousHandoff)
        {
            if (lease.containerPort !== null)
            {
                const publisher = reservations.get(role)?.find((entry) => entry.publisher)?.publisher;
                const expected = lease.containerReservation?.ownerIdentity;
                if (lease.handoffState !== 'handing-off' || !publisher || !expected ||
                    listenerIdentityRef !== `container:${expected.containerId}` ||
                    JSON.stringify(canonicalize(await publisher.observe())) !== JSON.stringify(canonicalize(expected)))
                {
                    throw new Error(`port lease ${role} listener is not its authorized continuous publisher`);
                }
                await publisher.transferToRuntime();
                return updateLease(role, {
                    handoffState: 'bound', boundListenerIdentityRef: listenerIdentityRef, handedOffAt: now()
                });
            }
            const expected = lease.handoffOwnerIdentity;
            if (!expected || listenerIdentityRef !== `pid:${expected.pid}` ||
                !nativeSocketOwnerMatches(expected, lease.port))
            {
                throw new Error(`port lease ${role} listener is not the authorized same-attempt socket owner`);
            }
            const reservation = reservations.get(role)?.find((entry) => entry.host === '127.0.0.1');
            await reservation.retainNative();
            if (!nativeSocketOwnerMatches(expected, lease.port))
            {
                await failHandoff(role, 'native-completion-drift');
                throw new Error(`port lease ${role} listener drifted during completion`);
            }
            // Retain both reservations through the bootstrap attempt. Completion
            // is an ownership transition, never a close-then-rebind window.
            return updateLease(role, {
                handoffState: 'bound', boundListenerIdentityRef: listenerIdentityRef, handedOffAt: now()
            });
        }
        await closeRoleReservations(role);
        return updateLease(role, {
            handoffState: 'bound',
            boundListenerIdentityRef: listenerIdentityRef,
            handedOffAt: now()
        });
    }

    async function activateContainer(role)
    {
        const lease = leases.get(role);
        const publisher = reservations.get(role)?.find((entry) => entry.publisher)?.publisher;
        if (!allocationCompleted || !continuousHandoff || !lease || !publisher ||
            lease.handoffState !== 'reserved' || lease.containerPort === null)
        {
            throw new Error(`port lease ${role} cannot activate a final publisher`);
        }
        updateLease(role, { handoffState: 'handing-off', handedOffAt: now() });
        try
        {
            const observed = await publisher.activate();
            if (JSON.stringify(canonicalize(observed)) !== JSON.stringify(canonicalize(lease.containerReservation.ownerIdentity)))
            {
                throw new Error(`port lease ${role} publisher drifted during activation`);
            }
            return leases.get(role);
        }
        catch (error)
        {
            await failHandoff(role, 'container-activation-failed');
            throw error;
        }
    }

    async function failHandoff(role, reason)
    {
        if (typeof reason !== 'string' || reason.length === 0)
        {
            throw new Error(`port lease ${role} failure reason is missing`);
        }
        if (!leases.has(role))
        {
            throw new Error(`port lease role is not allocated: ${role}`);
        }
        if (continuousHandoff)
        {
            await reservations.get(role)?.find((entry) => entry.host === '127.0.0.1')?.cancelNative?.();
        }
        await closeRoleReservations(role);
        return updateLease(role, {
            handoffState: 'failed',
            failedReason: reason,
            handedOffAt: now()
        });
    }

    async function releaseAll(reason = 'release', { cancelBound = false } = {})
    {
        const released = [];
        const cleanupFailures = [];
        for (const role of leases.keys())
        {
            try
            {
                await serializeRole(role, async () =>
                {
                    const lease = leases.get(role);
                    if (continuousHandoff && cancelBound && lease.handoffState === 'bound')
                    {
                        await reservations.get(role)?.find((entry) => entry.host === '127.0.0.1')?.cancelNative?.();
                    }
                    const cleanup = await closeRoleReservations(role, { preserveRuntime: lease.handoffState === 'bound' && !cancelBound });
                    if ((lease.handoffState === 'bound' && !cancelBound && cleanup.length === 0) || lease.handoffState === 'released' || lease.handoffState === 'failed')
                    {
                        released.push(lease);
                        return;
                    }
                    released.push(updateLease(role, { handoffState: 'released', handedOffAt: now(), failedReason: null }));
                });
            }
            catch (error)
            {
                cleanupFailures.push(error);
            }
        }
        if (cleanupFailures.length > 0)
        {
            throw new AggregateError(cleanupFailures, `port lease ${reason} cleanup was not verified`, { cause: cleanupFailures[0] });
        }
        return released;
    }

    function snapshot()
    {
        return [...leases.values()].map((lease) => ({ ...lease }));
    }

    function tokenFor(role)
    {
        return tokens.get(role) ?? null;
    }

    function verifyToken(role, candidate)
    {
        const expected = tokens.get(role);
        if (!expected || typeof candidate !== 'string')
        {
            return false;
        }
        const a = Buffer.from(expected);
        const b = Buffer.from(candidate);
        return a.length === b.length && timingSafeEqual(a, b);
    }

    return {
        allocate,
        snapshot,
        beginHandoff: (role) => serializeRole(role, () => beginHandoff(role)),
        launchNative: (role, specification) => serializeRole(role, () => launchNative(role, specification)),
        activateContainer: (role) => serializeRole(role, () => activateContainer(role)),
        completeHandoff: (role, identity) => serializeRole(role, () => completeHandoff(role, identity)),
        failHandoff: (role, reason) => serializeRole(role, () => failHandoff(role, reason)),
        releaseAll,
        tokenFor,
        verifyToken,
        reservationOwnerIdentity
    };
}

export function writePortLeaseTerminalReceipt({ terminalReceiptPath, runId, namespace, reservationOwnerIdentity, terminalState, reason, manifestDigest, leases = [], cleanupObservations = [], now = () => new Date().toISOString() })
{
    if (!['released', 'failed'].includes(terminalState))
    {
        throw new Error(`terminal state must be released or failed: ${terminalState}`);
    }
    const payload = {
        schema: portLeaseTerminalSchema,
        version: portLeaseVersion,
        runId,
        namespace,
        reservationOwnerIdentity,
        terminalState,
        reason,
        manifestDigest,
        leases,
        cleanupObservations,
        terminalAt: now()
    };
    atomicWriteJson(terminalReceiptPath, { ...payload, contentDigest: digest(JSON.stringify(canonicalize(payload))) });
    return terminalReceiptPath;
}

function connectControl(controlSocketPath, payload, timeoutMs = 5000)
{
    return new Promise((resolve, reject) =>
    {
        const socket = net.connect(controlSocketPath);
        const timer = setTimeout(() =>
        {
            socket.destroy();
            reject(new Error(`port lease control connection timed out: ${controlSocketPath}`));
        }, timeoutMs);
        let buffer = '';
        socket.setEncoding('utf8');
        socket.once('error', (error) =>
        {
            clearTimeout(timer);
            reject(error);
        });
        socket.on('data', (chunk) =>
        {
            buffer += chunk;
            const newline = buffer.indexOf('\n');
            if (newline < 0)
            {
                return;
            }
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            clearTimeout(timer);
            socket.end();
            try
            {
                resolve(JSON.parse(line));
            }
            catch (error)
            {
                reject(new Error(`port lease control response is not JSON: ${line}`, {cause: error}));
            }
        });
        socket.write(`${JSON.stringify(payload)}\n`);
    });
}

export function createPortLeaseControlServer({ controlSocketPath, allocator, token, persist, onReleaseAll })
{
    return createPortLeaseControlServerWithOptions({ controlSocketPath, allocator, token, persist, onReleaseAll });
}

export function createPortLeaseControlServerWithOptions({ controlSocketPath, allocator, token, persist, onReleaseAll, verifyListenerIdentity })
{
    return new Promise((resolve, reject) =>
    {
        const server = net.createServer((socket) =>
        {
            let buffer = '';
            socket.setEncoding('utf8');
            socket.on('error', () =>
            {
                socket.destroy();
            });
            socket.on('data', async (chunk) =>
            {
                buffer += chunk;
                const newline = buffer.indexOf('\n');
                if (newline < 0)
                {
                    return;
                }
                const line = buffer.slice(0, newline);
                buffer = buffer.slice(newline + 1);
                let request;
                try
                {
                    request = JSON.parse(line);
                }
                catch
                {
                    socket.end(`${JSON.stringify({ ok: false, error: 'request is not JSON' })}\n`);
                    return;
                }
                const response = await handleControlRequest({
                    request,
                    allocator,
                    token,
                    persist,
                    onReleaseAll,
                    verifyListenerIdentity
                });
                socket.end(`${JSON.stringify(response)}\n`);
            });
        });
        server.once('error', (error) =>
        {
            reject(error);
        });
        server.once('close', () =>
        {
            try
            {
                fs.unlinkSync(controlSocketPath);
            }
            catch
            {
                // socket already removed
            }
        });
        server.listen(controlSocketPath, () =>
        {
            resolve({
                close: () =>
                {
                    try
                    {
                        server.close();
                        server.closeAllConnections?.();
                    }
                    catch
                    {
                        // already closed
                    }
                }
            });
        });
    });
}

async function handleControlRequest({ request, allocator, token, persist, onReleaseAll, verifyListenerIdentity })
{
    if (!request || typeof request !== 'object' || typeof request.command !== 'string')
    {
        return { ok: false, error: 'invalid control request' };
    }
    if (!verifyDaemonToken(token, request.token))
    {
        return { ok: false, error: 'invalid reservation token' };
    }
    try
    {
        switch (request.command)
        {
            case 'ping':
                return { ok: true, leases: allocator.snapshot() };
            case 'status':
                return { ok: true, leases: allocator.snapshot() };
            case 'release-before-bind':
                if (typeof request.role !== 'string')
                {
                    return { ok: false, error: 'role is required' };
                }
                {
                    const lease = await allocator.beginHandoff(request.role);
                    if (persist)
                    {
                        persist();
                    }
                    return { ok: true, lease };
                }
            case 'launch-native':
                if (typeof request.role !== 'string' || !request.specification)
                {
                    return { ok: false, error: 'role and native launch specification are required' };
                }
                {
                    try
                    {
                        const lease = await allocator.launchNative(request.role, request.specification);
                        return { ok: true, lease };
                    }
                    finally
                    {
                        persist?.();
                    }
                }
            case 'activate-container':
                if (typeof request.role !== 'string')
                {
                    return { ok: false, error: 'role is required' };
                }
                {
                    try
                    {
                        const lease = await allocator.activateContainer(request.role);
                        return { ok: true, lease };
                    }
                    finally
                    {
                        persist?.();
                    }
                }
            case 'complete-handoff':
                if (typeof request.role !== 'string' || typeof request.listenerIdentityRef !== 'string')
                {
                    return { ok: false, error: 'role and listenerIdentityRef are required' };
                }
                if (verifyListenerIdentity)
                {
                    const lease = allocator.snapshot().find((candidate) => candidate.role === request.role);
                    if (!lease)
                    {
                        return { ok: false, error: `role is not allocated: ${request.role}` };
                    }
                    let verified = false;
                    try
                    {
                        verified = await verifyListenerIdentity({
                            role: request.role,
                            port: lease.port,
                            listenerIdentityRef: request.listenerIdentityRef
                        });
                    }
                    catch (error)
                    {
                        return { ok: false, error: `listener identity verification failed: ${error.message}` };
                    }
                    if (!verified)
                    {
                        return {
                            ok: false,
                            error: `listener identity ${request.listenerIdentityRef} is not bound to leased port ${lease.port}`
                        };
                    }
                }
                {
                    const lease = await allocator.completeHandoff(request.role, request.listenerIdentityRef);
                    if (persist)
                    {
                        persist();
                    }
                    return { ok: true, lease };
                }
            case 'fail-handoff':
                if (typeof request.role !== 'string' || typeof request.reason !== 'string')
                {
                    return { ok: false, error: 'role and reason are required' };
                }
                {
                    const lease = await allocator.failHandoff(request.role, request.reason);
                    if (persist)
                    {
                        persist();
                    }
                    return { ok: true, lease };
                }
            case 'release-all': {
                const leases = await allocator.releaseAll(typeof request.reason === 'string' ? request.reason : 'release', {
                    cancelBound: request.cancelBound === true
                });
                if (persist)
                {
                    persist();
                }
                if (onReleaseAll)
                {
                    await onReleaseAll({ reason: request.reason, leases });
                }
                return { ok: true, leases };
            }
            default:
                return { ok: false, error: `unknown command: ${request.command}` };
        }
    }
    catch (error)
    {
        return { ok: false, error: error.message };
    }
}

function verifyDaemonToken(expected, candidate)
{
    if (!expected || typeof candidate !== 'string')
    {
        return false;
    }
    const a = Buffer.from(expected);
    const b = Buffer.from(candidate);
    return a.length === b.length && timingSafeEqual(a, b);
}

function nativeSocketOwnerMatches(expected, port)
{
    try
    {
        const stat = fs.readFileSync(`/proc/${expected.pid}/stat`, 'utf8');
        if (stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u)[19] !== expected.processStartIdentity)
        {
            return false;
        }
        const descriptors = fs.readdirSync(`/proc/${expected.pid}/fd`);
        const ownsSocket = descriptors.some((fd) =>
        {
            try
            {
                return fs.readlinkSync(`/proc/${expected.pid}/fd/${fd}`) === expected.socketIdentity;
            }
            catch
            {
                return false;
            }
        });
        return ownsSocket && pidListeningOnPort(expected.pid, port);
    }
    catch
    {
        return false;
    }
}

export async function observeBoundPortLease({manifest, role, runId, namespace})
{
    verifySealedPortLeaseManifest(manifest);
    if (!runId || !namespace || manifest.runId !== runId || manifest.namespace !== namespace)
    {
        throw new Error('bound listener manifest does not match the current run and namespace');
    }
    const lease = manifest.leases.find((entry) => entry.role === role);
    if (!lease || lease.handoffState !== 'bound')
    {
        throw new Error(`bound listener receipt is missing for ${role}`);
    }
    if (lease.reservationKind === 'inherited-native-socket')
    {
        const identity = lease.handoffOwnerIdentity;
        if (!identity || identity.runId !== runId || identity.namespace !== namespace || identity.role !== role ||
            identity.portLeaseId !== lease.portLeaseId || identity.attemptId !== lease.handoffAttemptId ||
            lease.boundListenerIdentityRef !== `pid:${identity.pid}` || !nativeSocketOwnerMatches(identity, lease.port))
        {
            throw new Error(`current-run bound native listener drift: ${role}`);
        }
        return {role, port: lease.port, portLeaseId: lease.portLeaseId, listenerIdentityRef: lease.boundListenerIdentityRef,
            identity, manifestDigest: manifest.contentDigest};
    }
    if (lease.reservationKind === 'final-docker-publisher')
    {
        const identity = await observeReservedContainerPublisher(lease.containerReservation);
        if (identity.runId !== runId || identity.namespace !== namespace ||
            lease.boundListenerIdentityRef !== `container:${identity.containerId}`)
        {
            throw new Error(`current-run bound container listener drift: ${role}`);
        }
        return {role, port: lease.port, portLeaseId: lease.portLeaseId, listenerIdentityRef: lease.boundListenerIdentityRef,
            identity, manifestDigest: manifest.contentDigest};
    }
    throw new Error(`continuous bound listener authority is missing for ${role}`);
}

export async function verifyBoundRuntimeListeners({manifest, runId, namespace, requireReadiness = false})
{
    const observations = [];
    for (const role of defaultRoleCatalog())
    {
        observations.push(await observeBoundPortLease({manifest, role: role.role, runId, namespace}));
    }
    if (requireReadiness)
    {
        // The active issue contract requires genuine imageDigest for every role.
        // Socket/process/build digests cannot supply OCI authority for these host
        // native listeners. Never promote this lifecycle observation to readiness.
        throw new Error('Production Fresh readiness is unavailable: native backend/debug-frontend/release-preview have no verified OCI imageDigest authority; protected exact runtime identity and business canary receipts are also required');
    }
    return observations;
}

function pidListeningOnPort(pid, port)
{
    try
    {
        if (process.platform === 'darwin')
        {
            const output = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
                encoding: 'utf8',
                timeout: 5000,
                stdio: ['ignore', 'pipe', 'ignore']
            });
            return output.split('\n').map((value) => value.trim()).filter(Boolean).includes(String(pid));
        }
        const output = execFileSync('ss', ['-H', '-ltnp', `( sport = :${port} )`], {
            encoding: 'utf8',
            timeout: 5000,
            stdio: ['ignore', 'pipe', 'ignore']
        });
        return output.split('\n').some((line) => new RegExp(`pid=${pid}([,)]|\\s|$)`).test(line));
    }
    catch
    {
        return false;
    }
}

function containerHasHostPort(containerRef, port)
{
    try
    {
        execFileSync('docker', ['inspect', '--format', '{{.Id}}', containerRef], {
            encoding: 'utf8',
            timeout: 5000,
            stdio: ['ignore', 'pipe', 'ignore']
        });
        const ports = execFileSync('docker', ['port', containerRef], {
            encoding: 'utf8',
            timeout: 5000,
            stdio: ['ignore', 'pipe', 'ignore']
        });
        return ports.split('\n').some((line) => line.includes(`127.0.0.1:${port}`));
    }
    catch
    {
        return false;
    }
}

export async function verifyListenerIdentityRef({ port, listenerIdentityRef })
{
    if (typeof listenerIdentityRef !== 'string' || listenerIdentityRef.length === 0)
    {
        return false;
    }
    if (listenerIdentityRef.startsWith('pid:'))
    {
        const pidText = listenerIdentityRef.slice(4);
        if (!/^\d+$/u.test(pidText))
        {
            return false;
        }
        return pidListeningOnPort(pidText, port);
    }
    if (listenerIdentityRef.startsWith('container:'))
    {
        return containerHasHostPort(listenerIdentityRef.slice(10), port);
    }
    return false;
}

function parseArgs(argv)
{
    const command = argv[0];
    const options = {};
    for (let index = 1; index < argv.length; index += 1)
    {
        const arg = argv[index];
        if (!arg.startsWith('--'))
        {
            throw new Error(`unexpected argument: ${arg}`);
        }
        const key = arg.slice(2);
        const value = argv[index + 1];
        if (value === undefined)
        {
            throw new Error(`missing value for ${arg}`);
        }
        options[key] = value;
        index += 1;
    }
    return { command, options };
}

function readTokenFile(tokenFilePath)
{
    const token = readPrivateFile(tokenFilePath).trim();
    if (!/^[a-f0-9]{64}$/u.test(token))
    {
        throw new Error('port lease token file is invalid');
    }
    return token;
}

function requireControl(manifest)
{
    return manifest.controlSocketPath;
}

async function runServe(options)
{
    const runId = options['run-id'];
    const namespace = options.namespace;
    const roleNames = String(options.roles ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
    if (!runId || !namespace || roleNames.length === 0)
    {
        throw new Error('serve requires --run-id, --namespace, and --roles');
    }
    const catalog = defaultRoleCatalog();
    const roles = catalog.filter((role) => roleNames.includes(role.role));
    const unknown = roleNames.filter((role) => !catalog.some((candidate) => candidate.role === role));
    if (unknown.length > 0)
    {
        throw new Error(`unknown port lease roles: ${unknown.join(', ')}`);
    }
    if (roles.length !== roleNames.length)
    {
        throw new Error(`serve role list has duplicates: ${roleNames.join(', ')}`);
    }
    const manifestPath = path.resolve(options.manifest);
    const controlSocketPath = path.resolve(options['control-socket']);
    const tokenFilePath = path.resolve(options['token-file']);
    const pidFilePath = path.resolve(options['pid-file']);
    const terminalReceiptPath = path.resolve(options['terminal-receipt']);
    const ttlMs = Number(options['ttl-ms'] ?? 0);
    const pins = {};
    for (const entry of String(options.pin ?? '').split(',').map((value) => value.trim()).filter(Boolean))
    {
        const separator = entry.lastIndexOf(':');
        if (separator < 1)
        {
            throw new Error(`invalid pin entry: ${entry}`);
        }
        const roleName = entry.slice(0, separator);
        const portText = entry.slice(separator + 1);
        if (!catalog.some((candidate) => candidate.role === roleName))
        {
            throw new Error(`unknown pinned port lease role: ${roleName}`);
        }
        const port = Number.parseInt(portText, 10);
        if (!Number.isInteger(port) || String(port) !== portText || port < 1 || port > 65535)
        {
            throw new Error(`invalid pinned port for role ${roleName}: ${portText}`);
        }
        pins[roleName] = port;
    }
    for (const pinnedRole of Object.keys(pins))
    {
        if (!roles.some((role) => role.role === pinnedRole))
        {
            throw new Error(`pinned role ${pinnedRole} is not in the served role list`);
        }
    }

    fs.mkdirSync(path.dirname(controlSocketPath), { recursive: true });
    try
    {
        fs.unlinkSync(controlSocketPath);
    }
    catch
    {
    // not present
    }

    const token = randomBytes(32).toString('hex');
    const allocator = createPortLeaseAllocator({
        runId, namespace, roles, reservationToken: token, pins,
        continuousHandoff: options['continuous-handoff'] === '1',
        containerReservations: options['container-reservations'] ?
            JSON.parse(readPrivateFile(path.resolve(options['container-reservations']))) : {}
    });
    const leases = await allocator.allocate();

    fs.writeFileSync(tokenFilePath, `${token}\n`, { mode: 0o600 });
    fs.chmodSync(tokenFilePath, 0o600);

    const createdAt = new Date().toISOString();
    let manifest = sealPortLeaseManifest({
        runId,
        namespace,
        reservationOwnerIdentity: allocator.reservationOwnerIdentity,
        createdAt,
        controlSocketPath,
        tokenFilePath,
        pidFilePath,
        terminalReceiptPath,
        leases
    });

    function persist()
    {
        manifest = sealPortLeaseManifest({
            runId,
            namespace,
            reservationOwnerIdentity: allocator.reservationOwnerIdentity,
            createdAt,
            controlSocketPath,
            tokenFilePath,
            pidFilePath,
            terminalReceiptPath,
            leases: allocator.snapshot()
        });
        atomicWriteJson(manifestPath, manifest);
    }

    persist();

    let shutdownAfterReleaseAll = null;
    const control = await createPortLeaseControlServerWithOptions({
        controlSocketPath,
        allocator,
        token,
        persist,
        verifyListenerIdentity: verifyListenerIdentityRef,
        onReleaseAll: async ({ reason, leases: released }) =>
        {
            writePortLeaseTerminalReceipt({
                terminalReceiptPath,
                runId,
                namespace,
                reservationOwnerIdentity: allocator.reservationOwnerIdentity,
                terminalState: 'released',
                reason: typeof reason === 'string' ? reason : 'release',
                manifestDigest: manifest.contentDigest,
                leases: released
            });
            shutdownAfterReleaseAll?.();
        }
    });

    atomicWriteText(pidFilePath, String(process.pid));

    let shuttingDown = false;
    async function shutdown(reason)
    {
        if (shuttingDown)
        {
            return;
        }
        shuttingDown = true;
        await allocator.releaseAll(reason, { cancelBound: true });
        persist();
        try
        {
            writePortLeaseTerminalReceipt({
                terminalReceiptPath,
                runId,
                namespace,
                reservationOwnerIdentity: allocator.reservationOwnerIdentity,
                terminalState: 'released',
                reason,
                manifestDigest: manifest.contentDigest,
                leases: allocator.snapshot()
            });
        }
        catch
        {
            // best effort on shutdown
        }
        control.close();
        process.exit(0);
    }
    shutdownAfterReleaseAll = () =>
    {
        setTimeout(() =>
        {
            if (!shuttingDown)
            {
                shuttingDown = true;
                control.close();
                process.exit(0);
            }
        }, 200);
    };
    process.on('SIGTERM', () =>
    {
        shutdown('signal-term');
    });
    process.on('SIGINT', () =>
    {
        shutdown('signal-int');
    });
    if (Number.isFinite(ttlMs) && ttlMs > 0)
    {
        setTimeout(() =>
        {
            shutdown('ttl-expired');
        }, ttlMs);
    }

    process.stdout.write(
        `[port-lease] ready runId=${runId} namespace=${namespace} roles=${roles.map((role) => role.role).join(',')} manifest=${manifestPath} pid=${process.pid}\n`
    );
    process.stdout.write(`[port-lease] reserved ${leases.map((lease) => `${lease.role}=${lease.port}`).join(' ')}\n`);
}

async function runControlCommand(commandName, options)
{
    const manifest = readSealedManifest(path.resolve(options.manifest));
    const token = readTokenFile(path.resolve(options['token-file']));
    const request = { command: commandName, token };
    if (['release-before-bind', 'complete-handoff', 'fail-handoff', 'launch-native', 'activate-container'].includes(commandName))
    {
        if (!options.role)
        {
            throw new Error(`${commandName} requires --role`);
        }
        request.role = options.role;
    }
    if (commandName === 'launch-native')
    {
        request.specification = JSON.parse(readPrivateFile(path.resolve(options.specification)));
    }
    if (commandName === 'complete-handoff')
    {
        if (!options['listener-identity-ref'])
        {
            throw new Error('complete-handoff requires --listener-identity-ref');
        }
        request.listenerIdentityRef = options['listener-identity-ref'];
    }
    if (commandName === 'fail-handoff' || commandName === 'release-all')
    {
        request.reason = options.reason ?? 'run-failure';
    }
    if (commandName === 'release-all')
    {
        request.cancelBound = options['cancel-bound'] === '1';
    }
    const response = await connectControl(requireControl(manifest), request);
    if (!response.ok)
    {
        throw new Error(`port lease ${commandName} failed: ${response.error ?? 'unknown'}`);
    }
    if (commandName === 'launch-native')
    {
        process.stdout.write(`${response.lease.handoffOwnerIdentity.pid}\n`);
    }
    else if (commandName === 'ping' || commandName === 'status')
    {
        process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
    }
    else
    {
        process.stdout.write(`[port-lease] ${commandName} ok\n`);
    }
}

async function runRecover(manifestPath)
{
    const resolved = path.resolve(manifestPath);
    let manifest;
    try
    {
        manifest = readSealedManifest(resolved);
    }
    catch (error)
    {
        throw new Error(`recover cannot validate stale manifest: ${error.message}`, {cause: error});
    }
    const pidFile = manifest.pidFilePath;
    let alive = false;
    if (fs.existsSync(pidFile))
    {
        const pidText = fs.readFileSync(pidFile, 'utf8').trim();
        if (/^\d+$/u.test(pidText))
        {
            const pid = Number.parseInt(pidText, 10);
            try
            {
                process.kill(pid, 0);
                const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
                const tail = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u);
                const startTimeTicks = tail[19] ?? '';
                alive = startTimeTicks === manifest.reservationOwnerIdentity.processStartIdentity;
            }
            catch
            {
                alive = false;
            }
        }
    }
    if (alive)
    {
        throw new Error(`port lease reservation owner is still alive; refusing recovery: ${manifest.reservationOwnerIdentity.instanceId}`);
    }
    const cleanupObservations = [];
    const recoveredLeases = [];
    const cleanupFailures = [];
    for (const lease of manifest.leases)
    {
        if (lease.handoffState === 'bound' || lease.handoffState === 'released')
        {
            recoveredLeases.push(lease);
            continue;
        }
        try
        {
            if (lease.containerReservation)
            {
                cleanupObservations.push({ role: lease.role, observation: await recoverReleaseContainerPublisher(lease.containerReservation) });
            }
            else if (lease.handoffOwnerIdentity)
            {
                const {pid, processStartIdentity, socketIdentity, guardian} = lease.handoffOwnerIdentity;
                cleanupObservations.push({role: lease.role,
                    observation: await verifyNativeReservationCleanup({pid, processStartIdentity, socketIdentity, guardian})});
            }
            recoveredLeases.push({ ...lease, handoffState: 'released',
                handedOffAt: new Date().toISOString(), failedReason: 'owner-crashed' });
        }
        catch (error)
        {
            cleanupFailures.push(`${lease.role}: ${error.message}`);
            cleanupObservations.push({ role: lease.role, verified: false, error: error.message });
            recoveredLeases.push(lease);
        }
    }
    writePortLeaseTerminalReceipt({
        terminalReceiptPath: manifest.terminalReceiptPath,
        runId: manifest.runId,
        namespace: manifest.namespace,
        reservationOwnerIdentity: manifest.reservationOwnerIdentity,
        terminalState: cleanupFailures.length > 0 ? 'failed' : 'released',
        reason: cleanupFailures.length > 0 ? 'owner-crashed-cleanup-unverified' : 'owner-crashed',
        manifestDigest: manifest.contentDigest,
        leases: recoveredLeases,
        cleanupObservations
    });
    if (cleanupFailures.length > 0)
    {
        throw new Error(`port lease recovery cleanup was not verified: ${cleanupFailures.join('; ')}`);
    }
    process.stdout.write(`[port-lease] recovered stale manifest ${resolved}\n`);
}

async function main()
{
    const { command, options } = parseArgs(process.argv.slice(2));
    if (command === 'help' || command === '--help' || command === '-h')
    {
        process.stdout.write(`Usage:
  node tools/test-matrix/production-fresh-port-lease.mjs serve --run-id <id> --namespace <ns> --roles <postgres,redis,...> --manifest <path> --control-socket <path> --token-file <path> --pid-file <path> --terminal-receipt <path> [--pin role:port,...] [--ttl-ms <ms>]
  node tools/test-matrix/production-fresh-port-lease.mjs verify --manifest <path>
  node tools/test-matrix/production-fresh-port-lease.mjs verify-listeners --manifest <path> --run-id <id> --namespace <ns>
  node tools/test-matrix/production-fresh-port-lease.mjs verify-readiness --manifest <path> --run-id <id> --namespace <ns>
  node tools/test-matrix/production-fresh-port-lease.mjs get-port --manifest <path> --role <role>
  node tools/test-matrix/production-fresh-port-lease.mjs roles --manifest <path>
  node tools/test-matrix/production-fresh-port-lease.mjs status --manifest <path> --token-file <path>
  node tools/test-matrix/production-fresh-port-lease.mjs launch-native --manifest <path> --token-file <path> --role <role> --specification <0600-json-path>
  node tools/test-matrix/production-fresh-port-lease.mjs release-before-bind --manifest <path> --token-file <path> --role <role>
  node tools/test-matrix/production-fresh-port-lease.mjs complete-handoff --manifest <path> --token-file <path> --role <role> --listener-identity-ref <ref>
  node tools/test-matrix/production-fresh-port-lease.mjs fail-handoff --manifest <path> --token-file <path> --role <role> --reason <reason>
  node tools/test-matrix/production-fresh-port-lease.mjs release-all --manifest <path> --token-file <path> [--reason <reason>]
  node tools/test-matrix/production-fresh-port-lease.mjs recover --manifest <path>
`);
        return;
    }
    if (command === 'serve')
    {
        await runServe(options);
        return;
    }
    if (command === 'verify')
    {
        readSealedManifest(path.resolve(options.manifest));
        process.stdout.write(`[port-lease] manifest ok ${options.manifest}\n`);
        return;
    }
    if (command === 'verify-listeners' || command === 'verify-readiness')
    {
        const observations = await verifyBoundRuntimeListeners({
            manifest: readSealedManifest(path.resolve(options.manifest)),
            runId: options['run-id'], namespace: options.namespace,
            requireReadiness: command === 'verify-readiness'
        });
        process.stdout.write(`${JSON.stringify(observations)}\n`);
        return;
    }
    if (command === 'get-port')
    {
        const manifest = readSealedManifest(path.resolve(options.manifest));
        const lease = manifest.leases.find((candidate) => candidate.role === options.role);
        if (!lease)
        {
            throw new Error(`port lease role is not in manifest: ${options.role}`);
        }
        process.stdout.write(`${lease.port}\n`);
        return;
    }
    if (command === 'roles')
    {
        const manifest = readSealedManifest(path.resolve(options.manifest));
        process.stdout.write(`${manifest.leases.map((lease) => lease.role).join(',')}\n`);
        return;
    }
    if (command === 'recover')
    {
        await runRecover(options.manifest);
        return;
    }
    if (['status', 'release-before-bind', 'complete-handoff', 'fail-handoff', 'release-all', 'ping', 'launch-native', 'activate-container'].includes(command))
    {
        await runControlCommand(command, options);
        return;
    }
    throw new Error(`unknown command: ${command}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
{
    try
    {
        await main();
    }
    catch (error)
    {
        process.stderr.write(`[port-lease] ${error.message}\n`);
        process.exit(1);
    }
}
