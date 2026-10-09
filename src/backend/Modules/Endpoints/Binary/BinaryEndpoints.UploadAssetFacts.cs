using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Interfaces;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Modules.Endpoints.Binary;

public static partial class BinaryEndpoints
{
    // Called only inside the original ArticleWrite/PoW upload group.
    private static void MapBinaryUploadAssetFactsEndpoints(IEndpointRouteBuilder uploadGroup)
    {
        uploadGroup.MapPost("/{uploadId}/facts", static (
            string uploadId,
            HttpContext httpContext,
            IFileService fileService,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
            HandleUploadAssetFactsAsync(uploadId, httpContext, fileService, aeds, cancellationToken))
            .WithMetadata(new FsusOpenApiAedsContractMetadata(AedsFrameType.UploadCompleteRequest, AedsFrameType.UploadAssetFacts));
    }

    internal static async Task<BinaryFrameResult> HandleUploadAssetFactsAsync(
        string uploadId,
        HttpContext httpContext,
        IFileService fileService,
        IAedsEncoder aeds,
        CancellationToken cancellationToken)
    {
        httpContext.Response.Headers.CacheControl = "private, no-store";
        if (httpContext.User.Identity?.IsAuthenticated != true || !httpContext.User.IsAdminPrincipal()
            || !httpContext.User.TryGetAdminPrincipalId(out _))
        {
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Unauthorized, "UNAUTHORIZED"), aeds);
        }
        if (!httpContext.User.HasAdminPermission(AdminPermissions.ArticleWrite))
        {
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Forbidden, "FORBIDDEN"), aeds);
        }
        using var payload = await ReadBinaryRequestPayloadAsync(httpContext, aeds,
            AedsFrameType.UploadCompleteRequest, cancellationToken, AedsFrameHeader.Size + 64);
        if (!payload.IsSuccess)
        {
            return BinaryResults.FromError(payload.Error, aeds);
        }
        if (!PodBinaryCodec.TryDecodeUploadCompleteRequest(payload.Payload, out var dto))
        {
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "upload_asset_facts_request_invalid"), aeds);
        }
        var result = await fileService.ObserveCommittedUploadAsync(CreateUploadAccess(uploadId, httpContext),
            dto.Sha256!, cancellationToken);
        cancellationToken.ThrowIfCancellationRequested();
        return BinaryResults.FromResult(result.Map(static observation => new UploadAssetFactsDto
        {
            UploadId = observation.UploadId,
            AssetId = observation.Asset.Id.ToString(),
            PublicUrl = observation.PublicUrl,
            MimeType = observation.Asset.MimeType,
            Extension = observation.Asset.Extension,
            SizeBytes = observation.Asset.SizeBytes,
            Width = observation.Asset.WidthPixels ?? 0,
            Height = observation.Asset.HeightPixels ?? 0,
            Sha256 = observation.Asset.Sha256!,
            AssetVersionSha256 = observation.AssetVersionSha256,
            ReferenceLedgerSha256 = observation.ReferenceLedgerSha256,
            ReferenceRowCount = observation.References.Count
        }), aeds, AedsFrameType.UploadAssetFacts, static (value, writer) => PodBinaryCodec.WriteUploadAssetFacts(value, writer));
    }
}
