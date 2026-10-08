using System.Collections.Immutable;

using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services.DocumentExport.Jobs;

namespace FsusBlog.Server.Services.DocumentExport;

/// <summary>
/// Complete server-owned facts from the exact authorized persisted coordinate.
/// Digests keep the export owner's domains; comparison-package digests, current
/// targets and browser-supplied bytes cannot stand in for these facts. The reader
/// independently verifies metadata, properties, assets and renderer provenance.
/// </summary>
public sealed record DocumentExportFrozenSourceFacts(
    long UserId,
    string SiteScope,
    DocumentExportArticleCoordinate Coordinate,
    ImmutableArray<byte> MarkdownUtf8,
    string SourceDigest,
    string MetadataDigest,
    string PropertyDigest,
    string AssetManifestDigest,
    string FontManifestDigest,
    string RendererId,
    string RendererVersion,
    string RendererDigest,
    ImmutableArray<DocumentExportAsset> Assets,
    DocumentExportFrozenEmbeds? FrozenEmbeds,
    string ContentDigest);

/// <summary>
/// The required canonical full-source reader. It reads and independently verifies
/// persisted metadata/properties, complete retained asset/font bytes, the original
/// renderer build and any frozen embeds for this exact owner/coordinate. A null
/// embed slot means the original source authority proved there are no embeds.
/// No implementation, numeric site alias, digest conversion or empty defaults
/// are supplied by the transport or freezer.
/// </summary>
public interface IDocumentExportFrozenSourceReader
{
    Task<DocumentExportFrozenSourceFacts?> ReadAsync(
        DocumentExportJobActor actor,
        DocumentExportArticleCoordinate coordinate,
        CancellationToken cancellationToken);
}

/// <summary>
/// The sole transport freezer: recheck original live permissions, own the complete
/// source snapshot, allocate opaque server identities and seal the closed catalog
/// task/input. It neither parses Markdown nor writes or executes a durable job.
/// Production admission still requires the real full-source reader and live
/// authorization implementation; registering this class alone grants neither.
/// </summary>
public sealed class DocumentExportRequestFreezer(
    IDocumentExportFrozenSourceReader sourceReader,
    IDocumentExportJobAuthorization authorization) : IDocumentExportRequestFreezer
{
    public async Task<(DocumentExportTask Task, DocumentExportFrozenInput Input)> FreezeAsync(
        HttpContext context,
        DocumentExportJobActor actor,
        DocumentExportRequestCoreModel request,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(context);
        ArgumentNullException.ThrowIfNull(actor);
        ArgumentNullException.ThrowIfNull(request);
        cancellationToken.ThrowIfCancellationRequested();
        DocumentExportContractValidator.RequireOwnerScope(actor.UserId, actor.SiteScope);
        DocumentExportContractValidator.RequireIdentifier(actor.SessionId, nameof(actor.SessionId));
        DocumentExportContractValidator.RequireIdentifier(request.RequestId, nameof(request.RequestId));
        DocumentExportContractValidator.RequireIdentifier(request.IdempotencyKey, nameof(request.IdempotencyKey));
        DocumentExportProviderContract provider = DocumentExportContractCatalog.RequireProvider(request.FormatId);
        var coordinate = new DocumentExportArticleCoordinate((DocumentExportCoordinateKind)request.Source.Kind,
            request.Source.ArticleId, request.Source.DraftKey, request.Source.RevisionId,
            request.Source.PublicationId, request.Source.SourceVersion);
        DocumentExportContractValidator.ValidateCoordinate(coordinate);
        if (request.LayoutProfile != DocumentExportReadingStyleAuthority.LayoutProfile
            || request.ThemeProfile is not (DocumentExportReadingStyleAuthority.LightThemeProfile
                or DocumentExportReadingStyleAuthority.DarkThemeProfile))
        {
            throw new DocumentExportJobDeniedException();
        }
        await RequirePermissionAsync(actor, coordinate, cancellationToken).ConfigureAwait(false);

        DocumentExportFrozenSourceFacts read = await sourceReader.ReadAsync(actor, coordinate, cancellationToken)
            .ConfigureAwait(false) ?? throw new DocumentExportJobDeniedException();
        cancellationToken.ThrowIfCancellationRequested();
        if (read.MarkdownUtf8.IsDefaultOrEmpty || read.Assets.IsDefault
            || read.UserId != actor.UserId || read.SiteScope != actor.SiteScope || read.Coordinate != coordinate
            || read.ContentDigest != DocumentExportDigest.Compute(read with
            {
                ContentDigest = string.Empty
            }))
        {
            throw new DocumentExportJobDeniedException();
        }
        long bytes = read.MarkdownUtf8.Length;
        foreach (DocumentExportAsset asset in read.Assets)
        {
            if (asset is null || asset.Bytes.IsDefaultOrEmpty)
            {
                throw new DocumentExportJobDeniedException();
            }
            bytes = checked(bytes + asset.Bytes.Length);
        }
        if (read.FrozenEmbeds is { } embeds)
        {
            foreach (DocumentExportFrozenEmbedProjection projection in embeds.Projections)
            {
                bytes = checked(bytes + projection.Bytes.Length);
            }
        }
        if (bytes > DocumentExportJobPolicy.MaximumInputBytes)
        {
            throw new DocumentExportJobDeniedException();
        }
        // Stable scoped identities let the sole jobs recognize a response-loss
        // retry without a second allocator/store. Changed source/options remain
        // a different admission and are rejected by its existing idempotency fence.
        string admissionDigest = DocumentExportDigest.Compute(new
        {
            actor.UserId,
            actor.SiteScope,
            request.RequestId,
            request.IdempotencyKey,
            SourceFactsDigest = read.ContentDigest,
            request.FormatId,
            request.LayoutProfile,
            request.ThemeProfile,
            request.Locale
        });
        string inputId = DocumentExportDigest.Compute(new
        {
            Kind = "input",
            Admission = admissionDigest
        });
        string taskId = DocumentExportDigest.Compute(new
        {
            Kind = "task",
            Admission = admissionDigest
        });

        var unsignedInput = new DocumentExportFrozenInput(DocumentExportContractCatalog.InputSchema,
            inputId, actor.UserId, actor.SiteScope, coordinate,
            read.MarkdownUtf8.AsSpan().ToArray().ToImmutableArray(), read.SourceDigest,
            read.MetadataDigest, read.PropertyDigest, read.AssetManifestDigest, read.FontManifestDigest,
            read.RendererId, read.RendererVersion, read.RendererDigest,
            request.LayoutProfile, request.ThemeProfile, request.Locale,
            read.Assets.Select(asset => asset with
            {
                Bytes = asset.Bytes.AsSpan().ToArray().ToImmutableArray()
            }).ToImmutableArray(), DocumentExportReadingStyleAuthority.AuthorityDigest, string.Empty)
        {
            FrozenEmbeds = read.FrozenEmbeds
        };
        DocumentExportFrozenInput input = DocumentExportContractValidator.Seal(unsignedInput);
        DocumentExportContractValidator.Validate(input);
        // Detect mutation of retained buffers while custody was being copied.
        if (read.ContentDigest != DocumentExportDigest.Compute(read with
        {
            ContentDigest = string.Empty
        }))
        {
            throw new DocumentExportJobDeniedException();
        }
        var unsignedTask = new DocumentExportTask(DocumentExportContractCatalog.TaskSchema,
            taskId, request.RequestId, request.IdempotencyKey,
            actor.UserId, actor.SiteScope, coordinate, input.InputId, input.ContentDigest,
            input.SourceDigest, input.MetadataDigest, input.PropertyDigest,
            input.AssetManifestDigest, input.FontManifestDigest, input.ReadingStyleAuthorityDigest,
            input.RendererDigest, provider.FormatId, provider.ProviderId, provider.ProviderVersion,
            input.LayoutProfile, input.ThemeProfile, input.Locale, DocumentExportTaskStatus.Queued, string.Empty);
        DocumentExportTask task = DocumentExportContractValidator.Seal(unsignedTask);
        DocumentExportEndpointBinding.RequireFrozenRequestMatch(request, actor, task, input);
        await RequirePermissionAsync(actor, coordinate, cancellationToken).ConfigureAwait(false);
        return (task, input);
    }

    private async ValueTask RequirePermissionAsync(DocumentExportJobActor actor,
        DocumentExportArticleCoordinate coordinate, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!await authorization.IsAllowedAsync(actor, coordinate, DocumentExportJobOperation.Create,
            cancellationToken).ConfigureAwait(false))
        {
            throw new DocumentExportJobDeniedException();
        }
        cancellationToken.ThrowIfCancellationRequested();
    }
}
