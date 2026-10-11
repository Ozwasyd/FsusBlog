using System.Security.Cryptography;
using System.Text.Json;

using FsusBlog.Contracts.Articles;

using Microsoft.AspNetCore.DataProtection;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>All live source bindings required before an entity query cursor can be admitted.</summary>
/// <remarks>Constructing bindings alone does not verify source, permission or history authority.</remarks>
public sealed record AuthorArticleQueryCursorBinding(
    AuthorArticleQueryOwner Owner,
    string RequestDigest,
    string SourceDigest,
    string HistoryProjectionDigest,
    string PermissionDigest,
    string PermissionRevision,
    string SiteRevision,
    string SessionRevision);

/// <summary>Opaque entity-query rank anchor; it cannot be reused as a recent-history cursor.</summary>
public sealed record AuthorArticleQueryCursor(
    int SchemaVersion,
    string RankingId,
    AuthorArticleQueryCursorBinding Binding,
    AuthorArticleQueryRank Anchor);

/// <summary>
/// Authenticates an exact query identity and rank anchor. A future full source adapter must supply
/// its verified bindings; this codec cannot issue a query receipt or repair missing source fields.
/// </summary>
public sealed class AuthorArticleQueryCursorCodec(IDataProtectionProvider dataProtectionProvider)
{
    private readonly IDataProtector _protector = dataProtectionProvider.CreateProtector("FsusBlog.AuthorArticleQueryCursor.v1");

    /// <summary>Hashes original scope, request/cancellation identity and invariant query inputs.</summary>
    public static string ComputeRequestDigest(AuthorArticleQueryRequest request)
    {
        AuthorArticleQueryContract.ValidateRequest(request);
        AuthorArticleQueryRequest canonical = request with
        {
            QueryText = AuthorArticleQueryRanking.NormalizeText(request.QueryText),
            Statuses = request.Statuses.Order().ToArray(),
            Buckets = request.Buckets.Order().ToArray(),
            Cursor = null
        };
        return AuthorRecentArticleHistoryContract.HashText(JsonSerializer.Serialize(canonical));
    }

    /// <summary>Protects only a validated current-contract rank anchor.</summary>
    public string Encode(AuthorArticleQueryCursor cursor)
    {
        Validate(cursor);
        string encoded = Base64UrlEncode(_protector.Protect(JsonSerializer.SerializeToUtf8Bytes(cursor)));
        if (encoded.Length > 8192)
        {
            throw new ArgumentException("author_article_query_cursor_too_large", nameof(cursor));
        }
        return encoded;
    }

    /// <summary>Protects an anchor only when its binding describes this original v1 request.</summary>
    /// <remarks>This checks request identity, not the provenance of source or permission bindings.</remarks>
    public string EncodeForRequest(AuthorArticleQueryRequest request, AuthorArticleQueryCursor cursor)
    {
        AuthorArticleQueryContract.ValidateRequest(request);
        Validate(cursor);
        if (!MatchesRequest(cursor.Binding, request))
        {
            throw new ArgumentException("author_article_query_cursor_request_mismatch", nameof(cursor));
        }
        return Encode(cursor);
    }

    /// <summary>Reads this request's cursor only with matching request and current authority bindings.</summary>
    /// <remarks>A first-page request still requires well-formed bindings; this does not admit a query response.</remarks>
    public bool TryDecodeForRequest(
        AuthorArticleQueryRequest request,
        AuthorArticleQueryCursorBinding liveBinding,
        out AuthorArticleQueryRank? anchor,
        out string? unavailableReason)
    {
        anchor = null;
        unavailableReason = null;
        AuthorArticleQueryContract.ValidateRequest(request);
        try
        {
            ValidateBinding(liveBinding);
            if (!MatchesRequest(liveBinding, request))
            {
                unavailableReason = "author_article_query_cursor_stale";
                return false;
            }
            return TryDecode(request.Cursor, liveBinding, out anchor, out unavailableReason);
        }
        catch (Exception exception) when (exception is ArgumentException
            or AuthorRecentArticleHistoryValidationException)
        {
            unavailableReason = "author_article_query_cursor_invalid";
            return false;
        }
    }

    /// <summary>Rejects tampering, foreign cursor purposes and any live binding mismatch.</summary>
    public bool TryDecode(
        string? value,
        AuthorArticleQueryCursorBinding expectedBinding,
        out AuthorArticleQueryRank? anchor,
        out string? unavailableReason)
    {
        anchor = null;
        unavailableReason = null;
        try
        {
            ValidateBinding(expectedBinding);
            if (value is null)
            {
                return true;
            }
            if (value.Length is < 1 or > 8192
                || value.Any(static character => !(char.IsAsciiLetterOrDigit(character) || character is '-' or '_')))
            {
                throw new FormatException("author_article_query_cursor_invalid");
            }
            byte[] protectedPayload = Convert.FromBase64String(
                value.Replace('-', '+').Replace('_', '/') + new string('=', (4 - value.Length % 4) % 4));
            if (value != Base64UrlEncode(protectedPayload))
            {
                throw new FormatException("author_article_query_cursor_invalid");
            }
            AuthorArticleQueryCursor cursor = JsonSerializer.Deserialize<AuthorArticleQueryCursor>(
                _protector.Unprotect(protectedPayload))
                ?? throw new FormatException("author_article_query_cursor_invalid");
            Validate(cursor);
            if (cursor.Binding != expectedBinding)
            {
                unavailableReason = "author_article_query_cursor_stale";
                return false;
            }
            anchor = cursor.Anchor;
            return true;
        }
        catch (Exception exception) when (exception is FormatException or JsonException
            or CryptographicException or ArgumentException or AuthorRecentArticleHistoryValidationException)
        {
            unavailableReason = "author_article_query_cursor_invalid";
            return false;
        }
    }

    private static void Validate(AuthorArticleQueryCursor cursor)
    {
        ArgumentNullException.ThrowIfNull(cursor);
        ArgumentNullException.ThrowIfNull(cursor.Binding);
        ArgumentNullException.ThrowIfNull(cursor.Binding.Owner);
        ArgumentNullException.ThrowIfNull(cursor.Anchor);
        ValidateBinding(cursor.Binding);
        AuthorArticleQueryRank anchor = cursor.Anchor;
        if (cursor.SchemaVersion != AuthorArticleQueryContract.SchemaVersion
            || cursor.RankingId != AuthorArticleQueryRanking.RankingId
            || !ValidMatch(anchor.TitleMatch, anchor.TitleDistance)
            || !ValidMatch(anchor.SlugMatch, anchor.SlugDistance)
            || anchor.TaxonomyMatch is not (0 or 1 or AuthorArticleQueryRanking.NoMatch)
            || (anchor.RecentOrdinal is < 1 or > AuthorRecentArticleHistoryContract.MaxEntriesPerOwner
                && anchor.RecentOrdinal != int.MaxValue)
            || anchor.StatusPriority is < 0 or > 3
            || anchor.ArticleId <= 0)
        {
            throw new ArgumentException("author_article_query_cursor_anchor_invalid", nameof(cursor));
        }
    }

    private static bool MatchesRequest(AuthorArticleQueryCursorBinding binding, AuthorArticleQueryRequest request)
        => binding.Owner == request.Owner && binding.RequestDigest == ComputeRequestDigest(request);

    private static void ValidateBinding(AuthorArticleQueryCursorBinding binding)
    {
        ArgumentNullException.ThrowIfNull(binding);
        ArgumentNullException.ThrowIfNull(binding.Owner);
        AuthorRecentArticleHistoryContract.ValidateOwner(new(binding.Owner.AdminPrincipalId, binding.Owner.SiteScope));
        foreach (string digest in new[]
        {
            binding.RequestDigest, binding.SourceDigest, binding.HistoryProjectionDigest, binding.PermissionDigest,
            binding.PermissionRevision, binding.SiteRevision, binding.SessionRevision
        })
        {
            AuthorRecentArticleHistoryContract.ValidateDigest(digest);
        }
    }

    private static bool ValidMatch(int match, int distance) => match switch
    {
        0 or 1 => distance == 0,
        2 => distance is 1 or 2,
        AuthorArticleQueryRanking.NoMatch => distance == int.MaxValue,
        _ => false
    };

    private static string Base64UrlEncode(ReadOnlySpan<byte> bytes)
        => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}
