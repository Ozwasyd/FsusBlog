using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Helpers.Security;
using FsusBlog.Server.Infrastructure.Pagination;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Requests;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.Outputs;
using SqlSugar;
using System.Buffers;
using System.Data.Common;

namespace FsusBlog.Server.Modules.Endpoints.Binary;

public static partial class BinaryEndpoints
{
    private static void MapBinaryUploadEndpoints(IEndpointRouteBuilder group)
    {
        var uploadGroup = group.MapGroup("/upload")
            .RequireAuthorization(policy => policy.RequireRole("admin"))
            .AddEndpointFilter<RequiresPowFilter>();

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

            var result = await fileService.InitUploadSessionAsync(ToServerDto(dto), cancellationToken);
            return BinaryResults.FromResult(result, aeds, AedsFrameType.UploadInit, static (value, writer) => PodBinaryCodec.WriteUploadInit(value, writer));
        });

        uploadGroup.MapGet("/{uploadId}/status", static async Task<BinaryFrameResult> (
            string uploadId,
            IFileService fileService,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var result = await fileService.GetUploadStatusAsync(uploadId, cancellationToken);
            return BinaryResults.FromResult(result, aeds, AedsFrameType.UploadStatus, static (value, writer) => PodBinaryCodec.WriteUploadStatus(value, writer));
        });

        uploadGroup.MapGet("/{uploadId}/status/parts", static async Task<BinaryFrameResult> (
            string uploadId,
            IFileService fileService,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var result = await fileService.GetUploadPartMapAsync(uploadId, cancellationToken);
            return BinaryResults.FromResult(result, aeds, AedsFrameType.UploadPartMap, static (value, writer) => PodBinaryCodec.WriteUploadPartMap(value, writer));
        });

        uploadGroup.MapPut("/{uploadId}/part", static async Task<BinaryFrameResult> (
            string uploadId,
            HttpContext httpContext,
            IFileService fileService,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
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

            long payloadLength = httpContext.Request.ContentLength.GetValueOrDefault();
            if (payloadLength <= 0)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "上传分片为空"), aeds);
            }

            string? payloadHash = httpContext.Request.Headers[UploadPayloadHashHeader].FirstOrDefault();
            var file = new RequestBodyFormFile(httpContext.Request.Body, payloadLength, "file", $"{uploadId}-{partNumber}.part")
            {
                Headers = new HeaderDictionary(),
                ContentType = BinaryContentType
            };

            var result = await fileService.UploadPartAsync(uploadId, partNumber, offset, file, payloadHash, cancellationToken);
            return BinaryResults.FromResult(result, aeds, AedsFrameType.UploadPartAck, static (value, writer) => PodBinaryCodec.WriteUploadPartAck(value, writer));
        })
        .DisableAntiforgery();

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

            var result = await fileService.CompleteUploadAsync(uploadId, dto.Sha256, cancellationToken);
            return BinaryResults.FromResult(result, aeds, AedsFrameType.UploadComplete, static (value, writer) => PodBinaryCodec.WriteUploadComplete(value, writer));
        });

        uploadGroup.MapDelete("/{uploadId}", static async Task<BinaryFrameResult> (
            string uploadId,
            IFileService fileService,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var result = await fileService.AbortUploadAsync(uploadId, cancellationToken);
            return result.IsSuccess
                ? BinaryResults.Frame(aeds, AedsFrameType.UploadStatus, writer => PodBinaryCodec.WriteUploadStatus(CreateAbortedUploadStatus(uploadId), writer))
                : BinaryResults.FromError(result.Error, aeds);
        });
    }

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
