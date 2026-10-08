/* eslint-disable import-x/no-relative-parent-imports -- Tests import their canonical repository checker. */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
    checkArticleVaultAgentControlSources,
    readArticleVaultAgentControlSources
} from '../../tools/governance/check-article-vault-agent-control.mjs';

const contracts = 'src/shared/Contracts/ArticleVault';
const native = 'src/article-vault/linux';

function mutated(file, change)
{
    const sources = readArticleVaultAgentControlSources();
    sources.set(file, change(sources.get(file)));
    return checkArticleVaultAgentControlSources(sources).join('\n');
}

test('current agent control source has one closed protocol and no content/server writer', () =>
{
    assert.deepEqual(checkArticleVaultAgentControlSources(readArticleVaultAgentControlSources()), []);
});

test('unknown command and untyped/path/shell/network/secret fields are denied', () =>
{
    const file = `${contracts}/ArticleVaultAgentRequest.cs`;
    assert.match(mutated(file, (source) => source.replace('ObserveBatch,', 'ExecuteShell,\n    ObserveBatch,')), /command registry/u);
    for (const field of ['AbsolutePath', 'Shell', 'CommandLine', 'NetworkProxy', 'Payload', 'Body', 'ServiceCredentials', 'PluginIdentity'])
    {
        assert.match(mutated(file, (source) => `${source}\npublic object ${field};\n`), /wire field/u);
    }
});

test('second IPC or lease authority and remote listeners are denied', () =>
{
    const file = `${native}/LinuxVaultLocalIpcEndpoint.cs`;
    assert.match(mutated(file, (source) => `${source}\npublic class AlternativeIpcProtocol {}\n`), /second agent protocol/u);
    assert.match(mutated(file, (source) => `${source}\npublic class LinuxVaultLocalIpcEndpoint {}\n`), /exact-one/u);
    assert.match(mutated(file, (source) => `${source}\nnew IPEndPoint(IPAddress.Any, 1234);\n`), /never remote/u);
    assert.match(mutated(file, (source) => `${source}\nlistener.Bind(endpoint);\n`), /managed bind/u);
});

test('protocol version, schema and unbounded frames cannot drift', () =>
{
    const file = `${contracts}/ArticleVaultAgentBinding.cs`;
    for (const [before, after] of [
        ['Version = 1', 'Version = 2'],
        ['agent-request.v1', 'agent-request.v2'],
        ['MaximumFrameBytes = 16384', 'MaximumFrameBytes = int.MaxValue']
    ])
    {
        assert.match(mutated(file, (source) => source.replace(before, after)), /canonical contract/u);
    }
});

test('direct server, filesystem content and shell/Git/network fallback are denied', () =>
{
    const file = `${native}/LinuxVaultLocalIpcEndpoint.cs`;
    for (const injected of ['ArticleService.UpdateAsync();', 'File.WriteAllBytes(path, bytes);', 'new ProcessStartInfo();', 'new HttpClient();', 'new LibGit2Sharp.Repository();', 'Directory.Delete(path);'])
    {
        assert.match(mutated(file, (source) => `${source}\n${injected}\n`), /writer or fallback/u);
    }
});

test('native locking, journal verification and suspend-aware expiry guards are retained', () =>
{
    const file = `${native}/LinuxVaultWriterLeaseScope.cs`;
    for (const guard of ['LinuxVaultLeaseNative.Lock', 'RequirePrivate', 'BootMilliseconds', 'VerifyTransition', 'Flush(flushToDisk: true)', 'ValidateOriginalHeldRegularFileUnchanged'])
    {
        assert.match(mutated(file, (source) => source.replaceAll(guard, 'RemovedGuard')), /missing fail-closed guard/u);
    }
});

test('peer permissions, identity, replay, token revocation and zeroization guards are retained', () =>
{
    for (const [name, guards] of [
        ['LinuxVaultLocalIpcEndpoint.cs', ['RequireCurrentUserPeer', 'RequirePrivateSocket', 'MaximumFrameBytes', 'ZeroMemory']],
        ['LinuxVaultAgentGrantLedger.cs', ['FixedTimeEquals', '_requests.Add', '_lease.Revoke', 'grant.Binding != request.Binding', 'grant.Generation != request.LeaseGeneration']]
    ])
    {
        for (const guard of guards)
        {
            assert.match(mutated(`${native}/${name}`, (source) => source.replaceAll(guard, 'RemovedGuard')), /missing fail-closed guard/u);
        }
    }
});
