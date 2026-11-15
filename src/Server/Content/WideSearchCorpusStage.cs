using System.Buffers.Binary;
using System.Security.Cryptography;
using FsusBlog.V2.Contracts;
using Microsoft.Win32.SafeHandles;

namespace FsusBlog.V2.Server.Content;

internal readonly record struct WideSearchCorpusPage(int Number, int DocumentCount, int FirstArticleId, int LastArticleId,
    long Offset, int Length, string Sha256);

internal sealed record WideSearchCorpusManifest(int DocumentCount, long ByteCount, string ContentDigest,
    IReadOnlyList<WideSearchCorpusPage> Pages);

/// <summary>Owns an unpublished, sealed FSPK artifact through one unlinked file handle.</summary>
internal sealed class WideSearchCorpusStage : IDisposable
{
    private readonly object _gate = new();
    private readonly TaskCompletionSource _closed = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly SafeFileHandle _handle;
    private FileStream? _file;
    private int _readers;
    private bool _retired;

    private WideSearchCorpusStage(FileStream file, WideSearchCorpusManifest manifest)
    {
        _file = file;
        _handle = file.SafeFileHandle;
        Manifest = manifest;
    }

    internal WideSearchCorpusManifest Manifest { get; }
    internal Task Closed => _closed.Task;

    internal static WideSearchCorpusStage? Build(IReadOnlyList<Article> articles, int maxPages, int maxAggregateBytes,
        CancellationToken ct = default)
    {
        ct.ThrowIfCancellationRequested();
        ArgumentNullException.ThrowIfNull(articles);
        var documentCount = articles.Count;
        var file = OpenUnlinked();
        var transferred = false;
        Exception? workFailure = null;
        try
        {
            var pages = new List<WideSearchCorpusPage>();
            if (!LocalSearchCorpus.TryStagePages(articles, maxPages, maxAggregateBytes, page =>
                {
                    ct.ThrowIfCancellationRequested();
                    var entry = new WideSearchCorpusPage(page.Number, page.DocumentCount, page.FirstArticleId,
                        page.LastArticleId, file.Position, page.Bytes.Length,
                        Convert.ToHexStringLower(SHA256.HashData(page.Bytes)));
                    ct.ThrowIfCancellationRequested();
                    file.Write(page.Bytes);
                    pages.Add(entry);
                    return true;
                }, ct))
                return null;

            file.Flush();
            var manifest = Seal(documentCount, file.Length, pages);
            ct.ThrowIfCancellationRequested();
            var artifact = new WideSearchCorpusStage(file, manifest);
            transferred = true;
            return artifact;
        }
        catch (Exception failure)
        {
            workFailure = failure;
            throw;
        }
        finally
        {
            try { if (!transferred) file.Dispose(); }
            catch (Exception cleanup) when (workFailure is { } failure)
            {
                throw new AggregateException(failure, cleanup);
            }
        }
    }

    internal PageRead? Borrow(int number)
    {
        if (number < 1 || number > Manifest.Pages.Count) return null;
        lock (_gate)
        {
            if (_retired || _file is null) return null;
            var result = new PageRead(this, _handle, Manifest.Pages[number - 1]);
            _readers++;
            return result;
        }
    }

    public void Dispose()
    {
        FileStream? closing = null;
        lock (_gate)
        {
            _retired = true;
            if (_readers == 0)
            {
                closing = _file;
                _file = null;
            }
        }
        Close(closing);
    }

    private void Release()
    {
        FileStream? closing = null;
        lock (_gate)
        {
            _readers--;
            if (_retired && _readers == 0)
            {
                closing = _file;
                _file = null;
            }
        }
        Close(closing);
    }

    private void Close(FileStream? file)
    {
        if (file is null) return;
        try
        {
            file.Dispose();
            _closed.SetResult();
        }
        catch (Exception error)
        {
            _closed.SetException(error);
            throw;
        }
    }

    internal sealed class PageRead(WideSearchCorpusStage stage, SafeFileHandle handle, WideSearchCorpusPage page) : IDisposable
    {
        private WideSearchCorpusStage? _owner = stage;

        internal async ValueTask ReadAsync(Memory<byte> destination, CancellationToken ct = default)
        {
            if (destination.Length != page.Length)
                throw new ArgumentException("Destination length must match the sealed search page.", nameof(destination));
            var owner = Interlocked.Exchange(ref _owner, null) ?? throw new ObjectDisposedException(nameof(PageRead));
            Exception? workFailure = null;
            try
            {
                ct.ThrowIfCancellationRequested();
                var read = 0;
                while (read < destination.Length)
                {
                    var count = await RandomAccess.ReadAsync(handle, destination[read..], page.Offset + read, ct);
                    if (count == 0) throw new EndOfStreamException("The sealed search page is incomplete.");
                    read += count;
                }
                if (Convert.ToHexStringLower(SHA256.HashData(destination.Span)) != page.Sha256)
                    throw new InvalidDataException("The sealed search page has an invalid digest.");
                ct.ThrowIfCancellationRequested();
            }
            catch (Exception failure)
            {
                workFailure = failure;
                throw;
            }
            finally
            {
                try { owner.Release(); }
                catch (Exception cleanup) when (workFailure is { } failure)
                {
                    throw new AggregateException(failure, cleanup);
                }
            }
        }

        public void Dispose() => Interlocked.Exchange(ref _owner, null)?.Release();
    }

    private static WideSearchCorpusManifest Seal(int documentCount, long byteCount, List<WideSearchCorpusPage> pages)
    {
        if (pages.Count == 0 || pages.Sum(page => page.DocumentCount) != documentCount ||
            pages[^1].Offset + pages[^1].Length != byteCount)
            throw new InvalidDataException("The staged search corpus does not match its manifest.");
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        hash.AppendData("public-search-fspk-manifest-v1\0"u8);
        Span<byte> record = stackalloc byte[28];
        BinaryPrimitives.WriteInt32LittleEndian(record, documentCount);
        BinaryPrimitives.WriteInt32LittleEndian(record[4..], pages.Count);
        BinaryPrimitives.WriteInt64LittleEndian(record[8..], byteCount);
        hash.AppendData(record[..16]);
        foreach (var page in pages)
        {
            BinaryPrimitives.WriteInt32LittleEndian(record, page.Number);
            BinaryPrimitives.WriteInt32LittleEndian(record[4..], page.DocumentCount);
            BinaryPrimitives.WriteInt32LittleEndian(record[8..], page.FirstArticleId);
            BinaryPrimitives.WriteInt32LittleEndian(record[12..], page.LastArticleId);
            BinaryPrimitives.WriteInt64LittleEndian(record[16..], page.Offset);
            BinaryPrimitives.WriteInt32LittleEndian(record[24..], page.Length);
            hash.AppendData(record);
            hash.AppendData(Convert.FromHexString(page.Sha256));
        }
        return new WideSearchCorpusManifest(documentCount, byteCount, Convert.ToHexStringLower(hash.GetHashAndReset()),
            pages.AsReadOnly());
    }

    private static FileStream OpenUnlinked()
    {
        if (OperatingSystem.IsWindows())
            throw new PlatformNotSupportedException("Search spooling requires Unix file ownership.");
        const UnixFileMode privateFile = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        const UnixFileMode privateDirectory = privateFile | UnixFileMode.UserExecute;
        var directory = Directory.CreateTempSubdirectory("fsusblog-fspk-");
        var path = Path.Combine(directory.FullName, "corpus");
        FileStream? file = null;
        var linked = false;
        try
        {
            if (File.GetUnixFileMode(directory.FullName) != privateDirectory)
                throw new IOException("Search spool directory permissions must be 0700.");
            file = new FileStream(path, new FileStreamOptions
            {
                Access = FileAccess.ReadWrite,
                Mode = FileMode.CreateNew,
                Share = FileShare.None,
                Options = FileOptions.Asynchronous,
                UnixCreateMode = privateFile
            });
            linked = true;
            if (File.GetUnixFileMode(path) != privateFile)
                throw new IOException("Search spool file permissions must be 0600.");
            File.Delete(path);
            linked = false;
            Directory.Delete(directory.FullName);
            return file;
        }
        catch (Exception failure)
        {
            try
            {
                file?.Dispose();
                if (linked) File.Delete(path);
                Directory.Delete(directory.FullName);
            }
            catch (Exception cleanup)
            {
                throw new AggregateException(failure, cleanup);
            }
            throw;
        }
    }
}
