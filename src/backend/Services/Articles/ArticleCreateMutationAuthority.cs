using FsusBlog.Contracts.Articles;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Content;
using FsusBlog.Server.Infrastructure.Integrity;
using FsusBlog.Server.Models.Dtos;

using SqlSugar;

namespace FsusBlog.Server.Services.Articles;

/// <summary>
/// Production-shared create mutation transaction body used by
/// <c>ArticleService.CreateMutationAsync</c> and canonical publication fixture authority.
/// Does not establish the public mutation fence or run derived projection side effects.
/// </summary>
public static class ArticleCreateMutationAuthority
{
    public sealed record Request(
        string Title,
        string Content,
        string? Summary,
        string? CoverImageUrl,
        int CategoryId,
        IReadOnlyList<int> TagIds,
        ArticleStatus Status,
        DateTime? ScheduledPublishAt,
        DateTime? PublishedAt,
        DateTime? LastPublishedAt,
        DateTime? PublicUpdatedAt,
        DateTime? ArchivedAt,
        DateTime Now,
        ArticleRightsNormalizedModel Rights,
        long CreatedByAdminPrincipalId,
        string DiffSummary,
        string OutboxEventType,
        string TransitionKind,
        ArticleMutationScopeSnapshot? AfterScope,
        ArticleMutationIdentityWrite? MutationIdentity = null,
        Func<int, ArticleRevisionWriteResult, CancellationToken, Task<ResponsibilityAttachResult?>>? AttachResponsibilityAsync = null);

    public readonly record struct ArticleMutationIdentityWrite(
        long AdminPrincipalId,
        string ClientMutationId,
        string RequestHash);

    public readonly record struct ResponsibilityAttachResult(long SnapshotId, int Version);

    public sealed record Result(
        int ArticleId,
        ArticleRevisionWriteResult Revision,
        long RightsSnapshotId,
        long? ResponsibilitySnapshotId,
        int? ResponsibilityVersion,
        ArticleVersionCoordinates Version,
        ArticleMutationOutboxEvent Outbox,
        ArticleMutationCommand? MutationCommand);

    public static async Task<Result> ExecuteAsync(
        ISqlSugarClient db,
        Request request,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(db);
        ArgumentNullException.ThrowIfNull(request);
        await RequireSourceMutationTransactionAsync(db, cancellationToken).ConfigureAwait(false);

        string title = ArticleProductionNormalizers.NormalizeText(
            request.Title, ArticleProductionNormalizers.MaxTitleLength);
        string content = ArticleProductionNormalizers.NormalizeText(
            request.Content, ArticleProductionNormalizers.MaxContentLength);
        string summary = ArticleProductionNormalizers.NormalizeText(
            request.Summary, ArticleProductionNormalizers.MaxSummaryLength);
        string coverImageUrl = ArticleProductionNormalizers.NormalizeText(
            request.CoverImageUrl, ArticleProductionNormalizers.MaxCoverImageUrlLength);
        List<int> tagIds = ArticleProductionNormalizers.NormalizeTagIds(request.TagIds);
        ArticleSummaryProjectionResult summaryProjection = ArticleSummaryProjection.Resolve(summary, content);
        string safeSummary = summaryProjection.Text;
        string diffSummary = string.IsNullOrWhiteSpace(request.DiffSummary)
            ? ArticleSummaryProjection.AttachGenerationVersion("initial publish", summaryProjection)
            : request.DiffSummary;

        var article = new Article
        {
            Title = title,
            Summary = safeSummary,
            CoverImageUrl = coverImageUrl,
            CategoryId = request.CategoryId,
            CreateTime = request.Now,
            MetadataUpdatedAt = request.Now,
            Status = request.Status,
            ScheduledPublishAt = request.ScheduledPublishAt,
            PublishedAt = request.PublishedAt,
            LastPublishedAt = request.LastPublishedAt,
            PublicUpdatedAt = request.PublicUpdatedAt,
            PendingPublicationAt = null,
            CurrentRevisionId = null,
            CurrentPublicationId = null,
            ArchivedAt = request.ArchivedAt,
            IsDeleted = false,
            Content = content
        };

        int articleId = await db.Insertable(article).ExecuteReturnIdentityAsync().ConfigureAwait(false);
        if (articleId <= 0)
        {
            throw new InvalidOperationException("article_insert_failed");
        }

        await db.Insertable(new ArticleBody
        {
            ArticleId = articleId,
            MarkdownContent = content,
            UpdatedAt = request.Now
        }).ExecuteCommandAsync().ConfigureAwait(false);

        if (tagIds.Count > 0)
        {
            List<ArticleTag> tagRows = [.. tagIds.Select(tagId => new ArticleTag
            {
                ArticleId = articleId,
                TagId = tagId
            })];
            await db.Insertable(tagRows).ExecuteCommandAsync().ConfigureAwait(false);
        }

        ArticleRevisionWriteResult revision = await ArticleRevisionPersistence.SaveAsync(
            db,
            articleId,
            title,
            content,
            safeSummary,
            coverImageUrl,
            request.CategoryId,
            tagIds,
            diffSummary,
            request.Now,
            request.CreatedByAdminPrincipalId,
            cancellationToken: cancellationToken).ConfigureAwait(false);

        ArticleAssetReferenceWrite[] assetReferenceWrites = await new ArticleAssetReferenceWriteBoundary(db)
            .ResolveAsync(content, coverImageUrl, cancellationToken)
            .ConfigureAwait(false);
        var assetReferences = new ArticleAssetReferenceStore(db);
        await assetReferences.ReplaceCurrentArticleAsync(articleId, assetReferenceWrites, cancellationToken)
            .ConfigureAwait(false);
        await assetReferences.ReplaceRevisionAsync(revision.Id, articleId, assetReferenceWrites, cancellationToken)
            .ConfigureAwait(false);

        long policyId = await ArticleRightsPolicyPersistence.UpsertAsync(
            db,
            articleId,
            request.Rights,
            request.Now,
            cancellationToken).ConfigureAwait(false);

        var (rightsSnapshot, _, _) = ArticleRightsSnapshotBuilder.Build(
            articleId,
            revision.Id,
            revision.RevisionNo,
            policyId,
            title,
            content,
            safeSummary,
            coverImageUrl,
            request.CategoryId,
            tagIds,
            request.Status,
            request.PublishedAt,
            request.ScheduledPublishAt,
            request.Rights,
            request.Now);
        long rightsSnapshotId = await db.Insertable(rightsSnapshot).ExecuteReturnBigIdentityAsync()
            .ConfigureAwait(false);
        if (rightsSnapshotId <= 0)
        {
            throw new InvalidOperationException(
                $"Article rights snapshot was not created for article {articleId} revision {revision.Id}.");
        }

        long? responsibilitySnapshotId = null;
        int? responsibilityVersion = null;
        if (request.AttachResponsibilityAsync is not null)
        {
            ResponsibilityAttachResult? attached = await request.AttachResponsibilityAsync(
                articleId,
                revision,
                cancellationToken).ConfigureAwait(false);
            if (attached.HasValue)
            {
                responsibilitySnapshotId = attached.Value.SnapshotId;
                responsibilityVersion = attached.Value.Version;
            }
        }

        ArticleVersionCoordinates version = await ArticlePublicationTransitionWriter.ApplyAsync(
            db,
            new ArticlePublicationTransitionRequest(
                articleId,
                new ArticleVersionCoordinates(
                    revision.Id,
                    revision.RevisionNo,
                    rightsSnapshotId,
                    responsibilitySnapshotId,
                    null,
                    null,
                    responsibilityVersion),
                request.Status,
                request.ScheduledPublishAt,
                request.Now,
                request.TransitionKind,
                ArticleStatusTransitionOperation.Create),
            cancellationToken).ConfigureAwait(false);

        ArticleMutationScopeSnapshot afterScope = request.AfterScope
            ?? new ArticleMutationScopeSnapshot(
                request.CategoryId,
                tagIds.ToArray(),
                ArticleMutationVisibility.From(request.Status));

        ArticleMutationOutboxEvent outbox = ArticleMutationOutboxProducer.Create(
            articleId,
            request.OutboxEventType,
            version,
            before: null,
            after: afterScope,
            occurredAt: request.Now,
            publicUpdatedAt: request.PublicUpdatedAt);
        await db.Insertable(outbox).ExecuteCommandAsync(cancellationToken).ConfigureAwait(false);
        await ArticleSourceGenerationAuthority.RecordMutationAsync(db, outbox.EventId, cancellationToken)
            .ConfigureAwait(false);

        ArticleMutationCommand? mutationCommand = null;
        if (request.MutationIdentity is { } identity)
        {
            mutationCommand = new ArticleMutationCommand
            {
                AdminPrincipalId = identity.AdminPrincipalId,
                ClientMutationId = identity.ClientMutationId,
                RequestHash = identity.RequestHash,
                ArticleId = articleId,
                RevisionId = revision.Id,
                RevisionNo = revision.RevisionNo,
                ReleaseId = version.PublicationId ?? 0,
                ReleaseNo = version.PublicationNo ?? 0,
                Status = (int)request.Status,
                RightsSnapshotId = rightsSnapshotId,
                RightsRevisionNo = revision.RevisionNo,
                CreatedAtUtc = request.Now
            };
            await db.Insertable(mutationCommand).ExecuteCommandAsync().ConfigureAwait(false);
        }

        return new Result(
            articleId,
            revision,
            rightsSnapshotId,
            responsibilitySnapshotId,
            responsibilityVersion,
            version,
            outbox,
            mutationCommand);
    }

    internal static async Task RequireSourceMutationTransactionAsync(
        ISqlSugarClient db,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var (connection, transaction) = ArticleSourceGenerationAuthority.RequireTransaction(db);
        await ArticleSourceGenerationPersistence.RequireLockAsync(connection, transaction, cancellationToken)
            .ConfigureAwait(false);
    }
}
