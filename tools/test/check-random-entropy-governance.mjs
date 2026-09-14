#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRandomStreamInventory } from './random-streams.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const forbidden = [
    { id: 'wall-clock', pattern: /(?:Date\.now\(\)|new Date\(\)\.getTime\(\)|Environment\.TickCount)/gu },
    { id: 'uuid', pattern: /(?:randomUUID\(\)|Guid\.NewGuid\(\))/gu },
    { id: 'pid', pattern: /(?:process\.pid|Environment\.ProcessId)/gu },
    { id: 'os-entropy', pattern: /(?:randomBytes\(|RandomNumberGenerator\.|crypto\.getRandomValues\()/gu },
    { id: 'framework-default', pattern: /(?:Math\.random\(\)|Random\.Shared|new Random\(\))/gu }
];

export function scanRandomEntropy({ repositoryRoot = root, inventory = loadRandomStreamInventory(), sources = null } = {})
{
    const nonSemantic = new Map();
    for (const entry of inventory.nonSemanticEntropy)
    {
        if (entry.semanticDigestExcluded !== true)
        {
            throw new Error(`nonsemantic entropy declaration ${entry.entrypoint} is not excluded from semantic digest`);
        }
        const list = nonSemantic.get(entry.entrypoint) ?? [];
        list.push(entry.sourceAnchor);
        nonSemantic.set(entry.entrypoint, list);
    }
    const entrypoints = new Set(inventory.consumers.map((consumer) => consumer.entrypoint));
    const violations = [];
    for (const entrypoint of [...entrypoints].sort())
    {
        const source = sources?.get(entrypoint) ?? readFileSync(path.join(repositoryRoot, entrypoint), 'utf8');
        const scrubbed = (nonSemantic.get(entrypoint) ?? []).reduce((value, anchor) => value.replace(anchor, ''), source);
        for (const rule of forbidden)
        {
            for (const match of scrubbed.matchAll(rule.pattern))
            {
                violations.push({
                    entrypoint,
                    rule: rule.id,
                    offset: match.index,
                    token: match[0]
                });
            }
        }
    }
    return violations;
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href)
{
    const violations = scanRandomEntropy();
    if (violations.length > 0)
    {
        for (const violation of violations)
        {
            process.stderr.write(`${violation.entrypoint}:${violation.offset}: ${violation.rule} entropy ${violation.token}\n`);
        }
        process.exitCode = 1;
    }
    else
    {
        process.stdout.write('random entropy governance: 0 violations\n');
    }
}
