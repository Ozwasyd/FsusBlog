#!/usr/bin/env node

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const contracts = 'src/shared/Contracts/ArticleVault';
const native = 'src/article-vault/linux';
const commandFile = `${contracts}/ArticleVaultAgentRequest.cs`;
const protocolFile = `${contracts}/ArticleVaultAgentBinding.cs`;
const leaseFile = `${native}/LinuxVaultWriterLeaseScope.cs`;
const endpointFile = `${native}/LinuxVaultLocalIpcEndpoint.cs`;
const grantFile = `${native}/LinuxVaultAgentGrantLedger.cs`;
const commands = ['ObserveBatch', 'RequestPlanner', 'ExecuteVerifiedPlan', 'MaterializeVerifiedInstruction', 'InspectStatus', 'Cancel', 'Revoke'];
const owners = new Map([
    ['ArticleVaultAgentProtocol', protocolFile],
    ['ArticleVaultWriterLease', `${contracts}/ArticleVaultWriterLease.cs`],
    ['LinuxVaultWriterLeaseScope', leaseFile],
    ['LinuxVaultLocalIpcEndpoint', endpointFile],
    ['LinuxVaultAgentGrantLedger', grantFile]
]);

export function readArticleVaultAgentControlSources(repositoryRoot = root)
{
    const files = [contracts, native].flatMap((directory) => readdirSync(path.join(repositoryRoot, directory))
        .filter((name) => name.endsWith('.cs')).map((name) => `${directory}/${name}`));
    return new Map(files.map((file) => [file, readFileSync(path.join(repositoryRoot, file), 'utf8')]));
}

/** Static ownership/refusal evidence only; this never qualifies native locks, trust or recovery. */
export function checkArticleVaultAgentControlSources(sources)
{
    const errors = [];
    for (const [name, file] of owners)
    {
        const declarations = [...sources].flatMap(([owner, source]) =>
            [...source.matchAll(new RegExp(`\\b(?:class|record)\\s+${name}\\b`, 'gu'))].map(() => owner));
        if (declarations.length !== 1 || declarations[0] !== file)
        {
            errors.push(`exact-one agent control owner required: ${name}`);
        }
    }
    if (errors.length > 0)
    {
        return errors;
    }

    const request = sources.get(commandFile) ?? '';
    const protocol = sources.get(protocolFile);
    if (!protocol.includes('const int Version = 1;')
        || !protocol.includes('"fsusblog.article-vault.agent-request.v1"')
        || !protocol.includes('const int MaximumFrameBytes = 16384;'))
    {
        errors.push('IPC version, schema and frame budget must retain the canonical contract');
    }
    const match = /enum ArticleVaultAgentCommand\s*\{([^}]+)\}/u.exec(request);
    if (JSON.stringify(match?.[1].split(',').map((value) => value.trim())) !== JSON.stringify(commands))
    {
        errors.push('IPC command registry must retain the exact seven closed command purposes');
    }
    for (const file of [protocolFile, commandFile, `${contracts}/ArticleVaultAgentCommandReceipt.cs`])
    {
        const source = sources.get(file) ?? '';
        if (/\b(?:AbsolutePath|Shell|CommandLine|NetworkProxy|Payload|Body|ServiceCredentials|Database|PluginIdentity)\b/u.test(source)
            || /\b(?:object|dynamic)\s+[A-Z]\w*/u.test(source))
        {
            errors.push(`${file}: prohibited arbitrary path, execution, secret or untyped wire field`);
        }
    }
    for (const [file, source] of sources)
    {
        if (/\b(?:class|record|enum)\s+\w*(?:IpcProtocol|AgentRequest|AgentCommand|WriterLease)\b/u.test(source)
            && ![protocolFile, commandFile, `${contracts}/ArticleVaultWriterLease.cs`].includes(file))
        {
            errors.push(`${file}: second agent protocol or writer lease owner`);
        }
    }
    for (const file of [leaseFile, endpointFile, grantFile])
    {
        const source = sources.get(file);
        if (/\b(?:HttpClient|ProcessStartInfo|ArticleService|IArticleVaultCanonicalGroupWriter|Npgsql|DbContext|ExecuteSql|SaveChanges|LibGit2Sharp)\b/u.test(source)
            || /\b(?:File|Directory)\.(?:WriteAllBytes|WriteAllText|ReadAllBytes|Delete|CreateDirectory)\s*\(/u.test(source.replace('File.Delete(path);', '')))
        {
            errors.push(`${file}: prohibited direct server/content writer or fallback`);
        }
    }
    const guards = new Map([
        [protocolFile, ['UnmappedMemberHandling.Disallow', 'RespectRequiredConstructorParameters = true', 'allowIntegerValues: false', 'RejectDuplicates', 'agent_frame_size_invalid', 'agent_frame_schema_invalid']],
        [leaseFile, ['LinuxVaultLeaseNative.Lock', '2 | 4', '/run/user/', 'RequirePrivate', 'ValidateOriginalHeldRegularFileUnchanged', 'VerifyWatchedRoot', 'BootMilliseconds', 'VerifyTransition', 'Flush(flushToDisk: true)', 'writer_lease_journal_incomplete_recovery_required']],
        [endpointFile, ['CreateLocalListener', 'RequireCurrentUserPeer', 'RequirePrivateSocket', 'SameSocket', 'cleanup_unowned_endpoint', 'MaximumFrameBytes', '_grants.Admit', 'ZeroMemory', 'CreateLinkedTokenSource']],
        [grantFile, ['FixedTimeEquals', 'MaximumRequests', '_requests.Add', 'agent_request_duplicate_or_budget_exceeded', 'ZeroMemory', '_lease.Revoke', 'grant.Binding != request.Binding', 'grant.Generation != request.LeaseGeneration']]
    ]);
    for (const [file, required] of guards)
    {
        for (const guard of required)
        {
            if (!sources.get(file).includes(guard))
            {
                errors.push(`${file}: missing fail-closed guard ${guard}`);
            }
        }
    }
    if (/AddressFamily\.(?:InterNetwork|InterNetworkV6)|IPAddress\.Any|IPEndPoint/u.test(sources.get(endpointFile)))
    {
        errors.push('IPC must remain a closed current-user Unix endpoint, never remote or listen-all');
    }
    if (/\b\w+\.Bind\s*\(/u.test(sources.get(endpointFile)))
    {
        errors.push('managed bind would bypass explicit owned endpoint cleanup');
    }
    return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    const errors = checkArticleVaultAgentControlSources(readArticleVaultAgentControlSources());
    if (errors.length > 0)
    {
        process.stderr.write(`${errors.join('\n')}\n`);
        process.exitCode = 1;
    }
    else
    {
        process.stdout.write('Article Vault agent source governance passed; no runtime/platform acceptance claimed.\n');
    }
}
