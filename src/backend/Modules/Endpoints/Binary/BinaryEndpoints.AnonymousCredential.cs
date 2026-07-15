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
using FsusBlog.Shared.Contracts.Validation;
using System.Globalization;
using System.Security.Claims;
using System.Diagnostics;

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

        group.MapPost("/anonymous-credential/revocation-witness", static (IAedsEncoder aeds) =>
            BinaryResults.FromError(
                ErrorDetail.Create(ErrorCode.Validation, "credential_specific_revocation_witness_retired"),
                aeds,
                StatusCodes.Status410Gone))
        .AllowAnonymous()
        .RequireRateLimiting("public_read")
        .RequireNoStoreResponse()
        .RequireStrongAnonymousRequest()
        .WithName("binary_post_anonymous_credential_revocation_retired")
        .WithSummary("credential-specific revocation witness permanently retired");

        group.MapGet(
            "/anonymous-credential/revocation/{epoch:long}/{version:long}/{revocationRoot}/full.aeds",
            static async Task<BinaryFrameResult> (
                long epoch,
                long version,
                string revocationRoot,
                HttpContext httpContext,
                IAedsEncoder aeds,
                IAnonymousCredentialRevocationArtifactService artifacts,
                CancellationToken cancellationToken) =>
                await HandleAnonymousCredentialRevocationArtifactAsync(
                    epoch,
                    version,
                    revocationRoot,
                    AnonymousCredentialRevocationArtifactKinds.Full,
                    baseVersion: 0,
                    httpContext,
                    aeds,
                    artifacts,
                    cancellationToken))
        .AllowAnonymous()
        .RequireRateLimiting("public_read")
        .WithName("binary_get_anonymous_credential_revocation_full")
        .WithSummary("public immutable revocation full snapshot");

        group.MapGet(
            "/anonymous-credential/revocation/{epoch:long}/{version:long}/{revocationRoot}/delta/{baseVersion:long}.aeds",
            static async Task<BinaryFrameResult> (
                long epoch,
                long version,
                string revocationRoot,
                long baseVersion,
                HttpContext httpContext,
                IAedsEncoder aeds,
                IAnonymousCredentialRevocationArtifactService artifacts,
                CancellationToken cancellationToken) =>
                await HandleAnonymousCredentialRevocationArtifactAsync(
                    epoch,
                    version,
                    revocationRoot,
                    AnonymousCredentialRevocationArtifactKinds.Delta,
                    baseVersion,
                    httpContext,
                    aeds,
                    artifacts,
                    cancellationToken))
        .AllowAnonymous()
        .RequireRateLimiting("public_read")
        .WithName("binary_get_anonymous_credential_revocation_delta")
        .WithSummary("public immutable revocation delta");

        group.MapPost("/anonymous-credential/issue", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            cancellationToken.ThrowIfCancellationRequested();
            return BinaryResults.FromError(
                ErrorDetail.Create(ErrorCode.Validation, "anonymous_credential_legacy_issuance_rejected"),
                aeds,
                StatusCodes.Status410Gone);
        })
        .RequireAnonymousAccountPrincipal()
        .RequireRateLimiting("fixed_ip")
        .RequireNoStoreResponse();

        group.MapGet("/anonymous-credential/blind-issuer", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IAedsEncoder aeds,
            IAnonymousCredentialRootService roots,
            IRfc9474BlindCredentialSigner signer,
            IBlindCredentialRuntimeGate runtimeGate,
            IConfiguration configuration,
            CancellationToken cancellationToken) =>
            await HandleBlindCredentialIssuerMetadataAsync(
                httpContext, aeds, roots, signer, runtimeGate, configuration, cancellationToken))
        .AllowAnonymous()
        .RequireRateLimiting("public_read")
        .RequireNoStoreResponse();

        group.MapPost("/anonymous-credential/blind-issue", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IAedsEncoder aeds,
            IBlindCredentialIssuanceService issuer,
            IUserAccountReader users,
            IBlindCredentialRuntimeGate runtimeGate,
            CancellationToken cancellationToken) =>
            await HandleBlindCredentialIssueAsync(
                httpContext, aeds, issuer, users, runtimeGate, cancellationToken))
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

    internal static async Task<BinaryFrameResult> HandleBlindCredentialIssuerMetadataAsync(
        HttpContext httpContext,
        IAedsEncoder aeds,
        IAnonymousCredentialRootService roots,
        IRfc9474BlindCredentialSigner signer,
        IBlindCredentialRuntimeGate runtimeGate,
        IConfiguration configuration,
        CancellationToken cancellationToken)
    {
        if (!AcceptsBinaryResponse(httpContext.Request) ||
            !runtimeGate.IsEnabled ||
            !signer.IsConfigured)
        {
            return BinaryResults.FromError(
                ErrorDetail.Create(ErrorCode.InfraFailure, "anonymous_credential_blind_issuer_unavailable"),
                aeds,
                StatusCodes.Status503ServiceUnavailable);
        }

        Result<AnonymousCredentialRootSnapshotCoreModel> root =
            await roots.GetCurrentSnapshotAsync(cancellationToken);
        if (!root.IsSuccess ||
            !root.Value.ZkAnonymousEnabled ||
            !root.Value.VerifierConfigured ||
            root.Value.PublicInputLayoutVersion != AnonymousPrivacyContract.PublicInputLayoutVersion ||
            !string.Equals(root.Value.CircuitId, AnonymousPrivacyContract.CircuitId, StringComparison.Ordinal) ||
            !string.Equals(root.Value.IssuerPublicKeyHash, signer.PublicKeyHash, StringComparison.OrdinalIgnoreCase))
        {
            return BinaryResults.FromError(
                ErrorDetail.Create(ErrorCode.InfraFailure, "anonymous_credential_blind_issuer_unavailable"),
                aeds,
                StatusCodes.Status503ServiceUnavailable);
        }

        var metadata = new BlindCredentialIssuerMetadataCoreModel(
            root.Value.CredentialEpoch,
            root.Value.RootExpiresAtUnixMs,
            root.Value.CircuitNumericId,
            root.Value.PublicInputLayoutVersion,
            root.Value.CircuitId,
            BlindCredentialIssuanceService.ResolveCredentialLevel(configuration),
            Rfc9474BlindCredentialProfile.SchemeId,
            signer.KeyId,
            signer.PublicKeyHash,
            checked((ushort)signer.ModulusBytes),
            signer.SubjectPublicKeyInfo);
        return BinaryResults.Frame(
            aeds,
            AedsFrameType.BlindCredentialIssuerMetadata,
            writer => PodBinaryCodec.WriteBlindCredentialIssuerMetadata(metadata, writer));
    }

    internal static async Task<BinaryFrameResult> HandleBlindCredentialIssueAsync(
        HttpContext httpContext,
        IAedsEncoder aeds,
        IBlindCredentialIssuanceService issuer,
        IUserAccountReader users,
        IBlindCredentialRuntimeGate runtimeGate,
        CancellationToken cancellationToken)
    {
        long started = Stopwatch.GetTimestamp();
        BinaryFrameResult result;
        if (!AcceptsBinaryResponse(httpContext.Request))
        {
            result = BinaryResults.FromError(
                ErrorDetail.Create(ErrorCode.Forbidden, "anonymous_credential_blind_issue_denied"),
                aeds,
                StatusCodes.Status403Forbidden);
            await DelayBlindIssuanceEnvelopeAsync(started, runtimeGate, cancellationToken);
            return result;
        }

        Result<int> accountId = await ResolveBlindCredentialIssueAccountAsync(
            httpContext, users);
        if (!accountId.IsSuccess)
        {
            result = BinaryResults.FromError(
                ErrorDetail.Create(ErrorCode.Forbidden, "anonymous_credential_blind_issue_denied"),
                aeds,
                StatusCodes.Status403Forbidden);
            await DelayBlindIssuanceEnvelopeAsync(started, runtimeGate, cancellationToken);
            return result;
        }

        BinaryRequestPayload payload = await ReadBinaryRequestPayloadAsync(
            httpContext,
            aeds,
            AedsFrameType.BlindCredentialIssueRequest,
            cancellationToken,
            4 * 1024);
        if (!payload.IsSuccess ||
            !PodBinaryCodec.TryDecodeBlindCredentialIssueRequest(
                payload.Payload,
                out BlindCredentialIssueRequestCoreModel request))
        {
            result = BinaryResults.FromError(
                ErrorDetail.Create(ErrorCode.Forbidden, "anonymous_credential_blind_issue_denied"),
                aeds,
                StatusCodes.Status403Forbidden);
            await DelayBlindIssuanceEnvelopeAsync(started, runtimeGate, cancellationToken);
            return result;
        }

        Result<BlindCredentialIssueResponseCoreModel> issued =
            await issuer.IssueAsync(accountId.Value, request, cancellationToken);
        result = issued.IsSuccess
            ? BinaryResults.Frame(
                aeds,
                AedsFrameType.BlindCredentialIssueResponse,
                writer => PodBinaryCodec.WriteBlindCredentialIssueResponse(issued.Value, writer))
            : BinaryResults.FromError(
                ErrorDetail.Create(ErrorCode.Forbidden, "anonymous_credential_blind_issue_denied"),
                aeds,
                StatusCodes.Status403Forbidden);
        await DelayBlindIssuanceEnvelopeAsync(started, runtimeGate, cancellationToken);
        return result;
    }

    private static async Task DelayBlindIssuanceEnvelopeAsync(
        long started,
        IBlindCredentialRuntimeGate runtimeGate,
        CancellationToken cancellationToken)
    {
        TimeSpan remaining = runtimeGate.GetEnvelopeDelay(Stopwatch.GetElapsedTime(started));
        if (remaining > TimeSpan.Zero)
        {
            await Task.Delay(remaining, cancellationToken);
        }
    }

    private static async Task<Result<int>> ResolveBlindCredentialIssueAccountAsync(
        HttpContext httpContext,
        IUserAccountReader users)
    {
        if (httpContext.User.Identity?.IsAuthenticated != true ||
            !TryReadUserId(httpContext.User, out int accountId) ||
            !string.Equals(
                httpContext.User.FindFirst("identity_kind")?.Value,
                AnonymousIdentityRuntime.AnonymousAccountKind,
                StringComparison.Ordinal))
        {
            return Result<int>.Failure(ErrorCode.Forbidden, "anonymous_credential_blind_issue_denied");
        }

        UserAccountSnapshot? account = await users.GetAccountByIdAsync(accountId);
        if (account is null ||
            account.Value.DeletedAt.HasValue ||
            account.Value.Status == 2 ||
            !string.Equals(
                account.Value.IdentityKind,
                AnonymousIdentityRuntime.AnonymousAccountKind,
                StringComparison.Ordinal) ||
            !string.Equals(
                NormalizeAnonymousCredentialStatus(account.Value.AnonymousCredentialStatus),
                AnonymousCredentialStatuses.Active,
                StringComparison.Ordinal))
        {
            return Result<int>.Failure(ErrorCode.Forbidden, "anonymous_credential_blind_issue_denied");
        }

        // Deliberately no high-value audit here: raw account, trace and request
        // path correlation would defeat blind issuance. The quota store persists
        // only an epoch-scoped HMAC subject and an hour bucket.
        return Result<int>.Success(accountId);
    }

    internal static async Task<BinaryFrameResult> HandleAnonymousCredentialRevocationArtifactAsync(
        long epoch,
        long version,
        string revocationRoot,
        byte kind,
        long baseVersion,
        HttpContext httpContext,
        IAedsEncoder aeds,
        IAnonymousCredentialRevocationArtifactService artifacts,
        CancellationToken cancellationToken)
    {
        if (!AcceptsBinaryResponse(httpContext.Request))
        {
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "binary_accept_required"), aeds, StatusCodes.Status406NotAcceptable);
        }

        Result<AnonymousCredentialRevocationArtifactCoreModel> artifact = await artifacts.GetAsync(
            epoch,
            version,
            revocationRoot,
            kind,
            baseVersion,
            cancellationToken);
        if (!artifact.IsSuccess)
        {
            return BinaryResults.FromError(
                artifact.Error,
                aeds,
                artifact.Error.Code == ErrorCode.NotFound
                    ? StatusCodes.Status404NotFound
                    : StatusCodes.Status409Conflict);
        }

        AnonymousCredentialRevocationArtifactCoreModel response = artifact.Value;
        string digest = Convert.ToHexStringLower(response.ContentHash);
        httpContext.Response.Headers.CacheControl = "public, max-age=31536000, immutable";
        httpContext.Response.Headers.ETag = $"\"{digest}\"";
        httpContext.Response.Headers.Vary = "Accept-Encoding";
        AedsFrameType frameType = kind == AnonymousCredentialRevocationArtifactKinds.Full
            ? AedsFrameType.AnonymousCredentialRevocationSnapshot
            : AedsFrameType.AnonymousCredentialRevocationDelta;
        return BinaryResults.Frame(
            aeds,
            frameType,
            writer => PodBinaryCodec.WriteAnonymousCredentialRevocationArtifact(response, writer));
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
