using System.Buffers;
using System.Data.Common;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Helpers.Security;
using FsusBlog.Server.Infrastructure.Pagination;
using FsusBlog.Server.Infrastructure.Policies;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Requests;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.Outputs;

using SqlSugar;

namespace FsusBlog.Server.Modules.Endpoints.Binary;

public static partial class BinaryEndpoints
{
    private static void MapBinaryUploadEndpoints(IEndpointRouteBuilder group)
    {
        var uploadGroup = group.MapGroup("/upload")
            .RequireAdminPermission(AdminPermissions.ArticleWrite)
            .AddEndpointFilterWithMetadata<RequiresPowFilter>();

        MapBinaryUploadAssetFactsEndpoints(uploadGroup);

        uploadGroup.MapPost("/init", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IFileService fileService,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var payload = await ReadBinaryRequestPayloadAsync(httpContext, aeds, AedsFrameType.UploadInitRequest, cancellationToken);
            if (!payload.IsSuccess)
            {
                return BinaryResults.FromError(payload.Error, aeds);
            }

            if (!PodBinaryCodec.TryDecodeUploadInitRequest(payload.Payload, out var dto))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "上传初始化请求非法"), aeds);
            }

            if (!httpContext.User.TryGetAdminPrincipalId(out long adminPrincipalId))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Unauthorized, "UNAUTHORIZED"), aeds, ApiErrorSemanticMapper.RequireTransportMappingId(StatusCodes.Status401Unauthorized, ErrorCode.Unauthorized));
            }

            var result = await fileService.InitUploadSessionAsync(adminPrincipalId, ToServerDto(dto), cancellationToken);
            return BinaryResults.FromResult(result, aeds, AedsFrameType.UploadInit, static (value, writer) => PodBinaryCodec.WriteUploadInit(value, writer));
        });

        uploadGroup.MapGet("/{uploadId}/status", static async Task<BinaryFrameResult> (
            string uploadId,
            HttpContext httpContext,
            IFileService fileService,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var result = await fileService.GetUploadStatusAsync(CreateUploadAccess(uploadId, httpContext), cancellationToken);
            return BinaryResults.FromResult(result, aeds, AedsFrameType.UploadStatus, static (value, writer) => PodBinaryCodec.WriteUploadStatus(value, writer));
        });

        uploadGroup.MapGet("/{uploadId}/status/parts", static async Task<BinaryFrameResult> (
            string uploadId,
            HttpContext httpContext,
            IFileService fileService,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var result = await fileService.GetUploadPartMapAsync(CreateUploadAccess(uploadId, httpContext), cancellationToken);
            return BinaryResults.FromResult(result, aeds, AedsFrameType.UploadPartMap, static (value, writer) => PodBinaryCodec.WriteUploadPartMap(value, writer));
        });

        uploadGroup.MapPut("/{uploadId}/part", static (
            string uploadId,
            HttpContext httpContext,
            IFileService fileService,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
            HandleUploadPartAsync(uploadId, httpContext, fileService, aeds, cancellationToken));

        uploadGroup.MapPost("/{uploadId}/complete", static async Task<BinaryFrameResult> (
            string uploadId,
            HttpContext httpContext,
            IFileService fileService,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var payload = await ReadBinaryRequestPayloadAsync(httpContext, aeds, AedsFrameType.UploadCompleteRequest, cancellationToken);
            if (!payload.IsSuccess)
            {
                return BinaryResults.FromError(payload.Error, aeds);
            }

            if (!PodBinaryCodec.TryDecodeUploadCompleteRequest(payload.Payload, out var dto))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "上传完成请求非法"), aeds);
            }

            var result = await fileService.CompleteUploadAsync(CreateUploadAccess(uploadId, httpContext), dto.Sha256, cancellationToken);
            return BinaryResults.FromResult(result, aeds, AedsFrameType.UploadComplete, static (value, writer) => PodBinaryCodec.WriteUploadComplete(value, writer));
        });

        uploadGroup.MapPost("/{uploadId}/preview", static (
            string uploadId,
            HttpContext httpContext,
            IFileService fileService,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
            HandleUploadAssetPreviewAsync(uploadId, httpContext, fileService, aeds, cancellationToken))
            .WithMetadata(new FsusOpenApiAedsContractMetadata(AedsFrameType.UploadCompleteRequest, AedsFrameType.UploadAssetPreview));

        uploadGroup.MapDelete("/{uploadId}", static async Task<BinaryFrameResult> (
            string uploadId,
            HttpContext httpContext,
            IFileService fileService,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var result = await fileService.AbortUploadAsync(CreateUploadAccess(uploadId, httpContext), cancellationToken);
            return result.IsSuccess
                ? BinaryResults.Frame(
                    aeds,
                    AedsFrameType.UploadStatus,
                    writer => PodBinaryCodec.WriteUploadStatus(
                        CreateAbortedUploadStatus(NormalizeUploadIdForResponse(uploadId)),
                        writer))
                : BinaryResults.FromError(result.Error, aeds);
        });
    }

    internal static async Task<BinaryFrameResult> HandleUploadAssetPreviewAsync(
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
            return BinaryResults.FromError(payload.Error, aeds);
        if (!PodBinaryCodec.TryDecodeUploadCompleteRequest(payload.Payload, out var dto))
        {
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "upload_asset_preview_request_invalid"), aeds);
        }
        var result = await fileService.ReadCommittedUploadPreviewAsync(CreateUploadAccess(uploadId, httpContext),
            dto.Sha256!, cancellationToken);
        return BinaryResults.FromResult(result.Map(static preview => new UploadAssetPreviewDto
        {
            UploadId = preview.Observation.UploadId,
            AssetId = preview.Observation.Asset.Id.ToString(),
            PublicUrl = preview.Observation.PublicUrl,
            MimeType = preview.Observation.Asset.MimeType,
            Extension = preview.Observation.Asset.Extension,
            SizeBytes = preview.Observation.Asset.SizeBytes,
            Width = preview.Observation.Asset.WidthPixels ?? 0,
            Height = preview.Observation.Asset.HeightPixels ?? 0,
            Sha256 = preview.Observation.Asset.Sha256!,
            AssetVersionSha256 = preview.Observation.AssetVersionSha256,
            ReferenceLedgerSha256 = preview.Observation.ReferenceLedgerSha256,
            ReferenceRowCount = preview.Observation.References.Count,
            Bytes = preview.Bytes
        }), aeds, AedsFrameType.UploadAssetPreview, static (value, writer) => PodBinaryCodec.WriteUploadAssetPreview(value, writer));
    }

    internal static async Task<BinaryFrameResult> HandleUploadPartAsync(
        string uploadId,
        HttpContext httpContext,
        IFileService fileService,
        IAedsEncoder aeds,
        CancellationToken cancellationToken)
    {
        if (!IsBinaryContentType(httpContext.Request.ContentType))
        {
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "上传分片必须使用 application/octet-stream"), aeds);
        }

        if (!int.TryParse(httpContext.Request.Headers[UploadPartHeader], out int partNumber))
        {
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "分片索引非法"), aeds);
        }

        if (!long.TryParse(httpContext.Request.Headers[UploadOffsetHeader], out long offset))
        {
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "分片偏移非法"), aeds);
        }

        string transferEncoding = httpContext.Request.Headers["Transfer-Encoding"].ToString();
        if (!httpContext.Request.ContentLength.HasValue ||
            transferEncoding.Contains("chunked", StringComparison.OrdinalIgnoreCase))
        {
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "上传分片必须携带 Content-Length"), aeds, ApiErrorSemanticMapper.RequireTransportMappingId(StatusCodes.Status411LengthRequired, ErrorCode.Validation));
        }

        long payloadLength = httpContext.Request.ContentLength.GetValueOrDefault();
        if (payloadLength <= 0)
        {
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "上传分片为空"), aeds);
        }

        if (payloadLength > FileService.UploadRequestBodyLimitBytes)
        {
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "上传分片超过请求体上限"), aeds, ApiErrorSemanticMapper.RequireTransportMappingId(StatusCodes.Status413PayloadTooLarge, ErrorCode.Validation));
        }

        string? payloadHash = httpContext.Request.Headers[UploadPayloadHashHeader].FirstOrDefault();
        var file = new RequestBodyFormFile(httpContext.Request.Body, payloadLength, "file", $"{uploadId}-{partNumber}.part")
        {
            Headers = new HeaderDictionary(),
            ContentType = BinaryContentType
        };

        var result = await fileService.UploadPartAsync(CreateUploadAccess(uploadId, httpContext), partNumber, offset, file, payloadHash, cancellationToken);
        return BinaryResults.FromResult(result, aeds, AedsFrameType.UploadPartAck, static (value, writer) => PodBinaryCodec.WriteUploadPartAck(value, writer));
    }

    private static UploadSessionAccess CreateUploadAccess(string uploadId, HttpContext httpContext)
        => new(
            uploadId,
            httpContext.User.TryGetAdminPrincipalId(out long adminPrincipalId) ? adminPrincipalId : 0,
            ReadUploadToken(httpContext));

    private static string NormalizeUploadIdForResponse(string uploadId)
        => Guid.TryParseExact(uploadId.Trim(), "N", out Guid parsed)
            ? parsed.ToString("N")
            : uploadId;

    private sealed class RequestBodyFormFile(Stream body, long length, string name, string fileName) : IFormFile
    {
        public string ContentType { get; set; } = string.Empty;
        public string ContentDisposition { get; set; } = string.Empty;
        public IHeaderDictionary Headers { get; set; } = new HeaderDictionary();
        public long Length { get; } = length;
        public string Name { get; } = name;
        public string FileName { get; } = fileName;

        public Stream OpenReadStream() => body;

        public void CopyTo(Stream target)
        {
            body.CopyTo(target);
        }

        public Task CopyToAsync(Stream target, CancellationToken cancellationToken = default)
        {
            return body.CopyToAsync(target, cancellationToken);
        }
    }
}
