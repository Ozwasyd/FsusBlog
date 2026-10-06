import { createHash } from 'node:crypto';
import path from 'node:path';

const unsigned = /^(?:0|[1-9][0-9]*)$/u;
const signed = /^(?:0|-?[1-9][0-9]*)$/u;
const uint64Max = (1n << 64n) - 1n;
const int64Min = -(1n << 63n);
const int64Max = (1n << 63n) - 1n;
const leafFields = ['deviceMajor', 'deviceMinor', 'inode', 'mode', 'links', 'uid', 'gid', 'size',
    'modifiedSeconds', 'modifiedNanoseconds', 'changedSeconds', 'changedNanoseconds'];
const directoryFields = ['deviceMajor', 'deviceMinor', 'inode', 'mode'];

function exact(value, fields)
{
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).sort().join(',') !== [...fields].sort().join(','))
    {
        throw new Error('original file epoch requires its exact comparison-data fields');
    }
}

function integer(value, minimum, maximum)
{
    if (typeof value !== 'string' || !(minimum < 0n ? signed : unsigned).test(value))
    {
        throw new Error('original file epoch requires canonical decimal strings');
    }
    const number = BigInt(value);
    if (number < minimum || number > maximum)
    {
        throw new Error('original file epoch comparison field is out of range');
    }
    return value;
}

function row(value, fields)
{
    exact(value, fields);
    return fields.map((field) =>
    {
        if (field.endsWith('Seconds')) return integer(value[field], int64Min, int64Max);
        if (field.endsWith('Nanoseconds')) return integer(value[field], 0n, 999999999n);
        if (field === 'mode') return integer(value[field], 0n, 65535n);
        if (['deviceMajor', 'deviceMinor', 'links', 'uid', 'gid'].includes(field))
            return integer(value[field], 0n, 4294967295n);
        return integer(value[field], 0n, uint64Max);
    }).join(':');
}

// Pure comparison data only. This encoder never constructs a native identity,
// input lease, scheduler grant, signed invocation or parent terminal.
export function encodeOriginalFileEpochObservation(observation)
{
    exact(observation, ['path', 'leaf', 'ancestors']);
    if (typeof observation.path !== 'string' || !observation.path.startsWith('/')
        || path.posix.normalize(observation.path) !== observation.path
        || observation.path.endsWith('/') || Buffer.byteLength(observation.path, 'utf8') > 4095
        || /[\p{Cc}\p{Cs}]/u.test(observation.path)
        || !Array.isArray(observation.ancestors)
        || observation.ancestors.length !== observation.path.split('/').filter(Boolean).length)
    {
        throw new Error('original file epoch requires an absolute path and ordered ancestors');
    }
    const prefix = `fsus-original-file-epoch-v1\npath:${Buffer.byteLength(observation.path, 'utf8')}:${observation.path}\n`;
    const leaf = `leaf:${row(observation.leaf, leafFields)}\nancestors:${observation.ancestors.length}\n`;
    return Buffer.from(prefix + leaf + observation.ancestors.map((directory) =>
        `ancestor:${row(directory, directoryFields)}\n`).join(''), 'utf8');
}

export function originalFileEpochObservationSha256(observation)
{
    return createHash('sha256').update(encodeOriginalFileEpochObservation(observation)).digest('hex');
}

// Linux gnu_dev_major/gnu_dev_minor projection, with the full unsigned dev_t.
export function originalLinuxDeviceNumbers(device)
{
    if (typeof device !== 'bigint' || device < 0n || device > uint64Max)
        throw new Error('original Linux device requires unsigned uint64 bigint');
    return {
        deviceMajor: (((device & 0x00000000000fff00n) >> 8n)
            | ((device & 0xfffff00000000000n) >> 32n)).toString(),
        deviceMinor: ((device & 0x00000000000000ffn)
            | ((device & 0x00000ffffff00000n) >> 12n)).toString()
    };
}

export function originalLinuxTimestampParts(totalNanoseconds)
{
    if (typeof totalNanoseconds !== 'bigint')
        throw new Error('original Linux timestamp requires bigint nanoseconds');
    let seconds = totalNanoseconds / 1000000000n;
    let nanoseconds = totalNanoseconds % 1000000000n;
    if (nanoseconds < 0n)
    {
        seconds -= 1n;
        nanoseconds += 1000000000n;
    }
    integer(seconds.toString(), int64Min, int64Max);
    return { seconds: seconds.toString(), nanoseconds: nanoseconds.toString() };
}
