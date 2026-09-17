import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import { containsIdentifier, forbidTokens, maskCSharp, policyFile, requireTokens, walkCSharp } from './csharp-source.mjs';

export function auditCacheModules(root, policy, errors)
{
    for (const path of policy.retiredPaths)
    {
        if (existsSync(resolve(root, path)))
        {
            errors.push(`${path}: retired cache file must not exist`);
        }
    }

    for (const absolute of walkCSharp(resolve(root, policy.backendRoot)))
    {
        const code = maskCSharp(readFileSync(absolute, 'utf8'));
        for (const identifier of policy.retiredIdentifiers)
        {
            if (containsIdentifier(code, identifier))
            {
                errors.push(`${relative(root, absolute)}: retired cache identifier is present: ${identifier}`);
            }
        }
    }

    for (const [path, tokens] of Object.entries(policy.requiredTokensByPath))
    {
        requireTokens(policyFile(root, path, errors), tokens, errors);
    }
    for (const [path, tokens] of Object.entries(policy.forbiddenTokensByPath))
    {
        forbidTokens(policyFile(root, path, errors), tokens, errors);
    }
}
