using System.Collections.Immutable;
using System.Net;
using System.Net.Sockets;
using System.Runtime.ExceptionServices;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.Server.Infrastructure.AuthoringExtensions;

public sealed record AuthoringPinnedNetworkRequest(
    string Host,
    int Port,
    string PathAndQuery,
    ImmutableArray<IPAddress> Addresses,
    long MaximumBytes,
    DateTimeOffset Deadline);

public sealed record AuthoringPinnedNetworkResponse(
    int StatusCode,
    string? ContentType,
    ImmutableArray<byte> Payload);

public sealed record AuthoringServiceIoReceipt(
    string GrantId,
    string RuntimeIdentity,
    string Purpose,
    long Bytes,
    string ContentSha256,
    string Outcome,
    string? ArtifactReference);

public sealed record AuthoringServiceIoResult(
    AuthoringServiceIoReceipt Receipt,
    ImmutableArray<byte> Payload);

public interface IAuthoringPinnedNetworkTransport
{
    ValueTask<AuthoringPinnedNetworkResponse> GetAsync(
        AuthoringPinnedNetworkRequest request,
        CancellationToken cancellationToken);
}

public sealed class DnsAuthoringNetworkAddressResolver : IAuthoringNetworkAddressResolver
{
    public async ValueTask<ImmutableArray<IPAddress>> ResolveAsync(
        string host,
        CancellationToken cancellationToken) =>
        [.. await Dns.GetHostAddressesAsync(host, cancellationToken)];
}

public sealed class PinnedHttpsAuthoringNetworkTransport : IAuthoringPinnedNetworkTransport
{
    public async ValueTask<AuthoringPinnedNetworkResponse> GetAsync(
        AuthoringPinnedNetworkRequest request,
        CancellationToken cancellationToken)
    {
        if (request.Addresses.IsDefaultOrEmpty || request.PathAndQuery.Length is < 1 or > 2048 ||
            !request.PathAndQuery.StartsWith("/", StringComparison.Ordinal) ||
            request.PathAndQuery.StartsWith("//", StringComparison.Ordinal) ||
            request.PathAndQuery.Contains("://", StringComparison.Ordinal) ||
            request.PathAndQuery.ContainsAny(['\r', '\n', '\\']) ||
            request.MaximumBytes is < 1 or > 64 * 1024 * 1024 ||
            request.Deadline <= DateTimeOffset.UtcNow)
        {
            throw new AuthoringExtensionContractException("Pinned network request is broad, malformed, or expired.");
        }

        var handler = new SocketsHttpHandler
        {
            AllowAutoRedirect = false,
            AutomaticDecompression = DecompressionMethods.None,
            ConnectCallback = async (_, token) =>
            {
                Exception? failure = null;
                foreach (IPAddress address in request.Addresses)
                {
                    var socket = new Socket(address.AddressFamily, SocketType.Stream, ProtocolType.Tcp);
                    try
                    {
                        await socket.ConnectAsync(new IPEndPoint(address, request.Port), token);
                        return new NetworkStream(socket, ownsSocket: true);
                    }
                    catch (Exception exception) when (exception is SocketException or OperationCanceledException)
                    {
                        failure = exception;
                        socket.Dispose();
                    }
                }

                throw failure ?? new AuthoringExtensionContractException("Pinned network destination was unreachable.");
            },
            UseCookies = false
        };
        using var client = new HttpClient(handler)
        {
            Timeout = Timeout.InfiniteTimeSpan
        };
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(request.Deadline - DateTimeOffset.UtcNow);
        if (!Uri.TryCreate(
                $"https://{request.Host}:{request.Port}{request.PathAndQuery}",
                UriKind.Absolute,
                out Uri? uri) ||
            !string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.Ordinal) ||
            !string.Equals(uri.Host, request.Host, StringComparison.OrdinalIgnoreCase) ||
            uri.Port != request.Port || !string.IsNullOrEmpty(uri.UserInfo) || !string.IsNullOrEmpty(uri.Fragment))
        {
            throw new AuthoringExtensionContractException("Pinned network path changed authority or introduced a fragment.");
        }

        using var message = new HttpRequestMessage(HttpMethod.Get, uri);
        using HttpResponseMessage response = await client.SendAsync(
            message,
            HttpCompletionOption.ResponseHeadersRead,
            deadline.Token);
        if ((int)response.StatusCode is >= 300 and < 400 ||
            response.Content.Headers.ContentLength > request.MaximumBytes)
        {
            throw new AuthoringExtensionContractException("Pinned network response redirected or exceeded its byte grant.");
        }

        await using Stream stream = await response.Content.ReadAsStreamAsync(deadline.Token);
        byte[] payload = await ReadBoundedAsync(stream, request.MaximumBytes, deadline.Token);
        return new AuthoringPinnedNetworkResponse(
            (int)response.StatusCode,
            response.Content.Headers.ContentType?.MediaType,
            [.. payload]);
    }

    internal static async ValueTask<byte[]> ReadBoundedAsync(
        Stream stream,
        long maximumBytes,
        CancellationToken cancellationToken,
        Action? validateBoundary = null)
    {
        using var buffer = new MemoryStream((int)Math.Min(maximumBytes, 64 * 1024));
        byte[] chunk = new byte[16 * 1024];
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            validateBoundary?.Invoke();
            int read = await stream.ReadAsync(chunk, cancellationToken);
            cancellationToken.ThrowIfCancellationRequested();
            validateBoundary?.Invoke();
            if (read == 0)
            {
                return buffer.ToArray();
            }

            if (buffer.Length + read > maximumBytes)
            {
                throw new AuthoringExtensionContractException("Broker response exceeded its byte grant.");
            }

            await buffer.WriteAsync(chunk.AsMemory(0, read), cancellationToken);
            cancellationToken.ThrowIfCancellationRequested();
            validateBoundary?.Invoke();
        }
    }
}

[SupportedOSPlatform("linux")]
public sealed class LinuxAuthoringFilePathVerifier : IAuthoringFilePathVerifier
{
    public ValueTask<(string CanonicalPath, bool HasReparseBoundary)> ResolveAsync(
        string canonicalRoot,
        string relativePath,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        string root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(canonicalRoot));
        string candidate = Path.GetFullPath(relativePath, root);
        if (!Directory.Exists(root) || new DirectoryInfo(root).LinkTarget is not null ||
            !candidate.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.Ordinal))
        {
            return ValueTask.FromResult((candidate, true));
        }

        string current = root;
        foreach (string segment in Path.GetRelativePath(root, candidate)
            .Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries))
        {
            current = Path.Combine(current, segment);
            FileSystemInfo? info = Directory.Exists(current)
                ? new DirectoryInfo(current)
                : File.Exists(current)
                    ? new FileInfo(current)
                    : null;
            if (info?.LinkTarget is not null)
            {
                return ValueTask.FromResult((candidate, true));
            }
        }

        return ValueTask.FromResult((candidate, false));
    }
}

public sealed class AuthoringExtensionServiceIoBroker
{
    internal const string StagedWriteCleanupFailuresKey = "AuthoringStagedWriteCleanupFailures";

    private readonly AuthoringServiceGrantValidator _grantValidator;
    private readonly IAuthoringPinnedNetworkTransport _network;
    private readonly string _privateStagingRoot;

    public AuthoringExtensionServiceIoBroker(
        AuthoringServiceGrantValidator grantValidator,
        IAuthoringPinnedNetworkTransport network,
        string privateStagingRoot)
    {
        if (!Path.IsPathFullyQualified(privateStagingRoot) ||
            Path.GetPathRoot(privateStagingRoot) == Path.TrimEndingDirectorySeparator(privateStagingRoot))
        {
            throw new AuthoringExtensionContractException("Service broker staging root is missing or broad.");
        }

        _grantValidator = grantValidator;
        _network = network;
        _privateStagingRoot = privateStagingRoot;
        Directory.CreateDirectory(privateStagingRoot);
        if (new DirectoryInfo(privateStagingRoot).LinkTarget is not null)
        {
            throw new AuthoringExtensionContractException("Service broker staging root cannot be a reparse boundary.");
        }
        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(
                privateStagingRoot,
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }
    }

    public async ValueTask<AuthoringServiceIoResult> FetchAsync(
        AuthoringNetworkGrant grant,
        string runtimeIdentity,
        string purpose,
        string pathAndQuery,
        CancellationToken cancellationToken = default)
    {
        if (!string.Equals(purpose, grant.Purpose, StringComparison.Ordinal))
        {
            throw new AuthoringExtensionContractException("Network request purpose drifted from its grant.");
        }

        using var deadline = new GrantIoDeadline(grant.ExpiresAt, cancellationToken, _grantValidator.TimeProvider);
        ImmutableArray<IPAddress> addresses = await _grantValidator.ResolveNetworkAsync(
            grant,
            runtimeIdentity,
            deadline.Token);
        deadline.ThrowIfExpiredOrCancelled();
        AuthoringPinnedNetworkResponse response = await _network.GetAsync(
            new AuthoringPinnedNetworkRequest(
                grant.Host,
                grant.Port,
                pathAndQuery,
                addresses,
                grant.MaximumBytes,
                grant.ExpiresAt),
            deadline.Token);
        deadline.ThrowIfExpiredOrCancelled();
        if (response.Payload.IsDefault || response.Payload.Length > grant.MaximumBytes)
        {
            throw new AuthoringExtensionContractException("Network broker returned an unbounded payload.");
        }

        AuthoringServiceIoResult result = CreateResult(grant.GrantId, runtimeIdentity, purpose, response.Payload, "network-read");
        deadline.ThrowIfExpiredOrCancelled();
        return result;
    }

    public async ValueTask<AuthoringServiceIoResult> ReadFileAsync(
        AuthoringFileGrant grant,
        string runtimeIdentity,
        string purpose,
        CancellationToken cancellationToken = default)
    {
        if (grant.Operation != AuthoringFileGrantOperation.Read ||
            !string.Equals(purpose, grant.Purpose, StringComparison.Ordinal))
        {
            throw new AuthoringExtensionContractException("File read operation or purpose drifted from its grant.");
        }

        using var deadline = new GrantIoDeadline(grant.ExpiresAt, cancellationToken, _grantValidator.TimeProvider);
        string path = await _grantValidator.ResolveFileAsync(grant, runtimeIdentity, deadline.Token);
        deadline.ThrowIfExpiredOrCancelled();
        var file = new FileInfo(path);
        if (!file.Exists || file.Length > grant.MaximumBytes ||
            (file.Attributes & (FileAttributes.Directory | FileAttributes.Device | FileAttributes.ReparsePoint)) != 0)
        {
            throw new AuthoringExtensionContractException("File grant did not resolve to a bounded regular file.");
        }

        byte[] payload;
        await using (var stream = new FileStream(
            path,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            16 * 1024,
            FileOptions.Asynchronous | FileOptions.SequentialScan))
        {
            payload = await PinnedHttpsAuthoringNetworkTransport.ReadBoundedAsync(
                stream,
                grant.MaximumBytes,
                deadline.Token,
                deadline.ThrowIfExpiredOrCancelled);
            deadline.ThrowIfExpiredOrCancelled();
        }

        deadline.ThrowIfExpiredOrCancelled();
        AuthoringServiceIoResult result = CreateResult(grant.GrantId, runtimeIdentity, purpose, [.. payload], "file-read");
        deadline.ThrowIfExpiredOrCancelled();
        return result;
    }

    public async ValueTask<AuthoringServiceIoReceipt> StageProposedWriteAsync(
        AuthoringFileGrant grant,
        string runtimeIdentity,
        string purpose,
        ImmutableArray<byte> payload,
        CancellationToken cancellationToken = default)
    {
        if (grant.Operation != AuthoringFileGrantOperation.ProposeWrite || payload.IsDefault ||
            payload.Length > grant.MaximumBytes ||
            !string.Equals(purpose, grant.Purpose, StringComparison.Ordinal))
        {
            throw new AuthoringExtensionContractException("Proposed file write is missing, unbounded, or purpose-drifted.");
        }

        using var deadline = new GrantIoDeadline(grant.ExpiresAt, cancellationToken, _grantValidator.TimeProvider);
        _ = await _grantValidator.ResolveFileAsync(grant, runtimeIdentity, deadline.Token);
        deadline.ThrowIfExpiredOrCancelled();
        string digest = Convert.ToHexStringLower(SHA256.HashData(payload.AsSpan()));
        string proposalId = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(string.Join('\n',
            grant.GrantId,
            runtimeIdentity,
            purpose,
            digest))));
        string proposalPath = Path.Combine(_privateStagingRoot, proposalId);
        var receipt = new AuthoringServiceIoReceipt(
            grant.GrantId,
            runtimeIdentity,
            purpose,
            payload.Length,
            digest,
            "write-staged-for-host-approval",
            proposalId);
        deadline.ThrowIfExpiredOrCancelled();
        await WriteOwnedProposalAsync(
            proposalPath,
            payload.AsMemory(),
            SetProposalPermissions,
            File.Delete,
            deadline.Token,
            deadline.ThrowIfExpiredOrCancelled);

        try
        {
            deadline.ThrowIfExpiredOrCancelled();
            return receipt;
        }
        catch (Exception failure)
        {
            // Only a settled successful CreateNew transfers this proposal to us.
            var cleanupFailures = ImmutableArray.CreateBuilder<Exception>();
            DeleteOwnedProposal(proposalPath, File.Delete, cleanupFailures);
            RecordCleanupFailures(failure, cleanupFailures);
            throw;
        }
    }

    internal static async ValueTask WriteOwnedProposalAsync(
        string proposalPath,
        ReadOnlyMemory<byte> payload,
        Action<string> setPermissions,
        Action<string> deleteProposal,
        CancellationToken cancellationToken,
        Action? validateBoundary = null,
        Func<string, Stream>? createProposal = null)
    {
        ArgumentNullException.ThrowIfNull(setPermissions);
        ArgumentNullException.ThrowIfNull(deleteProposal);
        Stream? stream = null;
        Exception? failure = null;
        ImmutableArray<Exception>.Builder cleanupFailures = ImmutableArray.CreateBuilder<Exception>();
        try
        {
            // A successful factory return transfers an exclusively created proposal stream.
            stream = createProposal is null ? new FileStream(
                proposalPath,
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.None,
                16 * 1024,
                FileOptions.Asynchronous | FileOptions.WriteThrough) : createProposal(proposalPath);
            await stream.WriteAsync(payload, cancellationToken);
            cancellationToken.ThrowIfCancellationRequested();
            validateBoundary?.Invoke();
        }
        catch (Exception exception)
        {
            failure = exception;
        }

        if (stream is not null)
        {
            try
            {
                await stream.DisposeAsync();
            }
            catch (Exception exception)
            {
                if (failure is null)
                {
                    failure = exception;
                }
                else
                {
                    cleanupFailures.Add(exception);
                }
            }
        }

        if (failure is null)
        {
            try
            {
                cancellationToken.ThrowIfCancellationRequested();
                validateBoundary?.Invoke();
                setPermissions(proposalPath);
                cancellationToken.ThrowIfCancellationRequested();
                validateBoundary?.Invoke();
            }
            catch (Exception exception)
            {
                failure = exception;
            }
        }

        if (failure is not null)
        {
            // A failed CreateNew never owns an existing proposal at this path.
            if (stream is not null)
            {
                DeleteOwnedProposal(proposalPath, deleteProposal, cleanupFailures);
            }

            RecordCleanupFailures(failure, cleanupFailures);

            ExceptionDispatchInfo.Capture(failure).Throw();
        }
    }

    private static void DeleteOwnedProposal(
        string proposalPath,
        Action<string> deleteProposal,
        ImmutableArray<Exception>.Builder cleanupFailures)
    {
        try
        {
            deleteProposal(proposalPath);
        }
        catch (Exception exception)
        {
            cleanupFailures.Add(exception);
        }
    }

    private static void RecordCleanupFailures(Exception failure, ImmutableArray<Exception>.Builder cleanupFailures)
    {
        if (cleanupFailures.Count != 0)
        {
            ImmutableArray<Exception> existing = failure.Data[StagedWriteCleanupFailuresKey] is ImmutableArray<Exception> recorded
                && !recorded.IsDefault ? recorded : [];
            failure.Data[StagedWriteCleanupFailuresKey] = existing.AddRange(cleanupFailures);
        }
    }

    internal sealed class GrantIoDeadline : IDisposable
    {
        private static readonly TimeSpan s_maximumTimerDelay = TimeSpan.FromMilliseconds(uint.MaxValue - 1);

        private readonly object _gate = new();
        private readonly DateTimeOffset _expiresAt;
        private readonly TimeProvider _timeProvider;
        private readonly CancellationToken _callerToken;
        private readonly CancellationTokenSource _expiry;
        private readonly CancellationTokenSource _linked;
        private readonly ITimer _timer;
        private bool _disposed;
        private bool _resourcesReleased;
        private int _activeCallbacks;

        internal GrantIoDeadline(DateTimeOffset expiresAt, CancellationToken callerToken, TimeProvider timeProvider)
        {
            _expiresAt = expiresAt;
            _timeProvider = timeProvider;
            _callerToken = callerToken;
            callerToken.ThrowIfCancellationRequested();
            TimeSpan remaining = expiresAt - _timeProvider.GetUtcNow();
            if (remaining <= TimeSpan.Zero)
            {
                throw new AuthoringExtensionContractException("Service I/O grant expired.");
            }

            _expiry = new CancellationTokenSource();
            _linked = CancellationTokenSource.CreateLinkedTokenSource(callerToken, _expiry.Token);
            try
            {
                _timer = _timeProvider.CreateTimer(static state => ((GrantIoDeadline)state!).OnTimer(),
                    this, Timeout.InfiniteTimeSpan, Timeout.InfiniteTimeSpan);
                _timer.Change(remaining < s_maximumTimerDelay ? remaining : s_maximumTimerDelay, Timeout.InfiniteTimeSpan);
            }
            catch
            {
                _timer?.Dispose();
                _linked.Dispose();
                _expiry.Dispose();
                throw;
            }
        }

        internal CancellationToken Token => _linked.Token;

        internal void ThrowIfExpiredOrCancelled()
        {
            _callerToken.ThrowIfCancellationRequested();
            if (_expiresAt <= _timeProvider.GetUtcNow())
            {
                throw new AuthoringExtensionContractException("Service I/O grant expired.");
            }

            Token.ThrowIfCancellationRequested();
        }

        private void OnTimer()
        {
            lock (_gate)
            {
                if (_disposed)
                {
                    return;
                }

                TimeSpan remaining = _expiresAt - _timeProvider.GetUtcNow();
                if (remaining > TimeSpan.Zero)
                {
                    // System timers have a finite range; rearm without changing the grant.
                    _timer.Change(remaining < s_maximumTimerDelay ? remaining : s_maximumTimerDelay, Timeout.InfiniteTimeSpan);
                    return;
                }

                _activeCallbacks++;
            }

            try
            {
                _expiry.Cancel();
            }
            finally
            {
                lock (_gate)
                {
                    _activeCallbacks--;
                    if (_resourcesReleased && _activeCallbacks == 0)
                    {
                        _expiry.Dispose();
                    }
                }
            }
        }

        public void Dispose()
        {
            lock (_gate)
            {
                if (_disposed)
                {
                    return;
                }
                _disposed = true;
            }

            _timer.Dispose();
            _linked.Dispose();
            lock (_gate)
            {
                _resourcesReleased = true;
                if (_activeCallbacks == 0)
                {
                    _expiry.Dispose();
                }
            }
        }
    }

    private static void SetProposalPermissions(string proposalPath)
    {
        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(proposalPath, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        }
    }

    public ValueTask RevokeStagedWriteAsync(
        AuthoringServiceIoReceipt receipt,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!string.Equals(receipt.Outcome, "write-staged-for-host-approval", StringComparison.Ordinal) ||
            receipt.ArtifactReference is null || receipt.ArtifactReference.Length != 64 ||
            receipt.ArtifactReference.Any(static character =>
                character is not (>= '0' and <= '9') and not (>= 'a' and <= 'f')))
        {
            throw new AuthoringExtensionContractException("Staged write receipt is not an owned opaque artifact.");
        }

        string path = Path.Combine(_privateStagingRoot, receipt.ArtifactReference);
        if (File.Exists(path))
        {
            File.Delete(path);
        }

        return ValueTask.CompletedTask;
    }

    private static AuthoringServiceIoResult CreateResult(
        string grantId,
        string runtimeIdentity,
        string purpose,
        ImmutableArray<byte> payload,
        string outcome) =>
        new(
            new AuthoringServiceIoReceipt(
                grantId,
                runtimeIdentity,
                purpose,
                payload.Length,
                Convert.ToHexStringLower(SHA256.HashData(payload.AsSpan())),
                outcome,
                null),
            [.. payload]);
}
