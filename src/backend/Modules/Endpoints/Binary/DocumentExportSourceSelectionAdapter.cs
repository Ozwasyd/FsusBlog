using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Services.DocumentExport;
using FsusBlog.Server.Services.DocumentExport.Jobs;
using FsusBlog.Server.Services.DocumentExport.Sources;

namespace FsusBlog.Server.Modules.Endpoints.Binary;

/// <summary>
/// Private endpoint admission only. The endpoint passes Request and Actor to the
/// original freezer and checks RequireFrozenRequestMatch before job creation.
/// BoundSource contains private source and rights facts and must never be serialized.
/// </summary>
internal sealed record DocumentExportSourceSelectionAdmission(
    DocumentExportJobActor Actor,
    DocumentExportRequestCoreModel Request,
    DocumentExportBoundSource BoundSource);

/// <summary>
/// Reads one registered request body and consumes the canonical persisted source
/// binding with the actual authenticated actor. Freezer and source-reader owners
/// must not depend on this endpoint adapter.
/// </summary>
internal sealed class DocumentExportSourceSelectionAdapter(
    IDocumentExportEndpointBinding binding,
    IBinaryEndpointRequestContext requestContext,
    IDocumentExportSourceCatalog catalog)
{
    internal async Task<DocumentExportSourceSelectionAdmission> ReadAsync(
        HttpContext context,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(context);
        cancellationToken.ThrowIfCancellationRequested();
        DocumentExportJobActor actor = await binding.ResolveActorAsync(context, cancellationToken);
        cancellationToken.ThrowIfCancellationRequested();

        DocumentExportRequestCoreModel request;
        using (BinaryRequestPayload payload = await requestContext.ReadFrameAsync(context,
            context.RequestServices.GetRequiredService<IAedsEncoder>(),
            DocumentExportEndpointBinding.RequireRegisteredFrame(nameof(AedsFrameType.DocumentExportRequest)),
            cancellationToken, PodBinaryCodec.MaximumDocumentExportRequestFrameBytes))
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (!payload.IsSuccess || !PodBinaryCodec.TryDecodeDocumentExportRequest(payload.Payload, out request))
            {
                throw new DocumentExportJobDeniedException();
            }
        }

        DocumentExportSourceCoreModel source = request.Source;
        var coordinate = new DocumentExportArticleCoordinate((DocumentExportCoordinateKind)source.Kind,
            source.ArticleId, source.DraftKey, source.RevisionId, source.PublicationId, source.SourceVersion);
        if (coordinate.ArticleId is <= 0 or > int.MaxValue || coordinate.SourceVersion <= 0)
        {
            throw new DocumentExportJobDeniedException();
        }

        DocumentExportBoundSource boundSource;
        try
        {
            DocumentExportSourceCatalog.Validate(new(coordinate.Kind, (int)coordinate.ArticleId,
                coordinate.DraftKey, coordinate.RevisionId, coordinate.PublicationId));
            cancellationToken.ThrowIfCancellationRequested();
            boundSource = await catalog.ReadBoundAsync(actor, coordinate, cancellationToken);
        }
        catch (DocumentExportSourceDeniedException)
        {
            throw new DocumentExportJobDeniedException();
        }
        catch (DocumentExportSourceCapacityException)
        {
            throw new DocumentExportJobDeniedException();
        }
        cancellationToken.ThrowIfCancellationRequested();
        if (boundSource.Choice.Coordinate != coordinate)
        {
            throw new DocumentExportJobDeniedException();
        }
        return new(actor, request, boundSource);
    }
}
