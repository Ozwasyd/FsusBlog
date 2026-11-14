import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    assertCpuEqual, cpuAssertDigest, cpuDigest, exactCpuFields, sealCpuValue, validateCpuIdentity, verifyCpuSeal
} from './cpu-calibration-contract.mjs';

export const machineCpuTopologySchema = 'fsusblog.machine-cpu-topology-receipt.v1';
export const cpuCollectorVersion = 'fsusblog.machine-cpu-topology-collector.v1';
const sourceFields = ['host', 'online', 'allowed', 'cpuset', 'cores', 'boundary', 'power'];
const unknown = (reason, disposition = 'unknown') => ({ disposition, reason, value: null });
const observed = (value) => ({ disposition: 'observed', reason: null, value });

export function parseCpuList(text)
{
    if (typeof text !== 'string' || !/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/u.test(text.trim()))
    {
        throw new Error('CPU list unavailable or malformed');
    }
    const ids = [];
    for (const segment of text.trim().split(','))
    {
        const [start, end = start] = segment.split('-').map(Number);
        if (end < start || end > 65535)
        {
            throw new Error('CPU list range invalid');
        }
        for (let id = start; id <= end; id++)
        {
            if (ids.includes(id))
            {
                throw new Error('CPU list duplicate');
            }
            ids.push(id);
        }
    }
    return ids.sort((left, right) => left - right);
}

function source(value, label)
{
    exactCpuFields(value, ['disposition', 'reason', 'value'], label);
    if (!['observed', 'unknown', 'unsupported'].includes(value.disposition)
        || (value.disposition === 'observed' ? value.value === null || value.reason !== null
            : value.value !== null || typeof value.reason !== 'string' || !value.reason))
    {
        throw new Error(`${label}: invalid observation disposition`);
    }
    return value;
}

function cpuSet(value)
{
    return value.disposition === 'observed' ? observed(parseCpuList(value.value)) : value;
}

function projectBoundary(raw)
{
    if (raw.disposition !== 'observed')
    {
        return raw;
    }
    const value = raw.value;
    exactCpuFields(value, ['kind', 'ancestryComplete', 'limits'], 'finite boundary');
    if (!['linux-cgroup-v2', 'linux-cgroup-v1', 'windows-job'].includes(value.kind)
        || typeof value.ancestryComplete !== 'boolean' || !Array.isArray(value.limits) || !value.limits.length)
    {
        throw new Error('finite boundary raw observation malformed');
    }
    if (!value.ancestryComplete)
    {
        return unknown('finite boundary ancestry incomplete');
    }
    const limits = value.limits.map((limit) =>
    {
        exactCpuFields(limit, ['locator', 'quota', 'period'], 'CPU limit');
        if (typeof limit.locator !== 'string' || !limit.locator)
        {
            throw new Error('finite boundary locator missing');
        }
        if (!/^\d+$/u.test(limit.period) || Number(limit.period) <= 0)
        {
            throw new Error('finite boundary period invalid');
        }
        if (limit.quota === 'max' || (value.kind === 'linux-cgroup-v1' && limit.quota === '-1'))
        {
            return null;
        }
        if (!/^\d+$/u.test(limit.quota) || Number(limit.quota) <= 0)
        {
            throw new Error('finite boundary quota invalid');
        }
        return Number(limit.quota) / Number(limit.period);
    }).filter((limit) => limit !== null);
    return limits.length ? observed({ kind: value.kind, cores: Math.min(...limits), verified: true })
        : { disposition: 'unlimited', reason: 'no finite CPU limit observed', value: null };
}

function physicalObservation(allowed, cores)
{
    if (allowed.disposition !== 'observed' || cores.disposition !== 'observed')
    {
        return unknown('allowed logical to physical mapping unavailable');
    }
    if (!Array.isArray(cores.value))
    {
        throw new Error('physical core observations must be an array');
    }
    const rows = cores.value;
    const byCpu = new Map();
    for (const row of rows)
    {
        exactCpuFields(row, ['cpu', 'package', 'core', 'siblings', 'numa', 'coreClass'], 'physical CPU row');
        if (!Number.isSafeInteger(row.cpu) || row.cpu < 0 || byCpu.has(row.cpu)
            || !/^[0-9]+$/u.test(row.package ?? '') || !/^[0-9]+$/u.test(row.core ?? ''))
        {
            return unknown('physical mapping missing identity or collision');
        }
        source(row.numa, 'NUMA observation');
        source(row.coreClass, 'core class observation');
        byCpu.set(row.cpu, row);
    }
    const groups = new Map();
    for (const cpu of allowed.value)
    {
        const row = byCpu.get(cpu);
        if (!row)
        {
            return unknown('physical mapping incomplete');
        }
        let siblings;
        try
        {
            siblings = parseCpuList(row.siblings);
        }
        catch
        {
            return unknown('SMT sibling mapping unavailable');
        }
        if (!siblings.includes(cpu))
        {
            return unknown('SMT self identity missing');
        }
        const key = `${row.package}:${row.core}`;
        const previous = groups.get(key);
        if (previous && cpuDigest(previous.siblings) !== cpuDigest(siblings))
        {
            return unknown('core identity collision');
        }
        for (const sibling of siblings.filter((id) => allowed.value.includes(id)))
        {
            const peer = byCpu.get(sibling);
            if (!peer || peer.package !== row.package || peer.core !== row.core
                || cpuDigest(parseCpuList(peer.siblings)) !== cpuDigest(siblings))
            {
                return unknown('sibling identity collision');
            }
        }
        groups.set(key, { package: row.package, core: row.core, siblings,
            allowedSiblings: siblings.filter((id) => allowed.value.includes(id)),
            numa: row.numa, coreClass: row.coreClass });
    }
    return observed({ count: groups.size, cores: [...groups.values()] });
}

export function buildMachineCpuTopology(raw)
{
    exactCpuFields(raw, ['platform', 'arch', 'kernel', 'machineIdentityDigest', 'sources'], 'CPU raw observation');
    cpuAssertDigest(raw.machineIdentityDigest, 'machineIdentityDigest');
    for (const field of ['platform', 'arch', 'kernel'])
    {
        if (typeof raw[field] !== 'string' || !raw[field])
        {
            throw new Error(`CPU ${field} unavailable`);
        }
    }
    exactCpuFields(raw.sources, sourceFields, 'CPU raw sources');
    for (const field of sourceFields)
    {
        source(raw.sources[field], field);
    }
    const host = cpuSet(raw.sources.host);
    const online = cpuSet(raw.sources.online);
    const affinity = cpuSet(raw.sources.allowed);
    const cpuset = cpuSet(raw.sources.cpuset);
    let allowed = affinity;
    if (online.disposition !== 'observed')
    {
        allowed = unknown('online CPU set unavailable');
    }
    else if (affinity.disposition === 'observed')
    {
        allowed = observed(affinity.value.filter((id) => online.value.includes(id)
            && (cpuset.disposition !== 'observed' || cpuset.value.includes(id))));
        if (!allowed.value.length)
        {
            throw new Error('allowed CPU intersection empty');
        }
    }
    const projection = {
        host, online, allowed, cpuset,
        physical: physicalObservation(allowed, raw.sources.cores),
        finiteBoundary: projectBoundary(raw.sources.boundary), power: raw.sources.power
    };
    return sealCpuValue({ schema: machineCpuTopologySchema, collectorVersion: cpuCollectorVersion,
        raw, collectorDisposition: sourceFields.every((field) => raw.sources[field].disposition === 'unsupported')
            ? 'unsupported' : sourceFields.every((field) => raw.sources[field].disposition === 'observed')
                && projection.physical.disposition === 'observed' && projection.finiteBoundary.disposition === 'observed'
                ? 'observed' : 'partial', rawSourceDigests: Object.fromEntries(sourceFields.map((field) => [field, cpuDigest(raw.sources[field])])),
        projection, topologyDigest: cpuDigest({ platform: raw.platform, arch: raw.arch, kernel: raw.kernel,
            machineIdentityDigest: raw.machineIdentityDigest, projection }) });
}

export function validateMachineCpuTopology(receipt, expectedDigest)
{
    verifyCpuSeal(receipt, machineCpuTopologySchema);
    assertCpuEqual(receipt, buildMachineCpuTopology(receipt.raw), 'CPU topology');
    if (expectedDigest !== undefined && receipt.topologyDigest !== expectedDigest)
    {
        throw new Error('stale CPU topology receipt');
    }
    return receipt;
}

export function validateCpuMachineIdentity(topology, identity)
{
    validateCpuIdentity(identity);
    validateMachineCpuTopology(topology, identity.topology);
    const expected = { machine: topology.raw.machineIdentityDigest,
        finiteBoundary: cpuDigest(topology.projection.finiteBoundary), platform: cpuDigest(topology.raw.platform),
        arch: cpuDigest(topology.raw.arch), kernel: cpuDigest(topology.raw.kernel), powerPolicy: cpuDigest(topology.projection.power) };
    for (const [field, value] of Object.entries(expected))
    {
        if (identity[field] !== value)
        {
            throw new Error(`CPU machine identity mismatch: ${field}`);
        }
    }
    return identity;
}

function readObservation(file)
{
    try
    {
        return observed(fs.readFileSync(file, 'utf8').trim());
    }
    catch
    {
        return unknown(`unreadable:${file}`);
    }
}

function collectLinuxBoundary()
{
    const membership = readObservation('/proc/self/cgroup');
    const mounts = readObservation('/proc/self/mountinfo');
    if (membership.disposition !== 'observed' || mounts.disposition !== 'observed')
    {
        return { boundary: unknown('cgroup membership unavailable'), cpuset: unknown('cpuset unavailable') };
    }
    const unified = membership.value.split('\n').find((line) => line.startsWith('0::'));
    const mount = mounts.value.split('\n').find((line) => line.split(' - ')[1]?.startsWith('cgroup2 '));
    if (!unified || !mount)
    {
        return { boundary: unknown('cgroup v1 collector unsupported'), cpuset: unknown('cpuset unavailable') };
    }
    const fields = mount.split(' - ')[0].split(' ');
    const root = fields[3];
    const mountPoint = fields[4];
    const member = unified.slice(3);
    if ([root, mountPoint, member].some((item) => item.includes('\\') || item.split('/').includes('..'))
        || !(member === root || member.startsWith(root === '/' ? '/' : `${root}/`)))
    {
        return { boundary: unknown('cgroup membership outside visible mount'), cpuset: unknown('cpuset unavailable') };
    }
    const current = path.join(mountPoint, member.slice(root.length));
    const cpuset = readObservation(path.join(current, 'cpuset.cpus.effective'));
    const limits = [];
    let directory = current;
    while (true)
    {
        const limit = readObservation(path.join(directory, 'cpu.max'));
        if (limit.disposition !== 'observed')
        {
            return { boundary: unknown('CPU quota ancestry unreadable'), cpuset };
        }
        const [quota, period, extra] = limit.value.split(/\s+/u);
        if (extra || !period)
        {
            return { boundary: unknown('CPU quota malformed'), cpuset };
        }
        limits.push({ locator: directory, quota, period });
        if (directory === mountPoint)
        {
            break;
        }
        directory = path.dirname(directory);
    }
    // A subtree mount can hide tighter ancestor limits; it cannot attest a full boundary.
    return { boundary: observed({ kind: 'linux-cgroup-v2', ancestryComplete: root === '/', limits }), cpuset };
}

export function collectMachineCpuTopology()
{
    const unavailable = unknown('native platform observation unavailable', 'unsupported');
    let sources = Object.fromEntries(sourceFields.map((field) => [field, unavailable]));
    let machine = unavailable;
    if (process.platform === 'linux')
    {
        const status = readObservation('/proc/self/status');
        const allowedText = status.value?.match(/^Cpus_allowed_list:\s*(.+)$/mu)?.[1];
        const allowed = allowedText ? observed(allowedText) : unknown('process CPU affinity unavailable');
        const cores = [];
        if (allowed.disposition === 'observed')
        {
            for (const cpu of parseCpuList(allowed.value))
            {
                const base = `/sys/devices/system/cpu/cpu${cpu}`;
                const nodes = fs.existsSync(base) ? fs.readdirSync(base).filter((name) => /^node\d+$/u.test(name)) : [];
                cores.push({ cpu, package: readObservation(`${base}/topology/physical_package_id`).value,
                    core: readObservation(`${base}/topology/core_id`).value,
                    siblings: readObservation(`${base}/topology/thread_siblings_list`).value,
                    numa: nodes.length === 1 ? observed(nodes[0]) : unknown('NUMA identity unavailable'),
                    coreClass: readObservation(`${base}/topology/core_type`) });
            }
        }
        const policies = [];
        const policyRoot = '/sys/devices/system/cpu/cpufreq';
        if (fs.existsSync(policyRoot))
        {
            for (const policy of fs.readdirSync(policyRoot).sort().filter((name) => /^policy\d+$/u.test(name)))
            {
                policies.push({ policy, governor: readObservation(`${policyRoot}/${policy}/scaling_governor`),
                    driver: readObservation(`${policyRoot}/${policy}/scaling_driver`),
                    preference: readObservation(`${policyRoot}/${policy}/energy_performance_preference`) });
            }
        }
        sources = { host: readObservation('/sys/devices/system/cpu/possible'),
            online: readObservation('/sys/devices/system/cpu/online'), allowed,
            cores: observed(cores), ...collectLinuxBoundary(),
            power: policies.length ? observed(policies) : unknown('power policy unavailable') };
        machine = readObservation('/etc/machine-id');
    }
    return buildMachineCpuTopology({ platform: process.platform, arch: process.arch, kernel: os.release(),
        machineIdentityDigest: cpuDigest({ hostname: os.hostname(), machine }), sources });
}
