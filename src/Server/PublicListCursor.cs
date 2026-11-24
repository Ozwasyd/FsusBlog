namespace FsusBlog.V2.Server;

internal enum PublicListSort { Latest, Relevance }

internal readonly record struct PublicListQuery(
    string Scope, int Page, int Size, string Keyword, PublicListSort Sort, string? Cursor)
{
    internal static PublicListQuery Parse(string scope, int page, int size, string? keyword, string? sort, string? cursor)
    {
        if (page < 1 || size is < 1 or > 100)
            throw new PublicListFailure(400, "Invalid page or page size.", "article_pagination_invalid");
        if ((page == 1) != (cursor is null))
            throw PublicListFailure.InvalidCursor();

        var term = keyword?.Trim() ?? string.Empty;
        var length = Math.Min(80, term.Length);
        if (length > 0 && char.IsHighSurrogate(term[length - 1])) length--;
        term = term[..length];
        var mode = sort?.Trim().ToLowerInvariant() ?? string.Empty;
        var resolved = mode switch
        {
            "" => term.Length == 0 ? PublicListSort.Latest : PublicListSort.Relevance,
            "latest" => PublicListSort.Latest,
            "relevance" when term.Length != 0 => PublicListSort.Relevance,
            "hot" when term.Length != 0 => throw new PublicListFailure(503, "Article popularity is unavailable.", "article_hot_unavailable"),
            _ => throw new PublicListFailure(400, "Invalid article sort.", "article_sort_invalid")
        };
        return new(scope, page, size, term, resolved, cursor);
    }
}

internal sealed class PublicListFailure(int status, string message, string details) : Exception(message)
{
    internal int Status { get; } = status;
    internal string Details { get; } = details;

    internal static PublicListFailure InvalidCursor() =>
        new(400, "Invalid or expired article cursor.", "article_cursor_invalid");
}

internal readonly record struct PublicListPosition(int Score, long CreatedTicks, int Id, long Revision, long Publication)
{
    internal static PublicListPosition From(Article article, int score) =>
        new(score, article.CreatedAt.UtcTicks, article.Id, article.Revision, article.Publication);

    internal int CompareTo(PublicListPosition other)
    {
        var value = other.Score.CompareTo(Score);
        if (value != 0) return value;
        value = other.CreatedTicks.CompareTo(CreatedTicks);
        return value == 0 ? other.Id.CompareTo(Id) : value;
    }
}

internal sealed class PublicListCursor(TimeProvider time)
{
    private const int NonceSize = 12;
    private const int TagSize = 16;
    private const int PayloadSize = 88;
    private const int EncodedSize = 155;
    private const long LifetimeSeconds = 15 * 60;
    private readonly byte[] key = RandomNumberGenerator.GetBytes(32);

    internal long Now => time.GetUtcNow().ToUnixTimeSeconds();

    internal string Encode(long generation, PublicListQuery query, PublicListPosition position)
    {
        Span<byte> payload = stackalloc byte[PayloadSize];
        BinaryPrimitives.WriteInt64LittleEndian(payload, generation);
        BinaryPrimitives.WriteInt64LittleEndian(payload[8..], Now + LifetimeSeconds);
        BinaryPrimitives.WriteInt32LittleEndian(payload[16..], query.Size);
        BinaryPrimitives.WriteInt32LittleEndian(payload[20..], checked(query.Page + 1));
        BinaryPrimitives.WriteInt32LittleEndian(payload[24..], position.Score);
        BinaryPrimitives.WriteInt64LittleEndian(payload[28..], position.CreatedTicks);
        BinaryPrimitives.WriteInt32LittleEndian(payload[36..], position.Id);
        BinaryPrimitives.WriteInt64LittleEndian(payload[40..], position.Revision);
        BinaryPrimitives.WriteInt64LittleEndian(payload[48..], position.Publication);
        Fingerprint(query, payload[56..]);

        Span<byte> protectedBytes = stackalloc byte[NonceSize + PayloadSize + TagSize];
        var nonce = protectedBytes[..NonceSize];
        RandomNumberGenerator.Fill(nonce);
        using var aes = new AesGcm(key, TagSize);
        aes.Encrypt(nonce, payload, protectedBytes.Slice(NonceSize, PayloadSize), protectedBytes[^TagSize..]);
        return Base64Url.EncodeToString(protectedBytes);
    }

    internal PublicListPosition Decode(long generation, PublicListQuery query)
    {
        Span<byte> protectedBytes = stackalloc byte[NonceSize + PayloadSize + TagSize];
        if (query.Cursor is not { Length: EncodedSize } cursor ||
            !Base64Url.TryDecodeFromChars(cursor, protectedBytes, out var written) || written != protectedBytes.Length ||
            !string.Equals(Base64Url.EncodeToString(protectedBytes), cursor, StringComparison.Ordinal))
            throw PublicListFailure.InvalidCursor();

        Span<byte> payload = stackalloc byte[PayloadSize];
        try
        {
            using var aes = new AesGcm(key, TagSize);
            aes.Decrypt(protectedBytes[..NonceSize], protectedBytes.Slice(NonceSize, PayloadSize), protectedBytes[^TagSize..], payload);
        }
        catch (AuthenticationTagMismatchException)
        {
            throw PublicListFailure.InvalidCursor();
        }

        Span<byte> fingerprint = stackalloc byte[32];
        Fingerprint(query, fingerprint);
        if (BinaryPrimitives.ReadInt64LittleEndian(payload) != generation ||
            BinaryPrimitives.ReadInt64LittleEndian(payload[8..]) <= Now ||
            BinaryPrimitives.ReadInt32LittleEndian(payload[16..]) != query.Size ||
            BinaryPrimitives.ReadInt32LittleEndian(payload[20..]) != query.Page ||
            !CryptographicOperations.FixedTimeEquals(payload[56..], fingerprint))
            throw PublicListFailure.InvalidCursor();

        return new(
            BinaryPrimitives.ReadInt32LittleEndian(payload[24..]),
            BinaryPrimitives.ReadInt64LittleEndian(payload[28..]),
            BinaryPrimitives.ReadInt32LittleEndian(payload[36..]),
            BinaryPrimitives.ReadInt64LittleEndian(payload[40..]),
            BinaryPrimitives.ReadInt64LittleEndian(payload[48..]));
    }

    private static void Fingerprint(PublicListQuery query, Span<byte> output) => SHA256.HashData(
        Encoding.UTF8.GetBytes(string.Concat(query.Scope, "\0", query.Sort.ToString(), "\0", query.Keyword)), output);
}
