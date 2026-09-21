import { createReleaseIdValueContract } from './release-id-value-contract.mjs';

export function createSchemaCompatibilityCoordinateValueContract(contract, releaseIdContract)
{
    const { parseReleaseId } = createReleaseIdValueContract(releaseIdContract);
const legacyPattern = new RegExp(contract.legacyRegex, 'u');

const SCHEMA_COMPATIBILITY_COORDINATE_CONTRACT = Object.freeze({ ...contract });

function parseSchemaCompatibilityCoordinate(value, options = {})
{
    if (value === contract.minimum)
    {
        return Object.freeze({ value, sortKey: value, kind: 'minimum' });
    }
    if (value === contract.maximum)
    {
        return Object.freeze({ value, sortKey: value, kind: 'maximum' });
    }
    if (parseReleaseId(value))
    {
        return Object.freeze({ value, sortKey: value, kind: 'release' });
    }
    if (options.allowLegacy === true)
    {
        return parseLegacySchemaCompatibilityCoordinate(value);
    }
    return null;
}

function parseLegacySchemaCompatibilityCoordinate(value)
{
    if (value === contract.legacyMinimum)
    {
        return parseSchemaCompatibilityCoordinate(contract.minimum);
    }
    if (value === contract.legacyMaximum)
    {
        return parseSchemaCompatibilityCoordinate(contract.maximum);
    }
    if (typeof value !== 'string' || !legacyPattern.test(value) || !isRealLegacyDate(value.slice(0, 8)))
    {
        return null;
    }
    return Object.freeze({
        value,
        sortKey: `${value.slice(0, 8)}000000-000000000000~legacy~${value.slice(9)}`,
        kind: 'legacy'
    });
}

function compareSchemaCompatibilityCoordinates(left, right, options = {})
{
    const leftParsed = parseSchemaCompatibilityCoordinate(left, options);
    const rightParsed = parseSchemaCompatibilityCoordinate(right, options);
    if (!leftParsed || !rightParsed)
    {
        throw new Error('schema compatibility coordinate is invalid');
    }
    return leftParsed.sortKey === rightParsed.sortKey ? 0 : leftParsed.sortKey < rightParsed.sortKey ? -1 : 1;
}

function assertSchemaCompatibilityWindow(minimum, maximum)
{
    const min = parseSchemaCompatibilityCoordinate(minimum);
    const max = parseSchemaCompatibilityCoordinate(maximum);
    if (!min || !max)
    {
        throw new Error('schema compatibility window requires canonical coordinates');
    }
    if (compareSchemaCompatibilityCoordinates(minimum, maximum) > 0)
    {
        throw new Error('schema compatibility window is reversed');
    }
    return Object.freeze({ minimumCoordinate: min.value, maximumCoordinate: max.value });
}

function isRealLegacyDate(value)
{
    const year = Number(value.slice(0, 4));
    const month = Number(value.slice(4, 6));
    const day = Number(value.slice(6, 8));
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
}

    return { SCHEMA_COMPATIBILITY_COORDINATE_CONTRACT, parseSchemaCompatibilityCoordinate, parseLegacySchemaCompatibilityCoordinate, compareSchemaCompatibilityCoordinates, assertSchemaCompatibilityWindow };
}
