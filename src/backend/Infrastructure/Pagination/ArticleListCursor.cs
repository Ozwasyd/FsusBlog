using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Core.Services.Articles;

using Microsoft.AspNetCore.DataProtection;

namespace FsusBlog.Server.Infrastructure.Pagination;

public interface IArticleListCursorCodec
{
    string Encode(
        ArticleListCursorPosition position,
        int? categoryId,
        int? tagId,
        string? normalizedKeyword,
        int pageSize,
        long queryVersion,
        ArticleListSortMode sort);

    bool TryDecode(
        string? encoded,
        int? categoryId,
        int? tagId,
        string? normalizedKeyword,
        int pageSize,
        long queryVersion,
        ArticleListSortMode sort,
        out ArticleListCursorPosition position);
}

public sealed class ArticleListCursorCodec(
    IDataProtectionProvider dataProtectionProvider,
    TimeProvider timeProvider) : IArticleListCursorCodec
{
    public const int MaxEncodedLength = 512;

    private const byte CurrentVersion = 3;
    private const string ProtectionPurpose = "FsusBlog.PublicArticleListCursor.v3";
    private const int CreateTimeOffset = 1;
    private const int IdOffset = CreateTimeOffset + sizeof(long);
    private const int SortValueOffset = IdOffset + sizeof(int);
    private const int PageSizeOffset = SortValueOffset + sizeof(long);
    private const int QueryVersionOffset = PageSizeOffset + sizeof(int);
    private const int QueryFingerprintOffset = QueryVersionOffset + sizeof(long);
    private const int ExpiresAtOffset = QueryFingerprintOffset + sizeof(ulong);
    private const int PayloadSize = ExpiresAtOffset + sizeof(long);
    private static readonly TimeSpan s_lifetime = TimeSpan.FromMinutes(15);
    private readonly IDataProtector _protector = dataProtectionProvider.CreateProtector(ProtectionPurpose);

    public string Encode(
        ArticleListCursorPosition position,
        int? categoryId,
        int? tagId,
        string? normalizedKeyword,
        int pageSize,
        long queryVersion,
        ArticleListSortMode sort)
    {
        if (!Enum.IsDefined(sort))
        {
            throw new ArgumentOutOfRangeException(nameof(sort));
        }

        Span<byte> payload = stackalloc byte[PayloadSize];
        payload[0] = CurrentVersion;
        BinaryPrimitives.WriteInt64LittleEndian(payload[CreateTimeOffset..], position.CreateTimeUtc.Ticks);
        BinaryPrimitives.WriteInt32LittleEndian(payload[IdOffset..], position.Id);
        BinaryPrimitives.WriteInt64LittleEndian(payload[SortValueOffset..], position.SortValue);
        BinaryPrimitives.WriteInt32LittleEndian(payload[PageSizeOffset..], pageSize);
        BinaryPrimitives.WriteInt64LittleEndian(payload[QueryVersionOffset..], queryVersion);
        BinaryPrimitives.WriteUInt64LittleEndian(
            payload[QueryFingerprintOffset..],
            ComputeQueryFingerprint(categoryId, tagId, normalizedKeyword, sort));
        BinaryPrimitives.WriteInt64LittleEndian(
            payload[ExpiresAtOffset..],
            timeProvider.GetUtcNow().Add(s_lifetime).ToUnixTimeSeconds());
        return Base64UrlEncode(_protector.Protect(payload.ToArray()));
    }

    public bool TryDecode(
        string? encoded,
        int? categoryId,
        int? tagId,
        string? normalizedKeyword,
        int pageSize,
        long queryVersion,
        ArticleListSortMode sort,
        out ArticleListCursorPosition position)
    {
        position = default;
        if (string.IsNullOrWhiteSpace(encoded) || encoded.Length > MaxEncodedLength)
        {
            return false;
        }

        Span<byte> protectedPayload = stackalloc byte[MaxEncodedLength * 3 / 4];
        if (!TryBase64UrlDecode(encoded, protectedPayload, out int protectedLength)
            || !string.Equals(encoded, Base64UrlEncode(protectedPayload[..protectedLength]), StringComparison.Ordinal))
        {
            return false;
        }

        byte[] payload;
        try
        {
            payload = _protector.Unprotect(protectedPayload[..protectedLength].ToArray());
        }
        catch (CryptographicException)
        {
            return false;
        }

        if (payload.Length != PayloadSize || payload[0] != CurrentVersion)
        {
            return false;
        }

        int encodedPageSize = BinaryPrimitives.ReadInt32LittleEndian(payload.AsSpan(PageSizeOffset));
        long encodedQueryVersion = BinaryPrimitives.ReadInt64LittleEndian(payload.AsSpan(QueryVersionOffset));
        ulong queryFingerprint = BinaryPrimitives.ReadUInt64LittleEndian(payload.AsSpan(QueryFingerprintOffset));
        long expiresAtUnixSeconds = BinaryPrimitives.ReadInt64LittleEndian(payload.AsSpan(ExpiresAtOffset));
        if (!Enum.IsDefined(sort)
            || encodedPageSize != pageSize
            || encodedQueryVersion != queryVersion
            || queryFingerprint != ComputeQueryFingerprint(categoryId, tagId, normalizedKeyword, sort)
            || expiresAtUnixSeconds <= timeProvider.GetUtcNow().ToUnixTimeSeconds())
        {
            return false;
        }

        long ticks = BinaryPrimitives.ReadInt64LittleEndian(payload.AsSpan(CreateTimeOffset));
        int id = BinaryPrimitives.ReadInt32LittleEndian(payload.AsSpan(IdOffset));
        long sortValue = BinaryPrimitives.ReadInt64LittleEndian(payload.AsSpan(SortValueOffset));
        if (id <= 0
            || ticks < DateTime.UnixEpoch.Ticks
            || ticks > DateTime.MaxValue.Ticks
            || (sort == ArticleListSortMode.Latest && sortValue != 0)
            || (sort == ArticleListSortMode.Relevance && sortValue is < 0 or > 3)
            || (sort == ArticleListSortMode.Hot && sortValue < 0))
        {
            return false;
        }

        position = new ArticleListCursorPosition(new DateTime(ticks, DateTimeKind.Utc), id, sortValue);
        return true;
    }

    private static ulong ComputeQueryFingerprint(
        int? categoryId,
        int? tagId,
        string? normalizedKeyword,
        ArticleListSortMode sort)
    {
        string identity = string.Concat(
            "category:", categoryId?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "0",
            "|tag:", tagId?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "0",
            "|keyword:", normalizedKeyword ?? string.Empty,
            "|sort:", sort.ToString());
        Span<byte> digest = stackalloc byte[SHA256.HashSizeInBytes];
        SHA256.HashData(Encoding.UTF8.GetBytes(identity), digest);
        return BinaryPrimitives.ReadUInt64LittleEndian(digest);
    }

    private static string Base64UrlEncode(ReadOnlySpan<byte> payload)
        => Convert.ToBase64String(payload).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static bool TryBase64UrlDecode(string encoded, Span<byte> destination, out int written)
    {
        written = 0;
        if (encoded.Any(static character => !(char.IsAsciiLetterOrDigit(character) || character is '-' or '_')))
        {
            return false;
        }

        string normalized = encoded.Replace('-', '+').Replace('_', '/');
        normalized = normalized.PadRight((normalized.Length + 3) / 4 * 4, '=');
        return Convert.TryFromBase64String(normalized, destination, out written);
    }
}
