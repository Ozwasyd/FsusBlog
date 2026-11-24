namespace FsusBlog.V2.Contracts;

public static class SearchCorpusPatch
{
    public const string ContentType = "application/vnd.fsus.search-patch";
    public const string Accept = ContentType + ", " + Aeds.ContentType;

    /// <summary>Encodes one changed span between independently sealed compact pages.</summary>
    public static byte[]? TryCreate(long baseGeneration, long targetGeneration, int page, ReadOnlySpan<byte> basis,
        ReadOnlySpan<byte> target, ReadOnlySpan<byte> baseDigest, ReadOnlySpan<byte> targetDigest, CancellationToken ct)
    {
        if (basis.Length is 0 or > WireLimits.SearchCorpusPatchPageBytes ||
            target.Length is 0 or > WireLimits.SearchCorpusPatchPageBytes) return null;
        if (baseGeneration < 0 || targetGeneration < 0 || baseGeneration == targetGeneration ||
            page is < 2 or > WireLimits.SearchCorpusMaxPages || baseDigest.Length != 32 || targetDigest.Length != 32)
            throw new ArgumentException("A corpus patch requires distinct sealed generations, a continuation page and two SHA-256 digests.");

        ct.ThrowIfCancellationRequested();
        var common = Math.Min(basis.Length, target.Length);
        var prefix = 0;
        while (prefix < common && basis[prefix] == target[prefix]) prefix++;
        var suffix = 0;
        while (suffix < common - prefix && basis[^(suffix + 1)] == target[^(suffix + 1)]) suffix++;
        ct.ThrowIfCancellationRequested();

        var literal = target.Slice(prefix, target.Length - prefix - suffix);
        var length = SearchCorpusPatchHeaderSize + literal.Length;
        if (length > Math.Min(WireLimits.SearchCorpusPatchBytes, target.Length / 2)) return null;

        var patch = new byte[length];
        BinaryPrimitives.WriteInt32LittleEndian(patch, SearchCorpusPatchMagic);
        BinaryPrimitives.WriteInt32LittleEndian(patch.AsSpan(4), SearchCorpusPatchVersion);
        BinaryPrimitives.WriteInt64LittleEndian(patch.AsSpan(8), baseGeneration);
        BinaryPrimitives.WriteInt64LittleEndian(patch.AsSpan(16), targetGeneration);
        BinaryPrimitives.WriteInt32LittleEndian(patch.AsSpan(24), page);
        BinaryPrimitives.WriteInt32LittleEndian(patch.AsSpan(28), basis.Length);
        BinaryPrimitives.WriteInt32LittleEndian(patch.AsSpan(32), target.Length);
        BinaryPrimitives.WriteInt32LittleEndian(patch.AsSpan(36), prefix);
        BinaryPrimitives.WriteInt32LittleEndian(patch.AsSpan(40), suffix);
        baseDigest.CopyTo(patch.AsSpan(44, 32));
        targetDigest.CopyTo(patch.AsSpan(76, 32));
        literal.CopyTo(patch.AsSpan(SearchCorpusPatchHeaderSize));
        return patch;
    }
}
