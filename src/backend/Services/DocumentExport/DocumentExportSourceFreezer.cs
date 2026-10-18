using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;

using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.Authoring;

namespace FsusBlog.Server.Services.DocumentExport;

// This binding must be supplied by trusted server configuration. Numeric export
// site IDs cannot be inferred from the client or from a URL/hash convention.
internal sealed record DocumentExportSiteBinding(long SiteId, string PermissionSiteScope);

// A sealed canonical source package, not a complete provider input: typed property
// and asset authorities must contribute their own frozen evidence before admission.
internal sealed record DocumentExportFrozenSource(
    long UserId,
    long SiteId,
    DocumentExportArticleCoordinate Coordinate,
    string PermissionDigest,
    RevisionComparePackage Package);

internal sealed class DocumentExportSourceFreezer(
    IRevisionComparePackageReader packageReader,
    IAuthorRecentArticleHistoryPermissionProjectionProvider permissionAuthority,
    DocumentExportSiteBinding siteBinding)
{
    private static readonly JsonSerializerOptions s_releaseJson = new()
    {
        PropertyNameCaseInsensitive = false,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        RespectRequiredConstructorParameters = true
    };

    internal async Task<DocumentExportFrozenSource> FreezeAsync(
        long userId,
        long siteId,
        DocumentExportArticleCoordinate coordinate,
        string? documentEpoch,
        Guid requestId,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(coordinate);
        if (userId <= 0 || siteBinding.SiteId <= 0 || siteId != siteBinding.SiteId
            || string.IsNullOrWhiteSpace(siteBinding.PermissionSiteScope)
            || requestId == Guid.Empty || coordinate.ArticleId is < 1 or > int.MaxValue
            || coordinate.SourceVersion <= 0)
        {
            throw Unavailable();
        }
        RevisionCompareSourceSelector selector = Select(coordinate, documentEpoch);
        var owner = new AuthorRecentArticleHistoryOwner(userId, siteBinding.PermissionSiteScope);
        var permissionRequest = new AuthorRecentArticleHistoryPermissionRequest(
            owner, requestId, Array.AsReadOnly([(int)coordinate.ArticleId]));
        string before = await RequirePermissionAsync(permissionRequest, cancellationToken);
        var context = new RevisionCompareReadContext(
            userId, AuthoringRevisionCompareDraftContextProvider.PrimarySiteScope, requestId);
        RevisionComparePackageReadResult result = await packageReader.ReadAuthorizedAsync(
            context, (int)coordinate.ArticleId, selector, cancellationToken);
        cancellationToken.ThrowIfCancellationRequested();
        if (result.Status != RevisionComparePackageReadStatus.Available || result.Package is null
            || !RevisionComparePackageSeal.Verify(result.Package))
        {
            throw Unavailable();
        }

        RevisionComparePackage package = Copy(result.Package);
        if (package.ArticleId != coordinate.ArticleId
            || package.SourceKind != selector.Kind
            || package.RevisionId != selector.RevisionId
            || (coordinate.Kind == DocumentExportCoordinateKind.Draft
                ? !package.SourceIdentity.StartsWith(
                    $"draft:{userId}:{coordinate.DraftKey}:{coordinate.SourceVersion}:", StringComparison.Ordinal)
                : package.SourceIdentity != $"revision:{coordinate.RevisionId}:{coordinate.SourceVersion}")
            || (coordinate.Kind == DocumentExportCoordinateKind.Draft
                ? package.ServerRevision != coordinate.SourceVersion || package.DocumentEpoch != documentEpoch
                : package.RevisionNo != coordinate.SourceVersion)
            || package.Snapshots.Any(snapshot => snapshot.State == RevisionCompareSnapshotState.Missing)
            || package.Snapshots.Single(snapshot => snapshot.Kind == RevisionCompareSnapshotKind.Rights).State
                != RevisionCompareSnapshotState.Present
            || (coordinate.Kind != DocumentExportCoordinateKind.Draft
                && package.Snapshots.Single(snapshot => snapshot.Kind == RevisionCompareSnapshotKind.Responsibility).State
                    != RevisionCompareSnapshotState.Present))
        {
            throw Unavailable();
        }
        if (coordinate.Kind == DocumentExportCoordinateKind.Publication)
        {
            RequirePublication(package, coordinate.PublicationId!.Value);
        }
        string after = await RequirePermissionAsync(permissionRequest, cancellationToken);
        cancellationToken.ThrowIfCancellationRequested();
        if (!string.Equals(before, after, StringComparison.Ordinal))
        {
            throw Unavailable();
        }
        return new DocumentExportFrozenSource(userId, siteId, coordinate, before, package);
    }

    private static RevisionCompareSourceSelector Select(
        DocumentExportArticleCoordinate coordinate, string? documentEpoch)
    {
        RevisionCompareSourceSelector selector = coordinate.Kind switch
        {
            DocumentExportCoordinateKind.Draft when coordinate.RevisionId is null
                && coordinate.PublicationId is null && ValidIdentity(coordinate.DraftKey)
                && ValidIdentity(documentEpoch) => new(
                    RevisionCompareSourceKind.CurrentDraft, DraftKey: coordinate.DraftKey,
                    ExpectedServerRevision: coordinate.SourceVersion, DocumentEpoch: documentEpoch),
            DocumentExportCoordinateKind.Revision when coordinate.DraftKey is null
                && coordinate.PublicationId is null && documentEpoch is null && coordinate.RevisionId > 0 => new(
                    RevisionCompareSourceKind.HistoricalRevision, RevisionId: coordinate.RevisionId),
            DocumentExportCoordinateKind.Publication when coordinate.DraftKey is null
                && coordinate.PublicationId > 0 && documentEpoch is null && coordinate.RevisionId > 0 => new(
                    RevisionCompareSourceKind.HistoricalRevision, RevisionId: coordinate.RevisionId),
            _ => throw Unavailable()
        };
        return selector;
    }

    private static bool ValidIdentity(string? value)
        => !string.IsNullOrWhiteSpace(value) && value.Length <= RevisionCompareContract.MaxIdentityLength
            && !value.Any(char.IsControl);

    private async Task<string> RequirePermissionAsync(
        AuthorRecentArticleHistoryPermissionRequest request, CancellationToken cancellationToken)
    {
        AuthorRecentArticleHistoryPermissionSnapshot snapshot = await permissionAuthority.ResolveAsync(
            request, cancellationToken);
        if (snapshot.Status != AuthorRecentArticleHistoryPermissionSnapshotStatus.Current
            || snapshot.Owner != request.Owner || snapshot.Decisions.Count != 1
            || snapshot.Decisions[0].ArticleId != request.ArticleIds[0]
            || !snapshot.Decisions[0].CanProject || !snapshot.Decisions[0].CanWrite
            || snapshot.ContentDigest != AuthorRecentArticleHistoryContract.ComputePermissionDigest(snapshot))
        {
            throw Unavailable();
        }
        return snapshot.ContentDigest;
    }

    private static RevisionComparePackage Copy(RevisionComparePackage source)
    {
        RevisionCompareSnapshot[] snapshots = source.Snapshots.Select(snapshot => snapshot.State switch
        {
            RevisionCompareSnapshotState.Present => RevisionCompareSnapshot.Present(
                snapshot.Kind, snapshot.Reference!, snapshot.SchemaVersion, snapshot.Payload.AsSpan()),
            RevisionCompareSnapshotState.NotApplicable => RevisionCompareSnapshot.NotApplicable(snapshot.Kind),
            _ => RevisionCompareSnapshot.Missing(snapshot.Kind)
        }).ToArray();
        RevisionComparePackage copy = RevisionComparePackageSeal.Create(
            source.ArticleId, source.SourceKind, source.SourceIdentity, source.RevisionId,
            source.RevisionNo, source.ServerRevision, source.DocumentEpoch, source.RawMarkdown.AsSpan(),
            source.Metadata, snapshots);
        if (!RevisionComparePackageSeal.Verify(copy) || !RevisionComparePackageSeal.Verify(source)
            || !string.Equals(copy.PackageDigest, source.PackageDigest, StringComparison.Ordinal))
        {
            throw Unavailable();
        }
        return copy;
    }

    private static void RequirePublication(RevisionComparePackage package, long publicationId)
    {
        RevisionCompareSnapshot release = package.Snapshots.Single(snapshot =>
            snapshot.Kind == RevisionCompareSnapshotKind.Release);
        try
        {
            ArticleRevisionReleaseResponse? value = release.State == RevisionCompareSnapshotState.Present
                && release.SchemaVersion == 1
                    ? JsonSerializer.Deserialize<ArticleRevisionReleaseResponse>(release.Payload.AsSpan(), s_releaseJson)
                    : null;
            if (value is null || value.PublicationNo <= 0
                || value.Id != publicationId.ToString(CultureInfo.InvariantCulture)
                || release.Reference != $"release:{value.Id}:{value.PublicationNo}")
            {
                throw Unavailable();
            }
        }
        catch (JsonException)
        {
            throw Unavailable();
        }
    }

    private static InvalidOperationException Unavailable()
        => new("Export source is unavailable.");
}
