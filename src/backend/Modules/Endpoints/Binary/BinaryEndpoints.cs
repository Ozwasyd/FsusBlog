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
using FsusBlog.Server.Infrastructure.Observability;
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
    private const string BinaryContentType = "application/octet-stream";
    private const string UploadPartHeader = "X-Fsus-Upload-Part";
    private const string UploadOffsetHeader = "X-Fsus-Upload-Offset";
    private const string UploadPayloadHashHeader = "X-Fsus-Upload-Payload-Hash";
    private static readonly HashSet<string> AllowedPageSlugs = new(StringComparer.OrdinalIgnoreCase)
    {
        "about", "privacy", "guidelines", "copyright"
    };

    public static void MapBinaryEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("api/binary")
            .WithTags("Binary-POD")
            .WithMetadata(new FsusRouteKindMetadata("binary"));
        Int64CursorCodec cursorCodec = Int64CursorCodec.Instance;

        MapBinaryAuthEndpoints(group);
        MapBinaryMessageEndpoints(group);
        MapBinaryArticleEndpoints(group);
        MapBinaryReadProofEndpoints(group);
        MapBinaryTaxonomyEndpoints(group);
        MapBinaryFileEndpoints(group);
        MapBinaryAdminUserEndpoints(group);
        MapBinarySystemEndpoints(group);
        MapBinaryTelemetryEndpoints(group);
        MapBinarySubscriptionEndpoints(group);
        MapBinaryCommentEndpoints(group, cursorCodec);
        MapBinaryStatsEndpoints(group);
        MapBinaryUploadEndpoints(group);
    }

    private static UploadStatusDto CreateAbortedUploadStatus(string uploadId)
        => new()
            {
                UploadId = uploadId,
                Status = "aborted",
                TotalBytes = 0,
                UploadedBytes = 0,
                ChunkSize = 0,
                TotalParts = 0,
                UploadedPartCount = 0,
                NextPartHint = 0,
                ExpiresAt = DateTime.UtcNow
            };

    private static bool IsBinaryContentType(string? contentType)
        => contentType?.StartsWith(BinaryContentType, StringComparison.OrdinalIgnoreCase) == true;

    private static bool TryNormalizeImageDeletePath(string url, out string ioRelativePath, out string? errorMessage)
    {
        errorMessage = null;
        ReadOnlySpan<char> relativeWebPathSpan;
        if (url.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ||
            url.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
        {
            if (!Uri.TryCreate(url, UriKind.Absolute, out var uri))
            {
                ioRelativePath = string.Empty;
                errorMessage = "无效的 URL 格式";
                return false;
            }

            relativeWebPathSpan = uri.AbsolutePath.AsSpan();
        }
        else
        {
            relativeWebPathSpan = url.AsSpan();
        }

        if (!relativeWebPathSpan.Contains("/uploads/illustration/", StringComparison.OrdinalIgnoreCase) ||
            relativeWebPathSpan.Contains("..", StringComparison.Ordinal))
        {
            ioRelativePath = string.Empty;
            errorMessage = "非法路径请求";
            return false;
        }

        var trimmedSpan = relativeWebPathSpan.TrimStart('/');
        ioRelativePath = trimmedSpan.StartsWith("wwwroot", StringComparison.OrdinalIgnoreCase)
            ? trimmedSpan.ToString()
            : $"wwwroot/{trimmedSpan}";
        return true;
    }

    private static UploadInitRequestDto ToServerDto(UploadInitRequestCoreModel value)
        => new()
        {
            FileName = value.FileName,
            MimeType = value.MimeType,
            TargetFormat = value.TargetFormat,
            TotalBytes = value.TotalBytes,
            ChunkSize = value.ChunkSize,
            Sha256 = value.Sha256
        };

    private static Task<BinaryRequestPayload> ReadBinaryRequestPayloadAsync(
        HttpContext httpContext,
        IAedsEncoder aeds,
        AedsFrameType expectedFrameType,
        CancellationToken cancellationToken,
        int? maxFrameBytes = null)
        => RequestContext(httpContext).ReadFrameAsync(httpContext, aeds, expectedFrameType, cancellationToken, maxFrameBytes);

    private static Task<NameMutationPayload> ReadNameMutationAsync(
        HttpContext httpContext,
        IAedsEncoder aeds,
        AedsFrameType expectedFrameType,
        CancellationToken cancellationToken)
        => RequestContext(httpContext).ReadNameMutationAsync(httpContext, aeds, expectedFrameType, cancellationToken);

    private static string? GetDeviceFingerprint(HttpContext context)
        => RequestContext(context).GetDeviceFingerprint(context);

    private static bool TryReadMfaProof(HttpContext context, out string proofToken)
        => RequestContext(context).TryReadMfaProof(context, out proofToken);

    private static IBinaryEndpointRequestContext RequestContext(HttpContext context)
        => context.RequestServices.GetRequiredService<IBinaryEndpointRequestContext>();

}
