import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sharedHostScripts = new Set(['check:font-size-contract', 'check:font-weight-contract']);

function sha256(value)
{
    return crypto.createHash('sha256').update(value).digest('hex');
}

function compareOrdinal(left, right)
{
    return left < right ? -1 : left > right ? 1 : 0;
}

function matrixCommands(repoRoot)
{
    const matrixPath = path.join(repoRoot, 'tests/matrix.yml');
    if (!fs.existsSync(matrixPath))
    {
        return [];
    }
    const source = fs.readFileSync(matrixPath, 'utf8');
    const start = source.indexOf('    frontend-static-governance:');
    const end = source.indexOf('    frontend-runtime-contracts:', start);
    if (start < 0 || end < 0)
    {
        throw new Error('frontend static command group cannot be located');
    }
    const group = source.slice(start, end);
    const entries = [];
    const pattern = /\{id:\s*"(?<id>[^"]+)",\s*(?:script:\s*"(?<script>[^"]+)"|command:\s*\[(?<command>[^\]]+)\]),\s*access:\s*"(?<access>read|write)"[^}]*?consumedInputs:\s*\[(?<inputs>[^\]]*)\]/gu;
    for (const match of group.matchAll(pattern))
    {
        entries.push({
            id: match.groups.id,
            command: match.groups.script
                ? `npm run ${match.groups.script}`
                : [...match.groups.command.matchAll(/"([^"]+)"/gu)].map((entry) => entry[1]).join(' '),
            access: match.groups.access,
            consumedInputs: [...match.groups.inputs.matchAll(/"([^"]+)"/gu)].map((entry) => entry[1])
        });
    }
    return entries;
}

function ownerFor(id, command, matrixEntry = null)
{
    if (sharedHostScripts.has(id))
    {
        return {
            owner: 'shared-host',
            ownerId: 'frontend-source-rule-host',
            reason: 'Migrated source-bound rule consumes the canonical in-memory frontend source index.'
        };
    }
    if (matrixEntry?.access === 'write' || /(?:^|:)(?:writer|generate)(?:$|:)/u.test(id))
    {
        return {
            owner: 'isolated-writer',
            ownerId: matrixEntry?.id ?? id,
            reason: 'Writes evidence, cache, dist, or generated output and remains process-isolated.'
        };
    }
    if (matrixEntry?.consumedInputs?.some((value) => /fixture|os-temp/u.test(value))
    || /fixture/u.test(id)
    || /(?:node\s+--test|vitest|playwright)/u.test(command))
    {
        return {
            owner: 'isolated-fixture',
            ownerId: matrixEntry?.id ?? id,
            reason: 'Exercises fixtures or real runner behavior and remains process-isolated.'
        };
    }
    return {
        owner: 'retained-process',
        ownerId: matrixEntry?.id ?? id,
        reason: 'Not migrated in this source-index slice; its existing fail-closed process remains authoritative.'
    };
}

export function buildFrontendStaticOwnerRegistry({ repoRoot = moduleRoot } = {})
{
    const packagePath = path.join(repoRoot, 'src/frontend/package.json');
    const packageDocument = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    const packageChecks = Object.entries(packageDocument.scripts ?? {})
        .filter(([id]) => id.startsWith('check:'))
        .sort(([left], [right]) => compareOrdinal(left, right));
    const activeMatrix = matrixCommands(repoRoot);
    const commands = (activeMatrix.length > 0
        ? activeMatrix
            .filter(({ id }) => id !== 'frontend-source-rule-host')
            .concat([
                {
                    id: 'font-size-contract',
                    command: 'node ../../tests/frontend/checks/static/check-font-size-contract.mjs',
                    access: 'read',
                    consumedInputs: ['src/frontend/src', 'src/frontend/public/public-shell-emergency.css', 'docs/design/reading-typography.md']
                },
                {
                    id: 'font-weight-contract',
                    command: 'node ../../tests/frontend/checks/static/check-font-weight-contract.mjs',
                    access: 'read',
                    consumedInputs: ['src/frontend/src', 'docs/design/reading-typography.md']
                }
            ])
            .map((entry) => ({ ...entry, ...ownerFor(`check:${entry.id}`, entry.command, entry) }))
        : packageChecks.map(([id, command]) => ({ id, command, ...ownerFor(id, command) })))
        .sort((left, right) => compareOrdinal(left.id, right.id));
    const count = (owner) => commands.filter((entry) => entry.owner === owner).length;
    return {
        schema: 'fsusblog.frontend-static-owner-registry.v1',
        source: activeMatrix.length > 0
            ? 'tests/matrix.yml#commandGroups.frontend-static-governance@pre-migration'
            : 'src/frontend/package.json#scripts[check:*]',
        identity: {
            idsSha256: sha256(commands.map(({ id }) => id).join('\n')),
            definitionsSha256: sha256(commands.map(({ id, command }) => `${id}=${command}`).join('\n')),
            registrySha256: sha256(commands.map(({ id, owner, ownerId }) => `${id}=${owner}:${ownerId}`).join('\n'))
        },
        specializedGovernance: {
            package: 'src/frontend/package.json',
            commandCount: packageChecks.length,
            idsSha256: sha256(packageChecks.map(([id]) => id).join('\n')),
            definitionsSha256: sha256(packageChecks.map(([id, command]) => `${id}=${command}`).join('\n'))
        },
        summary: {
            commandCount: commands.length,
            sharedHost: count('shared-host'),
            isolatedWriter: count('isolated-writer'),
            isolatedFixture: count('isolated-fixture'),
            retainedProcess: count('retained-process')
        },
        commands
    };
}

export function validateFrontendStaticOwnerRegistry(registry)
{
    const errors = [];
    if (registry?.schema !== 'fsusblog.frontend-static-owner-registry.v1')
    {
        errors.push('frontend static owner registry schema is invalid');
    }
    if (!Array.isArray(registry?.commands) || registry.commands.length === 0)
    {
        errors.push('frontend static owner registry commands are missing');
        return errors;
    }
    const ids = registry.commands.map(({ id }) => id);
    if (new Set(ids).size !== ids.length)
    {
        errors.push('frontend static owner registry contains duplicate command IDs');
    }
    if (registry.summary?.commandCount !== ids.length)
    {
        errors.push('frontend static owner registry command count mismatch');
    }
    const summaryTotal = ['sharedHost', 'isolatedWriter', 'isolatedFixture', 'retainedProcess']
        .reduce((sum, field) => sum + Number(registry.summary?.[field] ?? 0), 0);
    if (summaryTotal !== ids.length)
    {
        errors.push('frontend static owner registry owner totals do not cover all commands');
    }
    for (const command of registry.commands)
    {
        if (!['shared-host', 'isolated-writer', 'isolated-fixture', 'retained-process'].includes(command.owner)
      || typeof command.ownerId !== 'string' || !command.ownerId
      || typeof command.reason !== 'string' || !command.reason)
        {
            errors.push(`${command.id}: frontend static owner assignment is invalid`);
        }
    }
    return errors;
}
