using System.Buffers;

namespace FsusBlog.V2.Server;

internal sealed class PublicSearchFailure(int status, string message, string details) : Exception(message)
{
    internal int Status { get; } = status;
    internal string Details { get; } = details;

    internal static PublicSearchFailure InvalidQuery(string message = "A valid search term is required.") =>
        new(400, message, "search_query_invalid");

    internal static PublicSearchFailure InvalidSort() =>
        new(400, "Invalid search sort mode.", "search_sort_invalid");

    internal static PublicSearchFailure InvalidSize() =>
        new(400, "Invalid search page size.", "search_size_invalid");

    internal static PublicSearchFailure InvalidCursor() =>
        new(400, "Invalid or expired search cursor.", "search_cursor_invalid");

    internal static PublicSearchFailure GenerationChanged() =>
        new(409, "The public search index changed. Start again from the first page.", "search_generation_changed");

    internal static PublicSearchFailure UnsupportedProfile() =>
        new(400, "Unsupported public search profile.", "search_profile_unsupported");

    internal static PublicSearchFailure BudgetExceeded() =>
        new(503, "This search exceeded its work budget. Refine your query and try again.", "search_budget_exceeded");

    internal static PublicSearchFailure Unavailable() =>
        new(503, "The article search projection is unavailable.", "search_unavailable");
}

internal readonly record struct DecodedSearchCursor(SearchCursorPosition Position, int ReturnedSoFar);

/// <summary>
/// Authenticated, generation-bound opaque continuation cursor for public search (#47).
/// Uses AES-256-GCM to distinguish authentic changed-generation cursors (409) from tampered,
/// expired, or mismatched query/sort/size/profile cursors (400).
/// </summary>
internal sealed class PublicSearchCursor(TimeProvider time)
{
    private const int NonceSize = 12;
    private const int TagSize = 16;
    private const int PayloadSize = 93;
    private const int ProtectedSize = NonceSize + PayloadSize + TagSize; // 121 bytes -> 162 Base64Url chars
    private const int EncodedSize = 162;
    private const long LifetimeSeconds = 15 * 60;
    private readonly byte[] _key = RandomNumberGenerator.GetBytes(32);

    internal long Now => time.GetUtcNow().ToUnixTimeSeconds();

    internal string Encode(
        long generation,
        SearchQueryPlan plan,
        ArticleSearchSort sort,
        int size,
        int returnedSoFar,
        SearchCursorPosition position)
    {
        Span<byte> payload = stackalloc byte[PayloadSize];
        BinaryPrimitives.WriteInt64LittleEndian(payload, generation);
        BinaryPrimitives.WriteInt64LittleEndian(payload[8..], Now + LifetimeSeconds);
        BinaryPrimitives.WriteInt32LittleEndian(payload[16..], plan.ProfileVersion);
        BinaryPrimitives.WriteInt32LittleEndian(payload[20..], plan.AnalyzerVersion);
        BinaryPrimitives.WriteInt32LittleEndian(payload[24..], size);
        BinaryPrimitives.WriteInt32LittleEndian(payload[28..], returnedSoFar);
        payload[32] = (byte)position.Tier;
        BinaryPrimitives.WriteInt64LittleEndian(payload[33..], position.ScoreBits);
        BinaryPrimitives.WriteInt64LittleEndian(payload[41..], position.PublishedAtTicks);
        BinaryPrimitives.WriteInt64LittleEndian(payload[49..], position.CreatedAtTicks);
        BinaryPrimitives.WriteInt32LittleEndian(payload[57..], position.Id);
        Fingerprint(plan, sort, size, payload[61..]);

        Span<byte> protectedBytes = stackalloc byte[ProtectedSize];
        var nonce = protectedBytes[..NonceSize];
        RandomNumberGenerator.Fill(nonce);
        using var aes = new AesGcm(_key, TagSize);
        aes.Encrypt(nonce, payload, protectedBytes.Slice(NonceSize, PayloadSize), protectedBytes[^TagSize..]);
        return Base64Url.EncodeToString(protectedBytes);
    }

    internal DecodedSearchCursor Decode(
        long currentGeneration,
        SearchQueryPlan plan,
        ArticleSearchSort sort,
        int size,
        string cursor)
    {
        Span<byte> protectedBytes = stackalloc byte[ProtectedSize];
        if (cursor.Length != EncodedSize ||
            Base64Url.DecodeFromChars(cursor, protectedBytes, out var consumed, out var written) != OperationStatus.Done ||
            consumed != cursor.Length ||
            written != ProtectedSize ||
            !string.Equals(Base64Url.EncodeToString(protectedBytes), cursor, StringComparison.Ordinal))
            throw PublicSearchFailure.InvalidCursor();

        Span<byte> payload = stackalloc byte[PayloadSize];
        try
        {
            using var aes = new AesGcm(_key, TagSize);
            aes.Decrypt(protectedBytes[..NonceSize], protectedBytes.Slice(NonceSize, PayloadSize), protectedBytes[^TagSize..], payload);
        }
        catch (AuthenticationTagMismatchException)
        {
            throw PublicSearchFailure.InvalidCursor();
        }

        var cursorGeneration = BinaryPrimitives.ReadInt64LittleEndian(payload);
        var expiresAt = BinaryPrimitives.ReadInt64LittleEndian(payload[8..]);
        var profileVersion = BinaryPrimitives.ReadInt32LittleEndian(payload[16..]);
        var analyzerVersion = BinaryPrimitives.ReadInt32LittleEndian(payload[20..]);
        var cursorSize = BinaryPrimitives.ReadInt32LittleEndian(payload[24..]);
        var returnedSoFar = BinaryPrimitives.ReadInt32LittleEndian(payload[28..]);
        var tierByte = payload[32];
        var scoreBits = BinaryPrimitives.ReadInt64LittleEndian(payload[33..]);
        var publishedTicks = BinaryPrimitives.ReadInt64LittleEndian(payload[41..]);
        var createdTicks = BinaryPrimitives.ReadInt64LittleEndian(payload[49..]);
        var lastId = BinaryPrimitives.ReadInt32LittleEndian(payload[57..]);

        if (expiresAt <= Now ||
            profileVersion != plan.ProfileVersion ||
            analyzerVersion != plan.AnalyzerVersion ||
            cursorSize != size ||
            returnedSoFar <= 0 || returnedSoFar >= ArticleSearchIndex.MaxPaginatedResults ||
            tierByte > (byte)SearchMatchTier.Relaxed ||
            lastId <= 0)
            throw PublicSearchFailure.InvalidCursor();

        Span<byte> expectedFingerprint = stackalloc byte[32];
        Fingerprint(plan, sort, size, expectedFingerprint);
        if (!CryptographicOperations.FixedTimeEquals(payload[61..], expectedFingerprint))
            throw PublicSearchFailure.InvalidCursor();

        if (cursorGeneration != currentGeneration)
            throw PublicSearchFailure.GenerationChanged();

        return new DecodedSearchCursor(
            new SearchCursorPosition((SearchMatchTier)tierByte, scoreBits, publishedTicks, createdTicks, lastId),
            returnedSoFar);
    }

    private static void Fingerprint(SearchQueryPlan plan, ArticleSearchSort sort, int size, Span<byte> output)
    {
        var sb = new StringBuilder(128);
        sb.Append("public-search-cursor-v1\0");
        sb.Append(plan.ProfileVersion).Append('\0');
        sb.Append(plan.AnalyzerVersion).Append('\0');
        sb.Append((int)sort).Append('\0');
        sb.Append(size).Append('\0');
        sb.Append(plan.NormalizedText);
        foreach (var concept in plan.ContentConcepts)
            sb.Append('\u001F').Append(concept.IdentityKey);
        foreach (var phrase in plan.QuotedPhrases)
            sb.Append('\u001E').Append(phrase.RawText);
        SHA256.HashData(Encoding.UTF8.GetBytes(sb.ToString()), output);
    }
}
