using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;

namespace FsusBlog.Server.Infrastructure.PublicReadArtifacts;

public sealed record PublicHotReadResidentBreakdown(
    long TotalBytes,
    long RawAedsBytes,
    long BrotliBytes,
    long GzipBytes,
    long HtmlBytes,
    long HtmlTemplateBytes,
    long KeyIndexBytes,
    long ArticleBytes,
    long ListBytes,
    long TaxonomyBytes,
    long HtmlResidentBytes,
    long BaseBytes,
    long OverlayBytes,
    long RemovedSetBytes,
    int ArtifactCount,
    int ObjectCount,
    int ArrayCount,
    int LohEligibleArrayCount,
    long LohEligibleArrayBytes)
{
    public static readonly PublicHotReadResidentBreakdown Empty = new(
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);

    public long CompressedBytes => BrotliBytes + GzipBytes;
}

public sealed record PublicHotReadBudgetLimits(
    long ContainerMemoryLimitBytes,
    long MaxResidentBytes,
    long MaxRawBytes,
    long MaxCompressedBytes,
    long MaxHtmlBytes,
    long MaxSnapshotOverlapBytes,
    long MaxArticleResidentBytes,
    int MaxArtifactObjects)
{
    internal static PublicHotReadBudgetLimits Resolve(
        PublicHotReadOptions options,
        long? availableMemoryBytes = null)
    {
        ArgumentNullException.ThrowIfNull(options);
        ValidateNonNegative(options.MaxResidentBytes, nameof(options.MaxResidentBytes));
        ValidateNonNegative(options.MaxRawBytes, nameof(options.MaxRawBytes));
        ValidateNonNegative(options.MaxCompressedBytes, nameof(options.MaxCompressedBytes));
        ValidateNonNegative(options.MaxHtmlBytes, nameof(options.MaxHtmlBytes));
        ValidateNonNegative(options.MaxSnapshotOverlapBytes, nameof(options.MaxSnapshotOverlapBytes));
        ValidateNonNegative(options.MaxArticleResidentBytes, nameof(options.MaxArticleResidentBytes));
        ArgumentOutOfRangeException.ThrowIfNegative(options.MaxArtifactObjects);

        long available = availableMemoryBytes ?? GC.GetGCMemoryInfo().TotalAvailableMemoryBytes;
        if (available <= 0)
        {
            available = Math.Max(Environment.WorkingSet * 4, 512L * 1024 * 1024);
        }

        long resident = options.MaxResidentBytes > 0
            ? options.MaxResidentBytes
            : Math.Clamp(available / 8, 64L * 1024 * 1024, 2L * 1024 * 1024 * 1024);
        long raw = options.MaxRawBytes > 0 ? options.MaxRawBytes : Scale(resident, 3, 4);
        long compressed = options.MaxCompressedBytes > 0 ? options.MaxCompressedBytes : Scale(resident, 1, 2);
        long html = options.MaxHtmlBytes > 0 ? options.MaxHtmlBytes : Scale(resident, 1, 2);
        long overlap = options.MaxSnapshotOverlapBytes > 0
            ? options.MaxSnapshotOverlapBytes
            : checked(resident <= long.MaxValue / 2 ? resident * 2 : long.MaxValue);
        long article = options.MaxArticleResidentBytes > 0
            ? options.MaxArticleResidentBytes
            : Math.Min(Scale(resident, 1, 2), Scale(raw, 3, 4));
        int objects = options.MaxArtifactObjects > 0
            ? options.MaxArtifactObjects
            : (int)Math.Clamp(resident / 1024, 16_384, 1_000_000);

        return new PublicHotReadBudgetLimits(
            available,
            resident,
            raw,
            compressed,
            html,
            overlap,
            Math.Max(1, article),
            objects);
    }

    private static long Scale(long value, long numerator, long denominator)
        => checked((value / denominator * numerator) + (value % denominator * numerator / denominator));

    private static void ValidateNonNegative(long value, string name)
    {
        if (value < 0)
        {
            throw new ArgumentOutOfRangeException(name, value, "Budget values cannot be negative.");
        }
    }
}

internal readonly record struct PublicHotReadRetiringLimits(
    int MaxSnapshots,
    long MaxBytes,
    TimeSpan Deadline)
{
    internal static PublicHotReadRetiringLimits Resolve(
        PublicHotReadOptions options,
        PublicHotReadBudgetLimits budgets)
    {
        ArgumentNullException.ThrowIfNull(options);
        ArgumentNullException.ThrowIfNull(budgets);
        ArgumentOutOfRangeException.ThrowIfNegative(options.MaxRetiringSnapshots);
        ArgumentOutOfRangeException.ThrowIfNegative(options.MaxRetiringBytes);
        if (options.RetiringSnapshotDeadline < TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(
                nameof(options.RetiringSnapshotDeadline),
                options.RetiringSnapshotDeadline,
                "Retiring snapshot deadline cannot be negative.");
        }

        int maxSnapshots = options.MaxRetiringSnapshots;
        long maxBytes = options.MaxRetiringBytes > 0
            ? options.MaxRetiringBytes
            : Math.Min(budgets.MaxSnapshotOverlapBytes, budgets.MaxResidentBytes);
        TimeSpan deadline = options.RetiringSnapshotDeadline;
        return new(maxSnapshots, Math.Max(1, maxBytes), deadline);
    }
}

internal static class PublicHotReadResidentAccounting
{
    internal const int LohThresholdBytes = 85_000;
    private const int MapObjectUpperBoundBytes = 96;
    private const int EntryObjectUpperBoundBytes = 40;
    private const int LogicalArtifactObjectUpperBoundBytes = 48;
    private const int BinaryIntegrityMetadataBytes = 3 * sizeof(ulong) * 2;
    private const int HtmlIntegrityMetadataBytes = 2 * sizeof(ulong) * 2;

    internal static PublicHotReadResidentBreakdown Calculate(
        IEnumerable<KeyValuePair<int, PublicBinaryArtifact>> articles,
        IEnumerable<KeyValuePair<PublicListKey, PublicBinaryArtifact>> lists,
        in PublicBinaryArtifact category,
        in PublicBinaryArtifact tag,
        IEnumerable<KeyValuePair<string, PublicHtmlArtifact>> htmlBase,
        IEnumerable<KeyValuePair<string, PublicHtmlArtifact>> htmlOverlay,
        IEnumerable<string> htmlRemoved)
    {
        var state = new AccountingState();
        state.ObjectCount += 6;
        state.KeyIndexBytes += 6L * MapObjectUpperBoundBytes;

        foreach ((int _, PublicBinaryArtifact artifact) in articles)
        {
            long bytes = state.AddBinary(artifact);
            state.ArticleBytes += bytes;
            state.AddFixedIndex(sizeof(int));
        }

        foreach ((PublicListKey _, PublicBinaryArtifact artifact) in lists)
        {
            long bytes = state.AddBinary(artifact);
            state.ListBytes += bytes;
            state.AddFixedIndex(Unsafe.SizeOf<PublicListKey>());
        }

        long categoryBytes = state.AddBinary(category);
        long tagBytes = state.AddBinary(tag);
        state.TaxonomyBytes += categoryBytes + tagBytes;

        foreach ((string key, PublicHtmlArtifact artifact) in htmlBase)
        {
            long bytes = state.AddHtml(key, artifact);
            state.BaseBytes += bytes;
        }

        foreach ((string key, PublicHtmlArtifact artifact) in htmlOverlay)
        {
            long bytes = state.AddHtml(key, artifact);
            state.OverlayBytes += bytes;
        }

        foreach (string key in htmlRemoved)
        {
            long bytes = EstimateStringBytes(key) + EntryObjectUpperBoundBytes;
            state.KeyIndexBytes += bytes;
            state.RemovedSetBytes += bytes;
            state.ObjectCount += 2;
        }

        long total = state.RawAedsBytes
            + state.BrotliBytes
            + state.GzipBytes
            + state.HtmlBytes
            + state.HtmlTemplateBytes
            + state.KeyIndexBytes;
        return new PublicHotReadResidentBreakdown(
            total,
            state.RawAedsBytes,
            state.BrotliBytes,
            state.GzipBytes,
            state.HtmlBytes,
            state.HtmlTemplateBytes,
            state.KeyIndexBytes,
            state.ArticleBytes,
            state.ListBytes,
            state.TaxonomyBytes,
            state.HtmlResidentBytes,
            state.BaseBytes,
            state.OverlayBytes,
            state.RemovedSetBytes,
            state.ArtifactCount,
            state.ObjectCount,
            state.ArrayCount,
            state.LohEligibleArrayCount,
            state.LohEligibleArrayBytes);
    }

    internal static IReadOnlyList<string> ValidateCandidate(
        PublicHotReadResidentBreakdown candidate,
        long overlapBytes,
        PublicHotReadBudgetLimits limits)
    {
        var violations = new List<string>(6);
        AddIfExceeded(violations, "resident", candidate.TotalBytes, limits.MaxResidentBytes);
        AddIfExceeded(violations, "raw", candidate.RawAedsBytes, limits.MaxRawBytes);
        AddIfExceeded(violations, "compressed", candidate.CompressedBytes, limits.MaxCompressedBytes);
        AddIfExceeded(violations, "html", candidate.HtmlResidentBytes, limits.MaxHtmlBytes);
        AddIfExceeded(violations, "snapshot-overlap", overlapBytes, limits.MaxSnapshotOverlapBytes);
        if (candidate.ObjectCount > limits.MaxArtifactObjects)
        {
            violations.Add($"objects:{candidate.ObjectCount}>{limits.MaxArtifactObjects}");
        }
        return violations;
    }

    internal static long EstimateArticleArtifactBytes(in PublicBinaryArtifact artifact)
    {
        var state = new AccountingState();
        _ = state.AddBinary(artifact);
        state.AddFixedIndex(sizeof(int));
        return state.RawAedsBytes
            + state.BrotliBytes
            + state.GzipBytes
            + state.KeyIndexBytes;
    }

    private static void AddIfExceeded(List<string> violations, string name, long actual, long limit)
    {
        if (actual > limit)
        {
            violations.Add($"{name}:{actual}>{limit}");
        }
    }

    private static long EstimateStringBytes(string value)
        => 24L + ((long)value.Length * sizeof(char));

    private sealed class AccountingState
    {
        internal long RawAedsBytes;
        internal long BrotliBytes;
        internal long GzipBytes;
        internal long HtmlBytes;
        internal long HtmlTemplateBytes;
        internal long KeyIndexBytes;
        internal long ArticleBytes;
        internal long ListBytes;
        internal long TaxonomyBytes;
        internal long HtmlResidentBytes;
        internal long BaseBytes;
        internal long OverlayBytes;
        internal long RemovedSetBytes;
        internal int ArtifactCount;
        internal int ObjectCount;
        internal int ArrayCount;
        internal int LohEligibleArrayCount;
        internal long LohEligibleArrayBytes;

        internal long AddBinary(in PublicBinaryArtifact artifact)
        {
            if (artifact.Frame.IsEmpty && artifact.BrotliFrame.IsEmpty && artifact.GzipFrame.IsEmpty)
            {
                return 0;
            }

            ArtifactCount++;
            ObjectCount++;
            long metadataBytes = LogicalArtifactObjectUpperBoundBytes
                + BinaryIntegrityMetadataBytes
                + AddMetadataString(artifact.ETag)
                + AddMetadataString(artifact.CacheControl)
                + AddMetadataString(artifact.BrotliETag)
                + AddMetadataString(artifact.GzipETag);
            KeyIndexBytes += metadataBytes;
            long before = RawAedsBytes + BrotliBytes + GzipBytes;
            RawAedsBytes += AddMemory(artifact.Frame);
            BrotliBytes += AddMemory(artifact.BrotliFrame);
            GzipBytes += AddMemory(artifact.GzipFrame);
            return (RawAedsBytes + BrotliBytes + GzipBytes) - before + metadataBytes;
        }

        internal long AddHtml(string key, in PublicHtmlArtifact artifact)
        {
            ArtifactCount++;
            ObjectCount += 2;
            long keyBytes = EstimateStringBytes(key)
                + EntryObjectUpperBoundBytes
                + LogicalArtifactObjectUpperBoundBytes
                + HtmlIntegrityMetadataBytes
                + AddMetadataString(artifact.ContentType)
                + AddMetadataString(artifact.ETag)
                + AddMetadataString(artifact.CacheControl);
            KeyIndexBytes += keyBytes;
            long html = AddMemory(artifact.Bytes);
            HtmlBytes += html;
            long template = artifact.CspNonceTemplate?.ResidentBytes ?? 0;
            HtmlTemplateBytes += template;
            HtmlResidentBytes += html + template + keyBytes;
            if (artifact.CspNonceTemplate is { } nonceTemplate)
            {
                ObjectCount += nonceTemplate.ResidentObjectCount;
                ArrayCount += nonceTemplate.ResidentArrayCount;
                LohEligibleArrayCount += nonceTemplate.LohEligibleArrayCount;
                LohEligibleArrayBytes += nonceTemplate.LohEligibleArrayBytes;
            }
            return html + template + keyBytes;
        }

        internal void AddFixedIndex(int keyBytes)
        {
            KeyIndexBytes += EntryObjectUpperBoundBytes + keyBytes;
            ObjectCount++;
        }

        private long AddMemory(ReadOnlyMemory<byte> memory)
        {
            if (memory.IsEmpty)
            {
                return 0;
            }

            ArrayCount++;
            ObjectCount++;
            int bytes = MemoryMarshal.TryGetArray(memory, out ArraySegment<byte> segment)
                && segment.Array is not null
                    ? segment.Array.Length
                    : memory.Length;
            if (bytes >= LohThresholdBytes)
            {
                LohEligibleArrayCount++;
                LohEligibleArrayBytes += bytes;
            }

            return bytes;
        }

        private long AddMetadataString(string value)
        {
            if (string.IsNullOrEmpty(value))
            {
                return 0;
            }
            ObjectCount++;
            return EstimateStringBytes(value);
        }
    }
}
