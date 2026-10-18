using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Models.Dtos;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>Exact persisted draft selector; no actor, permission, content or dependency facts are accepted.</summary>
public sealed record ArticleEmbedHostSourceSelector(int ArticleId, string DraftKey, long ExpectedServerRevision);

public enum ArticleEmbedHostSourceReadStatus
{
    Available = 1,
    Unavailable = 2,
    Stale = 3
}

/// <summary>
/// Authorized local host source observation, not an embed coordinate or refresh capability. The
/// database has no complete directive/recorded-coordinate roster producer for this source yet.
/// </summary>
public sealed class ArticleEmbedHostSourceObservation
{
    internal ArticleEmbedHostSourceObservation(long owner, string site, ServerDraftResponse draft,
        ImmutableArray<byte> source, string digest, string permissionDigest)
    {
        OwnerAdminPrincipalId = owner;
        SiteScope = site;
        ArticleId = draft.ArticleId!.Value;
        DraftKey = draft.DraftKey;
        ServerRevision = draft.ServerRevision;
        BaseRevisionId = draft.BaseRevisionId;
        SourceUtf8 = source;
        SourceDigest = digest;
        PermissionDigest = permissionDigest;
    }

    public long OwnerAdminPrincipalId
    {
        get;
    }
    public string SiteScope
    {
        get;
    }
    public int ArticleId
    {
        get;
    }
    public string DraftKey
    {
        get;
    }
    public long ServerRevision
    {
        get;
    }
    public long? BaseRevisionId
    {
        get;
    }
    public ImmutableArray<byte> SourceUtf8
    {
        get;
    }
    public string SourceDigest
    {
        get;
    }
    public string PermissionDigest
    {
        get;
    }
    public bool HasCompleteDependencyRoster => false;
}

public sealed record ArticleEmbedHostSourceReadResult(
    ArticleEmbedHostSourceReadStatus Status, ArticleEmbedHostSourceObservation? Source);

/// <summary>
/// Request-scoped read adapter over the already registered canonical draft and live permission ports.
/// A backend consumer calls this API with its actual HttpContext; no additional service registration,
/// transport, parser, authority implementation or caller-supplied fact facade is installed.
/// </summary>
public static class ArticleEmbedHostSourceReader
{
    public const int MaxSourceBytes = 1_048_576;
    private static readonly UTF8Encoding s_utf8 = new(false, true);

    public static async Task<ArticleEmbedHostSourceReadResult> ReadAsync(
        HttpContext context, ArticleEmbedHostSourceSelector selector, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(context);
        ArgumentNullException.ThrowIfNull(selector);
        cancellationToken.ThrowIfCancellationRequested();
        if (selector.ArticleId <= 0 || selector.ExpectedServerRevision <= 0
            || string.IsNullOrWhiteSpace(selector.DraftKey) || selector.DraftKey.Length > 96
            || !string.Equals(selector.DraftKey, selector.DraftKey.Trim(), StringComparison.Ordinal)
            || !context.User.TryGetAdminPrincipalId(out long owner) || owner <= 0)
        {
            return Unavailable();
        }
        IServiceProvider services = context.RequestServices;
        if (!ReferenceEquals(services.GetRequiredService<IHttpContextAccessor>().HttpContext, context))
        {
            return Unavailable();
        }
        string site = SqlAuthorRecentArticleHistoryPermissionAuthority.ResolveSiteScope(
            services.GetRequiredService<IConfiguration>());
        var actor = new AuthorRecentArticleHistoryOwner(owner, site);
        IAuthorRecentArticleHistoryPermissionProjectionProvider permissions =
            services.GetRequiredService<IAuthorRecentArticleHistoryPermissionProjectionProvider>();
        IAuthoringDraftLifecycle drafts = services.GetRequiredService<IAuthoringDraftLifecycle>();
        AuthorRecentArticleHistoryPermissionSnapshot before = await permissions.ResolveAsync(
            new(actor, Guid.CreateVersion7(), [selector.ArticleId]), cancellationToken).ConfigureAwait(false);
        if (!CanRead(before, actor, selector.ArticleId))
        {
            return Unavailable();
        }
        ServerDraftResponse? first = await drafts.GetDraftAsync(owner, selector.DraftKey, cancellationToken).ConfigureAwait(false);
        if (!Matches(first, selector))
        {
            return first is not null && first.ArticleId == selector.ArticleId
                && first.DraftKey == selector.DraftKey ? Stale() : Unavailable();
        }
        if (first!.Content.Length > MaxSourceBytes)
        {
            return Unavailable();
        }
        byte[] bytes;
        try
        {
            if (s_utf8.GetByteCount(first.Content) > MaxSourceBytes)
            {
                return Unavailable();
            }
            bytes = s_utf8.GetBytes(first.Content);
        }
        catch (EncoderFallbackException)
        {
            return Unavailable();
        }
        ServerDraftResponse? last = await drafts.GetDraftAsync(owner, selector.DraftKey, cancellationToken).ConfigureAwait(false);
        AuthorRecentArticleHistoryPermissionSnapshot after = await permissions.ResolveAsync(
            new(actor, Guid.CreateVersion7(), [selector.ArticleId]), cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        if (!CanRead(after, actor, selector.ArticleId))
        {
            return Unavailable();
        }
        if (!Matches(last, selector) || first.BaseRevisionId != last!.BaseRevisionId
            || !string.Equals(first.Content, last.Content, StringComparison.Ordinal)
            || before.ContentDigest != after.ContentDigest)
        {
            return Stale();
        }
        return new(ArticleEmbedHostSourceReadStatus.Available, new(owner, site, first,
            ImmutableArray.CreateRange(bytes), Convert.ToHexStringLower(SHA256.HashData(bytes)), after.ContentDigest));
    }

    /// <summary>Re-reads real source and live authorization; the observation's digest is never an access grant.</summary>
    public static async Task<bool> VerifyAsync(HttpContext context, ArticleEmbedHostSourceObservation candidate,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(candidate);
        cancellationToken.ThrowIfCancellationRequested();
        if (candidate.SourceUtf8.IsDefault || candidate.SourceUtf8.Length > MaxSourceBytes
            || Convert.ToHexStringLower(SHA256.HashData(candidate.SourceUtf8.AsSpan())) != candidate.SourceDigest)
        {
            return false;
        }
        ArticleEmbedHostSourceReadResult current = await ReadAsync(context,
            new(candidate.ArticleId, candidate.DraftKey, candidate.ServerRevision), cancellationToken).ConfigureAwait(false);
        ArticleEmbedHostSourceObservation? observed = current.Source;
        return current.Status == ArticleEmbedHostSourceReadStatus.Available && observed is not null
            && observed.OwnerAdminPrincipalId == candidate.OwnerAdminPrincipalId
            && observed.SiteScope == candidate.SiteScope && observed.BaseRevisionId == candidate.BaseRevisionId
            && observed.SourceDigest == candidate.SourceDigest && observed.PermissionDigest == candidate.PermissionDigest
            && observed.SourceUtf8.AsSpan().SequenceEqual(candidate.SourceUtf8.AsSpan());
    }

    private static bool Matches(ServerDraftResponse? draft, ArticleEmbedHostSourceSelector selector)
        => draft is not null && draft.ArticleId == selector.ArticleId
            && draft.DraftKey == selector.DraftKey && draft.ServerRevision == selector.ExpectedServerRevision;

    private static bool CanRead(AuthorRecentArticleHistoryPermissionSnapshot snapshot,
        AuthorRecentArticleHistoryOwner owner, int articleId)
        => snapshot.Status == AuthorRecentArticleHistoryPermissionSnapshotStatus.Current
            && snapshot.Owner == owner && snapshot.Decisions.Count == 1
            && snapshot.Decisions[0].ArticleId == articleId
            && snapshot.Decisions[0].CanProject && snapshot.Decisions[0].CanWrite
            && snapshot.ContentDigest == AuthorRecentArticleHistoryContract.ComputePermissionDigest(snapshot);

    private static ArticleEmbedHostSourceReadResult Unavailable() => new(ArticleEmbedHostSourceReadStatus.Unavailable, null);
    private static ArticleEmbedHostSourceReadResult Stale() => new(ArticleEmbedHostSourceReadStatus.Stale, null);
}
