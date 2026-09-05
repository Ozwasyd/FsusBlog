using System.Globalization;
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
public sealed class AuthoringRevisionComparePackageReader(IAuthoringRevisionCompareAuthority authority)
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
        if (draft.ServerRevision != selector.ExpectedServerRevision
            || !string.Equals(draft.ClientRevision, selector.DocumentEpoch, StringComparison.Ordinal))
        {
            return RevisionComparePackageReadResult.Stale();
        }

        RevisionComparePackage package = RevisionComparePackageSeal.Create(
            articleId,
            RevisionCompareSourceKind.CurrentDraft,
            string.Create(
                CultureInfo.InvariantCulture,
                $"draft:{context.AdminPrincipalId}:{draft.DraftKey}:{draft.ServerRevision}:{draft.ClientRevision}"),
            null,
            null,
            draft.ServerRevision,
            draft.ClientRevision,
            Encoding.UTF8.GetBytes(draft.Content),
            DraftMetadata(draft),
            [
                RevisionCompareSnapshot.Present(
                    RevisionCompareSnapshotKind.Rights,
                    $"draft-rights:{draft.ServerRevision}",
                    1,
                    JsonSerializer.SerializeToUtf8Bytes(draft.Rights)),
                RevisionCompareSnapshot.NotApplicable(RevisionCompareSnapshotKind.Responsibility),
                RevisionCompareSnapshot.NotApplicable(RevisionCompareSnapshotKind.Release)
            ]);
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

        RevisionComparePackage package = RevisionComparePackageSeal.Create(
            articleId,
            selector.Kind,
            $"revision:{revision.Id}:{revision.RevisionNo}",
            selector.RevisionId,
            revision.RevisionNo,
            null,
            null,
            Encoding.UTF8.GetBytes(revision.Content),
            RevisionMetadata(revision),
            RevisionSnapshots(revision));
        return RevisionComparePackageReadResult.Available(package);
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
