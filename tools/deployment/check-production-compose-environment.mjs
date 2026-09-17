#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const productionComposeEnvironmentSchema = 'fsusblog.production-compose-environment.v1';

const modulePath = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(modulePath), '../..');
const defaultContract = 'config/deployment/production-compose-environment.json';
const namePattern = /^[A-Z][A-Z0-9_]*$/u;
const interpolationPattern = /\$\{(?<name>[A-Z][A-Z0-9_]*)(?:(?<operator>:-|:\?|-|\?)(?<operand>[^}]*))?\}/gu;
const requirementKinds = new Set(['defaulted', 'must-set-at-deploy', 'optional-empty']);
const sourceKinds = new Set(['compose-default', 'operator-env', 'release-pipeline']);

function exactKeys(value, expected, label, errors)
{
    if (value === null || typeof value !== 'object' || Array.isArray(value))
    {
        errors.push(`${label} must be an object`);
        return;
    }
    const actual = Object.keys(value).sort();
    const required = [...expected].sort();
    if (JSON.stringify(actual) !== JSON.stringify(required))
    {
        errors.push(`${label} fields must be exactly ${required.join(', ')}`);
    }
}

function readJson(file, label, errors)
{
    try
    {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    catch (error)
    {
        errors.push(`${label} is missing or invalid: ${error instanceof Error ? error.message : String(error)}`);
        return {};
    }
}

export function parseComposeInterpolations(source)
{
    const variables = new Map();
    for (const match of source.matchAll(interpolationPattern))
    {
        const name = match.groups.name;
        const occurrence = {
            operator: match.groups.operator ?? '',
            operand: match.groups.operand ?? ''
        };
        const existing = variables.get(name) ?? [];
        existing.push(occurrence);
        variables.set(name, existing);
    }
    return variables;
}

function observedRequirement(occurrences, name, errors)
{
    const defaults = occurrences.filter((item) => item.operator === ':-' || item.operator === '-');
    const required = occurrences.filter((item) => item.operator === '' || item.operator === ':?' || item.operator === '?');
    if (defaults.length > 0 && required.length > 0)
    {
        errors.push(`${name} mixes defaulted and deploy-required interpolation`);
        return null;
    }
    if (defaults.length === 0)
    {
        return { requirement: 'must-set-at-deploy' };
    }
    const values = [...new Set(defaults.map((item) => item.operand))];
    if (values.length !== 1)
    {
        errors.push(`${name} has conflicting Compose defaults`);
        return null;
    }
    return {
        requirement: values[0] === '' ? 'optional-empty' : 'defaulted',
        defaultValue: values[0]
    };
}

export function parseComposeDurationSeconds(value)
{
    const match = /^(?<amount>[1-9][0-9]*)(?<unit>ms|s|m|h)$/u.exec(String(value ?? ''));
    if (!match)
    {
        throw new Error('Compose duration must be one positive integer with ms, s, m, or h');
    }
    const amount = Number(match.groups.amount);
    const multipliers = { ms: 0.001, s: 1, m: 60, h: 3600 };
    const seconds = amount * multipliers[match.groups.unit];
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600)
    {
        throw new Error('Compose duration must resolve to 1..3600 whole seconds');
    }
    return seconds;
}

export function checkProductionComposeEnvironment({
    root = defaultRoot,
    contractPath = defaultContract
} = {})
{
    const errors = [];
    const repositoryRoot = path.resolve(root);
    const contractFile = path.resolve(repositoryRoot, contractPath);
    const contract = readJson(contractFile, 'production Compose environment contract', errors);
    exactKeys(
        contract,
        ['schema', 'composePath', 'variableCount', 'variables'],
        'production Compose environment contract',
        errors
    );
    if (contract.schema !== productionComposeEnvironmentSchema)
    {
        errors.push(`contract schema must be ${productionComposeEnvironmentSchema}`);
    }
    if (typeof contract.composePath !== 'string'
        || path.posix.isAbsolute(contract.composePath)
        || path.posix.normalize(contract.composePath) !== contract.composePath)
    {
        errors.push('composePath must be one normalized repository-relative path');
    }

    let composeSource = '';
    try
    {
        composeSource = fs.readFileSync(path.resolve(repositoryRoot, contract.composePath), 'utf8');
    }
    catch (error)
    {
        errors.push(`production Compose file is missing: ${error instanceof Error ? error.message : String(error)}`);
    }
    const observed = parseComposeInterpolations(composeSource);
    const variables = contract.variables;
    if (variables === null || typeof variables !== 'object' || Array.isArray(variables))
    {
        errors.push('variables must be an object keyed by Compose variable name');
    }
    const declaredNames = variables && typeof variables === 'object' && !Array.isArray(variables)
        ? Object.keys(variables)
        : [];
    const sortedNames = [...declaredNames].sort();
    if (JSON.stringify(declaredNames) !== JSON.stringify(sortedNames))
    {
        errors.push('variables must be ordered by name');
    }
    if (!Number.isInteger(contract.variableCount)
        || contract.variableCount !== declaredNames.length
        || contract.variableCount !== observed.size)
    {
        errors.push(`variableCount must equal the declared and observed inventory (${declaredNames.length}/${observed.size})`);
    }

    for (const name of new Set([...declaredNames, ...observed.keys()]))
    {
        if (!namePattern.test(name))
        {
            errors.push(`invalid Compose variable name: ${name}`);
            continue;
        }
        const declaration = variables?.[name];
        const occurrences = observed.get(name);
        if (!declaration)
        {
            errors.push(`undocumented Compose variable: ${name}`);
            continue;
        }
        if (!occurrences)
        {
            errors.push(`contract variable is not used by Compose: ${name}`);
            continue;
        }
        const observedContract = observedRequirement(occurrences, name, errors);
        const expectedKeys = declaration.requirement === 'must-set-at-deploy'
            ? ['requirement', 'source', 'expectedValue']
            : ['requirement', 'source', 'defaultValue', 'expectedValue'];
        exactKeys(declaration, expectedKeys, `variables.${name}`, errors);
        if (!requirementKinds.has(declaration.requirement))
        {
            errors.push(`variables.${name}.requirement is invalid`);
        }
        if (!sourceKinds.has(declaration.source)
            || (declaration.requirement !== 'must-set-at-deploy'
                && declaration.source !== 'compose-default')
            || (declaration.requirement === 'must-set-at-deploy'
                && declaration.source === 'compose-default'))
        {
            errors.push(`variables.${name}.source does not match its requirement`);
        }
        if (typeof declaration.expectedValue !== 'string' || !declaration.expectedValue.trim())
        {
            errors.push(`variables.${name}.expectedValue must document the deployable value`);
        }
        if (observedContract
            && (declaration.requirement !== observedContract.requirement
                || (observedContract.requirement !== 'must-set-at-deploy'
                    && declaration.defaultValue !== observedContract.defaultValue)))
        {
            errors.push(`variables.${name} does not match its Compose interpolation contract`);
        }
    }

    let stopGracePeriodSeconds = null;
    const stopGrace = variables?.FSUSBLOG_STOP_GRACE_PERIOD;
    try
    {
        stopGracePeriodSeconds = parseComposeDurationSeconds(stopGrace?.defaultValue);
    }
    catch (error)
    {
        errors.push(`FSUSBLOG_STOP_GRACE_PERIOD is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {
        errors,
        variableCount: observed.size,
        stopGracePeriodSeconds
    };
}

function main()
{
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && args[0] !== '--print-stop-grace-seconds'))
    {
        throw new Error('usage: check-production-compose-environment.mjs [--print-stop-grace-seconds]');
    }
    const report = checkProductionComposeEnvironment();
    if (report.errors.length > 0)
    {
        for (const error of report.errors)
        {
            process.stderr.write(`[production-compose-environment] ${error}\n`);
        }
        process.exitCode = 1;
        return;
    }
    if (args[0] === '--print-stop-grace-seconds')
    {
        process.stdout.write(`${report.stopGracePeriodSeconds}\n`);
        return;
    }
    process.stdout.write(
        `[production-compose-environment] ok variables=${report.variableCount} stopGraceSeconds=${report.stopGracePeriodSeconds}\n`
    );
}

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath)
{
    try
    {
        main();
    }
    catch (error)
    {
        process.stderr.write(`[production-compose-environment] fatal: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}
