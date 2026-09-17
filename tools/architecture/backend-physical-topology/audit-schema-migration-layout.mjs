import { readFileSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';

import { maskCSharp, policyFile, walkCSharp } from './csharp-source.mjs';

function auditLegacyRegistries(root, policy, errors)
{
    const directory = resolve(root, policy.directory);
    const [legacyPrefix, legacySuffix] = policy.legacyRegistryPattern.split('*');
    for (const absolute of walkCSharp(directory))
    {
        const name = basename(absolute);
        const isLegacy = name.startsWith(legacyPrefix) && name.endsWith(legacySuffix);
        if (dirname(absolute) === directory && isLegacy && name !== policy.registry)
        {
            errors.push(`${relative(root, absolute)}: legacy schema registry partial must not exist`);
        }
    }
}

function auditRegistry(root, policy, errors)
{
    const path = `${policy.directory}/${policy.registry}`;
    const registry = policyFile(root, path, errors);
    if (!registry)
    {
        return;
    }
    if (/\bpartial\s+class\s+SchemaMigrationRegistry\b/u.test(registry.code))
    {
        errors.push(`${path}: registry must not be partial`);
    }
    if (/\bnew\s+SchemaMigrationDescriptor\s*\(/u.test(registry.code))
    {
        errors.push(`${path}: registry must not construct descriptors`);
    }
    if (/\bBuild[A-Za-z0-9_]*\b/u.test(registry.code))
    {
        errors.push(`${path}: registry must not contain Build* aggregation`);
    }
}

function auditDefinitions(root, policy, errors)
{
    for (const absolute of walkCSharp(resolve(root, policy.definitionsDirectory)))
    {
        const code = maskCSharp(readFileSync(absolute, 'utf8'));
        if (/\bpartial\s+class\b/u.test(code))
        {
            errors.push(`${relative(root, absolute)}: schema definition must not be partial`);
        }
    }
}

export function auditSchemaMigrationLayout(root, policy, errors)
{
    auditLegacyRegistries(root, policy, errors);
    auditRegistry(root, policy, errors);
    auditDefinitions(root, policy, errors);
}
