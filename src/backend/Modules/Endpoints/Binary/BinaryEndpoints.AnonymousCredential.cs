using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Policies;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services.Security;
using System.Globalization;
using System.Security.Claims;

namespace FsusBlog.Server.Modules.Endpoints.Binary;

public static partial class BinaryEndpoints
{
    private static void MapBinaryAnonymousCredentialEndpoints(IEndpointRouteBuilder group)
    {
        group.MapGet("/anonymous-credential/root", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IAedsEncoder aeds,
            IAnonymousCredentialRootService rootService,
            CancellationToken cancellationToken) =>
            await HandleAnonymousCredentialRootAsync(httpContext, aeds, rootService, cancellationToken))
        .AllowAnonymous()
        .RequireRateLimiting("public_read");

        group.MapGet("/anonymous-credential/circuit", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IAedsEncoder aeds,
            IAnonymousCredentialRootService rootService,
            CancellationToken cancellationToken) =>
            await HandleAnonymousCredentialRootAsync(httpContext, aeds, rootService, cancellationToken))
        .AllowAnonymous()
        .RequireRateLimiting("public_read");

        group.MapPost("/anonymous-credential/revocation-witness", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IAedsEncoder aeds,
            IAnonymousCredentialRevocationWitnessService witnessService,
            CancellationToken cancellationToken) =>
            await HandleAnonymousCredentialRevocationWitnessAsync(httpContext, aeds, witnessService, cancellationToken))
        .AllowAnonymous()
        .RequireRateLimiting("public_read")
        .RequireNoStoreResponse()
        .RequireStrongAnonymousRequest();

        group.MapPost("/anonymous-credential/issue", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IAedsEncoder aeds,
            IAnonymousCredentialIssuerService issuer,
            IUserAccountReader users,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
            await HandleAnonymousCredentialIssueAsync(httpContext, aeds, issuer, users, auditEvents, cancellationToken))
        .RequireAnonymousAccountPrincipal()
        .RequireRateLimiting("fixed_ip")
        .RequireNoStoreResponse();
    }

    internal static async Task<BinaryFrameResult> HandleAnonymousCredentialRootAsync(
        HttpContext httpContext,
        IAedsEncoder aeds,
        IAnonymousCredentialRootService rootService,
        CancellationToken cancellationToken)
    {
        if (!AcceptsBinaryResponse(httpContext.Request))
        {
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "binary_accept_required"), aeds, StatusCodes.Status406NotAcceptable);
        }

        Result<AnonymousCredentialRootSnapshotCoreModel> root = await rootService.GetCurrentSnapshotAsync(cancellationToken);
        if (!root.IsSuccess)
        {
            return BinaryResults.FromError(
                ErrorDetail.Create(root.Error.Code, string.IsNullOrWhiteSpace(root.Error.Message) ? "anonymous_root_unavailable" : root.Error.Message),
                aeds,
                StatusCodes.Status503ServiceUnavailable);
        }

        AnonymousCredentialRootSnapshotCoreModel snapshot = root.Value;
        return BinaryResults.Frame(
            aeds,
            AedsFrameType.AnonymousCredentialRootSnapshot,
            writer => PodBinaryCodec.WriteAnonymousCredentialRootSnapshot(snapshot, writer));
    }

    internal static async Task<BinaryFrameResult> HandleAnonymousCredentialRevocationWitnessAsync(
        HttpContext httpContext,
        IAedsEncoder aeds,
        IAnonymousCredentialRevocationWitnessService witnessService,
        CancellationToken cancellationToken)
    {
        if (!AcceptsBinaryResponse(httpContext.Request))
        {
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "binary_accept_required"), aeds, StatusCodes.Status406NotAcceptable);
        }

        BinaryRequestPayload payload = await ReadBinaryRequestPayloadAsync(
            httpContext,
            aeds,
            AedsFrameType.AnonymousCredentialRevocationWitnessRequest,
            cancellationToken,
            AnonymousCredentialRevocationWitnessLimits.MaxRequestFrameBytes);
        if (!payload.IsSuccess)
        {
            return BinaryResults.FromError(payload.Error, aeds);
        }

        if (!PodBinaryCodec.TryDecodeAnonymousCredentialRevocationWitnessRequest(
                payload.Payload,
                out AnonymousCredentialRevocationWitnessRequestCoreModel request))
        {
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "anonymous_credential_revocation_witness_request_invalid"), aeds);
        }

        Result<AnonymousCredentialRevocationWitnessResponseCoreModel> witness =
            await witnessService.CreateWitnessAsync(request, cancellationToken);
        return witness.IsSuccess && witness.Value is { } response
            ? BinaryResults.Frame(
                aeds,
                AedsFrameType.AnonymousCredentialRevocationWitnessResponse,
                writer => PodBinaryCodec.WriteAnonymousCredentialRevocationWitnessResponse(response, writer))
            : BinaryResults.FromError(witness.Error, aeds);
    }

    internal static async Task<BinaryFrameResult> HandleAnonymousCredentialIssueAsync(
        HttpContext httpContext,
        IAedsEncoder aeds,
        IAnonymousCredentialIssuerService issuer,
        IUserAccountReader users,
        IAuditEventService auditEvents,
        CancellationToken cancellationToken)
    {
        if (!AcceptsBinaryResponse(httpContext.Request))
        {
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "binary_accept_required"), aeds, StatusCodes.Status406NotAcceptable);
        }

        Result<int> accountId = await ResolveAnonymousCredentialIssueAccountAsync(
            httpContext,
            users,
            auditEvents,
            cancellationToken);
        if (!accountId.IsSuccess)
        {
            int statusCode = accountId.Error.Code == ErrorCode.Unauthorized
                ? StatusCodes.Status401Unauthorized
                : StatusCodes.Status403Forbidden;
            return BinaryResults.FromError(accountId.Error, aeds, statusCode);
        }

        BinaryRequestPayload payload = await ReadBinaryRequestPayloadAsync(
            httpContext,
            aeds,
            AedsFrameType.AnonymousCredentialIssueRequest,
            cancellationToken,
            AnonymousCredentialIssuerLimits.MaxIssueRequestFrameBytes);
        if (!payload.IsSuccess)
        {
            return BinaryResults.FromError(payload.Error, aeds);
        }

        if (!PodBinaryCodec.TryDecodeAnonymousCredentialIssueRequest(payload.Payload, out AnonymousCredentialIssueRequestCoreModel request))
        {
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "anonymous_credential_issue_request_invalid"), aeds);
        }

        Result<AnonymousCredentialIssueResponseCoreModel> issued = await issuer.IssueAsync(
            accountId.Value,
            request,
            httpContext.TraceIdentifier,
            cancellationToken);
        return issued.IsSuccess && issued.Value is { } response
            ? BinaryResults.Frame(aeds, AedsFrameType.AnonymousCredentialIssueResponse, writer => PodBinaryCodec.WriteAnonymousCredentialIssueResponse(response, writer))
            : BinaryResults.FromError(issued.Error, aeds);
    }

    private static async Task<Result<int>> ResolveAnonymousCredentialIssueAccountAsync(
        HttpContext httpContext,
        IUserAccountReader users,
        IAuditEventService auditEvents,
        CancellationToken cancellationToken)
    {
        if (httpContext.User.Identity?.IsAuthenticated != true ||
            !TryReadUserId(httpContext.User, out int accountId))
        {
            return Result<int>.Failure(ErrorCode.Unauthorized, "anonymous_credential_auth_required");
        }

        string? identityKind = httpContext.User.FindFirst("identity_kind")?.Value;
        if (string.IsNullOrWhiteSpace(identityKind))
        {
            await RecordAnonymousCredentialIssueDeniedAsync(
                httpContext,
                auditEvents,
                accountId,
                "identity_kind_missing",
                cancellationToken);
            return Result<int>.Failure(ErrorCode.Forbidden, "anonymous_credential_anonymous_account_required");
        }

        if (!string.Equals(identityKind, AnonymousIdentityRuntime.AnonymousAccountKind, StringComparison.Ordinal))
        {
            string reason = string.Equals(identityKind, AnonymousIdentityRuntime.AdminPrincipalKind, StringComparison.Ordinal)
                ? "admin_principal_rejected"
                : "identity_kind_invalid";
            await RecordAnonymousCredentialIssueDeniedAsync(
                httpContext,
                auditEvents,
                accountId,
                reason,
                cancellationToken);
            return Result<int>.Failure(ErrorCode.Forbidden, "anonymous_credential_anonymous_account_required");
        }

        UserAccountSnapshot? account = await users.GetAccountByIdAsync(accountId);
        if (account is null ||
            account.Value.DeletedAt.HasValue ||
            account.Value.Status == 2 ||
            !string.Equals(account.Value.IdentityKind, AnonymousIdentityRuntime.AnonymousAccountKind, StringComparison.Ordinal))
        {
            await RecordAnonymousCredentialIssueDeniedAsync(
                httpContext,
                auditEvents,
                accountId,
                "account_unavailable",
                cancellationToken);
            return Result<int>.Failure(ErrorCode.Forbidden, "anonymous_credential_account_unavailable");
        }

        if (!string.Equals(
                NormalizeAnonymousCredentialStatus(account.Value.AnonymousCredentialStatus),
                AnonymousCredentialStatuses.Active,
                StringComparison.Ordinal))
        {
            await RecordAnonymousCredentialIssueDeniedAsync(
                httpContext,
                auditEvents,
                accountId,
                "credential_disabled",
                cancellationToken);
            return Result<int>.Failure(ErrorCode.Forbidden, "anonymous_credential_disabled");
        }

        return Result<int>.Success(accountId);
    }

    private static bool TryReadUserId(ClaimsPrincipal principal, out int userId)
    {
        userId = 0;
        string? userIdClaim = principal.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        return int.TryParse(userIdClaim, NumberStyles.None, CultureInfo.InvariantCulture, out userId) && userId > 0;
    }

    private static string NormalizeAnonymousCredentialStatus(string? status)
    {
        string normalized = TextHelpers.LowerTrimmed(status) ?? string.Empty;
        return normalized;
    }

    private static Task RecordAnonymousCredentialIssueDeniedAsync(
        HttpContext httpContext,
        IAuditEventService auditEvents,
        int accountId,
        string reason,
        CancellationToken cancellationToken)
        => auditEvents.RecordHighValueAsync(new AuditEvent(
            AuditSourceCatalog.Security,
            AuditTypeCatalog.Security,
            AuditActionCatalog.AnonymousCredentialIssued,
            AuditOutcomeCatalog.Denied,
            AuditSeverityCatalog.Warning,
            "匿名凭证签发主体校验拒绝",
            ActorType: AuditActorTypeCatalog.Anonymous,
            ActorId: accountId.ToString(CultureInfo.InvariantCulture),
            TargetType: "anonymous_credential_issuance",
            TargetId: "anonymous-account-principal",
            ReasonCode: reason,
            Context: new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["traceId"] = httpContext.TraceIdentifier,
                ["path"] = httpContext.Request.Path.Value,
                ["identityKind"] = httpContext.User.FindFirst("identity_kind")?.Value
            }),
            cancellationToken);
}
