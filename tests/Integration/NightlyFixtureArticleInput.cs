using System.Buffers.Text;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace FsusBlog.V2.Integration.Tests;

public sealed partial class NightlyFixturePostgresTests
{
    private const int ShardedPlanMaxLineBytes = 64 * 1024;
    private const int ShardedPlanMaxRows = 65_536;
    private const long ShardedPlanMaxBytes = 512L * 1024 * 1024;
    private static readonly byte[] ShardedPlanHeader = Encoding.ASCII.GetBytes(Header + "\n");
    private static readonly UTF8Encoding ShardedPlanUtf8 = new(false, true);

    private static async Task<Stream> OpenShardedArticleInputAsync(string manifestPath, int count, long due,
        string manifestSha, string logicalSha, CancellationToken ct)
    {
        if (!Path.IsPathFullyQualified(manifestPath) || count != CheckpointPilotCount || due <= 0 ||
            !IsShardedPlanSha(manifestSha) || !IsShardedPlanSha(logicalSha))
            throw new InvalidOperationException("Expected the sealed 20-article sharded checkpoint plan.");

        var directory = PrivateDirectory(Path.GetDirectoryName(manifestPath)!);
        await using var manifest = OpenShardedPlanFile(Path.Combine(directory, Path.GetFileName(manifestPath)));
        long manifestLength = manifest.Length;
        if (manifestLength is <= 0 or > ShardedPlanMaxLineBytes)
            throw new InvalidOperationException("The sharded checkpoint manifest exceeds its byte budget.");
        var manifestBytes = new byte[(int)manifestLength];
        await manifest.ReadExactlyAsync(manifestBytes, ct);
        if (manifest.Length != manifestBytes.Length || Convert.ToHexStringLower(SHA256.HashData(manifestBytes)) != manifestSha)
            throw new InvalidOperationException("The sharded checkpoint manifest differs from its recorded SHA-256.");

        using var document = JsonDocument.Parse(manifestBytes, new JsonDocumentOptions
        {
            AllowDuplicateProperties = false,
            MaxDepth = 16
        });
        var plan = document.RootElement;
        var entries = plan.GetProperty("articleShards");
        if (plan.GetProperty("format").GetString() != "fsusblog-v2-nightly-postgres-fixture-v3" ||
            plan.GetProperty("profile").GetString() != "pilot" ||
            plan.GetProperty("sourceReference").GetString() != "2605b438eed8f16d12ddddf033d08a6fa18fcd12" ||
            plan.GetProperty("articles").GetInt32() != count || plan.GetProperty("scheduleDueUnixMs").GetInt64() != due ||
            plan.GetProperty("articlePlanSha256").GetString() != logicalSha || entries.GetArrayLength() != 3)
            throw new InvalidOperationException("The sharded checkpoint manifest does not match the selected plan and schedule.");
        int shardCount = entries.GetArrayLength();
        var names = Directory.EnumerateFileSystemEntries(directory, "articles-*.tsv").Take(shardCount + 1)
            .Select(Path.GetFileName).ToHashSet(StringComparer.Ordinal);
        if (names.Count != shardCount || Enumerable.Range(1, shardCount).Any(ordinal => !names.Contains(ShardedPlanLeaf(ordinal))))
            throw new InvalidOperationException("The fixture directory does not contain the exact sealed article shards.");

        using var logicalHash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var shards = new List<ArticleInputShard>(shardCount);
        long physicalLength = 0, logicalLength = 0;
        int article = 1;
        try
        {
            foreach (var entry in entries.EnumerateArray())
            {
                int ordinal = shards.Count + 1;
                int expectedRows = Math.Min(CheckpointPilotBatchSize, count - article + 1);
                long bytes = entry.GetProperty("bytes").GetInt64();
                var sha = entry.GetProperty("sha256").GetString();
                if (entry.GetPropertyCount() != 6 || entry.GetProperty("ordinal").GetInt32() != ordinal ||
                    entry.GetProperty("firstArticle").GetInt32() != article ||
                    entry.GetProperty("lastArticle").GetInt32() != article + expectedRows - 1 ||
                    expectedRows is <= 0 or > ShardedPlanMaxRows || entry.GetProperty("rows").GetInt32() != expectedRows ||
                    bytes <= ShardedPlanHeader.Length || bytes > ShardedPlanMaxBytes - physicalLength || !IsShardedPlanSha(sha))
                    throw new InvalidOperationException($"Unexpected row interval, byte count or SHA-256 for fixture shard {ordinal}.");

                var file = OpenShardedPlanFile(Path.Combine(directory, ShardedPlanLeaf(ordinal)));
                int skip = ordinal == 1 ? 0 : ShardedPlanHeader.Length;
                shards.Add(new(file, logicalLength, skip, bytes - skip));
                await VerifyPhysicalShardAsync(file, ordinal, article, expectedRows, bytes, sha!, logicalHash, ct);
                physicalLength += bytes;
                logicalLength += bytes - skip;
                article += expectedRows;
            }

            if (article != count + 1 || Convert.ToHexStringLower(logicalHash.GetHashAndReset()) != logicalSha)
                throw new InvalidOperationException("The verified shards do not reproduce the sealed logical TSV.");
            return new ShardedArticleInput(shards, logicalLength);
        }
        catch
        {
            foreach (var shard in shards) shard.File.Dispose();
            throw;
        }
    }

    private static bool IsShardedPlanSha(string? value) =>
        value is { Length: 64 } && value.All(char.IsAsciiHexDigitLower);

    private static string ShardedPlanLeaf(int ordinal) =>
        "articles-" + ordinal.ToString("D5", CultureInfo.InvariantCulture) + ".tsv";

    private static FileStream OpenShardedPlanFile(string path)
    {
        var info = new FileInfo(path);
        const FileAttributes forbidden = FileAttributes.ReparsePoint | FileAttributes.Directory | FileAttributes.Device;
        const UnixFileMode read = UnixFileMode.UserRead;
        const UnixFileMode readWrite = read | UnixFileMode.UserWrite;
        if (OperatingSystem.IsWindows() || !info.Exists || (info.Attributes & forbidden) != 0 ||
            File.GetUnixFileMode(path) is not (read or readWrite))
            throw new InvalidOperationException("Expected a private regular fixture manifest or shard file.");

        var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, ShardedPlanMaxLineBytes,
            FileOptions.Asynchronous | FileOptions.SequentialScan);
        if (file.CanSeek) return file;
        file.Dispose();
        throw new InvalidOperationException("Expected a seekable fixture manifest or shard file.");
    }

    private static async Task VerifyPhysicalShardAsync(FileStream file, int ordinal, int first, int expectedRows, long bytes,
        string sha, IncrementalHash logical, CancellationToken ct)
    {
        if (file.Length != bytes)
            throw new InvalidOperationException($"Fixture shard {ordinal} differs from its recorded byte count.");
        var header = new byte[ShardedPlanHeader.Length];
        await file.ReadExactlyAsync(header, ct);
        if (!header.AsSpan().SequenceEqual(ShardedPlanHeader))
            throw new InvalidOperationException($"Unexpected TSV header in fixture shard {ordinal}.");

        using var physical = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        physical.AppendData(header);
        if (ordinal == 1) logical.AppendData(header);
        var buffer = new byte[ShardedPlanMaxLineBytes];
        var line = new byte[ShardedPlanMaxLineBytes];
        long remaining = bytes - header.Length;
        int length = 0, seen = 0;
        while (remaining > 0)
        {
            int read = await file.ReadAsync(buffer.AsMemory(0, (int)Math.Min(remaining, buffer.Length)), ct);
            if (read == 0) throw new EndOfStreamException($"Fixture shard {ordinal} ended before its recorded byte count.");
            physical.AppendData(buffer, 0, read);
            logical.AppendData(buffer, 0, read);
            remaining -= read;

            for (int start = 0; start < read;)
            {
                int newline = Array.IndexOf(buffer, (byte)'\n', start, read - start);
                int end = newline < 0 ? read : newline;
                int extent = end - start;
                if (extent > line.Length - length)
                    throw new InvalidOperationException($"Fixture shard {ordinal} has a record exceeding 64 KiB.");
                Array.Copy(buffer, start, line, length, extent);
                length += extent;
                if (newline < 0) break;
                if (seen >= expectedRows || !IsShardedPlanRow(line.AsSpan(0, length), first + seen))
                    throw new InvalidOperationException($"Fixture shard {ordinal} has an invalid article row at position {seen + 1}.");
                seen++;
                length = 0;
                start = end + 1;
            }
        }

        if (length != 0 || seen != expectedRows || file.Length != bytes ||
            Convert.ToHexStringLower(physical.GetHashAndReset()) != sha)
            throw new InvalidOperationException($"Fixture shard {ordinal} differs from its recorded rows or SHA-256.");
    }

    private static bool IsShardedPlanRow(ReadOnlySpan<byte> row, int expected)
    {
        int tab = row.IndexOf((byte)'\t');
        if (tab <= 0 || row[0] is < (byte)'1' or > (byte)'9' || row.IndexOfAny((byte)'\r', (byte)0) >= 0 ||
            !Utf8Parser.TryParse(row[..tab], out int article, out int consumed) || consumed != tab || article != expected)
            return false;
        int tabs = 0;
        foreach (byte value in row)
            if (value == (byte)'\t') tabs++;
        if (tabs != 7) return false;
        _ = ShardedPlanUtf8.GetCharCount(row);
        return true;
    }

    private sealed record ArticleInputShard(FileStream File, long Start, int Skip, long Length)
    {
        internal long End => Start + Length;
    }

    private sealed class ShardedArticleInput(List<ArticleInputShard> shards, long length) : Stream
    {
        private int _index;
        private long _position;
        private bool _disposed;

        public override bool CanRead => !_disposed;
        public override bool CanSeek => !_disposed;
        public override bool CanWrite => false;
        public override long Length { get { ObjectDisposedException.ThrowIf(_disposed, this); return length; } }
        public override long Position
        {
            get { ObjectDisposedException.ThrowIf(_disposed, this); return _position; }
            set => Seek(value, SeekOrigin.Begin);
        }

        public override long Seek(long offset, SeekOrigin origin)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            long anchor = origin switch
            {
                SeekOrigin.Begin => 0,
                SeekOrigin.Current => _position,
                SeekOrigin.End => length,
                _ => throw new ArgumentOutOfRangeException(nameof(origin))
            };
            long next = checked(anchor + offset);
            if (next < 0) throw new IOException("Cannot seek before the logical TSV.");
            _index = 0;
            return _position = next;
        }

        public override int Read(byte[] buffer, int offset, int count)
        {
            ArgumentNullException.ThrowIfNull(buffer);
            return Read(buffer.AsSpan(offset, count));
        }

        public override int Read(Span<byte> buffer)
        {
            if (NextRead(buffer.Length) is not { } next) return 0;
            return Advance(next.File.Read(buffer[..next.Count]));
        }

        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (NextRead(buffer.Length) is not { } next) return 0;
            return Advance(await next.File.ReadAsync(buffer[..next.Count], cancellationToken));
        }

        private (FileStream File, int Count)? NextRead(int request)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            if (request == 0 || _position >= length) return null;
            while (_position >= shards[_index].End) _index++;
            var shard = shards[_index];
            long physicalPosition = _position - shard.Start + shard.Skip;
            if (shard.File.Position != physicalPosition) shard.File.Position = physicalPosition;
            return (shard.File, (int)Math.Min(request, shard.End - _position));
        }

        private int Advance(int read)
        {
            if (read == 0) throw new EndOfStreamException("A verified fixture shard is shorter than its recorded length.");
            _position += read;
            return read;
        }

        public override void Flush() => ObjectDisposedException.ThrowIf(_disposed, this);
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        protected override void Dispose(bool disposing)
        {
            if (disposing && !_disposed)
            {
                _disposed = true;
                foreach (var shard in shards) shard.File.Dispose();
            }
            base.Dispose(disposing);
        }
    }
}
