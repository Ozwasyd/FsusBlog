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
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Pagination;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Infrastructure.Security;
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
    private const string BinaryContentType = "application/octet-stream";
    private const string AdminSensitiveAction = "admin-sensitive";
    private const string MfaProofHeader = "X-Fsus-Mfa-Proof";
    private const string AdminBootstrapTokenHeader = "X-Fsus-Admin-Bootstrap-Token";
    private const string AdminHandleHeader = "X-Fsus-Admin-Handle";
    private const string UploadPartHeader = "X-Fsus-Upload-Part";
    private const string UploadOffsetHeader = "X-Fsus-Upload-Offset";
    private const string UploadPayloadHashHeader = "X-Fsus-Upload-Payload-Hash";
    private const string UploadTokenHeader = "X-Fsus-Upload-Token";
    private const string CanonicalIllustrationUploadPrefix = "/uploads/illustration/";
    private static readonly HashSet<string> AllowedPageSlugs = new(StringComparer.OrdinalIgnoreCase)
    {
        "about", "privacy", "guidelines", "copyright"
    };

    public static void MapBinaryEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("api/binary")
            .WithTags("Binary-POD")
            .WithMetadata(new FsusRouteKindMetadata("binary"));
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
        MapBinaryCommentEndpoints(group);
        MapBinaryStatsEndpoints(group);
        MapBinaryUploadEndpoints(group);
        MapBinarySecurityChallengeEndpoints(group);
        MapBinaryAnonymousCredentialEndpoints(group);
        MapBinaryAnonymousGovernanceEndpoints(group);
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

    private static bool IsAdminSensitiveAction(string action)
        => string.Equals(action.Trim(), AdminSensitiveAction, StringComparison.Ordinal);

    internal static bool IsSupportedAdminAccountStatus(int status)
        => status is 0 or 1;

    internal static bool IsValidSystemMessageTarget(long? targetAccountId)
        => targetAccountId is > 0;

    internal static bool IsAllowedStaticPageSlug(string? slug)
    {
        ReadOnlySpan<char> value = (slug ?? string.Empty).AsSpan();
        return !value.IsEmpty
            && FastCharValidator.IsAlphaNumericHyphen(value)
            && AllowedPageSlugs.Contains(slug!);
    }

    private static async Task<(ErrorDetail Error, int StatusCode)?> RequireAdminSensitiveStepUpAsync(
        HttpContext httpContext,
        IAdminPrincipalService adminPrincipals)
    {
        if (!TryResolveAdminSessionContext(httpContext, out long adminPrincipalId, out string adminSessionId))
        {
            return (ErrorDetail.Create(ErrorCode.Unauthorized, "UNAUTHORIZED"), StatusCodes.Status401Unauthorized);
        }

        if (!TrustedRequestOrigin.RequireTrustedOriginOrReferer(httpContext))
        {
            return (ErrorDetail.Create(ErrorCode.Forbidden, "ORIGIN_NOT_ALLOWED"), StatusCodes.Status403Forbidden);
        }

        string proofToken = httpContext.Request.Headers.TryGetValue(MfaProofHeader, out var values)
            ? values.ToString().Trim()
            : string.Empty;
        if (string.IsNullOrWhiteSpace(proofToken) ||
            !await adminPrincipals.ValidateAndConsumeAdminStepUpProofTokenAsync(
                adminPrincipalId,
                adminSessionId,
                AdminSensitiveAction,
                proofToken,
                httpContext.RequestAborted))
        {
            return (ErrorDetail.Create(ErrorCode.Forbidden, "MFA_PROOF_REQUIRED"), StatusCodes.Status428PreconditionRequired);
        }

        return null;
    }

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

        string relativeWebPath = relativeWebPathSpan.ToString();
        if (relativeWebPath.Contains('\\', StringComparison.Ordinal) ||
            relativeWebPath.Contains(':', StringComparison.Ordinal) ||
            !relativeWebPath.StartsWith(CanonicalIllustrationUploadPrefix, StringComparison.OrdinalIgnoreCase) ||
            relativeWebPathSpan.Contains("..", StringComparison.Ordinal))
        {
            ioRelativePath = string.Empty;
            errorMessage = "非法路径请求";
            return false;
        }

        ioRelativePath = $"wwwroot/{relativeWebPath.TrimStart('/')}";
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

    private static Task<BinaryRequestPayload> ReadBinaryRequestPayloadAsync(
        HttpContext httpContext,
        IAedsEncoder aeds,
        IReadOnlyCollection<AedsFrameType> expectedFrameTypes,
        CancellationToken cancellationToken,
        int? maxFrameBytes = null)
        => RequestContext(httpContext).ReadFrameAsync(httpContext, aeds, expectedFrameTypes, cancellationToken, maxFrameBytes);

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

    private static string ReadUploadToken(HttpContext context)
        => context.Request.Headers[UploadTokenHeader].ToString().Trim();

    private static IBinaryEndpointRequestContext RequestContext(HttpContext context)
        => context.RequestServices.GetRequiredService<IBinaryEndpointRequestContext>();

}
