#!/usr/bin/env node
import {
    defaultTimeoutPolicyDigest,
    qualificationTemporalContext
} from './temporal-context.mjs';
import { resolveTemporalRolesForProducer } from './temporal-role-resolver.mjs';

function parseArguments(argv)
{
    const values = new Map();
    for (let index = 0; index < argv.length; index += 2)
    {
        const key = argv[index];
        const value = argv[index + 1];
        if (!key?.startsWith('--') || value === undefined || value.startsWith('--'))
        {
            throw new Error(`invalid argument near ${key ?? '<end>'}`);
        }
        if (values.has(key))
        {
            throw new Error(`duplicate argument ${key}`);
        }
        values.set(key, value);
    }
    return values;
}

function required(argumentsByName, name)
{
    const value = argumentsByName.get(name)?.trim();
    if (!value)
    {
        throw new Error(`${name} is required`);
    }
    return value;
}

const argumentsByName = parseArguments(process.argv.slice(2));
const allowed = new Set([
    '--business-epoch-utc',
    '--fixture-id',
    '--locale',
    '--namespace',
    '--producer-id',
    '--scheduler-run-id',
    '--source-commit',
    '--source-fingerprint',
    '--ui-locale'
]);
const unknown = [...argumentsByName.keys()].filter((name) => !allowed.has(name));
if (unknown.length > 0)
{
    throw new Error(`unknown arguments: ${unknown.sort().join(', ')}`);
}

const producerId = required(argumentsByName, '--producer-id');
const schedulerRunId = required(argumentsByName, '--scheduler-run-id');
const locale = required(argumentsByName, '--locale');
const temporalContext = qualificationTemporalContext({
    businessEpochUtc: required(argumentsByName, '--business-epoch-utc'),
    locale,
    producerId,
    schedulerRunId,
    sourceCommit: required(argumentsByName, '--source-commit'),
    sourceFingerprint: required(argumentsByName, '--source-fingerprint'),
    timeoutPolicyDigest: defaultTimeoutPolicyDigest(),
    uiLocale: argumentsByName.get('--ui-locale')?.trim() || locale
});
const artifact = resolveTemporalRolesForProducer({
    temporalContext,
    namespace: required(argumentsByName, '--namespace'),
    fixtureId: required(argumentsByName, '--fixture-id')
});
process.stdout.write(`${JSON.stringify(artifact)}\n`);
