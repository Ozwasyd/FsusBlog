using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.Articles;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Services.DocumentExport.Jobs;

using SqlSugar;

namespace FsusBlog.Server.Services.DocumentExport.Sources;

/// <summary>
/// Reads persisted authoring sources under the canonical permission/session and configured site authority.
/// Captures only private fingerprints and bindings; never substitutes the latest publication or source version.
/// </summary>
public sealed class DocumentExportSourceCatalog(
    ISqlSugarClient db,
    IAuthoringDraftLifecycle authoring,
    SqlAuthorRecentArticleHistoryPermissionAuthority permissions,
    IHttpContextAccessor contextAccessor,
    IConfiguration configuration,
    DocumentExportSourceCatalogStore store) : IDocumentExportSourceCatalog
{
    public const int MaximumChoices = 50;

    public async Task<IReadOnlyList<DocumentExportSourceChoice>> CaptureAsync(
        DocumentExportJobActor actor,
        IReadOnlyList<DocumentExportSourceRequest> sources,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(sources);
        DocumentExportSourceRequest[] requests = [.. sources];
        if (requests.Length > MaximumChoices || requests.Distinct().Count() != requests.Length)
        {
            throw new DocumentExportSourceDeniedException();
        }
        foreach (DocumentExportSourceRequest request in requests)
        {
            Validate(request);
        }
        await AuthorizeAsync(actor, requests.Select(request => request.ArticleId), cancellationToken).ConfigureAwait(false);
        var choices = new List<DocumentExportSourceChoice>(requests.Length);
        await store.InTransactionAsync(async () =>
        {
            foreach (DocumentExportSourceRequest request in requests)
            {
                SourceSnapshot source = await ReadExactAsync(actor, request, cancellationToken).ConfigureAwait(false);
                DocumentExportSourceCatalogEntry entry = await store.CaptureAsync(
                    actor, request, source.Fingerprint, cancellationToken).ConfigureAwait(false);
                choices.Add(Choice(entry, source.Label));
                // The lifecycle draft may use a separate connection. Re-read before commit to detect edits/deletion.
                SourceSnapshot current = await ReadExactAsync(actor, request, cancellationToken).ConfigureAwait(false);
                if (!string.Equals(current.Fingerprint, source.Fingerprint, StringComparison.Ordinal))
                {
                    throw new DocumentExportSourceDeniedException();
                }
            }
            await AuthorizeAsync(actor, requests.Select(request => request.ArticleId), cancellationToken).ConfigureAwait(false);
        }, cancellationToken).ConfigureAwait(false);
        await AuthorizeAsync(actor, requests.Select(request => request.ArticleId), cancellationToken).ConfigureAwait(false);
        return choices.AsReadOnly();
    }

    public async Task<IReadOnlyList<DocumentExportSourceChoice>> CaptureRevisionsAsync(
        DocumentExportJobActor actor, int articleId, CancellationToken cancellationToken = default)
    {
        await AuthorizeAsync(actor, [articleId], cancellationToken).ConfigureAwait(false);
        IReadOnlyList<ArticleRevisionSummaryResponse> revisions = await authoring
            .GetRevisionsAsync(articleId, cancellationToken).ConfigureAwait(false);
        if (revisions.Count > MaximumChoices)
        {
            throw new DocumentExportSourceDeniedException();
        }
        var requests = new List<DocumentExportSourceRequest>(revisions.Count);
        foreach (ArticleRevisionSummaryResponse revision in revisions)
        {
            if (revision.ArticleId != articleId
                || !long.TryParse(revision.Id, NumberStyles.None, CultureInfo.InvariantCulture, out long revisionId))
            {
                throw new DocumentExportSourceDeniedException();
            }
            requests.Add(new(DocumentExportCoordinateKind.Revision, articleId, RevisionId: revisionId));
        }
        return await CaptureAsync(actor, requests, cancellationToken).ConfigureAwait(false);
    }

    public async Task<DocumentExportBoundSource> ReadBoundAsync(
        DocumentExportJobActor actor, DocumentExportArticleCoordinate coordinate,
        CancellationToken cancellationToken = default)
    {
        if (coordinate is null || coordinate.ArticleId is <= 0 or > int.MaxValue || coordinate.SourceVersion <= 0)
        {
            throw new DocumentExportSourceDeniedException();
        }
        var request = new DocumentExportSourceRequest(coordinate.Kind, (int)coordinate.ArticleId,
            coordinate.DraftKey, coordinate.RevisionId, coordinate.PublicationId);
        Validate(request);
        await AuthorizeAsync(actor, [request.ArticleId], cancellationToken).ConfigureAwait(false);
        DocumentExportSourceCatalogEntry? entry = await store.ReadVersionAsync(
            actor, coordinate.SourceVersion, cancellationToken).ConfigureAwait(false);
        if (entry is null)
        {
            throw new DocumentExportSourceDeniedException();
        }
        return await ReadBoundAsync(actor, entry.ChoiceId, coordinate, cancellationToken).ConfigureAwait(false);
    }

    public async Task<DocumentExportBoundSource> ReadBoundAsync(
        DocumentExportJobActor actor, string choiceId, DocumentExportArticleCoordinate coordinate,
        CancellationToken cancellationToken = default)
    {
        if (coordinate is null || coordinate.ArticleId is <= 0 or > int.MaxValue || coordinate.SourceVersion <= 0
            || !DocumentExportSourceCatalogStore.IsChoiceId(choiceId))
        {
            throw new DocumentExportSourceDeniedException();
        }
        var request = new DocumentExportSourceRequest(coordinate.Kind, (int)coordinate.ArticleId,
            coordinate.DraftKey, coordinate.RevisionId, coordinate.PublicationId);
        Validate(request);
        await AuthorizeAsync(actor, [request.ArticleId], cancellationToken).ConfigureAwait(false);
        DocumentExportSourceCatalogEntry? entry = await store.ReadAsync(actor, choiceId, cancellationToken).ConfigureAwait(false);
        if (entry is null || Choice(entry, string.Empty).Coordinate != coordinate)
        {
            throw new DocumentExportSourceDeniedException();
        }
        SourceSnapshot source = await ReadExactAsync(actor, request, cancellationToken).ConfigureAwait(false);
        if (!string.Equals(source.Fingerprint, entry.Fingerprint, StringComparison.Ordinal))
        {
            throw new DocumentExportSourceDeniedException();
        }
        await AuthorizeAsync(actor, [request.ArticleId], cancellationToken).ConfigureAwait(false);
        return new(Choice(entry, source.Label), source.Fingerprint, source.Draft, source.Revision,
            source.Publication, source.Rights, source.Responsibility);
    }

    private async Task<SourceSnapshot> ReadExactAsync(
        DocumentExportJobActor actor, DocumentExportSourceRequest request, CancellationToken cancellationToken)
    {
        await AuthorizeAsync(actor, [request.ArticleId], cancellationToken).ConfigureAwait(false);
        ServerDraftResponse? draft = null;
        ArticleDraft? storedDraft = null;
        ArticleRevision? revision = null;
        ArticlePublicationRecord? publication = null;
        ArticleRightsSnapshot? rights = null;
        ArticleResponsibilitySnapshot? responsibility = null;
        string label;
        if (request.Kind == DocumentExportCoordinateKind.Draft)
        {
            draft = await authoring.GetDraftAsync(actor.UserId, request.DraftKey!, cancellationToken).ConfigureAwait(false);
            if (draft is null || draft.DraftKey != request.DraftKey || draft.ArticleId != request.ArticleId
                || draft.ServerRevision <= 0)
            {
                throw new DocumentExportSourceDeniedException();
            }
            storedDraft = await db.Queryable<ArticleDraft>()
                .Where(row => row.OwnerAdminPrincipalId == actor.UserId && row.DraftKey == request.DraftKey)
                .FirstAsync(cancellationToken).ConfigureAwait(false);
            if (storedDraft is null || storedDraft.ArticleId != request.ArticleId
                || storedDraft.ServerRevision != draft.ServerRevision || storedDraft.MarkdownContent != draft.Content)
            {
                throw new DocumentExportSourceDeniedException();
            }
            label = draft.Title;
        }
        else
        {
            revision = await db.Queryable<ArticleRevision>()
                .Where(row => row.ArticleId == request.ArticleId && row.Id == request.RevisionId)
                .FirstAsync(cancellationToken).ConfigureAwait(false);
            if (revision is null || revision.ContentBlockId <= 0)
            {
                throw new DocumentExportSourceDeniedException();
            }
            try
            {
                revision.MarkdownContent = await ArticleRevisionContentBlockStore
                    .LoadAsync(db, revision.ContentBlockId, cancellationToken).ConfigureAwait(false);
            }
            catch (InvalidOperationException)
            {
                throw new DocumentExportSourceDeniedException();
            }
            label = revision.Title;
            if (request.Kind == DocumentExportCoordinateKind.Publication)
            {
                publication = await db.Queryable<ArticlePublicationRecord>()
                    .Where(row => row.Id == request.PublicationId && row.ArticleId == request.ArticleId
                        && row.ArticleRevisionId == request.RevisionId)
                    .FirstAsync(cancellationToken).ConfigureAwait(false);
                if (publication is null || publication.RevisionNo != revision.RevisionNo)
                {
                    throw new DocumentExportSourceDeniedException();
                }
                rights = await db.Queryable<ArticleRightsSnapshot>()
                    .Where(row => row.Id == publication.RightsSnapshotId && row.ArticleId == request.ArticleId
                        && row.ArticleRevisionId == request.RevisionId && row.RevisionNo == revision.RevisionNo)
                    .FirstAsync(cancellationToken).ConfigureAwait(false);
                if (rights is null)
                {
                    throw new DocumentExportSourceDeniedException();
                }
                if (publication.ResponsibilitySnapshotId is long responsibilityId)
                {
                    responsibility = await db.Queryable<ArticleResponsibilitySnapshot>()
                        .Where(row => row.Id == responsibilityId && row.ArticleId == request.ArticleId
                            && row.ArticleRevisionId == request.RevisionId && row.RevisionNo == revision.RevisionNo)
                        .FirstAsync(cancellationToken).ConfigureAwait(false);
                    if (responsibility is null)
                    {
                        throw new DocumentExportSourceDeniedException();
                    }
                }
            }
        }
        string fingerprint = Convert.ToHexStringLower(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(new
        {
            Schema = "document-export-source-binding-v1",
            Request = request,
            Draft = draft,
            StoredDraft = storedDraft,
            Revision = revision,
            Publication = publication,
            Rights = rights,
            Responsibility = responsibility
        })));
        return new(label, fingerprint, draft, revision, publication, rights, responsibility);
    }

    private async Task AuthorizeAsync(
        DocumentExportJobActor actor, IEnumerable<int> articleIds, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (actor is null || actor.UserId <= 0 || string.IsNullOrWhiteSpace(actor.SessionId)
            || actor.SiteScope is not { Length: > 0 and <= 128 } || actor.SiteScope.Any(char.IsControl)
            || actor.SiteScope != SqlAuthorRecentArticleHistoryPermissionAuthority.ResolveSiteScope(configuration)
            || contextAccessor.HttpContext?.User.GetAdminSessionId() != actor.SessionId)
        {
            throw new DocumentExportSourceDeniedException();
        }
        int[] ids = [.. articleIds.Distinct()];
        if (ids.Any(id => id <= 0) || ids.Length > MaximumChoices)
        {
            throw new DocumentExportSourceDeniedException();
        }
        var owner = new AuthorRecentArticleHistoryOwner(actor.UserId, actor.SiteScope);
        AuthorRecentArticleHistoryPermissionSnapshot snapshot = await permissions
            .ResolveAsync(new(owner, Guid.NewGuid(), ids), cancellationToken).ConfigureAwait(false);
        if (snapshot.Status != AuthorRecentArticleHistoryPermissionSnapshotStatus.Current || snapshot.Owner != owner
            || snapshot.Decisions.Count != ids.Length
            || ids.Any(id => !snapshot.Decisions.Any(decision => decision.ArticleId == id && decision.CanProject && decision.CanWrite)))
        {
            throw new DocumentExportSourceDeniedException();
        }
        cancellationToken.ThrowIfCancellationRequested();
    }

    private static DocumentExportSourceChoice Choice(DocumentExportSourceCatalogEntry entry, string label)
        => new(entry.ChoiceId, label, new((DocumentExportCoordinateKind)entry.SourceKind, entry.ArticleId,
            entry.DraftKey, entry.RevisionId, entry.PublicationId, entry.SourceVersion));

    private sealed record SourceSnapshot(
        string Label,
        string Fingerprint,
        ServerDraftResponse? Draft,
        ArticleRevision? Revision,
        ArticlePublicationRecord? Publication,
        ArticleRightsSnapshot? Rights,
        ArticleResponsibilitySnapshot? Responsibility);

    internal static void Validate(DocumentExportSourceRequest request)
    {
        if (request is null || request.ArticleId <= 0
            || (request.Kind switch
            {
                DocumentExportCoordinateKind.Draft => request.DraftKey is not { Length: > 0 and <= 96 }
                    || string.IsNullOrWhiteSpace(request.DraftKey) || request.DraftKey.Trim() != request.DraftKey
                    || request.RevisionId is not null || request.PublicationId is not null,
                DocumentExportCoordinateKind.Revision => request.DraftKey is not null
                    || request.RevisionId is not > 0 || request.PublicationId is not null,
                DocumentExportCoordinateKind.Publication => request.DraftKey is not null
                    || request.RevisionId is not > 0 || request.PublicationId is not > 0,
                _ => true
            }))
        {
            throw new DocumentExportSourceDeniedException();
        }
    }
}
