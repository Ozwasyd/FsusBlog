export function validateReleaseIdContractValue(value)
{
    const expected = {
        schema: 'fsusblog.release-id-contract.v1',
        regex: '^[0-9]{14}-[0-9a-f]{12}$',
        localSentinel: 'local-unversioned',
        timestampFormat: 'yyyyMMddHHmmss',
        timestampDigits: 14,
        shaDigits: 12
    };
    if (!isPlainObject(value) || Object.keys(expected).some(key => value[key] !== expected[key]))
    {
        throw new Error('release-id-contract.json does not match the v1 authority');
    }
    return value;
}


export function createReleaseIdValueContract(value)
{
    const contract = validateReleaseIdContractValue(value);
const releaseIdRegex = new RegExp(contract.regex, 'u');
const fullCommitRegex = /^[0-9a-f]{40}$/u;
const semverRegex = /^v?[0-9]+[.][0-9]+[.][0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u;
const mutableAliases = new Set(['latest', 'current', 'final-current', 'stable', 'production']);

const RELEASE_ID_CONTRACT = Object.freeze({ ...contract });
const RELEASE_ID_REGEX = releaseIdRegex;
const LOCAL_RELEASE_ID = contract.localSentinel;

function createReleaseId(timestampOrOptions, commitShaArgument)
{
    const options = isPlainObject(timestampOrOptions) ? timestampOrOptions : {
    createdAtUtc: timestampOrOptions,
    commitSha: commitShaArgument
  };
    const commitSha = String(options.commitSha ?? '').trim();
    if (!fullCommitRegex.test(commitSha))
    {
        throw new Error('commitSha must be a lowercase 40-character Git SHA');
    }
    const createdAtUtc = toValidDate(options.createdAtUtc ?? options.timestamp ?? options.date);
    if (!createdAtUtc)
    {
        throw new Error('createdAtUtc must be a real UTC timestamp');
    }
    return `${formatUtcTimestamp(createdAtUtc)}-${commitSha.slice(0, contract.shaDigits)}`;
}

function createReleaseIdentitySnapshot(options = {})
{
    const commitSha = String(options.commitSha ?? '').trim();
    if (!fullCommitRegex.test(commitSha))
    {
        throw new Error('commitSha must be a lowercase 40-character Git SHA');
    }
    const createdAtUtc = toValidDate(options.createdAtUtc ?? new Date());
    if (!createdAtUtc)
    {
        throw new Error('createdAtUtc must be a real UTC timestamp');
    }
    const canonicalCreatedAtUtc = createdAtUtc.toISOString().replace(/[.]000Z$/u, 'Z');
    return Object.freeze({
        releaseId: createReleaseId(canonicalCreatedAtUtc, commitSha),
        createdAtUtc: canonicalCreatedAtUtc,
        commitSha
    });
}

function parseReleaseId(value)
{
    if (typeof value !== 'string' || !releaseIdRegex.test(value))
    {
        return null;
    }
    const timestamp = value.slice(0, contract.timestampDigits);
    const createdAtUtc = parseCompactUtcTimestamp(timestamp);
    if (!createdAtUtc)
    {
        return null;
    }
    return Object.freeze({
        releaseId: value,
        timestamp,
        createdAtUtc: createdAtUtc.toISOString(),
        commitShaPrefix: value.slice(contract.timestampDigits + 1)
    });
}

function validateReleaseId(value, options = {})
{
    const errors = [];
    if (typeof value !== 'string' || value.length === 0)
    {
        return ['releaseId is required'];
    }
    if (value === contract.localSentinel)
    {
        if (options.allowLocalSentinel === true && options.forPublication !== true)
        {
            return errors;
        }
        return ['releaseId local sentinel cannot identify a published release'];
    }
    if (mutableAliases.has(value.toLowerCase()))
    {
        errors.push('releaseId must not be a mutable alias');
    }
    if (semverRegex.test(value))
    {
        errors.push('releaseId must not be a SemVer alias');
    }
    if (!releaseIdRegex.test(value))
    {
        errors.push(`releaseId must match ${contract.regex}`);
    }
    else if (!parseReleaseId(value))
    {
        errors.push('releaseId timestamp must be a real UTC calendar time');
    }
    return errors;
}

function isValidReleaseId(value, options = {})
{
    return validateReleaseId(value, options).length === 0;
}

function assertReleaseIdentity(identityOrReleaseId, options = {})
{
    const identity = isPlainObject(identityOrReleaseId)
        ? identityOrReleaseId
        : { releaseId: identityOrReleaseId, ...options };
    const validationOptions = isPlainObject(identityOrReleaseId) ? options : {};
    const errors = validateReleaseId(identity.releaseId, {
        allowLocalSentinel: validationOptions.allowLocalSentinel,
        forPublication: validationOptions.forPublication !== false
    });
    const parsed = parseReleaseId(identity.releaseId);
    const commitSha = String(identity.commitSha ?? '');
    if (!fullCommitRegex.test(commitSha))
    {
        errors.push('commitSha must be a lowercase 40-character Git SHA');
    }
    else if (parsed && !commitSha.startsWith(parsed.commitShaPrefix))
    {
        errors.push('releaseId commit prefix does not match commitSha');
    }
    const createdAtUtc = toValidIsoUtcDate(identity.createdAtUtc);
    if (!createdAtUtc)
    {
        errors.push('createdAtUtc must be an ISO UTC timestamp');
    }
    else if (parsed && Math.trunc(createdAtUtc.getTime() / 1000) !== Date.parse(parsed.createdAtUtc) / 1000)
    {
        errors.push('releaseId timestamp does not match createdAtUtc');
    }
    if (errors.length > 0)
    {
        throw new Error(errors.join('\n'));
    }
    return parsed;
}

function compareReleaseIds(left, right)
{
    const leftParsed = parseReleaseId(left);
    const rightParsed = parseReleaseId(right);
    if (!leftParsed)
    {
        throw new Error('left releaseId is invalid');
    }
    if (!rightParsed)
    {
        throw new Error('right releaseId is invalid');
    }
    return left === right ? 0 : left < right ? -1 : 1;
}

function parseCompactUtcTimestamp(value)
{
    const date = toValidDate(
        `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
      + `T${value.slice(8, 10)}:${value.slice(10, 12)}:${value.slice(12, 14)}Z`
    );
    if (!date)
    {
        return null;
    }
    return formatUtcTimestamp(date) === value ? date : null;
}

function formatUtcTimestamp(value)
{
    return [
        value.getUTCFullYear().toString().padStart(4, '0'),
        (value.getUTCMonth() + 1).toString().padStart(2, '0'),
        value.getUTCDate().toString().padStart(2, '0'),
        value.getUTCHours().toString().padStart(2, '0'),
        value.getUTCMinutes().toString().padStart(2, '0'),
        value.getUTCSeconds().toString().padStart(2, '0')
    ].join('');
}

function toValidDate(value)
{
    if (value instanceof Date)
    {
        return Number.isFinite(value.getTime()) ? new Date(value.getTime()) : null;
    }
    if (typeof value !== 'string')
    {
        return null;
    }
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:[.](\d{1,9}))?Z$/u.exec(value);
    if (!match || match[1] === '0000')
    {
        return null;
    }
    const date = new Date(value);
    if (!Number.isFinite(date.getTime()))
    {
        return null;
    }
    const actual = [
        date.getUTCFullYear().toString().padStart(4, '0'),
        (date.getUTCMonth() + 1).toString().padStart(2, '0'),
        date.getUTCDate().toString().padStart(2, '0'),
        date.getUTCHours().toString().padStart(2, '0'),
        date.getUTCMinutes().toString().padStart(2, '0'),
        date.getUTCSeconds().toString().padStart(2, '0')
    ];
    return actual.every((part, index) => part === match[index + 1]) ? date : null;
}

function toValidIsoUtcDate(value)
{
    return toValidDate(value);
}

    return { RELEASE_ID_CONTRACT, RELEASE_ID_REGEX, LOCAL_RELEASE_ID, createReleaseId, createReleaseIdentitySnapshot, parseReleaseId, validateReleaseId, isValidReleaseId, assertReleaseIdentity, compareReleaseIds };
}

function isPlainObject(value)
{
    return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
}
