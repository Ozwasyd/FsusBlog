using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Models.Dtos;

using SqlSugar;

namespace FsusBlog.Server.Services.Authoring;

public sealed record AuthoringRevisionCompareArticle(int ArticleId, long? CurrentRevisionId);

public interface IAuthoringRevisionCompareAuthority
{
    Task<AuthoringRevisionCompareArticle?> GetAuthorizedArticleAsync(
        RevisionCompareReadContext context,
        int articleId,
        CancellationToken cancellationToken);

    Task<ServerDraftResponse?> GetDraftAsync(
        long adminPrincipalId,
        string draftKey,
        CancellationToken cancellationToken);

    Task<ArticleRevisionDetailResponse?> GetRevisionAsync(
        int articleId,
        long revisionId,
        CancellationToken cancellationToken);

    Task<long?> GetCurrentRevisionIdAsync(int articleId, CancellationToken cancellationToken);
}

public sealed record AuthoringRevisionCompareDraftContextRequest(
    RevisionCompareReadContext Reader,
    int ArticleId,
    string DraftKey,
    long ServerRevision,
    string DocumentEpoch,
    string RightsPayloadDigest);

public sealed record AuthoringRevisionCompareDraftContext(
    long AdminPrincipalId,
    string SiteScope,
    int ArticleId,
    string DraftKey,
    long ServerRevision,
    string DocumentEpoch,
    string RightsPayloadDigest,
    IReadOnlyList<RevisionCompareSnapshot> Snapshots,
    string ContentDigest);

public sealed record AuthoringRevisionCompareDraftContextResult(
    RevisionComparePackageReadStatus Status,
    AuthoringRevisionCompareDraftContext? Context);

public interface IAuthoringRevisionCompareDraftContextProvider
{
    Task<AuthoringRevisionCompareDraftContextResult> ReadAsync(
        AuthoringRevisionCompareDraftContextRequest request,
        CancellationToken cancellationToken);
}

public interface IAuthoringRevisionCompareDraftContextAuthority
{
    Task<AuthoringRevisionCompareDraftContextResult> ReadAsync(
        AuthoringRevisionCompareDraftContextRequest request,
        CancellationToken cancellationToken);
}

public sealed class AuthoringRevisionCompareDraftContextAuthority(
    IEnumerable<IAuthoringRevisionCompareDraftContextProvider> providers)
    : IAuthoringRevisionCompareDraftContextAuthority
{
    private readonly IAuthoringRevisionCompareDraftContextProvider[] _providers = [.. providers];

    public async Task<AuthoringRevisionCompareDraftContextResult> ReadAsync(
        AuthoringRevisionCompareDraftContextRequest request,
        CancellationToken cancellationToken)
    {
        if (_providers.Length == 0)
        {
            return new AuthoringRevisionCompareDraftContextResult(
                RevisionComparePackageReadStatus.Unavailable,
                null);
        }
        if (_providers.Length != 1)
        {
            return new AuthoringRevisionCompareDraftContextResult(
                RevisionComparePackageReadStatus.Invalid,
                null);
        }
        AuthoringRevisionCompareDraftContextResult result = await _providers[0]
            .ReadAsync(request, cancellationToken)
            .ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        if (result.Status != RevisionComparePackageReadStatus.Available
            || result.Context is null)
        {
            return result with
            {
                Context = null
            };
        }
        return DraftContextMatches(request, result.Context)
            ? result
            : new AuthoringRevisionCompareDraftContextResult(RevisionComparePackageReadStatus.Stale, null);
    }

    public static AuthoringRevisionCompareDraftContext Seal(
        AuthoringRevisionCompareDraftContextRequest request,
        IReadOnlyList<RevisionCompareSnapshot> snapshots)
    {
        string digest = DraftContextDigest(request, snapshots);
        return new AuthoringRevisionCompareDraftContext(
            request.Reader.AdminPrincipalId,
            request.Reader.SiteScope,
            request.ArticleId,
            request.DraftKey,
            request.ServerRevision,
            request.DocumentEpoch,
            request.RightsPayloadDigest,
            snapshots,
            digest);
    }

    private static bool DraftContextMatches(
        AuthoringRevisionCompareDraftContextRequest request,
        AuthoringRevisionCompareDraftContext context)
        => context.AdminPrincipalId == request.Reader.AdminPrincipalId
            && string.Equals(context.SiteScope, request.Reader.SiteScope, StringComparison.Ordinal)
            && context.ArticleId == request.ArticleId
            && string.Equals(context.DraftKey, request.DraftKey, StringComparison.Ordinal)
            && context.ServerRevision == request.ServerRevision
            && string.Equals(context.DocumentEpoch, request.DocumentEpoch, StringComparison.Ordinal)
            && string.Equals(context.RightsPayloadDigest, request.RightsPayloadDigest, StringComparison.Ordinal)
            && context.Snapshots.Count == Enum.GetValues<RevisionCompareSnapshotKind>().Length
            && context.Snapshots.All(static snapshot => snapshot.State != RevisionCompareSnapshotState.Missing)
            && context.Snapshots.Single(static snapshot => snapshot.Kind == RevisionCompareSnapshotKind.Rights)
                .PayloadDigest == request.RightsPayloadDigest
            && string.Equals(
                context.ContentDigest,
                DraftContextDigest(request, context.Snapshots),
                StringComparison.Ordinal);

    private static string DraftContextDigest(
        AuthoringRevisionCompareDraftContextRequest request,
        IEnumerable<RevisionCompareSnapshot> snapshots)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        Append(hash, request.Reader.AdminPrincipalId);
        Append(hash, request.Reader.SiteScope);
        Append(hash, request.ArticleId);
        Append(hash, request.DraftKey);
        Append(hash, request.ServerRevision);
        Append(hash, request.DocumentEpoch);
        Append(hash, request.RightsPayloadDigest);
        foreach (RevisionCompareSnapshot snapshot in snapshots.OrderBy(static snapshot => snapshot.Kind))
        {
            Append(hash, (int)snapshot.Kind);
            Append(hash, (int)snapshot.State);
            Append(hash, snapshot.Reference);
            Append(hash, snapshot.SchemaVersion);
            Append(hash, snapshot.PayloadDigest);
        }
        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }

    private static void Append(IncrementalHash hash, object? value)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(
            value is null ? "null" : Convert.ToString(value, CultureInfo.InvariantCulture) ?? string.Empty);
        Span<byte> length = stackalloc byte[4];
        System.Buffers.Binary.BinaryPrimitives.WriteInt32LittleEndian(length, bytes.Length);
        hash.AppendData(length);
        hash.AppendData(bytes);
    }
}

public sealed class AuthoringRevisionCompareAuthority(
    ISqlSugarClient db,
    IAuthoringDraftLifecycle authoring) : IAuthoringRevisionCompareAuthority
{
    public async Task<AuthoringRevisionCompareArticle?> GetAuthorizedArticleAsync(
        RevisionCompareReadContext context,
        int articleId,
        CancellationToken cancellationToken)
    {
        bool authorized = await db.Queryable<AdminPrincipal>()
            .Where(principal => principal.Id == context.AdminPrincipalId
                && principal.Status == AdminPrincipalStatus.Active)
            .AnyAsync(principal => principal.Permissions == AdminPermissions.ArticleWrite
                || principal.Permissions.StartsWith(AdminPermissions.ArticleWrite + "\n")
                || principal.Permissions.EndsWith("\n" + AdminPermissions.ArticleWrite)
                || principal.Permissions.Contains("\n" + AdminPermissions.ArticleWrite + "\n"), cancellationToken)
            .ConfigureAwait(false);
        if (!authorized)
        {
            return null;
        }
        return await db.Queryable<Article>()
            .Where(item => item.Id == articleId && !item.IsDeleted)
            .Select(item => new AuthoringRevisionCompareArticle(item.Id, item.CurrentRevisionId))
            .FirstAsync(cancellationToken)
            .ConfigureAwait(false);
    }

    public Task<ServerDraftResponse?> GetDraftAsync(
        long adminPrincipalId,
        string draftKey,
        CancellationToken cancellationToken)
        => authoring.GetDraftAsync(adminPrincipalId, draftKey, cancellationToken);

    public Task<ArticleRevisionDetailResponse?> GetRevisionAsync(
        int articleId,
        long revisionId,
        CancellationToken cancellationToken)
        => authoring.GetRevisionAsync(articleId, revisionId, cancellationToken);

    public Task<long?> GetCurrentRevisionIdAsync(int articleId, CancellationToken cancellationToken)
        => db.Queryable<Article>()
            .Where(item => item.Id == articleId && !item.IsDeleted)
            .Select(item => item.CurrentRevisionId)
            .FirstAsync(cancellationToken);
}

/// <summary>
/// Adapts the existing authorized authoring readers into sealed comparison packages.
/// It does not create a second revision or draft read model.
/// </summary>
public sealed class AuthoringRevisionComparePackageReader(
    IAuthoringRevisionCompareAuthority authority,
    IAuthoringRevisionCompareDraftContextAuthority draftContextAuthority)
    : IRevisionComparePackageReader
{
    public async Task<RevisionComparePackageReadResult> ReadAuthorizedAsync(
        RevisionCompareReadContext context,
        int articleId,
        RevisionCompareSourceSelector selector,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        AuthoringRevisionCompareArticle? article = await authority.GetAuthorizedArticleAsync(
                context,
                articleId,
                cancellationToken)
            .ConfigureAwait(false);
        if (article is null)
        {
            return RevisionComparePackageReadResult.Unavailable();
        }

        try
        {
            return selector.Kind == RevisionCompareSourceKind.CurrentDraft
                ? await ReadDraftAsync(context, articleId, selector, cancellationToken).ConfigureAwait(false)
                : await ReadRevisionAsync(article, articleId, selector, cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (RevisionCompareContractException)
        {
            return RevisionComparePackageReadResult.Invalid();
        }
        catch (InvalidOperationException)
        {
            return RevisionComparePackageReadResult.Invalid();
        }
    }

    private async Task<RevisionComparePackageReadResult> ReadDraftAsync(
        RevisionCompareReadContext context,
        int articleId,
        RevisionCompareSourceSelector selector,
        CancellationToken cancellationToken)
    {
        ServerDraftResponse? draft = await authority.GetDraftAsync(
                context.AdminPrincipalId,
                selector.DraftKey!,
                cancellationToken)
            .ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        if (draft is null || draft.ArticleId != articleId)
        {
            return RevisionComparePackageReadResult.Unavailable();
        }
        if (draft.ServerRevision != selector.ExpectedServerRevision)
        {
            return RevisionComparePackageReadResult.Stale();
        }
        if (!TryEncodeMarkdown(draft.Content, out byte[] rawMarkdown))
        {
            return RevisionComparePackageReadResult.BudgetExceeded();
        }

        byte[] rightsPayload = JsonSerializer.SerializeToUtf8Bytes(draft.Rights);
        string rightsDigest = Convert.ToHexStringLower(SHA256.HashData(rightsPayload));
        var contextRequest = new AuthoringRevisionCompareDraftContextRequest(
            context,
            articleId,
            draft.DraftKey,
            draft.ServerRevision,
            selector.DocumentEpoch!,
            rightsDigest);
        AuthoringRevisionCompareDraftContextResult contextResult = await draftContextAuthority
            .ReadAsync(contextRequest, cancellationToken)
            .ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        if (contextResult.Status != RevisionComparePackageReadStatus.Available
            || contextResult.Context is null)
        {
            return new RevisionComparePackageReadResult(
                contextResult.Status,
                null,
                contextResult.Status == RevisionComparePackageReadStatus.Stale
                    ? "revision_compare_source_stale"
                    : contextResult.Status == RevisionComparePackageReadStatus.Invalid
                        ? "revision_compare_source_invalid"
                        : "revision_compare_source_unavailable");
        }

        RevisionComparePackage package = RevisionComparePackageSeal.Create(
            articleId,
            RevisionCompareSourceKind.CurrentDraft,
            string.Create(
                CultureInfo.InvariantCulture,
                $"draft:{context.AdminPrincipalId}:{draft.DraftKey}:{draft.ServerRevision}:{contextResult.Context.ContentDigest}"),
            null,
            null,
            draft.ServerRevision,
            contextResult.Context.DocumentEpoch,
            rawMarkdown,
            DraftMetadata(draft),
            contextResult.Context.Snapshots);
        return RevisionComparePackageReadResult.Available(package);
    }

    private async Task<RevisionComparePackageReadResult> ReadRevisionAsync(
        AuthoringRevisionCompareArticle article,
        int articleId,
        RevisionCompareSourceSelector selector,
        CancellationToken cancellationToken)
    {
        if (selector.RevisionId is not > 0)
        {
            return RevisionComparePackageReadResult.Invalid();
        }
        if (selector.Kind == RevisionCompareSourceKind.CurrentRevision
            && article.CurrentRevisionId != selector.RevisionId)
        {
            return RevisionComparePackageReadResult.Stale();
        }

        ArticleRevisionDetailResponse? revision = await authority.GetRevisionAsync(
                articleId,
                selector.RevisionId.Value,
                cancellationToken)
            .ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        if (revision is null || revision.ArticleId != articleId)
        {
            return RevisionComparePackageReadResult.Unavailable();
        }

        if (selector.Kind == RevisionCompareSourceKind.CurrentRevision)
        {
            long? currentRevisionId = await authority.GetCurrentRevisionIdAsync(articleId, cancellationToken)
                .ConfigureAwait(false);
            if (currentRevisionId != selector.RevisionId)
            {
                return RevisionComparePackageReadResult.Stale();
            }
        }

        if (!TryEncodeMarkdown(revision.Content, out byte[] rawMarkdown))
        {
            return RevisionComparePackageReadResult.BudgetExceeded();
        }
        RevisionComparePackage package = RevisionComparePackageSeal.Create(
            articleId,
            selector.Kind,
            $"revision:{revision.Id}:{revision.RevisionNo}",
            selector.RevisionId,
            revision.RevisionNo,
            null,
            null,
            rawMarkdown,
            RevisionMetadata(revision),
            RevisionSnapshots(revision));
        return RevisionComparePackageReadResult.Available(package);
    }

    private static bool TryEncodeMarkdown(string markdown, out byte[] bytes)
    {
        if (Encoding.UTF8.GetByteCount(markdown) > RevisionCompareContract.AbsoluteMaxSourceBytes)
        {
            bytes = [];
            return false;
        }
        bytes = Encoding.UTF8.GetBytes(markdown);
        return true;
    }

    private static RevisionCompareMetadataValue[] DraftMetadata(ServerDraftResponse draft)
        =>
        [
            RevisionCompareMetadataRegistry.String("title", draft.Title),
            RevisionCompareMetadataRegistry.NullableString("summary", draft.Summary),
            RevisionCompareMetadataRegistry.NullableString("cover-image-url", draft.CoverImageUrl),
            RevisionCompareMetadataRegistry.Int32("category-id", draft.CategoryId),
            RevisionCompareMetadataRegistry.Int32List("tag-ids", draft.TagIds),
            RevisionCompareMetadataRegistry.Int32("status", draft.Status),
            RevisionCompareMetadataRegistry.NullableInstant("scheduled-publish-at", draft.ScheduledPublishAt)
        ];

    private static RevisionCompareMetadataValue[] RevisionMetadata(ArticleRevisionDetailResponse revision)
        =>
        [
            RevisionCompareMetadataRegistry.String("title", revision.Title),
            RevisionCompareMetadataRegistry.NullableString("summary", revision.Summary),
            RevisionCompareMetadataRegistry.NullableString("cover-image-url", revision.CoverImageUrl),
            RevisionCompareMetadataRegistry.Int32("category-id", revision.CategoryId),
            RevisionCompareMetadataRegistry.Int32List("tag-ids", revision.TagIds)
        ];

    private static RevisionCompareSnapshot[] RevisionSnapshots(ArticleRevisionDetailResponse revision)
        =>
        [
            revision.Rights is null
                ? RevisionCompareSnapshot.Missing(RevisionCompareSnapshotKind.Rights)
                : RevisionCompareSnapshot.Present(
                    RevisionCompareSnapshotKind.Rights,
                    $"rights:{revision.Rights.Id}",
                    1,
                    JsonSerializer.SerializeToUtf8Bytes(revision.Rights)),
            revision.Responsibility is null
                ? RevisionCompareSnapshot.Missing(RevisionCompareSnapshotKind.Responsibility)
                : RevisionCompareSnapshot.Present(
                    RevisionCompareSnapshotKind.Responsibility,
                    $"responsibility:{revision.Responsibility.Id}:{revision.Responsibility.ResponsibilityVersion}",
                    revision.Responsibility.ResponsibilityVersion,
                    JsonSerializer.SerializeToUtf8Bytes(revision.Responsibility)),
            revision.Release is null
                ? RevisionCompareSnapshot.NotApplicable(RevisionCompareSnapshotKind.Release)
                : RevisionCompareSnapshot.Present(
                    RevisionCompareSnapshotKind.Release,
                    $"release:{revision.Release.Id}:{revision.Release.PublicationNo}",
                    1,
                    JsonSerializer.SerializeToUtf8Bytes(revision.Release))
        ];
}
