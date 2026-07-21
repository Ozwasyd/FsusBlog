#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const contractPath = path.join(root, 'src/shared/Contracts/Validation/release-id-contract.json');
const contract = loadContract();
const releaseIdRegex = new RegExp(contract.regex, 'u');
const fullCommitRegex = /^[0-9a-f]{40}$/u;
const semverRegex = /^v?[0-9]+[.][0-9]+[.][0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u;
const mutableAliases = new Set(['latest', 'current', 'final-current', 'stable', 'production']);

export const RELEASE_ID_CONTRACT = Object.freeze({ ...contract });
export const RELEASE_ID_REGEX = releaseIdRegex;
export const LOCAL_RELEASE_ID = contract.localSentinel;

export function createReleaseId(timestampOrOptions, commitShaArgument)
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

export function createReleaseIdentitySnapshot(options = {})
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

export function parseReleaseId(value)
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

export function validateReleaseId(value, options = {})
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

export function isValidReleaseId(value, options = {})
{
    return validateReleaseId(value, options).length === 0;
}

export function assertReleaseIdentity(identityOrReleaseId, options = {})
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

export function compareReleaseIds(left, right)
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

export const parse = parseReleaseId;
export const validate = validateReleaseId;
export const compare = compareReleaseIds;

export function renderGeneratedContracts()
{
    return [
        {
            path: 'src/backend/Infrastructure/Operations/ReleaseIdContract.Generated.cs',
            content: renderCSharpContract()
        },
        {
            path: 'src/frontend/src/generated/releaseIdContract.ts',
            content: renderTypeScriptContract()
        },
        {
            path: 'src/frontend/public/generated/release-id-contract.js',
            content: renderClassicServiceWorkerContract()
        }
    ];
}

function renderCSharpContract()
{
    return `// <auto-generated />
#nullable enable
using System.Globalization;
using System.Text.RegularExpressions;

namespace FsusBlog.Server.Infrastructure.Operations;

internal static class ReleaseIdContract
{
    internal const string Schema = "${contract.schema}";
    internal const string Pattern = "${contract.regex}";
    internal const string LocalSentinel = "${contract.localSentinel}";
    internal const string TimestampFormat = "${contract.timestampFormat}";
    internal const int TimestampDigits = ${contract.timestampDigits};
    internal const int ShaDigits = ${contract.shaDigits};

    internal static bool TryParse(
        string? releaseId,
        out DateTimeOffset createdAtUtc,
        out string commitShaPrefix)
    {
        createdAtUtc = default;
        commitShaPrefix = string.Empty;
        if (string.IsNullOrWhiteSpace(releaseId) || !Regex.IsMatch(releaseId, Pattern))
        {
            return false;
        }

        if (!DateTimeOffset.TryParseExact(
                releaseId.AsSpan(0, TimestampDigits),
                TimestampFormat,
                CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal,
                out createdAtUtc))
        {
            return false;
        }

        commitShaPrefix = releaseId[(TimestampDigits + 1)..];
        return true;
    }

    internal static bool TryParseCreatedAtUtc(string? value, out DateTimeOffset createdAtUtc)
    {
        createdAtUtc = default;
        if (string.IsNullOrWhiteSpace(value) ||
            !Regex.IsMatch(value, "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:[.][0-9]{1,7})?Z$"))
        {
            return false;
        }

        return DateTimeOffset.TryParseExact(
            value,
            ["yyyy-MM-dd'T'HH:mm:ss'Z'", "yyyy-MM-dd'T'HH:mm:ss.FFFFFFF'Z'"],
            CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal,
            out createdAtUtc);
    }
}
`;
}

function renderTypeScriptContract()
{
    return `// <auto-generated />
export const RELEASE_ID_CONTRACT_SCHEMA = '${contract.schema}'
export const RELEASE_ID_PATTERN = /${contract.regex}/u
export const LOCAL_UNVERSIONED_RELEASE_ID = '${contract.localSentinel}'

export interface ParsedReleaseId {
  releaseId: string
  createdAtUtc: string
  commitShaPrefix: string
}

export function parseReleaseId(value: string): ParsedReleaseId | null {
  if (!RELEASE_ID_PATTERN.test(value)) return null
  const timestamp = value.slice(0, ${contract.timestampDigits})
  const year = Number(timestamp.slice(0, 4))
  const month = Number(timestamp.slice(4, 6))
  const day = Number(timestamp.slice(6, 8))
  const hour = Number(timestamp.slice(8, 10))
  const minute = Number(timestamp.slice(10, 12))
  const second = Number(timestamp.slice(12, 14))
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second))
  const canonical = date.toISOString().replace(/[-:]/gu, '').replace('T', '').slice(0, ${contract.timestampDigits})
  if (canonical !== timestamp) return null
  return {
    releaseId: value,
    createdAtUtc: date.toISOString().replace('.000Z', 'Z'),
    commitShaPrefix: value.slice(${contract.timestampDigits + 1})
  }
}

export function isCanonicalReleaseId(value: string): boolean {
  return parseReleaseId(value) !== null
}
`;
}

function renderClassicServiceWorkerContract()
{
    return `// <auto-generated />
;(function installReleaseIdContract(scope) {
  const releaseIdPattern = /${contract.regex.slice(1, -1)}/

  function isCanonicalReleaseId(value) {
    if (typeof value !== 'string' || !releaseIdPattern.test(value)) return false
    const timestamp = value.slice(0, ${contract.timestampDigits})
    const year = Number(timestamp.slice(0, 4))
    const month = Number(timestamp.slice(4, 6))
    const day = Number(timestamp.slice(6, 8))
    const hour = Number(timestamp.slice(8, 10))
    const minute = Number(timestamp.slice(10, 12))
    const second = Number(timestamp.slice(12, 14))
    const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second))
    const canonical = date.toISOString().replace(/[-:]/g, '').replace('T', '').slice(0, ${contract.timestampDigits})
    return canonical === timestamp
  }

  scope.FsusReleaseIdContract = Object.freeze({ isCanonicalReleaseId })
})(self)
`;
}

function loadContract()
{
    const value = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
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

function isPlainObject(value)
{
    return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
}

function runCli()
{
    const args = process.argv.slice(2);
    const command = args[0];
    if (command === 'create')
    {
        const options = parseCliOptions(args.slice(1));
        console.log(createReleaseId(options['created-at-utc'], options['commit-sha']));
        return;
    }
    if (command === 'snapshot')
    {
        const options = parseCliOptions(args.slice(1));
        const snapshot = createReleaseIdentitySnapshot({
            createdAtUtc: options['created-at-utc'],
            commitSha: options['commit-sha']
        });
        if (options.format === 'lines')
        {
            for (const field of ['releaseId', 'createdAtUtc', 'commitSha'])
            {
                console.log(snapshot[field]);
            }
        }
        else
        {
            console.log(JSON.stringify(snapshot));
        }
        return;
    }
    if (command === 'parse')
    {
        requirePositionalCount(args, 2);
        const parsed = parseReleaseId(args[1]);
        if (!parsed)
        {
            throw new Error('releaseId is invalid');
        }
        console.log(JSON.stringify(parsed));
        return;
    }
    if (command === 'validate')
    {
        requirePositionalCount(args, 2);
        const errors = validateReleaseId(args[1], { forPublication: true });
        if (errors.length > 0)
        {
            throw new Error(errors.join('\n'));
        }
        console.log(args[1]);
        return;
    }
    if (command === 'assert')
    {
        const options = parseCliOptions(args.slice(1));
        const parsed = assertReleaseIdentity({
            releaseId: options['release-id'],
            createdAtUtc: options['created-at-utc'],
            commitSha: options['commit-sha']
        });
        console.log(JSON.stringify(parsed));
        return;
    }
    if (command === 'compare')
    {
        requirePositionalCount(args, 3);
        console.log(compareReleaseIds(args[1], args[2]));
        return;
    }
    if (args.some(argument => argument !== '--check'))
    {
        throw new Error(cliUsage());
    }
    const check = args.includes('--check');
    for (const generated of renderGeneratedContracts())
    {
        const file = path.join(root, generated.path);
        if (check)
        {
            if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== generated.content)
            {
                throw new Error(`${generated.path} is stale; run node tools/release/release-id.mjs`);
            }
        }
        else
        {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, generated.content);
        }
    }
    console.log(check
        ? '[release-id] generated contracts are in sync'
        : '[release-id] generated cross-language contracts');
}

function parseCliOptions(args)
{
    const options = {};
    for (let index = 0; index < args.length; index += 2)
    {
        const key = args[index];
        const value = args[index + 1];
        if (!key?.startsWith('--') || value === undefined || value.startsWith('--'))
        {
            throw new Error(cliUsage());
        }
        options[key.slice(2)] = value;
    }
    return options;
}

function requirePositionalCount(args, count)
{
    if (args.length !== count)
    {
        throw new Error(cliUsage());
    }
}

function cliUsage()
{
    return 'usage: release-id.mjs [--check] | create --created-at-utc <utc> --commit-sha <sha40> | snapshot --commit-sha <sha40> [--created-at-utc <utc>] [--format lines] | parse <release-id> | validate <release-id> | assert --release-id <id> --created-at-utc <utc> --commit-sha <sha40> | compare <left> <right>';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    try
    {
        runCli();
    }
    catch (error)
    {
        console.error(`[release-id] ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    }
}
