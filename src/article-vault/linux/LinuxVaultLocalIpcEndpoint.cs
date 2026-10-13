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
public sealed class LinuxVaultLocalIpcEndpoint : IDisposable, IAsyncDisposable
{
    private readonly object _gate = new();
    private readonly CancellationTokenSource _lifetime = new();
    private readonly LinuxVaultWriterLeaseScope _lease;
    private readonly LinuxVaultAgentGrantLedger _grants;
    private readonly Socket _listener;
    private readonly string _path;
    private readonly LinuxVaultLeaseNative.FileIdentity _socketIdentity;
    private bool _disposed;
    private int _activeRequests;
    private TaskCompletionSource? _drained;
    private Task? _closing;

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
    public Task<ArticleVaultAgentRequest> ReadRequestAsync(CancellationToken cancellationToken)
        => ExchangeAsync(null, cancellationToken);

    /// <summary>Writes only the verified bounded command receipt back to the same admitted peer.</summary>
    internal Task<ArticleVaultAgentRequest> DispatchRequestAsync(
        Func<ArticleVaultAgentRequest, int, CancellationToken, Task<ArticleVaultAgentCommandReceipt>> dispatch,
        CancellationToken cancellationToken)
        => ExchangeAsync(dispatch ?? throw new ArgumentNullException(nameof(dispatch)), cancellationToken);

    private async Task<ArticleVaultAgentRequest> ExchangeAsync(
        Func<ArticleVaultAgentRequest, int, CancellationToken, Task<ArticleVaultAgentCommandReceipt>>? dispatch,
        CancellationToken cancellationToken)
    {
        lock (_gate)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            if (_activeRequests >= 8)
            {
                throw new InvalidDataException("agent_ipc_pending_request_budget_exceeded");
            }

            if (_activeRequests++ == 0)
            {
                _drained = new(TaskCreationOptions.RunContinuationsAsynchronously);
            }
        }

        try
        {
            _lease.RequireCurrent(cancellationToken);
            VerifyEndpoint();
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, _lifetime.Token);
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
                if (dispatch is not null)
                {
                    ArticleVaultAgentCommandReceipt receipt = await dispatch(request, length, timeout.Token).ConfigureAwait(false);
                    // Reparse through the sole closed result codec; no service/source body can
                    // appear in this transport and a result must name this admitted request.
                    byte[] response = ArticleVaultAgentCommandReceipts.EncodeForRequest(request, length, receipt);

                    LinuxVaultLeaseNative.RequireCurrentUserPeer(peer);
                    VerifyEndpoint();
                    BinaryPrimitives.WriteInt32BigEndian(prefix, response.Length);
                    await stream.WriteAsync(prefix, timeout.Token).ConfigureAwait(false);
                    await stream.WriteAsync(response, timeout.Token).ConfigureAwait(false);
                    await stream.FlushAsync(timeout.Token).ConfigureAwait(false);
                }

                return request;
            }
            finally
            {
                CryptographicOperations.ZeroMemory(secret);
            }
        }
        finally
        {
            lock (_gate)
            {
                if (--_activeRequests == 0)
                {
                    _drained!.TrySetResult();
                }
            }
        }
    }

    public void Dispose() => DisposeAsync().AsTask().GetAwaiter().GetResult();

    public ValueTask DisposeAsync()
    {
        lock (_gate)
        {
            _disposed = true;
            _closing ??= CloseAsync(_activeRequests == 0 ? Task.CompletedTask : _drained!.Task);
            return new(_closing);
        }
    }

    private async Task CloseAsync(Task drained)
    {
        try
        {
            _lifetime.Cancel();
            _listener.Dispose();
            await drained.ConfigureAwait(false);
            DeleteOwned(_path, _socketIdentity);
        }
        finally
        {
            _lifetime.Dispose();
        }
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
