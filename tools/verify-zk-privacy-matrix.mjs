#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseYamlDocument } from './yaml/parse-document.mjs';

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const negativeInvariantIdPattern = /^tamper-[a-z0-9]+(?:-[a-z0-9]+)*$/u;

const failures = [];

function parseArgs(argv)
{
    const parsed = {};
    for (let index = 0; index < argv.length; index += 1)
    {
        const arg = argv[index];
        if (arg === '--matrix' || arg === '--tamper')
        {
            const value = argv[index + 1];
            if (!value)
            {
                throw new Error(`${arg} requires a path`);
            }
            parsed[arg.slice(2)] = value;
            index += 1;
            continue;
        }
        throw new Error(`unknown argument ${arg}`);
    }
    return parsed;
}

function resolvePath(value)
{
    return path.isAbsolute(value) ? value : path.join(root, value);
}

function relative(file)
{
    const rel = path.relative(root, file);
    return rel.startsWith('..') ? file : rel.replaceAll(path.sep, '/');
}

function fail(message)
{
    failures.push(`[zk-privacy-matrix] ${message}`);
}

function readText(file)
{
    if (!fs.existsSync(file))
    {
        fail(`missing file ${relative(file)}`);
        return '';
    }
    return fs.readFileSync(file, 'utf8');
}

function readJson(file)
{
    const text = readText(file);
    if (!text)
    {
        return {};
    }
    try
    {
        return JSON.parse(text);
    }
    catch (error)
    {
        fail(`invalid JSON ${relative(file)}: ${error.message}`);
        return {};
    }
}

function extractMatrixRequiredCases(yaml)
{
    const document = parseYamlDocument(yaml, { source: 'privacy ZK matrix' });
    const scenarios = Array.isArray(document.scenarios) ? document.scenarios : [];
    const required = new Set();
    for (const scenario of scenarios)
    {
        if (scenario?.id !== 'PRIVACY-ZK-CIRCUIT-CONTRACT')
        {
            continue;
        }
        for (const item of Array.isArray(scenario?.requiredCases) ? scenario.requiredCases : [])
        {
            const id = String(item).trim();
            if (negativeInvariantIdPattern.test(id))
            {
                required.add(id);
            }
        }
    }
    return [...required];
}

function asArray(value)
{
    return Array.isArray(value) ? value : [];
}

function main()
{
    const args = parseArgs(process.argv.slice(2));
    const matrixPath = resolvePath(args.matrix ?? 'security/matrices/privacy-zk-comment.yml');
    const tamperPath = resolvePath(args.tamper ?? 'security/zk/contracts/comment-v5-tamper-cases.manifest.json');
    let matrixText = readText(matrixPath);
    const tamper = readJson(tamperPath);
    if (!matrixText.endsWith('\n'))
    {
        matrixText = `${matrixText}\n`;
    }

    const requiredNegativeInvariants = extractMatrixRequiredCases(matrixText);
    if (requiredNegativeInvariants.length === 0)
    {
        fail(`${relative(matrixPath)} declares no required negative invariant cases`);
    }

    const tamperCases = new Map(
        asArray(tamper.tamper_cases)
            .filter((entry) => typeof entry?.id === 'string')
            .map((entry) => [entry.id, entry])
    );
    for (const id of requiredNegativeInvariants)
    {
        const tamperCase = tamperCases.get(id);
        if (!tamperCase)
        {
            fail(`${relative(tamperPath)} missing tamper case ${id}`);
            continue;
        }
        if (tamperCase.expected !== 'reject')
        {
            fail(`tamper case ${id} must expect reject`);
        }
    }

    if (failures.length > 0)
    {
        console.error(failures.join('\n'));
        process.exit(1);
    }

    console.log(`[zk-privacy-matrix] ok: ${requiredNegativeInvariants.length} required negative invariant case(s) verified`);
}

try
{
    main();
}
catch (error)
{
    console.error(`[zk-privacy-matrix] ${error.message}`);
    process.exit(1);
}
