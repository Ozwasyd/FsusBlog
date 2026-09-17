using System.Buffers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.Security;

namespace FsusBlog.Server.Modules.Endpoints.Binary;

public static partial class BinaryEndpoints
{
    private const int MaxAnonymousGovernanceActionFrameBytes = 8 * 1024;
    private static readonly JsonSerializerOptions s_anonymousGovernanceJsonOptions = new(JsonSerializerDefaults.Web);

    private static void MapBinaryAnonymousGovernanceEndpoints(IEndpointRouteBuilder group)
    {
        group.MapGet("/admin/anonymous-governance/status", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IAedsEncoder aeds,
            IAdminPrincipalService adminPrincipals,
            IAnonymousGovernanceService governance,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
            await HandleAnonymousGovernanceStatusAsync(httpContext, aeds, adminPrincipals, governance, auditEvents, cancellationToken))
        .RequireAdminPermission(AdminPermissions.AnonymousCommentConfigure)
        .RequireRateLimiting("fixed_ip");

        group.MapGet("/admin/anonymous-governance/nullifiers", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IAedsEncoder aeds,
            IAdminPrincipalService adminPrincipals,
            IAnonymousGovernanceService governance,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
            await HandleAnonymousGovernanceNullifiersAsync(httpContext, aeds, adminPrincipals, governance, auditEvents, cancellationToken))
        .RequireAdminPermission(AdminPermissions.AnonymousNullifierBlock)
        .RequireRateLimiting("fixed_ip");

        group.MapPost("/admin/anonymous-governance/nullifiers/block", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IAedsEncoder aeds,
            IAdminPrincipalService adminPrincipals,
            IAnonymousGovernanceService governance,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
            await HandleAnonymousGovernanceNullifierBlockAsync(httpContext, aeds, adminPrincipals, governance, auditEvents, cancellationToken))
        .RequireAdminPermission(AdminPermissions.AnonymousNullifierBlock)
        .RequireRateLimiting("fixed_ip");

        group.MapPost("/admin/anonymous-governance/credentials/revoke", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IAedsEncoder aeds,
            IAdminPrincipalService adminPrincipals,
            IAnonymousGovernanceService governance,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
            await HandleAnonymousGovernanceCredentialRevokeAsync(httpContext, aeds, adminPrincipals, governance, auditEvents, cancellationToken))
        .RequireAdminPermission(AdminPermissions.AnonymousCredentialRevoke)
        .RequireRateLimiting("fixed_ip");
    }

    internal static async Task<BinaryFrameResult> HandleAnonymousGovernanceStatusAsync(
        HttpContext httpContext,
        IAedsEncoder aeds,
        IAdminPrincipalService adminPrincipals,
        IAnonymousGovernanceService governance,
        IAuditEventService auditEvents,
        CancellationToken cancellationToken)
    {
        BinaryFrameResult? guard = await RequireAnonymousGovernanceReadAsync(httpContext, aeds, adminPrincipals);
        if (guard is not null)
        {
            return guard;
        }

        AnonymousGovernanceStatusResponse status = await governance.GetStatusAsync(cancellationToken);
        await RecordAnonymousGovernanceStatusReadAuditAsync(auditEvents, status, cancellationToken);
        return JsonGovernanceFrame(aeds, status);
    }

    internal static async Task<BinaryFrameResult> HandleAnonymousGovernanceNullifiersAsync(
        HttpContext httpContext,
        IAedsEncoder aeds,
        IAdminPrincipalService adminPrincipals,
        IAnonymousGovernanceService governance,
        IAuditEventService auditEvents,
        CancellationToken cancellationToken)
    {
        BinaryFrameResult? guard = await RequireAnonymousGovernanceReadAsync(httpContext, aeds, adminPrincipals);
        if (guard is not null)
        {
            return guard;
        }

        AnonymousGovernanceNullifierListResponse response = await governance.ListNullifiersAsync(cancellationToken);
        await RecordAnonymousGovernanceNullifiersReadAuditAsync(auditEvents, response, cancellationToken);
        return JsonGovernanceFrame(aeds, response);
    }

    internal static async Task<BinaryFrameResult> HandleAnonymousGovernanceNullifierBlockAsync(
        HttpContext httpContext,
        IAedsEncoder aeds,
        IAdminPrincipalService adminPrincipals,
        IAnonymousGovernanceService governance,
        IAuditEventService auditEvents,
        CancellationToken cancellationToken)
    {
        BinaryFrameResult? guard = await RequireAnonymousGovernanceWriteAsync(httpContext, aeds, adminPrincipals);
        if (guard is not null)
        {
            return guard;
        }

        BinaryRequestPayload payload = await ReadBinaryRequestPayloadAsync(
            httpContext,
            aeds,
            AedsFrameType.AnonymousGovernanceActionRequest,
            cancellationToken,
            MaxAnonymousGovernanceActionFrameBytes);
        if (!payload.IsSuccess)
        {
            return BinaryResults.FromError(payload.Error, aeds);
        }

        if (!TryReadGovernanceJson(payload.Payload, out AnonymousNullifierBlockRequest? request) || request is null)
        {
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "anonymous_nullifier_block_request_invalid"), aeds);
        }

        Result<AnonymousGovernanceActionResponse> result = await governance.BlockNullifierAsync(request, cancellationToken);
        await RecordAnonymousNullifierBlockAuditAsync(auditEvents, request, result.IsSuccess, cancellationToken);
        return result.IsSuccess && result.Value is not null
            ? JsonGovernanceFrame(aeds, result.Value)
            : BinaryResults.FromError(result.Error, aeds);
    }

    internal static async Task<BinaryFrameResult> HandleAnonymousGovernanceCredentialRevokeAsync(
        HttpContext httpContext,
        IAedsEncoder aeds,
        IAdminPrincipalService adminPrincipals,
        IAnonymousGovernanceService governance,
        IAuditEventService auditEvents,
        CancellationToken cancellationToken)
    {
        BinaryFrameResult? guard = await RequireAnonymousGovernanceWriteAsync(httpContext, aeds, adminPrincipals);
        if (guard is not null)
        {
            return guard;
        }

        BinaryRequestPayload payload = await ReadBinaryRequestPayloadAsync(
            httpContext,
            aeds,
            AedsFrameType.AnonymousGovernanceActionRequest,
            cancellationToken,
            MaxAnonymousGovernanceActionFrameBytes);
        if (!payload.IsSuccess)
        {
            return BinaryResults.FromError(payload.Error, aeds);
        }

        if (!TryReadGovernanceJson(payload.Payload, out AnonymousGovernanceCredentialRevokeRequest? request) || request is null)
        {
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "anonymous_credential_revoke_request_invalid"), aeds);
        }

        string? actorId = TryResolveAdminSessionContext(httpContext, out long adminPrincipalId, out _)
            ? $"admin:{adminPrincipalId.ToString(System.Globalization.CultureInfo.InvariantCulture)}"
            : null;
        Result<AnonymousGovernanceActionResponse> result = await governance.RevokeCredentialAsync(request, actorId, cancellationToken);
        await RecordAnonymousCredentialRevokeAuditAsync(auditEvents, request, result.IsSuccess, cancellationToken);
        return result.IsSuccess && result.Value is not null
            ? JsonGovernanceFrame(aeds, result.Value)
            : BinaryResults.FromError(result.Error, aeds);
    }

    private static async Task<BinaryFrameResult?> RequireAnonymousGovernanceReadAsync(
        HttpContext httpContext,
        IAedsEncoder aeds,
        IAdminPrincipalService adminPrincipals)
    {
        if (!AcceptsBinaryResponse(httpContext.Request))
        {
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "binary_accept_required"), aeds, StatusCodes.Status406NotAcceptable);
        }

        var stepUp = await RequireAdminSensitiveStepUpAsync(httpContext, adminPrincipals);
        return stepUp.HasValue ? BinaryResults.FromError(stepUp.Value.Error, aeds, stepUp.Value.StatusCode) : null;
    }

    private static Task<BinaryFrameResult?> RequireAnonymousGovernanceWriteAsync(
        HttpContext httpContext,
        IAedsEncoder aeds,
        IAdminPrincipalService adminPrincipals)
        => RequireAnonymousGovernanceReadAsync(httpContext, aeds, adminPrincipals);

    private static BinaryFrameResult JsonGovernanceFrame(IAedsEncoder aeds, object value)
    {
        byte[] payload = JsonSerializer.SerializeToUtf8Bytes(value, s_anonymousGovernanceJsonOptions);
        return BinaryResults.Frame(aeds, AedsFrameType.AnonymousGovernanceActionResponse, writer => writer.Write(payload));
    }

    private static bool TryReadGovernanceJson<T>(ReadOnlyMemory<byte> payload, out T? value)
    {
        try
        {
            value = JsonSerializer.Deserialize<T>(payload.Span, s_anonymousGovernanceJsonOptions);
            return true;
        }
        catch (JsonException)
        {
            value = default;
            return false;
        }
    }

    private static Task RecordAnonymousGovernanceStatusReadAuditAsync(
        IAuditEventService auditEvents,
        AnonymousGovernanceStatusResponse status,
        CancellationToken cancellationToken)
        => auditEvents.RecordHighValueAsync(new AuditEvent(
            AuditSourceCatalog.Admin,
            AuditTypeCatalog.Audit,
            AuditActionCatalog.AnonymousGovernanceStatusRead,
            AuditOutcomeCatalog.Success,
            AuditSeverityCatalog.Info,
            "管理员读取匿名治理状态",
            TargetType: "anonymous_governance_status",
            TargetId: HashAuditTargetId("anonymous_governance_status", "status"),
            Context: new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["rootStatus"] = status.Root.Status,
                ["rootAvailable"] = status.Root.Available,
                ["revocationStatus"] = status.Revocation.Status,
                ["credentialRows"] = status.Credentials.Count,
                ["anonymousCommentTotal"] = status.CommentStats.TotalAnonymous
            }), cancellationToken);

    private static Task RecordAnonymousGovernanceNullifiersReadAuditAsync(
        IAuditEventService auditEvents,
        AnonymousGovernanceNullifierListResponse response,
        CancellationToken cancellationToken)
        => auditEvents.RecordHighValueAsync(new AuditEvent(
            AuditSourceCatalog.Admin,
            AuditTypeCatalog.Audit,
            AuditActionCatalog.AnonymousGovernanceNullifiersRead,
            AuditOutcomeCatalog.Success,
            AuditSeverityCatalog.Info,
            "管理员读取匿名 nullifier 治理列表",
            TargetType: "comment_anonymous_nullifier",
            TargetId: HashAuditTargetId("comment_anonymous_nullifier", "collection"),
            Context: new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["returnedCount"] = response.Items.Count
            }), cancellationToken);

    private static Task RecordAnonymousNullifierBlockAuditAsync(
        IAuditEventService auditEvents,
        AnonymousNullifierBlockRequest request,
        bool applied,
        CancellationToken cancellationToken)
    {
        string reason = string.IsNullOrWhiteSpace(request.Reason) ? "blocked_by_admin" : request.Reason.Trim();
        string target = HashAuditTargetId("comment_anonymous_nullifier", $"{request.Scope}:{request.NullifierHash}");
        return auditEvents.RecordHighValueAsync(new AuditEvent(
            AuditSourceCatalog.Admin,
            AuditTypeCatalog.Audit,
            AuditActionCatalog.AnonymousNullifierBlocked,
            applied ? AuditOutcomeCatalog.Success : AuditOutcomeCatalog.Failure,
            applied ? AuditSeverityCatalog.Warning : AuditSeverityCatalog.Error,
            "管理员封禁匿名评论 nullifier",
            TargetType: "comment_anonymous_nullifier",
            TargetId: target,
            ReasonCode: reason,
            Context: new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["scope"] = request.Scope,
                ["nullifierTarget"] = target,
                ["applied"] = applied
            }), cancellationToken);
    }

    private static Task RecordAnonymousCredentialRevokeAuditAsync(
        IAuditEventService auditEvents,
        AnonymousGovernanceCredentialRevokeRequest request,
        bool applied,
        CancellationToken cancellationToken)
    {
        string rootTarget = HashAuditTargetId("anonymous_credential_root", request.RootHash);
        string handleTarget = HashAuditTargetId("anonymous_revocation_handle", request.RevocationHandleHash);
        return auditEvents.RecordHighValueAsync(new AuditEvent(
            AuditSourceCatalog.Admin,
            AuditTypeCatalog.Audit,
            AuditActionCatalog.AnonymousCredentialRevoked,
            applied ? AuditOutcomeCatalog.Success : AuditOutcomeCatalog.Failure,
            applied ? AuditSeverityCatalog.Warning : AuditSeverityCatalog.Error,
            "管理员撤销匿名凭证资格",
            TargetType: "anonymous_credential_revocation",
            TargetId: handleTarget,
            ReasonCode: request.Reason,
            Context: new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["epoch"] = request.Epoch,
                ["rootTarget"] = rootTarget,
                ["revocationHandleTarget"] = handleTarget,
                ["applied"] = applied
            }), cancellationToken);
    }

    private static string HashAuditTargetId(string kind, string value)
    {
        string normalized = $"{kind}:{(value ?? string.Empty).Trim()}";
        string hash = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(normalized)));
        return $"{kind}:sha256:{hash}";
    }
}
