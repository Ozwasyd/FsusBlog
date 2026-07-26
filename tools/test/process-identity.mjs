import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

export const processIdentitySchema = 'fsusblog.process-identity.v1'
const executableDigestCache = new Map()
const macProcStartScript = [
    'import ctypes, sys',
    'class ProcBsdInfo(ctypes.Structure):',
    '    _fields_ = [',
    "        ('header', ctypes.c_uint32 * 12),",
    "        ('command', ctypes.c_char * 16),",
    "        ('name', ctypes.c_char * 32),",
    "        ('tail', ctypes.c_uint32 * 5),",
    "        ('nice', ctypes.c_int32),",
    "        ('start_sec', ctypes.c_uint64),",
    "        ('start_usec', ctypes.c_uint64),",
    '    ]',
    "libproc = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)",
    'libproc.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]',
    'libproc.proc_pidinfo.restype = ctypes.c_int',
    'info = ProcBsdInfo()',
    'size = libproc.proc_pidinfo(int(sys.argv[1]), 3, 0, ctypes.byref(info), ctypes.sizeof(info))',
    "if size != ctypes.sizeof(info) or info.start_sec <= 0 or info.start_usec >= 1000000: raise OSError(ctypes.get_errno(), 'proc_pidinfo failed')",
    "print(f'{info.start_sec}:{info.start_usec:06d}')"
].join('\n')

function digest(value) {
    return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function executableDigest(executablePath) {
    const metadata = fs.statSync(executablePath)
    const fingerprint = `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}:${metadata.ctimeMs}`
    const cached = executableDigestCache.get(executablePath)
    if (cached?.fingerprint === fingerprint) return cached.digest
    const value = digest(fs.readFileSync(executablePath))
    executableDigestCache.set(executablePath, { fingerprint, digest: value })
    return value
}

function linuxIdentity(pid, procRoot) {
    const stat = fs.readFileSync(path.join(procRoot, String(pid), 'stat'), 'utf8')
    const close = stat.lastIndexOf(')')
    if (close < 0) throw new Error('missing process stat command boundary')
    const fields = stat
        .slice(close + 2)
        .trim()
        .split(/\s+/u)
    if (fields[0] === 'Z') {
        const error = new Error('process is a zombie')
        error.code = 'ESRCH'
        throw error
    }
    const startTicks = fields[19]
    if (!startTicks) throw new Error('missing process start ticks')
    const bootId = fs.readFileSync(path.join(procRoot, 'sys/kernel/random/boot_id'), 'utf8').trim()
    const executablePath = fs.readlinkSync(path.join(procRoot, String(pid), 'exe'))
    const command = fs
        .readFileSync(path.join(procRoot, String(pid), 'cmdline'))
        .toString('utf8')
        .split('\0')
        .filter(Boolean)
        .join('\0')
    if (!command) {
        const error = new Error('process exited while command identity was collected')
        error.code = 'ESRCH'
        throw error
    }
    if (!bootId || !executablePath) throw new Error('incomplete Linux process identity')
    return {
        schema: processIdentitySchema,
        pid,
        processStartIdentity: `linux:${bootId}:${startTicks}`,
        executablePath,
        executableDigest: executableDigest(executablePath),
        commandDigest: digest(command)
    }
}

export function parseMacProcessIdentityFields({ startIdentity, executablePath, command }) {
    const normalized = {
        startIdentity: String(startIdentity ?? '').trim(),
        executablePath: String(executablePath ?? '').trim(),
        command: String(command ?? '').trim()
    }
    if (!normalized.startIdentity || !normalized.executablePath || !normalized.command) {
        throw new Error('incomplete macOS process identity')
    }
    return normalized
}

function commandIdentity(pid, platform, execute) {
    const script =
        platform === 'win32'
            ? `Get-CimInstance Win32_Process -Filter \"ProcessId=${pid}\" | Select-Object ProcessId,CreationDate,ExecutablePath,CommandLine | ConvertTo-Json -Compress`
            : ''
    if (platform === 'win32') {
        const value = JSON.parse(execute('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' }))
        if (!value?.CreationDate || !value?.ExecutablePath || !value?.CommandLine)
            throw new Error('incomplete Windows process identity')
        return {
            schema: processIdentitySchema,
            pid,
            processStartIdentity: `windows:${value.CreationDate}`,
            executablePath: value.ExecutablePath,
            executableDigest: executableDigest(value.ExecutablePath),
            commandDigest: digest(value.CommandLine)
        }
    }
    const parsed = parseMacProcessIdentityFields({
        startIdentity: execute('/usr/bin/python3', ['-c', macProcStartScript, String(pid)], { encoding: 'utf8' }),
        executablePath: execute('ps', ['-ww', '-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' }),
        command: execute('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
    })
    return {
        schema: processIdentitySchema,
        pid,
        processStartIdentity: `darwin:${parsed.startIdentity}`,
        executablePath: parsed.executablePath,
        executableDigest: executableDigest(parsed.executablePath),
        commandDigest: digest(parsed.command)
    }
}

export function collectProcessIdentity(
    pid,
    { platform = process.platform, procRoot = '/proc', execute = execFileSync } = {}
) {
    if (!Number.isInteger(pid) || pid <= 0) return { status: 'unverifiable', pid, reason: 'invalid-pid' }
    try {
        const identity = platform === 'linux' ? linuxIdentity(pid, procRoot) : commandIdentity(pid, platform, execute)
        return { status: 'verified', ...identity }
    } catch (error) {
        return {
            status: 'unverifiable',
            pid,
            code: error && typeof error === 'object' ? (error.code ?? null) : null,
            reason: error instanceof Error ? error.message : String(error)
        }
    }
}

export function processIdentityMatches(expected, actual) {
    if (expected?.status && expected.status !== 'verified') return false
    if (actual?.status && actual.status !== 'verified') return false
    return Boolean(
        expected &&
            actual &&
            actual.schema === processIdentitySchema &&
            expected.pid === actual.pid &&
            expected.processStartIdentity === actual.processStartIdentity &&
            expected.executablePath === actual.executablePath &&
            expected.executableDigest === actual.executableDigest &&
            expected.commandDigest === actual.commandDigest
    )
}

export function currentProcessIdentity() {
    const identity = collectProcessIdentity(process.pid)
    if (identity.status !== 'verified') throw new Error(`current process identity is unverifiable: ${identity.reason}`)
    return identity
}

export function collectProcessGroupOrJobIdentity(
    pid,
    { platform = process.platform, procRoot = '/proc', execute = execFileSync } = {}
) {
    try {
        if (platform === 'linux') {
            const stat = fs.readFileSync(path.join(procRoot, String(pid), 'stat'), 'utf8')
            const close = stat.lastIndexOf(')')
            const fields = stat
                .slice(close + 2)
                .trim()
                .split(/\s+/u)
            const bootId = fs.readFileSync(path.join(procRoot, 'sys/kernel/random/boot_id'), 'utf8').trim()
            const groupId = Number(fields[2])
            const leader = collectProcessIdentity(groupId, { platform, procRoot, execute })
            if (!bootId || !Number.isInteger(groupId) || leader.status !== 'verified') {
                throw new Error('incomplete Linux process-group leader identity')
            }
            return {
                status: 'verified',
                value: {
                    schema: 'fsusblog.process-group-or-job-identity.v1',
                    platform,
                    kind: 'process-group',
                    groupId,
                    leaderPid: groupId,
                    leaderProcessStartIdentity: leader.processStartIdentity
                }
            }
        }
        if (platform === 'darwin') {
            const pgid = String(execute('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' })).trim()
            if (!/^\d+$/u.test(pgid)) throw new Error('incomplete macOS process-group identity')
            const groupId = Number(pgid)
            const leader = collectProcessIdentity(groupId, { platform, procRoot, execute })
            if (leader.status !== 'verified') throw new Error('incomplete macOS process-group leader identity')
            return {
                status: 'verified',
                value: {
                    schema: 'fsusblog.process-group-or-job-identity.v1',
                    platform,
                    kind: 'process-group',
                    groupId,
                    leaderPid: groupId,
                    leaderProcessStartIdentity: leader.processStartIdentity
                }
            }
        }
        if (platform === 'win32') {
            throw new Error('Windows PPID snapshots are not a durable Job Object authority')
        }
        throw new Error(`unsupported process-group platform: ${platform}`)
    } catch (error) {
        return { status: 'unverifiable', reason: error instanceof Error ? error.message : String(error) }
    }
}

export function processGroupOrJobIdentityMatches(expected, actual) {
    return Boolean(
        expected &&
            actual &&
            expected.schema === 'fsusblog.process-group-or-job-identity.v1' &&
            actual.schema === expected.schema &&
            expected.platform === actual.platform &&
            expected.kind === actual.kind &&
            expected.groupId === actual.groupId &&
            expected.leaderPid === actual.leaderPid &&
            expected.leaderProcessStartIdentity === actual.leaderProcessStartIdentity
    )
}

export function processIdentityStatus(expected, options = {}) {
    if (
        !expected ||
        !Number.isInteger(Number(expected.pid)) ||
        !expected.processStartIdentity ||
        !expected.executablePath ||
        !expected.executableDigest ||
        !expected.commandDigest
    ) {
        return { status: 'mismatch', actual: null }
    }
    const actual = collectProcessIdentity(Number(expected?.pid), options)
    if (actual.status === 'unverifiable' && ['ENOENT', 'ESRCH'].includes(actual.code)) return { status: 'dead', actual }
    if (actual.status !== 'verified') return { status: 'unverifiable', actual }
    return processIdentityMatches(expected, actual) ? { status: 'live', actual } : { status: 'mismatch', actual }
}

export function processDescendantIdentities(
    owner,
    { procRoot = '/proc', platform = process.platform, execute = execFileSync, raceRetries = 2 } = {}
) {
    if (platform === 'win32') {
        return { status: 'unverifiable', reason: 'Windows descendants require a durable Job Object authority' }
    }
    try {
        const parentByPid = new Map()
        if (platform === 'linux') {
            for (const entry of fs.readdirSync(procRoot, { withFileTypes: true })) {
                if (!/^\d+$/u.test(entry.name)) continue
                let stat
                try {
                    stat = fs.readFileSync(path.join(procRoot, entry.name, 'stat'), 'utf8')
                } catch (error) {
                    if (error.code === 'ENOENT') continue
                    throw error
                }
                const close = stat.lastIndexOf(')')
                const parentPid = Number(
                    stat
                        .slice(close + 2)
                        .trim()
                        .split(/\s+/u)[1]
                )
                parentByPid.set(Number(entry.name), parentPid)
            }
        } else if (platform === 'darwin') {
            for (const line of execute('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n')) {
                const [pid, parentPid] = line.trim().split(/\s+/u).map(Number)
                if (Number.isInteger(pid) && Number.isInteger(parentPid)) parentByPid.set(pid, parentPid)
            }
        } else {
            throw new Error(`unsupported process-tree platform: ${platform}`)
        }
        const descendants = []
        const pending = [owner.pid]
        while (pending.length) {
            const parentPid = pending.pop()
            for (const [pid, candidateParent] of parentByPid) {
                if (candidateParent !== parentPid) continue
                pending.push(pid)
                const identity = collectProcessIdentity(pid, { platform, procRoot, execute })
                if (identity.status !== 'verified') {
                    if (['ENOENT', 'ESRCH'].includes(identity.code)) continue
                    return { status: 'unverifiable', reason: `descendant-${pid}-${identity.reason}` }
                }
                descendants.push(identity)
            }
        }
        return { status: 'verified', identities: descendants.sort((left, right) => left.pid - right.pid) }
    } catch (error) {
        if (['ENOENT', 'ESRCH'].includes(error?.code) && raceRetries > 0) {
            return processDescendantIdentities(owner, { procRoot, platform, execute, raceRetries: raceRetries - 1 })
        }
        return { status: 'unverifiable', reason: error instanceof Error ? error.message : String(error) }
    }
}

export function processGroupMemberIdentities(
    group,
    { procRoot = '/proc', platform = process.platform, execute = execFileSync, raceRetries = 2 } = {}
) {
    if (group?.schema !== 'fsusblog.process-group-or-job-identity.v1' || group.platform !== platform) {
        return { status: 'unverifiable', reason: 'process group or Job identity is incomplete' }
    }
    if (group.kind === 'process-tree') {
        if (platform === 'win32') {
            return { status: 'unverifiable', reason: 'Windows PPID snapshots are not a durable Job Object authority' }
        }
        const leader = collectProcessIdentity(group.leaderPid, { procRoot, platform, execute })
        if (leader.status === 'verified' && leader.processStartIdentity !== group.leaderProcessStartIdentity) {
            return { status: 'unverifiable', reason: 'process-tree leader start identity mismatch' }
        }
        if (leader.status === 'unverifiable' && !['ENOENT', 'ESRCH'].includes(leader.code)) {
            return { status: 'unverifiable', reason: `process-tree leader is unverifiable: ${leader.reason}` }
        }
        return processDescendantIdentities({ pid: group.leaderPid }, { procRoot, platform, execute })
    }
    try {
        const leader = collectProcessIdentity(group.leaderPid, { procRoot, platform, execute })
        if (leader.status === 'verified' && leader.processStartIdentity !== group.leaderProcessStartIdentity) {
            return { status: 'unverifiable', reason: 'process-group leader start identity mismatch' }
        }
        if (leader.status === 'unverifiable' && !['ENOENT', 'ESRCH'].includes(leader.code)) {
            return { status: 'unverifiable', reason: `process-group leader is unverifiable: ${leader.reason}` }
        }
        const memberPids = []
        if (platform === 'linux') {
            for (const entry of fs.readdirSync(procRoot, { withFileTypes: true })) {
                if (!/^\d+$/u.test(entry.name)) continue
                try {
                    const stat = fs.readFileSync(path.join(procRoot, entry.name, 'stat'), 'utf8')
                    const close = stat.lastIndexOf(')')
                    const fields = stat
                        .slice(close + 2)
                        .trim()
                        .split(/\s+/u)
                    if (Number(fields[2]) === group.groupId) memberPids.push(Number(entry.name))
                } catch (error) {
                    if (error.code !== 'ENOENT') throw error
                }
            }
        } else if (platform === 'darwin') {
            for (const line of execute('ps', ['-axo', 'pid=,pgid='], { encoding: 'utf8' }).trim().split('\n')) {
                const [pid, groupId] = line.trim().split(/\s+/u).map(Number)
                if (groupId === group.groupId) memberPids.push(pid)
            }
        } else {
            return { status: 'unverifiable', reason: `unsupported group member platform: ${platform}` }
        }
        const identities = []
        for (const pid of [...new Set(memberPids)]) {
            const identity = collectProcessIdentity(pid, { platform, procRoot, execute })
            if (identity.status === 'unverifiable' && ['ENOENT', 'ESRCH'].includes(identity.code)) continue
            if (identity.status !== 'verified')
                return { status: 'unverifiable', reason: `group-member-${pid}-${identity.reason}` }
            identities.push(identity)
        }
        return { status: 'verified', identities: identities.sort((left, right) => left.pid - right.pid) }
    } catch (error) {
        if (error?.code === 'ENOENT' && raceRetries > 0) {
            return processGroupMemberIdentities(group, { procRoot, platform, execute, raceRetries: raceRetries - 1 })
        }
        return { status: 'unverifiable', reason: error instanceof Error ? error.message : String(error) }
    }
}
