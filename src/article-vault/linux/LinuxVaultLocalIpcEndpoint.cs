using System.Buffers.Binary;
using System.Net.Sockets;
using System.Runtime.Versioning;
using System.Security.Cryptography;

using FsusBlog.Shared.Contracts.ArticleVault;

namespace FsusBlog.ArticleVault.Linux;

/// <summary>
/// Opens only an owned current-user Unix socket beneath the fixed lease namespace. It reads closed
/// authenticated command references, never article bodies, file paths, shell or network operations.
/// </summary>
[SupportedOSPlatform("linux")]
public sealed class LinuxVaultLocalIpcEndpoint : IDisposable
{
    private readonly LinuxVaultWriterLeaseScope _lease;
    private readonly LinuxVaultAgentGrantLedger _grants;
    private readonly Socket _listener;
    private readonly string _path;
    private readonly LinuxVaultLeaseNative.FileIdentity _socketIdentity;
    private bool _disposed;

    private LinuxVaultLocalIpcEndpoint(
        LinuxVaultWriterLeaseScope lease,
        LinuxVaultAgentGrantLedger grants,
        Socket listener,
        string path,
        LinuxVaultLeaseNative.FileIdentity identity)
    {
        _lease = lease;
        _grants = grants;
        _listener = listener;
        _path = path;
        _socketIdentity = identity;
    }

    public static LinuxVaultLocalIpcEndpoint Open(
        LinuxVaultWriterLeaseScope lease,
        LinuxVaultAgentGrantLedger grants,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(lease);
        ArgumentNullException.ThrowIfNull(grants);
        if (!grants.UsesLease(lease))
        {
            throw new InvalidDataException("agent_ipc_grant_lease_mismatch");
        }

        lease.RequireCurrent(cancellationToken);
        string name = ArticleVaultAgentProtocol.Digest(new[] { lease.Receipt.Binding.SiteIdentity, lease.Receipt.Binding.VaultIdentity });
        string path = Path.Combine(LinuxVaultWriterLeaseScope.ControlDirectory, name + ".socket");
        Socket listener = LinuxVaultLeaseNative.CreateLocalListener(path);
        LinuxVaultLeaseNative.FileIdentity identity = default;
        try
        {
            // Existing endpoints, including stale ones, are never silently removed or replaced.
            identity = LinuxVaultLeaseNative.ObserveSocket(path);
            File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            LinuxVaultLeaseNative.FileIdentity secured = LinuxVaultLeaseNative.RequirePrivateSocket(path);
            if (!SameSocket(identity, secured))
            {
                throw new InvalidDataException("agent_ipc_endpoint_replaced");
            }
            lease.RequireCurrent(cancellationToken);
            listener.Listen(8);
            return new(lease, grants, listener, path, identity);
        }
        catch
        {
            listener.Dispose();
            if (identity._inode != 0)
            {
                DeleteOwned(path, identity);
            }

            throw;
        }
    }

    /// <summary>
    /// Reads one bounded frame from one actual current-user peer. Returning a request proves only
    /// local IPC admission; execution/materialization still belongs to the canonical producers.
    /// </summary>
    public async Task<ArticleVaultAgentRequest> ReadRequestAsync(CancellationToken cancellationToken)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        _lease.RequireCurrent(cancellationToken);
        VerifyEndpoint();
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(30));
        using Socket peer = await _listener.AcceptAsync(timeout.Token).ConfigureAwait(false);
        LinuxVaultLeaseNative.RequireCurrentUserPeer(peer);
        byte[] secret = new byte[32];
        try
        {
            using var stream = new NetworkStream(peer, ownsSocket: false);
            await stream.ReadExactlyAsync(secret, timeout.Token).ConfigureAwait(false);
            byte[] prefix = new byte[4];
            await stream.ReadExactlyAsync(prefix, timeout.Token).ConfigureAwait(false);
            int length = BinaryPrimitives.ReadInt32BigEndian(prefix);
            if (length is < 1 or > ArticleVaultAgentProtocol.MaximumFrameBytes)
            {
                throw new InvalidDataException("agent_frame_size_invalid");
            }

            byte[] bytes = new byte[length];
            await stream.ReadExactlyAsync(bytes, timeout.Token).ConfigureAwait(false);
            ArticleVaultAgentRequest request = ArticleVaultAgentRequestCodec.Decode(bytes);
            LinuxVaultLeaseNative.RequireCurrentUserPeer(peer);
            VerifyEndpoint();
            _grants.Admit(request, secret, timeout.Token);
            return request;
        }
        finally
        {
            CryptographicOperations.ZeroMemory(secret);
        }
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        _listener.Dispose();
        DeleteOwned(_path, _socketIdentity);
    }

    private void VerifyEndpoint()
    {
        LinuxVaultLeaseNative.FileIdentity current = LinuxVaultLeaseNative.RequirePrivateSocket(_path);
        if (!SameSocket(current, _socketIdentity))
        {
            throw new InvalidDataException("agent_ipc_endpoint_replaced");
        }
    }

    private static void DeleteOwned(string path, LinuxVaultLeaseNative.FileIdentity identity)
    {
        LinuxVaultLeaseNative.FileIdentity current = LinuxVaultLeaseNative.ObserveSocket(path);
        if (!SameSocket(current, identity))
        {
            throw new InvalidDataException("agent_ipc_cleanup_unowned_endpoint");
        }

        File.Delete(path);
    }

    private static bool SameSocket(LinuxVaultLeaseNative.FileIdentity left, LinuxVaultLeaseNative.FileIdentity right)
        => left._inode == right._inode && left._deviceMajor == right._deviceMajor && left._deviceMinor == right._deviceMinor;
}
