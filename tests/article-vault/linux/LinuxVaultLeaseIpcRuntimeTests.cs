using System.Buffers.Binary;
using System.Net.Sockets;
using System.Runtime.Versioning;
using System.Security.Cryptography;

using FsusBlog.ArticleVault.Linux;
using FsusBlog.Shared.Contracts.ArticleVault;

using Xunit;

namespace FsusBlog.ArticleVault.Linux.Tests;

/// <summary>Requires the real provisioned per-user namespace; never simulates native admission.</summary>
[Trait("Category", "LinuxArticleVaultLeaseIpcRuntime")]
[SupportedOSPlatform("linux")]
public sealed class LinuxVaultLeaseIpcRuntimeTests
{
    [Fact]
    public async Task RealControlSession_UnlinkDrainsPendingReadAndRetainsUserMarkdown()
    {
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        ArticleVaultRootManifest manifest = root.Manifest with
        {
            VaultIdentity = "vault-control-session-test",
            ContentSha256 = string.Empty
        };
        manifest = manifest with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(manifest)
        };
        File.WriteAllBytes(Path.Combine(root.Path, ".fsus", "vault.json"), ArticleVaultManifestCodec.Serialize(manifest));
        string control = Path.Combine(LinuxVaultWriterLeaseScope.ControlDirectory, LinuxVaultWriterLeaseScope.ControlFileName(manifest));
        Assert.True(File.Exists(control), "Runtime gate: owned current-user control state must be provisioned externally; no permission installation or fake lifecycle success.");
        using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        LinuxVaultWriterLeaseScope lease = LinuxVaultWriterLeaseScope.Open(root.Path, manifest,
            "agent-control-runtime", "session-control-runtime", "1.0.0", new string('b', 64), cancellation.Token);
        await using LinuxVaultAgentControlSession session = LinuxVaultAgentControlSession.Open(lease, cancellation.Token);
        Assert.Equal(ArticleVaultAgentLifecycleState.Starting, session.InspectStatus().NewState);
        Assert.True(session.InspectStatus().RescanRequired);
        using LinuxVaultAgentGrant grant = session.CreateStatusGrant(cancellation.Token);
        string source = Path.Combine(root.Path, "retained.md");
        byte[] bytes = "# user Markdown\n"u8.ToArray();
        File.WriteAllBytes(source, bytes);
        Task<ArticleVaultAgentRequest> pending = session.ReadStatusRequestAsync(cancellation.Token);
        ArticleVaultAgentLifecycleReceipt terminal = await session.ShutdownAsync(ArticleVaultAgentShutdownIntent.Unlink);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () => await pending);
        Assert.Equal(ArticleVaultAgentLifecycleState.RetainedControlState, terminal.NewState);
        Assert.Equal(bytes, File.ReadAllBytes(source));
        Assert.True(File.Exists(control));
        Assert.Equal(ArticleVaultWriterLeaseState.Revoked, lease.Receipt.State);
        Assert.Throws<ObjectDisposedException>(() => session.CreateStatusGrant(cancellation.Token));
        Assert.Equal(terminal, await session.ShutdownAsync(ArticleVaultAgentShutdownIntent.Unlink));
    }

    [Fact]
    public async Task RealKernelLeaseAndSocket_RejectSecondAgentReplayRotationAndRevocation()
    {
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        string control = Path.Combine(LinuxVaultWriterLeaseScope.ControlDirectory, LinuxVaultWriterLeaseScope.ControlFileName(root.Manifest));
        Assert.True(File.Exists(control),
            "Runtime gate: operator-provisioned current-user directory 0700 and owned resident lease file 0600 are required. Tests never install permissions or fake admission.");
        using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        using LinuxVaultWriterLeaseScope lease = LinuxVaultWriterLeaseScope.Open(root.Path, root.Manifest,
            "agent-lease-runtime", "session-lease-runtime", "1.0.0", new string('b', 64), cancellation.Token);
        Assert.Throws<InvalidDataException>(() => LinuxVaultWriterLeaseScope.Open(root.Path, root.Manifest,
            "agent-other", "session-lease-runtime", "1.0.0", new string('b', 64), cancellation.Token));
        using var grants = new LinuxVaultAgentGrantLedger(lease);
        using LinuxVaultAgentGrant first = grants.Issue(ArticleVaultAgentCommand.InspectStatus, cancellation.Token);
        using LinuxVaultLocalIpcEndpoint endpoint = LinuxVaultLocalIpcEndpoint.Open(lease, grants, cancellation.Token);
        ArticleVaultAgentRequest request = Request(lease, "request-native-one");
        Assert.Equal(request, await Send(endpoint, lease, request, first, cancellation.Token));
        await Assert.ThrowsAsync<InvalidDataException>(() => Send(endpoint, lease, request, first, cancellation.Token));
        using LinuxVaultAgentGrant rotated = grants.Issue(ArticleVaultAgentCommand.InspectStatus, cancellation.Token);
        await Assert.ThrowsAsync<InvalidDataException>(() => Send(endpoint, lease,
            Request(lease, "request-native-two"), first, cancellation.Token));
        Assert.Equal("ArticleVaultAgentGrant[redacted]", rotated.ToString());
        grants.Revoke(cancellation.Token);
        Assert.Throws<InvalidDataException>(() => lease.RequireCurrent(cancellation.Token));
        Assert.Throws<ObjectDisposedException>(() => grants.Issue(ArticleVaultAgentCommand.InspectStatus, cancellation.Token));
        Assert.Equal(ArticleVaultWriterLeaseState.Revoked, lease.Receipt.State);
        Assert.True(ArticleVaultWriterLease.Verify(lease.Receipt));
    }

    private static ArticleVaultAgentRequest Request(LinuxVaultWriterLeaseScope lease, string identity)
        => ArticleVaultLeaseProtocolTests.Seal(new(ArticleVaultAgentProtocol.RequestSchema, lease.Receipt.Binding,
            identity, lease.Receipt.Generation, lease.Receipt.ContentSha256, ArticleVaultAgentCommand.InspectStatus,
            lease.Receipt.DeadlineUnixMilliseconds - 1, "cancel-native", null, string.Empty));

    private static async Task<ArticleVaultAgentRequest> Send(
        LinuxVaultLocalIpcEndpoint endpoint,
        LinuxVaultWriterLeaseScope lease,
        ArticleVaultAgentRequest request,
        LinuxVaultAgentGrant grant,
        CancellationToken cancellationToken)
    {
        Task<ArticleVaultAgentRequest> receiving = endpoint.ReadRequestAsync(cancellationToken);
        using var client = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
        string name = ArticleVaultAgentProtocol.Digest(new[] { lease.Receipt.Binding.SiteIdentity, lease.Receipt.Binding.VaultIdentity });
        await client.ConnectAsync(new UnixDomainSocketEndPoint(Path.Combine(LinuxVaultWriterLeaseScope.ControlDirectory,
            name + ".socket")), cancellationToken);
        byte[] secret = grant.CopySecret();
        try
        {
            using var stream = new NetworkStream(client, ownsSocket: false);
            byte[] bytes = ArticleVaultAgentProtocol.Encode(request);
            byte[] prefix = new byte[4];
            BinaryPrimitives.WriteInt32BigEndian(prefix, bytes.Length);
            await stream.WriteAsync(secret, cancellationToken);
            await stream.WriteAsync(prefix, cancellationToken);
            await stream.WriteAsync(bytes, cancellationToken);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(secret);
        }

        return await receiving;
    }
}
