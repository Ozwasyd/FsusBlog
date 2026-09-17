import { readFileSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';

import {
    containsIdentifier,
    forbidTokens,
    maskCSharp,
    policyFile,
    requireIdentifiers,
    requireQualifiedSymbols,
    walkCSharp
} from './csharp-source.mjs';

function auditBootstrap(root, policy, errors)
{
    const composition = policyFile(root, policy.composition.path, errors);
    requireIdentifiers(composition, policy.composition.requiredIdentifiers, errors);
    requireQualifiedSymbols(composition, policy.composition.requiredQualifiedSymbols, errors);
    forbidTokens(composition, policy.composition.forbiddenTokens, errors);
    for (const owner of policy.runtimeOwners)
    {
        requireIdentifiers(policyFile(root, owner.path, errors), owner.requiredIdentifiers, errors);
    }
    for (const path of policy.registrationRoots)
    {
        forbidTokens(policyFile(root, path, errors), policy.registrationForbiddenTokens, errors);
    }
}

function forbidIdentifiers(root, files, identifiers, describe, errors)
{
    for (const absolute of files)
    {
        const code = maskCSharp(readFileSync(absolute, 'utf8'));
        for (const identifier of identifiers)
        {
            if (containsIdentifier(code, identifier))
            {
                errors.push(`${relative(root, absolute)}: ${describe(identifier)}`);
            }
        }
    }
}

function auditAuthoringImplementations(root, policy, errors)
{
    for (const owner of policy.implementations)
    {
        const path = `${policy.serviceRoot}/${owner}.cs`;
        const file = policyFile(root, path, errors);
        if (!file)
        {
            continue;
        }
        for (const sibling of policy.implementations.filter((candidate) => candidate !== owner))
        {
            if (containsIdentifier(file.code, sibling))
            {
                errors.push(`${path}: authoring implementation ${owner} references sibling ${sibling}`);
            }
        }
    }
}

function auditAuthoring(root, policy, errors)
{
    const backendFiles = walkCSharp(resolve(root, policy.backendRoot));
    forbidIdentifiers(root, backendFiles, policy.retiredIdentifiers,
        (identifier) => `retired authoring identifier is present: ${identifier}`, errors);

    const endpointFiles = walkCSharp(resolve(root, policy.endpointRoot))
        .filter((path) => basename(path).startsWith(policy.endpointPrefix));
    if (endpointFiles.length === 0)
    {
        errors.push(`${policy.endpointRoot}: no ${policy.endpointPrefix} endpoint files found`);
    }
    forbidIdentifiers(root, endpointFiles, policy.endpointForbiddenIdentifiers,
        (identifier) => `endpoint depends on concrete authoring service ${identifier}`, errors);

    const serviceFiles = walkCSharp(resolve(root, policy.serviceRoot));
    forbidIdentifiers(root, serviceFiles, policy.serviceForbiddenIdentifiers,
        (identifier) => `authoring service depends on forbidden ${identifier}`, errors);
    auditAuthoringImplementations(root, policy, errors);
}

export function auditBootstrapAndAuthoring(root, policy, errors)
{
    auditBootstrap(root, policy.bootstrapComposition, errors);
    auditAuthoring(root, policy.authoringModules, errors);
}
