using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Policies;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Services.DocumentExport;
using FsusBlog.Server.Services.DocumentExport.Jobs;
using FsusBlog.Server.Services.DocumentExport.Sources;
using FsusBlog.Shared.Contracts.DocumentExport;

namespace FsusBlog.Server.Modules.Endpoints.Binary;

public static partial class BinaryEndpoints
{
    private static void MapBinaryDocumentExportSourceOptionsEndpoints(IEndpointRouteBuilder group)
    {
        // Both operations persist bindings through the original catalog transaction.
        group.MapPost("/document-export/sources/capture", HandleDocumentExportSourcesCaptureAsync)
            .RequireAdminPermission(AdminPermissions.ArticleWrite)
            .AddEndpointFilterWithMetadata<RequiresPowFilter>();
        group.MapPost("/document-export/sources/revisions", HandleDocumentExportSourceRevisionsAsync)
            .RequireAdminPermission(AdminPermissions.ArticleWrite)
            .AddEndpointFilterWithMetadata<RequiresPowFilter>();
    }

    internal static Task<IResult> HandleDocumentExportSourcesCaptureAsync(
        HttpContext context, IDocumentExportSourceCatalog catalog,
        IDocumentExportEndpointBinding binding, IBinaryEndpointRequestContext requests,
        IAedsEncoder encoder, CancellationToken cancellationToken)
        => ExecuteDocumentExportAsync(context, binding, encoder, async actor =>
        {
            using BinaryRequestPayload payload = await requests.ReadFrameAsync(context, encoder,
                AedsFrameType.DocumentExportSourceCaptureRequest, cancellationToken,
                DocumentExportSourceOptionsLimits.CaptureFrameBytes);
            cancellationToken.ThrowIfCancellationRequested();
            if (!payload.IsSuccess
                || !PodBinaryCodec.TryDecodeDocumentExportSourceCaptureRequest(payload.Payload, out var request))
            {
                throw new DocumentExportJobDeniedException();
            }
            DocumentExportSourceRequest[] sources = [.. request.Sources.Select(source => new DocumentExportSourceRequest(
                (DocumentExportCoordinateKind)source.Kind, source.ArticleId, source.DraftKey,
                source.RevisionId, source.PublicationId))];
            return await CaptureDocumentExportChoicesAsync(
                () => catalog.CaptureAsync(actor, sources, cancellationToken), encoder, cancellationToken);
        }, cancellationToken);

    internal static Task<IResult> HandleDocumentExportSourceRevisionsAsync(
        HttpContext context, IDocumentExportSourceCatalog catalog,
        IDocumentExportEndpointBinding binding, IBinaryEndpointRequestContext requests,
        IAedsEncoder encoder, CancellationToken cancellationToken)
        => ExecuteDocumentExportAsync(context, binding, encoder, async actor =>
        {
            using BinaryRequestPayload payload = await requests.ReadFrameAsync(context, encoder,
                AedsFrameType.DocumentExportRevisionChoicesRequest, cancellationToken,
                DocumentExportSourceOptionsLimits.RevisionChoicesFrameBytes);
            cancellationToken.ThrowIfCancellationRequested();
            if (!payload.IsSuccess
                || !PodBinaryCodec.TryDecodeDocumentExportRevisionChoicesRequest(payload.Payload, out var request))
            {
                throw new DocumentExportJobDeniedException();
            }
            return await CaptureDocumentExportChoicesAsync(
                () => catalog.CaptureRevisionsAsync(actor, request.ArticleId, cancellationToken), encoder, cancellationToken);
        }, cancellationToken);

    private static async Task<IResult> CaptureDocumentExportChoicesAsync(
        Func<Task<IReadOnlyList<DocumentExportSourceChoice>>> capture, IAedsEncoder encoder,
        CancellationToken cancellationToken)
    {
        IReadOnlyList<DocumentExportSourceChoice> choices;
        try
        {
            choices = await capture();
        }
        catch (Exception exception) when (exception is DocumentExportSourceDeniedException
            or DocumentExportSourceCapacityException)
        {
            throw new DocumentExportJobDeniedException();
        }
        cancellationToken.ThrowIfCancellationRequested();
        if (choices is null || choices.Count > DocumentExportSourceOptionsLimits.MaximumChoices
            || choices.Any(choice => choice?.Coordinate is null))
        {
            throw new DocumentExportJobDeniedException();
        }
        var response = new DocumentExportSourceChoicesResponse([.. choices.Select(choice => new DocumentExportSourceChoiceResponse(
            choice.ChoiceId, choice.Label, new((int)choice.Coordinate.Kind, choice.Coordinate.ArticleId,
                choice.Coordinate.DraftKey, choice.Coordinate.RevisionId, choice.Coordinate.PublicationId,
                choice.Coordinate.SourceVersion)))]);
        // Validate and encode once inside the original error boundary, before returning
        // a deferred HTTP result. Only this public DTO enters the original AEDS encoder.
        byte[] bytes = PodBinaryCodec.EncodeDocumentExportSourceChoicesResponse(response);
        cancellationToken.ThrowIfCancellationRequested();
        return BinaryResults.FrameRaw(encoder, AedsFrameType.DocumentExportSourceChoicesResponse, bytes);
    }
}
