import fs from 'node:fs';
import path from 'node:path';

import { normalizeDeclaration } from './repository-governance-identity.mjs';

export const defaultManifest = 'config/governance/repository-governance-authorities.json';

export function validateAuthorityManifest(manifest)
{
    const errors = [];
    if (manifest?.schema !== 'fsusblog.repository-governance-authorities.v1')
    {
        errors.push('unsupported authority manifest schema');
    }
    const required = new Set([
        'application-static-governance',
        'test-asset-governance',
        'workflow-lint',
        'document-governance',
        'community-governance'
    ]);
    const authorities = Array.isArray(manifest?.authorities) ? manifest.authorities : [];
    const authorityIds = new Set();
    const commandIds = new Set();
    const checkerOwners = new Map();
    const ruleOwners = new Map();
    for (const authority of authorities)
    {
        if (!required.delete(authority?.id))
        {
            errors.push(`unexpected or duplicate authority: ${authority?.id ?? '<missing>'}`);
        }
        authorityIds.add(authority?.id);
        if (typeof authority?.canonicalOwner !== 'string' || !authority.canonicalOwner.trim())
        {
            errors.push(`${authority?.id ?? '<missing>'} canonicalOwner is required`);
        }
        if (!Array.isArray(authority?.inputs) || authority.inputs.length === 0)
        {
            errors.push(`${authority?.id} inputs are required`);
        }
        if (!Array.isArray(authority?.commands) || authority.commands.length === 0)
        {
            errors.push(`${authority?.id} commands are required`);
        }
        if (!Array.isArray(authority?.toolchain?.identityFiles) || authority.toolchain.identityFiles.length === 0)
        {
            errors.push(`${authority?.id} toolchain identityFiles are required`);
        }
        for (const command of authority?.commands ?? [])
        {
            if (!command?.id || commandIds.has(command.id))
            {
                errors.push(`duplicate or missing governance command id: ${command?.id ?? '<missing>'}`);
            }
            commandIds.add(command?.id);
            if (!Array.isArray(command?.argv) || command.argv.length === 0)
            {
                errors.push(`${command?.id} argv is required`);
            }
            if (!Array.isArray(command?.checkerSources) || command.checkerSources.length === 0)
            {
                errors.push(`${command?.id} checkerSources are required`);
            }
            if (!Array.isArray(command?.ruleIds) || command.ruleIds.length === 0)
            {
                errors.push(`${command?.id} ruleIds are required`);
            }
            for (const checker of command?.checkerSources ?? [])
            {
                const normalized = normalizeDeclaration(checker);
                if (checkerOwners.has(normalized))
                {
                    errors.push(`${normalized} checker is owned by both ${checkerOwners.get(normalized)} and ${authority.id}`);
                }
                checkerOwners.set(normalized, authority.id);
            }
            for (const ruleId of command?.ruleIds ?? [])
            {
                if (ruleOwners.has(ruleId))
                {
                    errors.push(`${ruleId} rule/test ID is owned by both ${ruleOwners.get(ruleId)} and ${authority.id}`);
                }
                ruleOwners.set(ruleId, authority.id);
            }
        }
    }
    if (required.size > 0)
    {
        errors.push(`missing governance authorities: ${[...required].join(', ')}`);
    }
    return errors;
}

export function loadAuthorityManifest(root, manifestFile = defaultManifest)
{
    const manifest = JSON.parse(fs.readFileSync(path.resolve(root, manifestFile), 'utf8'));
    const errors = validateAuthorityManifest(manifest);
    if (errors.length > 0)
    {
        throw new Error(errors.join('; '));
    }
    return manifest;
}

export function resolveAuthority(manifest, authorityId)
{
    const authority = manifest.authorities.find((entry) => entry.id === authorityId);
    if (!authority)
    {
        throw new Error(`unknown repository governance authority: ${authorityId}`);
    }
    return authority;
}
