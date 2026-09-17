using System.Text.Json;

namespace FsusBlog.Server.Infrastructure.Storage;

public sealed record UploadCommitTempCleanupCandidate(
    string Path,
    DateTimeOffset LastWriteUtc,
    bool Protected,
    string Reason);

/// <summary>
/// Exclusive, renewable lease for cleaning orphaned upload commit files.
/// Ownership is guarded both by an OS-level exclusive handle and a random CAS token.
/// </summary>
public sealed class UploadCommitTempCleanupLease : IAsyncDisposable
{
    private const string LeaseFileName = ".cleanup-lease.json";
    private readonly FileStream _stream;
    private readonly string _leasePath;
    private readonly string _token;
    private bool _disposed;

    private UploadCommitTempCleanupLease(FileStream stream, string leasePath, string token)
    {
        _stream = stream;
        _leasePath = leasePath;
        _token = token;
    }

    public string Token => _token;

    public static async Task<UploadCommitTempCleanupLease?> TryAcquireAsync(
        string incomingRoot,
        string owner,
        TimeSpan ttl,
        CancellationToken cancellationToken = default)
    {
        if (ttl <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(ttl));
        }

        Directory.CreateDirectory(incomingRoot);
        string leasePath = Path.Combine(Path.GetFullPath(incomingRoot), LeaseFileName);
        FileStream stream;
        try
        {
            stream = new FileStream(leasePath, new FileStreamOptions
            {
                Mode = FileMode.OpenOrCreate,
                Access = FileAccess.ReadWrite,
                Share = FileShare.None,
                BufferSize = 4096,
                Options = FileOptions.Asynchronous | FileOptions.WriteThrough
            });
        }
        catch (IOException)
        {
            return null;
        }
        catch (UnauthorizedAccessException)
        {
            return null;
        }

        string token = Convert.ToHexStringLower(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32));
        var lease = new UploadCommitTempCleanupLease(stream, leasePath, token);
        try
        {
            await lease.WriteLeaseAsync(owner, ttl, cancellationToken);
            return lease;
        }
        catch
        {
            await lease.DisposeAsync();
            throw;
        }
    }

    public async Task RenewAsync(string owner, TimeSpan ttl, CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (ttl <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(ttl));
        }

        LeaseDocument? current = await ReadLeaseAsync(cancellationToken);
        if (current is null || !string.Equals(current.Token, _token, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("Upload cleanup lease CAS token changed.");
        }

        await WriteLeaseAsync(owner, ttl, cancellationToken);
    }

    public static IReadOnlyList<UploadCommitTempCleanupCandidate> Plan(
        string incomingRoot,
        string currentInstanceDirectoryName,
        DateTimeOffset olderThanUtc)
    {
        string normalizedRoot = Path.GetFullPath(incomingRoot);
        if (!Directory.Exists(normalizedRoot))
        {
            return [];
        }

        var result = new List<UploadCommitTempCleanupCandidate>();
        foreach (string directory in Directory.EnumerateDirectories(normalizedRoot).Order(StringComparer.Ordinal))
        {
            string name = Path.GetFileName(directory);
            bool isCurrent = string.Equals(name, currentInstanceDirectoryName, StringComparison.Ordinal);
            foreach (string file in Directory.EnumerateFiles(directory, "*.tmp", SearchOption.TopDirectoryOnly).Order(StringComparer.Ordinal))
            {
                DateTimeOffset lastWrite = File.GetLastWriteTimeUtc(file);
                bool retained = isCurrent || lastWrite >= olderThanUtc;
                result.Add(new UploadCommitTempCleanupCandidate(
                    file,
                    lastWrite,
                    retained,
                    isCurrent ? "current-instance" : retained ? "retention-window" : "expired-orphan"));
            }
        }

        return result;
    }

    public IReadOnlyList<UploadCommitTempCleanupCandidate> Execute(
        string currentInstanceDirectoryName,
        DateTimeOffset olderThanUtc,
        bool dryRun = true)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        string incomingRoot = Path.GetDirectoryName(_leasePath)!;
        IReadOnlyList<UploadCommitTempCleanupCandidate> plan = Plan(
            incomingRoot,
            currentInstanceDirectoryName,
            olderThanUtc);
        if (dryRun)
        {
            return plan;
        }

        string normalizedRootPrefix = Path.TrimEndingDirectorySeparator(Path.GetFullPath(incomingRoot))
            + Path.DirectorySeparatorChar;
        StringComparison comparison = OperatingSystem.IsWindows()
            ? StringComparison.OrdinalIgnoreCase
            : StringComparison.Ordinal;
        foreach (UploadCommitTempCleanupCandidate candidate in plan.Where(static candidate => !candidate.Protected))
        {
            string normalizedCandidate = Path.GetFullPath(candidate.Path);
            if (!normalizedCandidate.StartsWith(normalizedRootPrefix, comparison))
            {
                throw new InvalidOperationException("Upload cleanup candidate escaped the incoming root.");
            }

            File.Delete(normalizedCandidate);
        }

        return plan;
    }

    public async Task<IReadOnlyList<UploadCommitTempCleanupCandidate>> ExecuteAsync(
        string currentInstanceDirectoryName,
        DateTimeOffset olderThanUtc,
        bool dryRun,
        Func<UploadCommitTempCleanupCandidate, CancellationToken, ValueTask>? beforeDelete,
        CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        string incomingRoot = Path.GetDirectoryName(_leasePath)!;
        IReadOnlyList<UploadCommitTempCleanupCandidate> plan = Plan(
            incomingRoot,
            currentInstanceDirectoryName,
            olderThanUtc);
        if (dryRun)
        {
            return plan;
        }

        string normalizedRootPrefix = Path.TrimEndingDirectorySeparator(Path.GetFullPath(incomingRoot))
            + Path.DirectorySeparatorChar;
        StringComparison comparison = OperatingSystem.IsWindows()
            ? StringComparison.OrdinalIgnoreCase
            : StringComparison.Ordinal;
        foreach (UploadCommitTempCleanupCandidate candidate in plan.Where(static candidate => !candidate.Protected))
        {
            cancellationToken.ThrowIfCancellationRequested();
            string normalizedCandidate = Path.GetFullPath(candidate.Path);
            if (!normalizedCandidate.StartsWith(normalizedRootPrefix, comparison))
            {
                throw new InvalidOperationException("Upload cleanup candidate escaped the incoming root.");
            }

            if (beforeDelete is not null)
            {
                await beforeDelete(candidate, cancellationToken).ConfigureAwait(false);
            }

            File.Delete(normalizedCandidate);
        }

        return plan;
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        bool ownsLease = false;
        try
        {
            LeaseDocument? current = await ReadLeaseAsync(CancellationToken.None);
            ownsLease = string.Equals(current?.Token, _token, StringComparison.Ordinal);
        }
        finally
        {
            await _stream.DisposeAsync();
            if (ownsLease)
            {
                try
                {
                    File.Delete(_leasePath);
                }
                catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
                {
                    // Expiry in the persisted lease lets the next owner recover safely.
                }
            }
        }
    }

    private async Task WriteLeaseAsync(string owner, TimeSpan ttl, CancellationToken cancellationToken)
    {
        var document = new LeaseDocument(
            "fsusblog.upload-temp-cleanup-lease.v1",
            owner,
            _token,
            DateTimeOffset.UtcNow,
            DateTimeOffset.UtcNow.Add(ttl));
        byte[] payload = JsonSerializer.SerializeToUtf8Bytes(document);
        _stream.Position = 0;
        _stream.SetLength(0);
        await _stream.WriteAsync(payload, cancellationToken);
        await _stream.FlushAsync(cancellationToken);
        _stream.Flush(flushToDisk: true);
    }

    private async Task<LeaseDocument?> ReadLeaseAsync(CancellationToken cancellationToken)
    {
        _stream.Position = 0;
        if (_stream.Length == 0)
        {
            return null;
        }

        return await JsonSerializer.DeserializeAsync<LeaseDocument>(_stream, cancellationToken: cancellationToken);
    }

    private sealed record LeaseDocument(
        string Schema,
        string Owner,
        string Token,
        DateTimeOffset AcquiredAt,
        DateTimeOffset ExpiresAt);
}
