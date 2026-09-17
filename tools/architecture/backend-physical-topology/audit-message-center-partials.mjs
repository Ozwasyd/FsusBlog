import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import { countLines, declaresMethod, maskCSharp, policyFile, walkCSharp } from './csharp-source.mjs';

const partialClassPattern = /\bpublic\s+sealed\s+partial\s+class\s+MessageCenterService\b/u;
const facadePrimaryConstructorPattern = /\bpublic\s+sealed\s+partial\s+class\s+MessageCenterService\s*\(/u;

function readMessageFiles(root, policy)
{
    const files = walkCSharp(resolve(root, policy.directory))
        .filter((path) => basename(path).startsWith('MessageCenterService'));
    return new Map(files.map((absolute) => [basename(absolute), maskCSharp(readFileSync(absolute, 'utf8'))]));
}

function auditOwnedMember(policy, codeByFile, fileName, code, member, errors)
{
    if (!declaresMethod(code, member))
    {
        errors.push(`${policy.directory}/${fileName}: owned member declaration is missing: ${member}`);
    }
    for (const [candidateName, candidateCode] of codeByFile)
    {
        if (candidateName !== fileName && declaresMethod(candidateCode, member))
        {
            errors.push(`${policy.directory}/${candidateName}: ${member} is declared outside owner ${fileName}`);
        }
    }
}

function auditOwners(policy, codeByFile, errors)
{
    for (const [fileName, members] of Object.entries(policy.owners))
    {
        const code = codeByFile.get(fileName);
        if (!code)
        {
            errors.push(`${policy.directory}/${fileName}: required responsibility file is missing`);
            continue;
        }
        if (!partialClassPattern.test(code))
        {
            errors.push(`${policy.directory}/${fileName}: must declare public sealed partial class MessageCenterService`);
        }
        for (const member of members)
        {
            auditOwnedMember(policy, codeByFile, fileName, code, member, errors);
        }
    }
}

function auditFacade(root, policy, errors)
{
    const path = `${policy.directory}/${policy.facade}`;
    const facade = policyFile(root, path, errors);
    if (!facade)
    {
        return;
    }
    if (!facadePrimaryConstructorPattern.test(facade.code))
    {
        errors.push(`${path}: facade must declare public sealed partial class MessageCenterService with its primary constructor`);
    }
    for (const member of policy.facadeForbiddenMembers)
    {
        if (declaresMethod(facade.code, member))
        {
            errors.push(`${path}: facade must not own ${member}`);
        }
    }
    const lines = countLines(facade.source);
    if (lines >= policy.facadeMaxLinesExclusive)
    {
        errors.push(`${path}: facade has ${lines} lines; required < ${policy.facadeMaxLinesExclusive}`);
    }
}

export function auditMessageCenterPartials(root, policy, errors)
{
    auditOwners(policy, readMessageFiles(root, policy), errors);
    auditFacade(root, policy, errors);
}
