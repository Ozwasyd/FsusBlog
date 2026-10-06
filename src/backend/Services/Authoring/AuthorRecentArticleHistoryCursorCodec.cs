using System.Security.Cryptography;
using System.Text.Json;

using Microsoft.AspNetCore.DataProtection;

namespace FsusBlog.Server.Services.Authoring;

public interface IAuthorRecentArticleHistoryCursorCodec
{
    string Encode(AuthorRecentArticleHistoryCursor cursor);

    bool TryDecode(
        string? value,
        out AuthorRecentArticleHistoryCursor? cursor,
        out string reason);
}

/// <summary>
/// Authenticates the private recent-history keyset cursor. The protected payload binds the
/// owner/site, collection and permission revisions, so a client can neither forge an anchor nor
/// reuse one after server authority changes.
/// </summary>
public sealed class AuthorRecentArticleHistoryCursorCodec(
    IDataProtectionProvider dataProtectionProvider) : IAuthorRecentArticleHistoryCursorCodec
{
    private const string ProtectionPurpose = "FsusBlog.AuthorRecentArticleHistoryCursor.v1";
    private readonly IDataProtector _protector = dataProtectionProvider.CreateProtector(ProtectionPurpose);

    public string Encode(AuthorRecentArticleHistoryCursor cursor)
    {
        AuthorRecentArticleHistoryContract.ValidateCursor(cursor);
        byte[] payload = JsonSerializer.SerializeToUtf8Bytes(cursor);
        string encoded = Base64UrlEncode(_protector.Protect(payload));
        if (encoded.Length > AuthorRecentArticleHistoryContract.MaxCursorLength)
        {
            throw new AuthorRecentArticleHistoryValidationException(
                "author_recent_history_cursor_too_large");
        }
        return encoded;
    }

    public bool TryDecode(
        string? value,
        out AuthorRecentArticleHistoryCursor? cursor,
        out string reason)
    {
        cursor = null;
        reason = string.Empty;
        if (string.IsNullOrWhiteSpace(value))
        {
            return true;
        }
        if (value.Length > AuthorRecentArticleHistoryContract.MaxCursorLength)
        {
            reason = "author_recent_history_cursor_too_large";
            return false;
        }

        try
        {
            byte[] protectedPayload = Base64UrlDecode(value);
            if (!string.Equals(value, Base64UrlEncode(protectedPayload), StringComparison.Ordinal))
            {
                reason = "author_recent_history_cursor_invalid";
                return false;
            }
            cursor = JsonSerializer.Deserialize<AuthorRecentArticleHistoryCursor>(
                _protector.Unprotect(protectedPayload));
            if (cursor is null)
            {
                reason = "author_recent_history_cursor_invalid";
                return false;
            }
            AuthorRecentArticleHistoryContract.ValidateCursor(cursor);
            return true;
        }
        catch (Exception exception) when (exception is FormatException
            or JsonException
            or CryptographicException
            or AuthorRecentArticleHistoryValidationException)
        {
            cursor = null;
            reason = exception is AuthorRecentArticleHistoryValidationException validation
                ? validation.Code
                : "author_recent_history_cursor_invalid";
            return false;
        }
    }

    private static string Base64UrlEncode(ReadOnlySpan<byte> bytes)
        => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static byte[] Base64UrlDecode(string encoded)
    {
        if (encoded.Any(static character =>
                !(char.IsAsciiLetterOrDigit(character) || character is '-' or '_')))
        {
            throw new FormatException("cursor contains non-base64url characters");
        }
        string padded = encoded.Replace('-', '+').Replace('_', '/');
        padded = padded.PadRight((padded.Length + 3) / 4 * 4, '=');
        return Convert.FromBase64String(padded);
    }
}
