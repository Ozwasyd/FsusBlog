using System.Buffers;
using System.Data.Common;
using System.Diagnostics;
using System.Globalization;

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
using FsusBlog.Server.Infrastructure.Policies;
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
    private const string AccessExpiresAtUtcHeader = "X-Fsus-Access-Expires-At-Utc";
    private static readonly TimeSpan s_authRiskSignalTtl = TimeSpan.FromMinutes(10);

    private static string ResolveBinaryIdentityKind(string? identityKind)
        => string.IsNullOrWhiteSpace(identityKind) ? AnonymousIdentityRuntime.AnonymousAccountKind : identityKind.Trim();

    private static bool TryResolveAccountSubjectHash(
        UserAccountSnapshot account,
        out string accountSubjectHash)
        => AccountSubjectHashRequirement.TryResolve(account.AccountSubjectHash, out accountSubjectHash);

    private static void MapBinaryAuthEndpoints(IEndpointRouteBuilder group)
    {
        group.MapGet("/auth/pow-challenge", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IPowService powService,
            IAedsEncoder aeds) =>
        {
            string clientIp = httpContext.GetClientIp();
            var challenge = await powService.GenerateChallengeAsync(clientIp);
            return BinaryResults.Frame(aeds, AedsFrameType.PowChallenge, writer => PodBinaryCodec.WritePowChallenge(challenge, writer));
        })
        .RequireRateLimiting("fixed_ip")
        .AllowAnonymous()
        .RequireNoStoreResponse();

        group.MapPost("/auth/anonymous/bootstrap", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            AuthBinaryApplicationFacade authFacade,
            IWebHostEnvironment env,
            AuthCookieService authCookieService,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var request = await AuthBinaryRequestReader.ReadAnonymousBootstrapAsync(httpContext, aeds, cancellationToken);
            if (!request.IsSuccess)
            {
                return AuthBinaryResponseWriter.Error(aeds, request.Error);
            }

            var result = await authFacade.BootstrapAnonymousAccountAsync(request.Value, AuthBinaryClientContext.From(httpContext), cancellationToken);
            if (!result.Success)
            {
                return AuthBinaryResponseWriter.Error(aeds, result.Error);
            }

            if (result.EnrollmentCredential is { } enrollment)
            {
                authCookieService.SetEnrollmentCookie(
                    httpContext,
                    env,
                    enrollment.Token,
                    enrollment.ExpiresAt);
            }

            if (result.SessionTokens is { } tokens)
            {
                authCookieService.SetTokenCookies(
                    httpContext,
                    env,
                    tokens.AccessToken,
                    tokens.AccessTokenExpiresAtUtc,
                    tokens.RefreshToken,
                    tokens.SessionId,
                    tokens.RefreshTokenExpiresAt,
                    persistent: false);
            }

            return AuthBinaryResponseWriter.LoginFlow(aeds, result.Flow);
        })
        .RequireRateLimiting("fixed_ip")
        .AllowAnonymous()
        .AddEndpointFilterWithMetadata<RequiresPowFilter>()
        .RequireNoStoreResponse();

        group.MapPost("/auth/enrollment/passkey/register/begin", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            AuthCookieService authCookieService,
            IAccountEnrollmentService enrollments,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var result = await enrollments.BeginPasskeyRegistrationAsync(
                authCookieService.ReadEnrollmentToken(httpContext),
                cancellationToken);
            return result.Success && result.Data is not null
                ? BinaryResults.Frame(aeds, AedsFrameType.PasskeyRegisterBegin, writer => PodBinaryCodec.WritePasskeyRegisterBegin(result.Data.Options, writer))
                : AuthBinaryResponseWriter.Error(aeds, result.Error);
        })
        .RequireRateLimiting("fixed_ip")
        .AllowAnonymous()
        .RequireNoStoreResponse();

        group.MapPost("/auth/enrollment/passkey/register/complete", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            AuthCookieService authCookieService,
            IAccountEnrollmentService enrollments,
            IWebHostEnvironment env,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var payload = await ReadBinaryRequestPayloadAsync(httpContext, aeds, AedsFrameType.PasskeyRegisterCompleteRequest, cancellationToken);
            if (!payload.IsSuccess)
            {
                return BinaryResults.FromError(payload.Error, aeds);
            }

            if (!PodBinaryCodec.TryDecodePasskeyRegisterCompleteRequest(payload.Payload, out var request) ||
                string.IsNullOrWhiteSpace(request.SessionKey) || request.RawId.Length == 0 ||
                request.ClientDataBytes.Length == 0 || request.AttestationObject.Length == 0)
            {
                return AuthBinaryResponseWriter.Error(aeds, ErrorDetail.Create(ErrorCode.Validation, "请求参数无效"));
            }

            var result = await enrollments.CompletePasskeyRegistrationAsync(
                authCookieService.ReadEnrollmentToken(httpContext),
                request,
                AuthBinaryClientContext.From(httpContext),
                cancellationToken);
            if (!result.Success || result.SessionTokens is not { } tokens)
            {
                return AuthBinaryResponseWriter.Error(aeds, result.Error);
            }

            authCookieService.SetTokenCookies(
                httpContext,
                env,
                tokens.AccessToken,
                tokens.AccessTokenExpiresAtUtc,
                tokens.RefreshToken,
                tokens.SessionId,
                tokens.RefreshTokenExpiresAt,
                persistent: false);
            authCookieService.ClearEnrollmentCookie(httpContext);
            return AuthBinaryResponseWriter.LoginFlow(aeds, result.Flow);
        })
        .RequireRateLimiting("fixed_ip")
        .AllowAnonymous()
        .RequireNoStoreResponse();

        group.MapGet("/auth/enrollment/status", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            AuthCookieService authCookieService,
            IAccountEnrollmentService enrollments,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var result = await enrollments.GetStatusAsync(authCookieService.ReadEnrollmentToken(httpContext), cancellationToken);
            return result.Success
                ? AuthBinaryResponseWriter.LoginFlow(aeds, result.Flow)
                : AuthBinaryResponseWriter.Error(aeds, result.Error);
        })
        .RequireRateLimiting("fixed_ip")
        .AllowAnonymous()
        .RequireNoStoreResponse();

        group.MapPost("/auth/enrollment/cancel", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            AuthCookieService authCookieService,
            IAccountEnrollmentService enrollments,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var result = await enrollments.CancelAsync(authCookieService.ReadEnrollmentToken(httpContext), cancellationToken);
            if (!result.Success)
            {
                return AuthBinaryResponseWriter.Error(aeds, result.Error);
            }

            authCookieService.ClearEnrollmentCookie(httpContext);
            return BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess);
        })
        .RequireRateLimiting("fixed_ip")
        .AllowAnonymous()
        .RequireNoStoreResponse();

        group.MapPost("/auth/admin/bootstrap/passkey/begin", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IAdminPrincipalService adminPrincipals,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            string bootstrapToken = ReadHeader(httpContext, AdminBootstrapTokenHeader);
            string handle = ReadHeader(httpContext, AdminHandleHeader);
            var (success, message, data) = await adminPrincipals.BeginBootstrapPasskeyRegistrationAsync(bootstrapToken, handle, cancellationToken);
            return success && data != null
                ? BinaryResults.Frame(aeds, AedsFrameType.PasskeyRegisterBegin, writer => PodBinaryCodec.WritePasskeyRegisterBegin(data.Options, writer))
                : BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Forbidden, message), aeds, StatusCodes.Status403Forbidden);
        })
        .AllowAnonymous()
        .RequireRateLimiting("fixed_ip")
        .RequireNoStoreResponse();

        group.MapPost("/auth/admin/bootstrap/passkey/complete", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IAdminPrincipalService adminPrincipals,
            IWebHostEnvironment env,
            AuthCookieService authCookieService,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var payload = await ReadBinaryRequestPayloadAsync(httpContext, aeds, AedsFrameType.PasskeyRegisterCompleteRequest, cancellationToken);
            if (!payload.IsSuccess)
            {
                return BinaryResults.FromError(payload.Error, aeds);
            }

            if (!PodBinaryCodec.TryDecodePasskeyRegisterCompleteRequest(payload.Payload, out var request) ||
                string.IsNullOrWhiteSpace(request.SessionKey) ||
                request.RawId.Length == 0 ||
                request.ClientDataBytes.Length == 0 ||
                request.AttestationObject.Length == 0)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "请求参数无效"), aeds);
            }

            string bootstrapToken = ReadHeader(httpContext, AdminBootstrapTokenHeader);
            var result = await adminPrincipals.CompleteBootstrapPasskeyRegistrationAsync(
                bootstrapToken,
                request,
                AdminAuthClientContext.From(httpContext),
                cancellationToken);
            if (!result.Success || result.Tokens is null)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Forbidden, result.Message), aeds, StatusCodes.Status403Forbidden);
            }

            authCookieService.SetAdminSessionCookies(
                httpContext,
                env,
                result.Tokens.AccessToken,
                result.Tokens.AccessTokenExpiresAtUtc,
                result.Tokens.SessionId,
                result.Tokens.IdleExpiresAtUtc);
            return BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess);
        })
        .AllowAnonymous()
        .RequireRateLimiting("fixed_ip")
        .RequireNoStoreResponse();

        group.MapPost("/auth/admin/login/passkey/begin", static async Task<BinaryFrameResult> (
            IAdminPrincipalService adminPrincipals,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var (success, message, data) = await adminPrincipals.BeginAdminAssertionAsync(cancellationToken);
            return success && data != null
                ? BinaryResults.Frame(aeds, AedsFrameType.PasskeyLoginBegin, writer => PodBinaryCodec.WritePasskeyLoginBegin(data.Options, writer))
                : BinaryResults.FromError(ErrorDetail.Create(ErrorCode.InfraFailure, message), aeds);
        })
        .AllowAnonymous()
        .RequireRateLimiting("fixed_ip")
        .RequireNoStoreResponse();

        group.MapPost("/auth/admin/login/passkey/complete", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IAdminPrincipalService adminPrincipals,
            IWebHostEnvironment env,
            AuthCookieService authCookieService,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var payload = await ReadBinaryRequestPayloadAsync(httpContext, aeds, AedsFrameType.PasskeyLoginCompleteRequest, cancellationToken);
            if (!payload.IsSuccess)
            {
                return BinaryResults.FromError(payload.Error, aeds);
            }

            if (!PodBinaryCodec.TryDecodePasskeyLoginCompleteRequest(payload.Payload, out var request) ||
                string.IsNullOrWhiteSpace(request.ChallengeToken) ||
                request.RawId.Length == 0 ||
                request.ClientDataBytes.Length == 0 ||
                request.AuthenticatorData.Length == 0 ||
                request.Signature.Length == 0)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "请求参数无效"), aeds);
            }

            var result = await adminPrincipals.CompleteAdminAssertionAsync(request, AdminAuthClientContext.From(httpContext), cancellationToken);
            if (!result.Success || result.Tokens is null)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Unauthorized, result.Message), aeds);
            }

            authCookieService.SetAdminSessionCookies(
                httpContext,
                env,
                result.Tokens.AccessToken,
                result.Tokens.AccessTokenExpiresAtUtc,
                result.Tokens.SessionId,
                result.Tokens.IdleExpiresAtUtc);
            return BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess);
        })
        .AllowAnonymous()
        .RequireRateLimiting("fixed_ip")
        .RequireNoStoreResponse();

        group.MapPost("/auth/admin/step-up/passkey/begin", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IAdminPrincipalService adminPrincipals,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            if (!TryResolveAdminSessionContext(httpContext, out long adminPrincipalId, out string adminSessionId))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Unauthorized, "admin_session_missing"), aeds, StatusCodes.Status401Unauthorized);
            }

            var (success, message, data) = await adminPrincipals.BeginAdminStepUpAssertionAsync(adminPrincipalId, adminSessionId, cancellationToken);
            return success && data != null
                ? BinaryResults.Frame(aeds, AedsFrameType.PasskeyLoginBegin, writer => PodBinaryCodec.WritePasskeyLoginBegin(data.Options, writer))
                : BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Forbidden, message), aeds, StatusCodes.Status403Forbidden);
        })
        .RequireAdminPermission(AdminPermissions.AdminManage)
        .RequireRateLimiting("fixed_ip")
        .RequireNoStoreResponse();

        group.MapPost("/auth/admin/step-up/passkey/complete", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IAdminPrincipalService adminPrincipals,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            if (!TryResolveAdminSessionContext(httpContext, out long adminPrincipalId, out string adminSessionId))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Unauthorized, "admin_session_missing"), aeds, StatusCodes.Status401Unauthorized);
            }

            var payload = await ReadBinaryRequestPayloadAsync(httpContext, aeds, AedsFrameType.PasskeyLoginCompleteRequest, cancellationToken);
            if (!payload.IsSuccess)
            {
                return BinaryResults.FromError(payload.Error, aeds);
            }

            if (!PodBinaryCodec.TryDecodePasskeyLoginCompleteRequest(payload.Payload, out var request) ||
                string.IsNullOrWhiteSpace(request.ChallengeToken) ||
                request.RawId.Length == 0 ||
                request.ClientDataBytes.Length == 0 ||
                request.AuthenticatorData.Length == 0 ||
                request.Signature.Length == 0)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "请求参数无效"), aeds);
            }

            var result = await adminPrincipals.CompleteAdminStepUpAssertionAsync(
                adminPrincipalId,
                adminSessionId,
                request,
                AdminAuthClientContext.From(httpContext),
                cancellationToken);
            if (!result.Success || string.IsNullOrWhiteSpace(result.ProofToken))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Unauthorized, result.Message), aeds, StatusCodes.Status401Unauthorized);
            }

            var proof = new MfaChallengeResultDto(true, AdminSensitiveAction, result.ProofToken, null);
            return BinaryResults.Frame(aeds, AedsFrameType.MfaChallengeResult, writer => PodBinaryCodec.WriteMfaChallengeResult(proof, writer));
        })
        .RequireAdminPermission(AdminPermissions.AdminManage)
        .RequireRateLimiting("fixed_ip")
        .RequireNoStoreResponse();

        group.MapGet("/auth/admin/me", static (HttpContext httpContext, IAedsEncoder aeds) =>
        {
            if (!TryResolveAdminSessionContext(httpContext, out long adminPrincipalId, out _))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Unauthorized, "admin_session_missing"), aeds, StatusCodes.Status401Unauthorized);
            }

            AdminPrincipalSnapshotDto snapshot = BuildAdminPrincipalSnapshot(httpContext, adminPrincipalId);
            return BinaryResults.Frame(aeds, AedsFrameType.AdminPrincipalSnapshot, writer => PodBinaryCodec.WriteJsonPayload(snapshot, writer));
        })
            .RequireAdminPermission(AdminPermissions.AdminManage)
            .RequireNoStoreResponse();

        group.MapPost("/auth/admin/logout", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IAdminPrincipalService adminPrincipals,
            AuthCookieService authCookieService,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            if (!TryResolveAdminSessionContext(httpContext, out long adminPrincipalId, out string adminSessionId))
            {
                authCookieService.ClearAdminSessionCookies(httpContext);
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Unauthorized, "admin_session_missing"), aeds, StatusCodes.Status401Unauthorized);
            }

            _ = await adminPrincipals.LogoutAdminSessionAsync(adminPrincipalId, adminSessionId, cancellationToken);
            authCookieService.ClearAdminSessionCookies(httpContext);
            return BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess);
        })
        .RequireAdminPermission(AdminPermissions.AdminManage)
        .RequireNoStoreResponse();

        group.MapGet("/auth/admin/sessions", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IAdminPrincipalService adminPrincipals,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            if (!TryResolveAdminSessionContext(httpContext, out long adminPrincipalId, out string adminSessionId))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Unauthorized, "admin_session_missing"), aeds, StatusCodes.Status401Unauthorized);
            }

            IReadOnlyList<AdminSessionSummaryDto> sessions = await adminPrincipals.GetAdminSessionsAsync(adminPrincipalId, adminSessionId, cancellationToken);
            return BinaryResults.Frame(aeds, AedsFrameType.AdminSessionList, writer => PodBinaryCodec.WriteAdminSessions(sessions, writer));
        })
        .RequireAdminPermission(AdminPermissions.AdminManage)
        .RequireNoStoreResponse();

        group.MapPost("/auth/admin/sessions/{sessionId}/revoke", static async Task<BinaryFrameResult> (
            string sessionId,
            HttpContext httpContext,
            IAdminPrincipalService adminPrincipals,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            if (!TryResolveAdminSessionContext(httpContext, out long adminPrincipalId, out _))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Unauthorized, "admin_session_missing"), aeds, StatusCodes.Status401Unauthorized);
            }

            if (!await adminPrincipals.EnsureAdminSessionBelongsToPrincipalAsync(adminPrincipalId, sessionId, cancellationToken))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.NotFound, "admin_session_not_found"), aeds);
            }

            AdminSessionRevokeResult revoked = await adminPrincipals.RevokeAdminSessionAsync(adminPrincipalId, sessionId, "revoked_by_admin", cancellationToken);
            return revoked switch
            {
                AdminSessionRevokeResult.Revoked => BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess),
                AdminSessionRevokeResult.Conflict => BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Conflict, "admin_session_revoke_conflict"), aeds, StatusCodes.Status409Conflict),
                _ => BinaryResults.FromError(ErrorDetail.Create(ErrorCode.NotFound, "admin_session_not_found"), aeds)
            };
        })
        .RequireAdminPermission(AdminPermissions.AdminManage)
        .RequireNoStoreResponse();

        group.MapPost("/auth/admin/sessions/revoke-others", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IAdminPrincipalService adminPrincipals,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            if (!TryResolveAdminSessionContext(httpContext, out long adminPrincipalId, out string adminSessionId))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Unauthorized, "admin_session_missing"), aeds, StatusCodes.Status401Unauthorized);
            }

            _ = await adminPrincipals.RevokeOtherAdminSessionsAsync(adminPrincipalId, adminSessionId, cancellationToken);
            return BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess);
        })
        .RequireAdminPermission(AdminPermissions.AdminManage)
        .RequireNoStoreResponse();

        group.MapGet("/auth/me", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IUserAccountReader users,
            IAedsEncoder aeds) =>
        {
            long startedAt = Stopwatch.GetTimestamp();
            try
            {
                var userContext = EndpointUserContext.From(httpContext.User);
                UserAccountSnapshot? user = await users.GetAccountByIdAsync(userContext.AccountId);
                if (user == null)
                {
                    return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.NotFound, "用户不存在"), aeds);
                }

                if (user.Value.Status == 2 || user.Value.DeletedAt.HasValue)
                {
                    return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Unauthorized, "账户已注销"), aeds);
                }

                var snapshot = UserAccountReader.ToAnonymousAccountSnapshot(user.Value);
                if (!TryWriteAccessExpiryHeader(httpContext))
                {
                    return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Unauthorized, "访问凭证到期时间无效"), aeds, StatusCodes.Status401Unauthorized);
                }
                return BinaryResults.Frame(aeds, AedsFrameType.IdentityAccountSnapshot, writer => PodBinaryCodec.WriteIdentityAccountSnapshot(snapshot, writer));
            }
            finally
            {
                FsusObservability.RecordAuthMe(Stopwatch.GetElapsedTime(startedAt));
            }
        })
        .RequireAnonymousAccountPrincipal()
        .AllowRestrictedAccountAction(RestrictedAccountAction.ViewSelf);

        group.MapGet("/auth/{id:int}", static async Task<BinaryFrameResult> (
            int id,
            IUserAccountReader users,
            IAedsEncoder aeds) =>
        {
            UserAccountSnapshot? user = await users.GetAccountByIdAsync(id);
            if (user == null)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.NotFound, "未找到该用户"), aeds);
            }

            var snapshot = new CurrentUserSnapshotDto(
                user.Value.Id,
                ResolveBinaryIdentityKind(user.Value.IdentityKind),
                user.Value.Status,
                user.Value.BanReason,
                user.Value.DeletedAt);
            return BinaryResults.Frame(aeds, AedsFrameType.CurrentUserSnapshot, writer => PodBinaryCodec.WriteCurrentUserSnapshot(snapshot, writer));
        })
        .RequireAdminPermission(AdminPermissions.AdminManage);

        group.MapPut("/auth/public-handle", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IUserProfileCommandService profileCommands,
            IContentFilterService contentFilterService,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var payload = await ReadBinaryRequestPayloadAsync(httpContext, aeds, AedsFrameType.AuthUpdatePublicHandleRequest, cancellationToken);
            if (!payload.IsSuccess)
            {
                return BinaryResults.FromError(payload.Error, aeds);
            }

            if (!PodBinaryCodec.TryDecodeStringMutationRequest(payload.Payload, out string publicHandle))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "公开称呼请求体非法"), aeds);
            }

            publicHandle = publicHandle.Trim();
            if (!string.IsNullOrWhiteSpace(publicHandle))
            {
                ContentValidationResult validation = contentFilterService.ValidateContent(publicHandle);
                if (!validation.IsValid)
                {
                    return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, validation.Message, validation.ReasonCode), aeds);
                }
            }

            int userId = EndpointUserContext.From(httpContext).AccountId;
            var (success, message) = await profileCommands.UpdatePublicHandleAsync(userId, publicHandle, cancellationToken);
            if (!success)
            {
                ErrorCode code = message.Contains("已被占用", StringComparison.Ordinal) ? ErrorCode.Conflict : ErrorCode.Validation;
                return BinaryResults.FromError(ErrorDetail.Create(code, message), aeds);
            }

            return BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess);
        })
        .RequireRateLimiting("fixed_ip")
        .RequireAnonymousAccountPrincipal()
        .RequireNoStoreResponse();

        group.MapPost("/auth/delete-account", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IUserProfileCommandService profileCommands,
            IUserSecurityStepUpService stepUp,
            AuthCookieService authCookieService,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var payload = await ReadBinaryRequestPayloadAsync(httpContext, aeds, AedsFrameType.AuthDeleteAccountRequest, cancellationToken);
            if (!payload.IsSuccess)
            {
                return BinaryResults.FromError(payload.Error, aeds);
            }

            if (!PodBinaryCodec.TryDecodeAuthDeleteAccountRequest(payload.Payload, out var request))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "注销账户请求体非法"), aeds);
            }

            var stepUpResult = await RequireUserSecurityStepUpAsync(
                httpContext,
                stepUp,
                UserSecurityStepUpActions.AccountDelete,
                cancellationToken);
            if (stepUpResult is { } rejected)
            {
                return BinaryResults.FromError(rejected.Error, aeds, rejected.StatusCode);
            }

            int userId = EndpointUserContext.From(httpContext).AccountId;
            var result = await profileCommands.DeleteAccountAsync(userId, new DeleteAccountRequestDto
            {
                ConfirmText = request.ConfirmText
            }, cancellationToken);
            if (!result.Success)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, result.Message), aeds, StatusCodes.Status422UnprocessableEntity);
            }

            authCookieService.ClearTokenCookies(httpContext);
            return BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess);
        })
        .RequireAnonymousAccountPrincipal()
        .AllowRestrictedAccountAction(RestrictedAccountAction.DeleteOwnAccount)
        .RequireNoStoreResponse()
        .AddEndpointFilterWithMetadata<RequiresPowFilter>();

        group.MapGet("/auth/sessions", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IUserSessionCommandService sessions,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var userContext = EndpointUserContext.From(httpContext.User);
            var result = await sessions.GetUserSessionsAsync(userContext.AccountId, userContext.SessionId, cancellationToken);
            return BinaryResults.Frame(aeds, AedsFrameType.AuthSessionList, writer => PodBinaryCodec.WriteUserSessions(result, writer));
        })
        .RequireAnonymousAccountPrincipal()
        .AllowRestrictedAccountAction(RestrictedAccountAction.ViewSessions);

        group.MapPost("/auth/sessions/{id}/revoke", static async Task<BinaryFrameResult> (
            string id,
            HttpContext httpContext,
            IUserSessionCommandService sessions,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var userContext = EndpointUserContext.From(httpContext.User);
            bool revoked = await sessions.RevokeSessionAsync(userContext.AccountId, id, cancellationToken: cancellationToken);
            return revoked
                ? BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess)
                : BinaryResults.FromError(ErrorDetail.Create(ErrorCode.NotFound, "会话不存在"), aeds);
        })
        .RequireAnonymousAccountPrincipal()
        .AllowRestrictedAccountAction(RestrictedAccountAction.RevokeOwnSession);

        group.MapPost("/auth/sessions/revoke-others", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IUserSessionCommandService sessions,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var userContext = EndpointUserContext.From(httpContext.User);
            _ = await sessions.RevokeOtherSessionsAsync(userContext.AccountId, userContext.SessionId, cancellationToken);
            return BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess);
        })
        .RequireAnonymousAccountPrincipal()
        .AllowRestrictedAccountAction(RestrictedAccountAction.RevokeOtherSessions);

        group.MapPost("/auth/mfa/setup/start", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IUserMfaCommandService mfaCommands,
            IUserAccountReader users,
            IMfaChallengeService mfaChallengeService,
            ISystemService systemService,
            IAedsEncoder aeds) =>
        {
            EndpointUserContext endpointUser = EndpointUserContext.From(httpContext);
            int userId = endpointUser.AccountId;
            string? password = null;
            string? code = null;
            string? recoveryCode = null;
            bool stepUpVerified = false;
            UserAccountSnapshot? account = await users.GetAccountByIdAsync(userId);
            if (AnonymousIdentityRuntime.IsAnonymousIdentityModeEnabled())
            {
                string setupAction = account?.MfaEnabled == true ? "mfa_setup_rebind" : "mfa_setup";
                if (account is null ||
                    !TryReadMfaProof(httpContext, out string proofToken) ||
                    !TryResolveAccountSubjectHash(account.Value, out string accountSubjectHash) ||
                    !await mfaChallengeService.ValidateAndConsumeProofTokenAsync(
                        userId,
                        accountSubjectHash,
                        endpointUser.SessionId ?? string.Empty,
                        setupAction,
                        proofToken))
                {
                    return BinaryResults.FromError(
                        ErrorDetail.Create(ErrorCode.Forbidden, "ANONYMOUS_MFA_STEP_UP_REQUIRED"),
                        aeds,
                        StatusCodes.Status428PreconditionRequired);
                }

                stepUpVerified = true;
            }
            else if (account?.MfaEnabled == true)
            {
                var payload = await ReadBinaryRequestPayloadAsync(httpContext, aeds, AedsFrameType.MfaPasswordProofRequest, httpContext.RequestAborted);
                if (!payload.IsSuccess)
                {
                    return BinaryResults.FromError(payload.Error, aeds);
                }

                if (!PodBinaryCodec.TryDecodeMfaPasswordProofRequest(payload.Payload, out var proof) ||
                    string.IsNullOrWhiteSpace(proof.Password))
                {
                    return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "MFA 重新绑定需要当前密码和验证码"), aeds, StatusCodes.Status428PreconditionRequired);
                }

                password = proof.Password;
                code = proof.Code;
                recoveryCode = proof.RecoveryCode;
            }

            var site = await systemService.GetSeoConfigAsync();
            string issuer = string.IsNullOrWhiteSpace(site.Title) ? "FsusBlog" : site.Title;
            var result = await mfaCommands.StartMfaSetupAsync(userId, issuer, password, code, recoveryCode, stepUpVerified);
            return result.Success && result.Data != null
                ? BinaryResults.Frame(aeds, AedsFrameType.MfaSetupStart, writer => PodBinaryCodec.WriteMfaSetupStart(result.Data.Value, writer))
                : BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, result.Message), aeds, StatusCodes.Status428PreconditionRequired);
        })
        .RequireRateLimiting("fixed_ip")
        .RequireAnonymousAccountPrincipal()
        .RequireNoStoreResponse();

        group.MapGet("/auth/mfa/profile", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IUserMfaCommandService mfaCommands,
            IAedsEncoder aeds) =>
        {
            int userId = EndpointUserContext.From(httpContext).AccountId;
            var profile = await mfaCommands.GetMfaProfileAsync(userId);
            return profile.HasValue
                ? BinaryResults.Frame(aeds, AedsFrameType.MfaProfile, writer => PodBinaryCodec.WriteMfaProfile(profile.Value, writer))
                : BinaryResults.FromError(ErrorDetail.Create(ErrorCode.NotFound, "用户不存在"), aeds);
        })
        .RequireAnonymousAccountPrincipal();

        group.MapPost("/auth/mfa/setup/verify", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IUserMfaCommandService mfaCommands,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var payload = await ReadBinaryRequestPayloadAsync(httpContext, aeds, AedsFrameType.MfaSetupVerifyRequest, cancellationToken);
            if (!payload.IsSuccess)
            {
                return BinaryResults.FromError(payload.Error, aeds);
            }

            if (!PodBinaryCodec.TryDecodeStringMutationRequest(payload.Payload, out string code) ||
                string.IsNullOrWhiteSpace(code))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "验证码不能为空"), aeds);
            }

            int userId = EndpointUserContext.From(httpContext).AccountId;
            var result = await mfaCommands.VerifyMfaSetupAsync(userId, code);
            return result.Success && result.Data != null
                ? BinaryResults.Frame(aeds, AedsFrameType.MfaSetupVerify, writer => PodBinaryCodec.WriteMfaSetupVerify(result.Data, writer))
                : BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, result.Message), aeds, StatusCodes.Status422UnprocessableEntity);
        })
        .RequireAnonymousAccountPrincipal();

        group.MapPost("/auth/mfa/disable", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IUserMfaCommandService mfaCommands,
            IMfaChallengeService mfaChallengeService,
            IUserAccountReader users,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            EndpointUserContext endpointUser = EndpointUserContext.From(httpContext);
            int userId = endpointUser.AccountId;
            string password = string.Empty;
            string? code = null;
            string? recoveryCode = null;
            bool stepUpVerified = false;
            if (AnonymousIdentityRuntime.IsAnonymousIdentityModeEnabled())
            {
                UserAccountSnapshot? account = await users.GetAccountByIdAsync(userId);
                if (account is null ||
                    !TryReadMfaProof(httpContext, out string proofToken) ||
                    !TryResolveAccountSubjectHash(account.Value, out string accountSubjectHash) ||
                    !await mfaChallengeService.ValidateAndConsumeProofTokenAsync(
                        userId,
                        accountSubjectHash,
                        endpointUser.SessionId ?? string.Empty,
                        "mfa_disable",
                        proofToken))
                {
                    return BinaryResults.FromError(
                        ErrorDetail.Create(ErrorCode.Forbidden, "ANONYMOUS_MFA_STEP_UP_REQUIRED"),
                        aeds,
                        StatusCodes.Status428PreconditionRequired);
                }

                stepUpVerified = true;
            }
            else
            {
                var payload = await ReadBinaryRequestPayloadAsync(httpContext, aeds, AedsFrameType.MfaPasswordProofRequest, cancellationToken);
                if (!payload.IsSuccess)
                {
                    return BinaryResults.FromError(payload.Error, aeds);
                }

                if (!PodBinaryCodec.TryDecodeMfaPasswordProofRequest(payload.Payload, out var request))
                {
                    return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "MFA 禁用请求体非法"), aeds);
                }

                password = request.Password;
                code = request.Code;
                recoveryCode = request.RecoveryCode;
            }

            var result = await mfaCommands.DisableMfaAsync(userId, password, code, recoveryCode, stepUpVerified);
            return result.Success
                ? BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess)
                : BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, result.Message), aeds, StatusCodes.Status422UnprocessableEntity);
        })
        .RequireAnonymousAccountPrincipal();

        group.MapPost("/auth/mfa/recovery/regenerate", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IUserMfaCommandService mfaCommands,
            IMfaChallengeService mfaChallengeService,
            IUserAccountReader users,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            EndpointUserContext endpointUser = EndpointUserContext.From(httpContext);
            int userId = endpointUser.AccountId;
            string password = string.Empty;
            string? code = null;
            string? recoveryCode = null;
            bool stepUpVerified = false;
            if (AnonymousIdentityRuntime.IsAnonymousIdentityModeEnabled())
            {
                UserAccountSnapshot? account = await users.GetAccountByIdAsync(userId);
                if (account is null ||
                    !TryReadMfaProof(httpContext, out string proofToken) ||
                    !TryResolveAccountSubjectHash(account.Value, out string accountSubjectHash) ||
                    !await mfaChallengeService.ValidateAndConsumeProofTokenAsync(
                        userId,
                        accountSubjectHash,
                        endpointUser.SessionId ?? string.Empty,
                        "mfa_recovery_regenerate",
                        proofToken))
                {
                    return BinaryResults.FromError(
                        ErrorDetail.Create(ErrorCode.Forbidden, "ANONYMOUS_MFA_STEP_UP_REQUIRED"),
                        aeds,
                        StatusCodes.Status428PreconditionRequired);
                }

                stepUpVerified = true;
            }
            else
            {
                var payload = await ReadBinaryRequestPayloadAsync(httpContext, aeds, AedsFrameType.MfaPasswordProofRequest, cancellationToken);
                if (!payload.IsSuccess)
                {
                    return BinaryResults.FromError(payload.Error, aeds);
                }

                if (!PodBinaryCodec.TryDecodeMfaPasswordProofRequest(payload.Payload, out var request))
                {
                    return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "MFA 恢复码请求体非法"), aeds);
                }

                password = request.Password;
                code = request.Code;
                recoveryCode = request.RecoveryCode;
            }

            var result = await mfaCommands.RegenerateMfaRecoveryCodesAsync(userId, password, code, recoveryCode, stepUpVerified);
            return result.Success && result.Data != null
                ? BinaryResults.Frame(aeds, AedsFrameType.MfaSetupVerify, writer => PodBinaryCodec.WriteMfaSetupVerify(result.Data, writer))
                : BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, result.Message), aeds, StatusCodes.Status422UnprocessableEntity);
        })
        .RequireAnonymousAccountPrincipal();

        group.MapPost("/auth/step-up/passkey/begin", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IPasskeyService passkeyService,
            IConfiguration configuration,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            if (!configuration.GetValue<bool>("Auth:PasskeyStepUp:Enabled", true))
            {
                return BinaryResults.FromError(
                    ErrorDetail.Create(ErrorCode.Forbidden, "PASSKEY_STEP_UP_DISABLED"),
                    aeds,
                    StatusCodes.Status503ServiceUnavailable);
            }

            var payload = await ReadBinaryRequestPayloadAsync(httpContext, aeds, AedsFrameType.MfaChallengeStartRequest, cancellationToken);
            if (!payload.IsSuccess)
            {
                return BinaryResults.FromError(payload.Error, aeds);
            }

            if (!PodBinaryCodec.TryDecodeStringMutationRequest(payload.Payload, out string action) ||
                string.IsNullOrWhiteSpace(action))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "STEP_UP_ACTION_REQUIRED"), aeds);
            }

            action = action.Trim();
            if (!UserSecurityStepUpActions.IsCredentialMutation(action))
            {
                return BinaryResults.FromError(
                    ErrorDetail.Create(ErrorCode.Forbidden, "STEP_UP_ACTION_UNSUPPORTED"),
                    aeds,
                    StatusCodes.Status403Forbidden);
            }

            int accountId = EndpointUserContext.From(httpContext).AccountId;
            var (success, message, data) = await passkeyService.BeginActionStepUpAssertionAsync(accountId, action, cancellationToken);
            return success && data != null
                ? BinaryResults.Frame(aeds, AedsFrameType.PasskeyLoginBegin, writer => PodBinaryCodec.WritePasskeyLoginBegin(data.Options, writer))
                : BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Forbidden, message), aeds, StatusCodes.Status428PreconditionRequired);
        })
        .RequireAnonymousAccountPrincipal()
        .AllowRestrictedAccountAction(RestrictedAccountAction.SecurityStepUp)
        .RequireRateLimiting("fixed_ip")
        .RequireNoStoreResponse();

        group.MapPost("/auth/step-up/passkey/complete", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IPasskeyService passkeyService,
            IUserAccountReader users,
            IMfaChallengeService challengeService,
            IConfiguration configuration,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            if (!configuration.GetValue<bool>("Auth:PasskeyStepUp:Enabled", true))
            {
                return BinaryResults.FromError(
                    ErrorDetail.Create(ErrorCode.Forbidden, "PASSKEY_STEP_UP_DISABLED"),
                    aeds,
                    StatusCodes.Status503ServiceUnavailable);
            }

            var payload = await ReadBinaryRequestPayloadAsync(httpContext, aeds, AedsFrameType.PasskeyLoginCompleteRequest, cancellationToken);
            if (!payload.IsSuccess)
            {
                return BinaryResults.FromError(payload.Error, aeds);
            }

            if (!PodBinaryCodec.TryDecodePasskeyLoginCompleteRequest(payload.Payload, out var request) ||
                string.IsNullOrWhiteSpace(request.ChallengeToken) ||
                request.RawId.Length == 0 ||
                request.ClientDataBytes.Length == 0 ||
                request.AuthenticatorData.Length == 0 ||
                request.Signature.Length == 0)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "请求参数无效"), aeds);
            }

            int accountId = EndpointUserContext.From(httpContext).AccountId;
            string? sessionId = EndpointUserContext.From(httpContext).SessionId;
            if (string.IsNullOrWhiteSpace(sessionId))
            {
                return BinaryResults.FromError(
                    ErrorDetail.Create(ErrorCode.Unauthorized, "SESSION_CONTEXT_REQUIRED"),
                    aeds,
                    StatusCodes.Status401Unauthorized);
            }
            var result = await passkeyService.CompleteActionStepUpAssertionAsync(accountId, request, cancellationToken);
            if (!result.Success || string.IsNullOrWhiteSpace(result.Action))
            {
                return BinaryResults.FromError(
                    ErrorDetail.Create(ErrorCode.Unauthorized, result.Message),
                    aeds,
                    StatusCodes.Status401Unauthorized);
            }

            UserAccountSnapshot? account = await users.GetAccountByIdAsync(accountId);
            if (account is null)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.NotFound, "用户不存在"), aeds);
            }

            if (!TryResolveAccountSubjectHash(account.Value, out string accountSubjectHash))
            {
                return BinaryResults.FromError(
                    ErrorDetail.Create(ErrorCode.Unauthorized, "ACCOUNT_SUBJECT_REQUIRED"),
                    aeds,
                    StatusCodes.Status401Unauthorized);
            }

            string proofToken = await challengeService.CreateProofTokenAsync(
                account.Value.Id,
                accountSubjectHash,
                sessionId,
                result.Action,
                UserSessionAuthenticationMethods.Passkey,
                TimeSpan.FromMinutes(5));
            var proof = new MfaChallengeResultDto(true, result.Action, proofToken, null);
            return BinaryResults.Frame(aeds, AedsFrameType.MfaChallengeResult, writer => PodBinaryCodec.WriteMfaChallengeResult(proof, writer));
        })
        .RequireAnonymousAccountPrincipal()
        .AllowRestrictedAccountAction(RestrictedAccountAction.SecurityStepUp)
        .RequireRateLimiting("fixed_ip")
        .RequireNoStoreResponse();

        group.MapPost("/auth/mfa/challenge/start", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IUserAccountReader users,
            IUserLoginWorkflowService loginWorkflow,
            IMfaChallengeService challengeService,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var payload = await ReadBinaryRequestPayloadAsync(httpContext, aeds, AedsFrameType.MfaChallengeStartRequest, cancellationToken);
            if (!payload.IsSuccess)
            {
                return BinaryResults.FromError(payload.Error, aeds);
            }

            string action = "generic";
            if (PodBinaryCodec.TryDecodeStringMutationRequest(payload.Payload, out string decodedAction) &&
                !string.IsNullOrWhiteSpace(decodedAction))
            {
                action = decodedAction;
            }

            EndpointUserContext endpointUser = EndpointUserContext.From(httpContext);
            int userId = endpointUser.AccountId;
            if (string.IsNullOrWhiteSpace(endpointUser.SessionId))
            {
                return BinaryResults.FromError(
                    ErrorDetail.Create(ErrorCode.Unauthorized, "SESSION_CONTEXT_REQUIRED"),
                    aeds,
                    StatusCodes.Status401Unauthorized);
            }
            long accountReadStartedAt = Stopwatch.GetTimestamp();
            UserAccountSnapshot? user = await users.GetAccountByIdAsync(userId);
            FsusObservability.RecordMfaChallengeStartAccountRead(Stopwatch.GetElapsedTime(accountReadStartedAt));
            if (user == null)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.NotFound, "用户不存在"), aeds);
            }

            if (!TryResolveAccountSubjectHash(user.Value, out string accountSubjectHash))
            {
                return BinaryResults.FromError(
                    ErrorDetail.Create(ErrorCode.Unauthorized, "ACCOUNT_SUBJECT_REQUIRED"),
                    aeds,
                    StatusCodes.Status401Unauthorized);
            }

            if (!user.Value.MfaEnabled)
            {
                if (IsAdminSensitiveAction(action))
                {
                    return BinaryResults.FromError(
                        ErrorDetail.Create(ErrorCode.Forbidden, "MFA_REQUIRED"),
                        aeds,
                        StatusCodes.Status403Forbidden);
                }

                if (UserSecurityStepUpActions.IsCredentialMutation(action))
                {
                    return BinaryResults.FromError(
                        ErrorDetail.Create(ErrorCode.Forbidden, "PASSWORD_OR_STEP_UP_PROOF_REQUIRED"),
                        aeds,
                        StatusCodes.Status428PreconditionRequired);
                }

                string proofToken = await challengeService.CreateProofTokenAsync(
                    user.Value.Id,
                    accountSubjectHash,
                    endpointUser.SessionId,
                    action,
                    UserSessionAuthenticationMethods.Other,
                    TimeSpan.FromMinutes(5));
                var noMfa = new MfaChallengeResultDto(true, action, proofToken, null);
                return BinaryResults.Frame(aeds, AedsFrameType.MfaChallengeResult, writer => PodBinaryCodec.WriteMfaChallengeResult(noMfa, writer));
            }

            string? deviceFp = GetDeviceFingerprint(httpContext);
            var risk = await loginWorkflow.EvaluateLoginRiskAsync(userId, httpContext.GetClientIp(), deviceFp, httpContext.GetUserAgent(), cancellationToken);
            var ticket = await challengeService.CreateActionChallengeAsync(
                user.Value.Id,
                accountSubjectHash,
                action,
                risk.RequiresMfa);
            var challenge = new MfaChallengeResultDto(false, action, ticket.TicketId, null);
            return BinaryResults.Frame(aeds, AedsFrameType.MfaChallengeResult, writer => PodBinaryCodec.WriteMfaChallengeResult(challenge, writer));
        })
        .RequireRateLimiting("fixed_ip")
        .RequireAnonymousAccountPrincipal()
        .AllowRestrictedAccountAction(RestrictedAccountAction.SecurityStepUp);

        group.MapPost("/auth/mfa/challenge", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IUserLoginWorkflowService loginWorkflow,
            IUserMfaVerificationService mfaVerification,
            IMfaChallengeService challengeService,
            IWebHostEnvironment env,
            AuthCookieService authCookieService,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var payload = await ReadBinaryRequestPayloadAsync(httpContext, aeds, AedsFrameType.MfaChallengeVerifyRequest, cancellationToken);
            if (!payload.IsSuccess)
            {
                return BinaryResults.FromError(payload.Error, aeds);
            }

            if (!PodBinaryCodec.TryDecodeMfaChallengeVerifyRequest(payload.Payload, out var request) ||
                string.IsNullOrWhiteSpace(request.ChallengeToken))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "MFA_CHALLENGE_REQUIRED"), aeds);
            }

            var ticket = await challengeService.GetChallengeAsync(request.ChallengeToken);
            if (ticket == null)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Unauthorized, "MFA_CHALLENGE_EXPIRED"), aeds);
            }

            bool verified = await mfaVerification.VerifyMfaOrRecoveryCodeAsync(ticket.AccountId, request.Code, request.RecoveryCode, persistRecoveryConsumption: true, cancellationToken: cancellationToken);
            if (!verified)
            {
                bool locked = await challengeService.RecordFailureAsync(
                    ticket,
                    httpContext.GetClientIp(),
                    httpContext.GetUserAgent());
                return BinaryResults.FromError(
                    ErrorDetail.Create(ErrorCode.Unauthorized, locked ? "MFA_CHALLENGE_LOCKED" : "MFA_CHALLENGE_INVALID"),
                    aeds);
            }

            await challengeService.ConsumeChallengeAsync(ticket.TicketId);

            if (ticket.Type == "login")
            {
                var login = await loginWorkflow.CompleteLoginAsync(
                    ticket.AccountId,
                    httpContext.GetClientIp(),
                    GetDeviceFingerprint(httpContext),
                    httpContext.GetUserAgent(),
                    mfaVerified: true,
                    rememberMe: ticket.RememberMe,
                    authenticationContext: new UserSessionAuthenticationContext(
                        string.IsNullOrWhiteSpace(request.RecoveryCode)
                            ? UserSessionAuthenticationMethods.Other
                            : UserSessionAuthenticationMethods.RecoveryKey,
                        string.IsNullOrWhiteSpace(request.RecoveryCode)
                            ? UserSessionAuthenticationStrengths.Mfa
                            : UserSessionAuthenticationStrengths.Recovery,
                        DateTime.UtcNow,
                        DurationPolicy: UserSessionDurationPolicies.FromRememberMe(ticket.RememberMe)),
                    cancellationToken: cancellationToken);
                if (!login.Success || login.Data == null || login.User == null)
                {
                    return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Unauthorized, "LOGIN_FINALIZE_FAILED"), aeds);
                }

                authCookieService.SetTokenCookies(
                    httpContext,
                    env,
                    login.Data.Value.AccessToken,
                    login.Data.Value.AccessTokenExpiresAtUtc,
                    login.Data.Value.RefreshToken,
                    login.Data.Value.SessionId,
                    login.Data.Value.RefreshTokenExpiresAt,
                    persistent: UserSessionDurationPolicies.IsPersistent(login.Data.Value.DurationPolicy));
                var loginResult = new MfaChallengeResultDto(
                    true,
                    "login",
                    null,
                    new AuthIdentitySnapshotDto(
                        login.User.Value.Id,
                        ResolveBinaryIdentityKind(login.User.Value.IdentityKind)));
                return BinaryResults.Frame(aeds, AedsFrameType.MfaChallengeResult, writer => PodBinaryCodec.WriteMfaChallengeResult(loginResult, writer));
            }

            string? currentSessionId = EndpointUserContext.From(httpContext).SessionId;
            if (string.IsNullOrWhiteSpace(currentSessionId))
            {
                return BinaryResults.FromError(
                    ErrorDetail.Create(ErrorCode.Unauthorized, "SESSION_CONTEXT_REQUIRED"),
                    aeds,
                    StatusCodes.Status401Unauthorized);
            }

            string proofToken = await challengeService.CreateProofTokenAsync(
                ticket.AccountId,
                ticket.AccountSubjectHash,
                currentSessionId,
                ticket.Action,
                string.IsNullOrWhiteSpace(request.RecoveryCode)
                    ? UserSessionAuthenticationMethods.Other
                    : UserSessionAuthenticationMethods.RecoveryKey,
                TimeSpan.FromMinutes(5));
            var result = new MfaChallengeResultDto(true, ticket.Action, proofToken, null);
            return BinaryResults.Frame(aeds, AedsFrameType.MfaChallengeResult, writer => PodBinaryCodec.WriteMfaChallengeResult(result, writer));
        })
        .AllowAnonymous()
        .RequireRateLimiting("fixed_ip")
        .RequireNoStoreResponse();

        group.MapPost("/auth/refresh-token", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IUserSessionCommandService sessions,
            IWebHostEnvironment env,
            AuthCookieService authCookieService,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            string? oldRefreshToken = authCookieService.ReadRefreshToken(httpContext);
            if (string.IsNullOrEmpty(oldRefreshToken))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Unauthorized, "会话已失效，请重新登录"), aeds);
            }

            string? sessionId = authCookieService.ReadSessionId(httpContext);
            RefreshTokenRotationResult rotation = await sessions.RotateRefreshTokenAsync(
                oldRefreshToken,
                sessionId,
                cancellationToken);
            if (!rotation.Success
                || rotation.Tokens is not { } newTokens
                || newTokens.AccessTokenExpiresAtUtc is not { } accessTokenExpiresAtUtc
                || string.IsNullOrWhiteSpace(newTokens.SessionId))
            {
                if (rotation.Outcome == RefreshTokenRotationOutcome.ConcurrentConflict)
                {
                    return BinaryResults.FromError(
                        ErrorDetail.Create(ErrorCode.Conflict, "REFRESH_ROTATION_CONFLICT"),
                        aeds,
                        StatusCodes.Status409Conflict);
                }
                authCookieService.ClearUserSessionCookies(httpContext);
                string failureCode = rotation.Outcome switch
                {
                    RefreshTokenRotationOutcome.ReplayCompromised => "REFRESH_FAMILY_COMPROMISED",
                    RefreshTokenRotationOutcome.SessionMismatchCompromised => "REFRESH_SESSION_MISMATCH_COMPROMISED",
                    RefreshTokenRotationOutcome.ExpiredOrUnknown => "REFRESH_EXPIRED_OR_UNKNOWN",
                    RefreshTokenRotationOutcome.InvalidSessionContext => "REFRESH_SESSION_CONTEXT_INVALID",
                    RefreshTokenRotationOutcome.AccountUnavailable => "REFRESH_ACCOUNT_UNAVAILABLE",
                    _ => "REFRESH_TOKEN_MISSING"
                };
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Unauthorized, failureCode), aeds);
            }

            TokenResponseDto rotatedTokens = newTokens;
            string rotatedSessionId = rotatedTokens.SessionId!;
            bool persistent = UserSessionDurationPolicies.IsPersistent(rotation.DurationPolicy);
            if (!await VerifyRefreshCookieDeliveryAsync(
                    sessions,
                    authCookieService,
                    httpContext,
                    rotatedTokens.RefreshToken,
                    rotatedSessionId,
                    "before_cookie",
                    cancellationToken))
            {
                _ = await sessions.RevokeRefreshDeliveryAsync(
                    rotatedTokens.RefreshToken,
                    rotatedSessionId,
                    CancellationToken.None);
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Unauthorized, "REFRESH_DELIVERY_FAILED"), aeds);
            }

            try
            {
                authCookieService.SetTokenCookies(
                    httpContext,
                    env,
                    rotatedTokens.AccessToken,
                    accessTokenExpiresAtUtc,
                    rotatedTokens.RefreshToken,
                    rotatedSessionId,
                    rotation.RefreshTokenExpiresAt,
                    persistent);
            }
            catch
            {
                FsusObservability.RecordAuthRefreshCookieWriteFailed("cookie_append_exception");
                _ = await sessions.RevokeRefreshDeliveryAsync(
                    rotatedTokens.RefreshToken,
                    rotatedSessionId,
                    CancellationToken.None);
                authCookieService.ClearUserSessionCookies(httpContext);
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Unauthorized, "REFRESH_DELIVERY_FAILED"), aeds);
            }

            if (!await VerifyRefreshCookieDeliveryAsync(
                    sessions,
                    authCookieService,
                    httpContext,
                    rotatedTokens.RefreshToken,
                    rotatedSessionId,
                    "after_cookie",
                    cancellationToken))
            {
                _ = await sessions.RevokeRefreshDeliveryAsync(
                    rotatedTokens.RefreshToken,
                    rotatedSessionId,
                    CancellationToken.None);
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Unauthorized, "REFRESH_DELIVERY_FAILED"), aeds);
            }

            return BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess);
        })
        .RequireRateLimiting("fixed_ip")
        .AllowAnonymous()
        .AllowRestrictedAccountAction(RestrictedAccountAction.RefreshSession)
        .RequireNoStoreResponse();

        group.MapPost("/auth/logout", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IUserSessionCommandService sessions,
            AuthCookieService authCookieService,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            string? refreshToken = authCookieService.ReadRefreshToken(httpContext);
            if (!string.IsNullOrEmpty(refreshToken))
            {
                await sessions.RevokeRefreshTokenAsync(refreshToken, cancellationToken);
            }

            authCookieService.ClearTokenCookies(httpContext);
            return BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess);
        })
        .RequireAnonymousAccountPrincipal()
        .AllowRestrictedAccountAction(RestrictedAccountAction.Logout)
        .RequireNoStoreResponse();

        group.MapPost("/auth/recovery-key/create", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IRecoveryKeyService recoveryKeys,
            IUserSecurityStepUpService stepUp,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var stepUpResult = await RequireUserSecurityStepUpAsync(
                httpContext,
                stepUp,
                UserSecurityStepUpActions.RecoveryKeyCreate,
                cancellationToken);
            if (stepUpResult is { } rejected)
            {
                return BinaryResults.FromError(rejected.Error, aeds, rejected.StatusCode);
            }

            Result<RecoveryKeyCreateResponseCoreModel> result = await recoveryKeys.CreateAsync(EndpointUserContext.From(httpContext).AccountId, cancellationToken);
            return result.IsSuccess && result.Value is { } value
                ? BinaryResults.Frame(aeds, AedsFrameType.RecoveryKeyCreateResponse, writer => PodBinaryCodec.WriteRecoveryKeyCreateResponse(value, writer))
                : RecoveryKeyError(result.Error, aeds);
        })
        .RequireAnonymousAccountPrincipal()
        .RequireRateLimiting("fixed_ip")
        .RequireNoStoreResponse();

        group.MapPost("/auth/recovery-key/rotate", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IRecoveryKeyService recoveryKeys,
            IUserSecurityStepUpService stepUp,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var stepUpResult = await RequireUserSecurityStepUpAsync(
                httpContext,
                stepUp,
                UserSecurityStepUpActions.RecoveryKeyRotate,
                cancellationToken);
            if (stepUpResult is { } rejected)
            {
                return BinaryResults.FromError(rejected.Error, aeds, rejected.StatusCode);
            }

            Result<RecoveryKeyCreateResponseCoreModel> result = await recoveryKeys.RotateAsync(EndpointUserContext.From(httpContext).AccountId, cancellationToken);
            return result.IsSuccess && result.Value is { } value
                ? BinaryResults.Frame(aeds, AedsFrameType.RecoveryKeyCreateResponse, writer => PodBinaryCodec.WriteRecoveryKeyCreateResponse(value, writer))
                : RecoveryKeyError(result.Error, aeds);
        })
        .RequireAnonymousAccountPrincipal()
        .RequireRateLimiting("fixed_ip")
        .RequireNoStoreResponse();

        group.MapPost("/auth/recovery-key/verify", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IRecoveryKeyService recoveryKeys,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var payload = await ReadBinaryRequestPayloadAsync(httpContext, aeds, AedsFrameType.RecoveryKeyVerifyRequest, cancellationToken);
            if (!payload.IsSuccess)
            {
                return BinaryResults.FromError(payload.Error, aeds);
            }

            if (!PodBinaryCodec.TryDecodeRecoveryKeyVerifyRequest(payload.Payload, out var request) ||
                string.IsNullOrWhiteSpace(request.RecoveryKey))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "RECOVERY_KEY_REQUEST_INVALID"), aeds);
            }

            Result<RecoveryKeyVerifyResponseCoreModel> result = await recoveryKeys.VerifyAsync(
                request,
                httpContext.GetClientIp(),
                httpContext.GetUserAgent(),
                cancellationToken);
            return result.IsSuccess && result.Value is { } value
                ? BinaryResults.Frame(aeds, AedsFrameType.RecoveryKeyVerifyResponse, writer => PodBinaryCodec.WriteRecoveryKeyVerifyResponse(value, writer))
                : RecoveryKeyError(result.Error, aeds);
        })
        .AllowAnonymous()
        .RequireRateLimiting("fixed_ip")
        .WithRiskAction(RiskActionNames.RecoveryKeyVerify)
        .AddEndpointFilterWithMetadata<RequiresRiskControlFilter>()
        .AddEndpointFilterWithMetadata<RequiresPowFilter>()
        .RequireNoStoreResponse();

        group.MapPost("/auth/recovery-key/passkey/register/begin", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IRecoveryKeyService recoveryKeys,
            IPasskeyService passkeyService,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var payload = await ReadBinaryRequestPayloadAsync(httpContext, aeds, AedsFrameType.RecoveryKeySessionRequest, cancellationToken);
            if (!payload.IsSuccess)
            {
                return BinaryResults.FromError(payload.Error, aeds);
            }

            if (!PodBinaryCodec.TryDecodeStringMutationRequest(payload.Payload, out string recoverySessionToken) ||
                string.IsNullOrWhiteSpace(recoverySessionToken))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "RECOVERY_SESSION_REQUIRED"), aeds);
            }

            Result<RecoveryKeySession> session = await recoveryKeys.GetRecoverySessionAsync(recoverySessionToken, cancellationToken);
            if (!session.IsSuccess || session.Value is null)
            {
                return RecoveryKeyError(session.Error, aeds);
            }

            var (success, message, data) = await passkeyService.BeginRegistrationAsync(session.Value.AccountId, cancellationToken);
            return success && data != null
                ? BinaryResults.Frame(aeds, AedsFrameType.PasskeyRegisterBegin, writer => PodBinaryCodec.WritePasskeyRegisterBegin(data.Options, writer))
                : BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, message), aeds);
        })
        .AllowAnonymous()
        .RequireRateLimiting("fixed_ip")
        .RequireNoStoreResponse();

        group.MapPost("/auth/recovery-key/passkey/register/complete", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IRecoveryKeyService recoveryKeys,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var payload = await ReadBinaryRequestPayloadAsync(httpContext, aeds, AedsFrameType.PasskeyRegisterCompleteRequest, cancellationToken);
            if (!payload.IsSuccess)
            {
                return BinaryResults.FromError(payload.Error, aeds);
            }

            if (!PodBinaryCodec.TryDecodePasskeyRegisterCompleteRequest(payload.Payload, out var request) ||
                string.IsNullOrWhiteSpace(request.SessionKey) ||
                string.IsNullOrWhiteSpace(request.MfaProofToken) ||
                request.RawId.Length == 0 ||
                request.ClientDataBytes.Length == 0 ||
                request.AttestationObject.Length == 0)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "请求参数无效"), aeds);
            }

            Result<RecoveryPasskeyBindOutcome> completion = await recoveryKeys.CompletePasskeyBindAsync(
                request.MfaProofToken,
                request,
                cancellationToken);
            if (!completion.IsSuccess)
            {
                return RecoveryKeyError(completion.Error, aeds);
            }

            return BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess);
        })
        .AllowAnonymous()
        .RequireRateLimiting("fixed_ip")
        .RequireNoStoreResponse();

        group.MapPost("/auth/passkey/register/begin", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IPasskeyService passkeyService,
            IUserAccountReader users,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var userContext = EndpointUserContext.From(httpContext.User);
            UserAccountSnapshot? user = await users.GetAccountByIdAsync(userContext.AccountId);
            if (user == null)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.NotFound, "用户不存在"), aeds);
            }

            var (success, message, data) = await passkeyService.BeginRegistrationAsync(user.Value.Id, cancellationToken);
            return success && data != null
                ? BinaryResults.Frame(aeds, AedsFrameType.PasskeyRegisterBegin, writer => PodBinaryCodec.WritePasskeyRegisterBegin(data.Options, writer))
                : BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, message), aeds);
        })
        .RequireAnonymousAccountPrincipal();

        group.MapPost("/auth/passkey/register/complete", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IPasskeyService passkeyService,
            IUserSecurityStepUpService stepUp,
            IUserAccountReader users,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var payload = await ReadBinaryRequestPayloadAsync(httpContext, aeds, AedsFrameType.PasskeyRegisterCompleteRequest, cancellationToken);
            if (!payload.IsSuccess)
            {
                return BinaryResults.FromError(payload.Error, aeds);
            }

            if (!PodBinaryCodec.TryDecodePasskeyRegisterCompleteRequest(payload.Payload, out var request) ||
                string.IsNullOrWhiteSpace(request.SessionKey) ||
                request.RawId.Length == 0 ||
                request.ClientDataBytes.Length == 0 ||
                request.AttestationObject.Length == 0)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "请求参数无效"), aeds);
            }

            var userContext = EndpointUserContext.From(httpContext.User);
            UserAccountSnapshot? user = await users.GetAccountByIdAsync(userContext.AccountId);
            if (user == null)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.NotFound, "用户不存在"), aeds);
            }

            var stepUpResult = await RequireUserSecurityStepUpAsync(
                httpContext,
                stepUp,
                UserSecurityStepUpActions.PasskeyRegister,
                cancellationToken);
            if (stepUpResult is { } rejected)
            {
                return BinaryResults.FromError(rejected.Error, aeds, rejected.StatusCode);
            }

            var (success, message, signalState) = await passkeyService.CompleteRegistrationAsync(user.Value.Id, request, cancellationToken);
            if (!success)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, message), aeds);
            }

            return signalState is not null
                ? BinaryResults.Frame(aeds, AedsFrameType.PasskeySignalState, writer => PodBinaryCodec.WritePasskeySignalState(signalState.Value, writer))
                : BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Conflict, "PASSKEY_SIGNAL_STATE_UNAVAILABLE"), aeds, StatusCodes.Status409Conflict);
        })
        .RequireAnonymousAccountPrincipal();

        group.MapPost("/auth/passkey/login/begin", static async Task<BinaryFrameResult> (
            IPasskeyService passkeyService,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var (success, message, data) = await passkeyService.BeginAssertionAsync(cancellationToken);
            return success && data != null
                ? BinaryResults.Frame(aeds, AedsFrameType.PasskeyLoginBegin, writer => PodBinaryCodec.WritePasskeyLoginBegin(data.Options, writer))
                : BinaryResults.FromError(ErrorDetail.Create(ErrorCode.InfraFailure, message), aeds);
        })
        .AllowAnonymous()
        .RequireRateLimiting("fixed_ip")
        .WithRiskAction(RiskActionNames.AuthPasskeyBegin)
        .AddEndpointFilterWithMetadata<RequiresRiskControlFilter>()
        .RequireNoStoreResponse();

        group.MapPost("/auth/passkey/login/complete", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IPasskeyService passkeyService,
            IUserLoginWorkflowService loginWorkflow,
            IWebHostEnvironment env,
            AuthCookieService authCookieService,
            ISecurityRiskSignalSink riskSignals,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var payload = await ReadBinaryRequestPayloadAsync(httpContext, aeds, AedsFrameType.PasskeyLoginCompleteRequest, cancellationToken);
            if (!payload.IsSuccess)
            {
                return BinaryResults.FromError(payload.Error, aeds);
            }

            if (!PodBinaryCodec.TryDecodePasskeyLoginCompleteRequest(payload.Payload, out var request) ||
                string.IsNullOrWhiteSpace(request.ChallengeToken) ||
                request.RawId.Length == 0 ||
                request.ClientDataBytes.Length == 0 ||
                request.AuthenticatorData.Length == 0 ||
                request.Signature.Length == 0)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "请求参数无效"), aeds);
            }

            var (success, message, user, credentialRowId) = await passkeyService.CompleteAssertionAsync(request, cancellationToken);
            if (!success || user == null)
            {
                await RecordPasskeyAssertionFailureAsync(httpContext, riskSignals, cancellationToken);
                string? details = string.Equals(message, PasskeyService.CredentialNotFoundMessage, StringComparison.Ordinal)
                    ? PasskeyService.CredentialNotFoundSignalCode
                    : null;
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Unauthorized, message, details), aeds);
            }

            string clientIp = httpContext.GetClientIp();
            string? deviceFp = GetDeviceFingerprint(httpContext);
            string? userAgent = httpContext.GetUserAgent();
            var login = await loginWorkflow.CompleteLoginAsync(
                user.Id,
                clientIp,
                deviceFp,
                userAgent,
                mfaVerified: true,
                rememberMe: request.RememberMe,
                authenticationContext: new UserSessionAuthenticationContext(
                    UserSessionAuthenticationMethods.Passkey,
                    UserSessionAuthenticationStrengths.WebAuthnUv,
                    DateTime.UtcNow,
                    credentialRowId,
                    UserSessionDurationPolicies.FromRememberMe(request.RememberMe)),
                cancellationToken: cancellationToken);
            if (!login.Success || login.Data == null || login.User == null)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Unauthorized, login.Message), aeds);
            }

            await RecordPasskeyAssertionAcceptedAsync(httpContext, riskSignals, cancellationToken);
            authCookieService.SetTokenCookies(
                httpContext,
                env,
                login.Data.Value.AccessToken,
                login.Data.Value.AccessTokenExpiresAtUtc,
                login.Data.Value.RefreshToken,
                login.Data.Value.SessionId,
                login.Data.Value.RefreshTokenExpiresAt,
                persistent: UserSessionDurationPolicies.IsPersistent(login.Data.Value.DurationPolicy));
            var flow = new AuthLoginFlowDto(
                login.User.Value.Id,
                ResolveBinaryIdentityKind(login.User.Value.IdentityKind),
                "authenticated",
                null,
                null);
            return BinaryResults.Frame(aeds, AedsFrameType.AuthLoginFlow, writer => PodBinaryCodec.WriteAuthLoginFlow(flow, writer));
        })
        .AllowAnonymous()
        .RequireRateLimiting("fixed_ip")
        .WithRiskAction(RiskActionNames.AuthPasskeyComplete)
        .AddEndpointFilterWithMetadata<RequiresRiskControlFilter>()
        .RequireNoStoreResponse();

        group.MapGet("/auth/passkey/credentials", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IPasskeyService passkeyService,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            int userId = EndpointUserContext.From(httpContext).AccountId;
            var credentials = await passkeyService.GetCredentialsAsync(userId, cancellationToken);
            return BinaryResults.Frame(aeds, AedsFrameType.PasskeyCredentialList, writer => PodBinaryCodec.WritePasskeyCredentialList([.. credentials], writer));
        })
        .RequireAnonymousAccountPrincipal();

        group.MapGet("/auth/passkey/signal-state", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IPasskeyService passkeyService,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            int userId = EndpointUserContext.From(httpContext).AccountId;
            PasskeySignalStateDto? signalState = await passkeyService.GetSignalStateAsync(userId, cancellationToken);
            return signalState is not null
                ? BinaryResults.Frame(aeds, AedsFrameType.PasskeySignalState, writer => PodBinaryCodec.WritePasskeySignalState(signalState.Value, writer))
                : BinaryResults.FromError(ErrorDetail.Create(ErrorCode.NotFound, "PASSKEY_SIGNAL_STATE_UNAVAILABLE"), aeds);
        })
        .RequireAnonymousAccountPrincipal()
        .RequireNoStoreResponse();

        group.MapDelete("/auth/passkey/credentials/{id:int}", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IPasskeyService passkeyService,
            IUserSecurityStepUpService stepUp,
            int id,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var stepUpResult = await RequireUserSecurityStepUpAsync(
                httpContext,
                stepUp,
                UserSecurityStepUpActions.PasskeyDelete,
                cancellationToken);
            if (stepUpResult is { } rejected)
            {
                return BinaryResults.FromError(rejected.Error, aeds, rejected.StatusCode);
            }

            int userId = EndpointUserContext.From(httpContext).AccountId;
            PasskeyCredentialMutationResult removeResult = await passkeyService.RemoveCredentialAsync(userId, id, cancellationToken);
            return removeResult.Success && removeResult.SignalState is not null
                ? BinaryResults.Frame(aeds, AedsFrameType.PasskeySignalState, writer => PodBinaryCodec.WritePasskeySignalState(removeResult.SignalState.Value, writer))
                : BinaryResults.FromError(
                    ErrorDetail.Create(removeResult.NotFound ? ErrorCode.NotFound : ErrorCode.Validation, removeResult.Message),
                    aeds,
                    removeResult.NotFound ? 0 : StatusCodes.Status409Conflict);
        })
        .RequireAnonymousAccountPrincipal();

        group.MapPut("/auth/passkey/credentials/{id:int}/name", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IPasskeyService passkeyService,
            IUserSecurityStepUpService stepUp,
            int id,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var payload = await ReadBinaryRequestPayloadAsync(httpContext, aeds, AedsFrameType.PasskeyCredentialFriendlyNameUpdateRequest, cancellationToken);
            if (!payload.IsSuccess)
            {
                return BinaryResults.FromError(payload.Error, aeds);
            }

            if (!PodBinaryCodec.TryDecodePasskeyCredentialFriendlyNameUpdateRequest(payload.Payload, out string name) ||
                string.IsNullOrWhiteSpace(name))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "名称不能为空"), aeds);
            }

            int userId = EndpointUserContext.From(httpContext).AccountId;
            var stepUpResult = await RequireUserSecurityStepUpAsync(
                httpContext,
                stepUp,
                UserSecurityStepUpActions.PasskeyCredentialNameUpdate,
                cancellationToken);
            if (stepUpResult is { } rejected)
            {
                return BinaryResults.FromError(rejected.Error, aeds, rejected.StatusCode);
            }

            bool renamed = await passkeyService.RenameCredentialAsync(userId, id, name, cancellationToken);
            return renamed
                ? BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess)
                : BinaryResults.FromError(ErrorDetail.Create(ErrorCode.NotFound, "通行密钥不存在"), aeds);
        })
        .RequireAnonymousAccountPrincipal();
    }

    private static BinaryFrameResult RecoveryKeyError(in ErrorDetail error, IAedsEncoder aeds)
        => BinaryResults.FromError(
            error,
            aeds,
            string.Equals(error.Message, "RECOVERY_KEY_RATE_LIMITED", StringComparison.Ordinal)
                ? StatusCodes.Status429TooManyRequests
                : 0);

    private static async Task<(ErrorDetail Error, int StatusCode)?> RequireUserSecurityStepUpAsync(
        HttpContext httpContext,
        IUserSecurityStepUpService stepUp,
        string action,
        CancellationToken cancellationToken)
    {
        string proofToken = TryReadMfaProof(httpContext, out string token)
            ? token
            : string.Empty;

        UserSecurityStepUpResult result = await stepUp.VerifyAsync(
            new UserSecurityStepUpRequest(
                EndpointUserContext.From(httpContext).AccountId,
                action,
                new UserSecurityStepUpProof(proofToken),
                httpContext.GetClientIp(),
                EndpointUserContext.From(httpContext).SessionId),
            cancellationToken);
        return result.Success
            ? null
            : (ErrorDetail.Create(result.ErrorCode, result.Message), result.StatusCode);
    }

    private static ValueTask RecordPasskeyAssertionFailureAsync(
        HttpContext httpContext,
        ISecurityRiskSignalSink riskSignals,
        CancellationToken cancellationToken)
        => riskSignals.AddRiskAsync(new SecurityRiskSignal(
            httpContext,
            SecurityRiskReason.PasskeyAssertionFailed,
            25,
            s_authRiskSignalTtl,
            SecurityRiskSources.Passkey,
            RiskActionNames.AuthPasskeyComplete,
            "passkey_assertion_failed"), cancellationToken);

    private static ValueTask RecordPasskeyAssertionAcceptedAsync(
        HttpContext httpContext,
        ISecurityRiskSignalSink riskSignals,
        CancellationToken cancellationToken)
        => riskSignals.AddRiskAsync(new SecurityRiskSignal(
            httpContext,
            SecurityRiskReason.PasskeyAssertionAccepted,
            -20,
            s_authRiskSignalTtl,
            SecurityRiskSources.Passkey,
            RiskActionNames.AuthPasskeyComplete,
            "passkey_assertion_accepted"), cancellationToken);

    private static bool TryResolveAdminSessionContext(HttpContext context, out long adminPrincipalId, out string adminSessionId)
    {
        adminSessionId = context.User.GetAdminSessionId() ?? string.Empty;
        return context.User.TryGetAdminPrincipalId(out adminPrincipalId) && !string.IsNullOrWhiteSpace(adminSessionId);
    }

    private static AdminPrincipalSnapshotDto BuildAdminPrincipalSnapshot(HttpContext context, long adminPrincipalId)
    {
        string displayName = context.User.FindFirst("admin_handle")?.Value
            ?? context.User.Identity?.Name
            ?? $"admin-{adminPrincipalId.ToString(CultureInfo.InvariantCulture)}";
        string[] permissions = context.User.Claims
            .Where(static claim => claim.Type == AdminPermissions.PermissionClaimType)
            .Select(static claim => claim.Value)
            .Where(static value => !string.IsNullOrWhiteSpace(value))
            .Distinct(StringComparer.Ordinal)
            .ToArray();

        return new AdminPrincipalSnapshotDto(
            adminPrincipalId.ToString(CultureInfo.InvariantCulture),
            displayName,
            "independent",
            permissions,
            "active",
            context.User.IsAdminStepUpVerified());
    }

    private static string ReadHeader(HttpContext httpContext, string name)
        => httpContext.Request.Headers.TryGetValue(name, out var values)
            ? values.ToString().Trim()
            : string.Empty;

    private static bool TryWriteAccessExpiryHeader(HttpContext httpContext)
    {
        string? rawExpiry = httpContext.User.FindFirst("exp")?.Value;
        if (!long.TryParse(rawExpiry, NumberStyles.None, CultureInfo.InvariantCulture, out long unixSeconds))
        {
            return false;
        }

        try
        {
            DateTimeOffset expiresAtUtc = DateTimeOffset.FromUnixTimeSeconds(unixSeconds);
            if (expiresAtUtc <= DateTimeOffset.UtcNow)
            {
                return false;
            }

            httpContext.Response.Headers[AccessExpiresAtUtcHeader] = expiresAtUtc.ToString("O", CultureInfo.InvariantCulture);
            return true;
        }
        catch (ArgumentOutOfRangeException)
        {
            return false;
        }
    }

    private static async Task<bool> VerifyRefreshCookieDeliveryAsync(
        IUserSessionCommandService sessions,
        AuthCookieService authCookieService,
        HttpContext httpContext,
        string refreshToken,
        string sessionId,
        string phase,
        CancellationToken cancellationToken)
    {
        try
        {
            if (await sessions.VerifyRefreshRotationAsync(refreshToken, sessionId, cancellationToken))
            {
                return true;
            }

            FsusObservability.RecordAuthRefreshCookieWriteFailed($"{phase}_verify_failed");
            authCookieService.ClearUserSessionCookies(httpContext);
            return false;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            FsusObservability.RecordAuthRefreshCookieWriteFailed($"{phase}_request_aborted");
            authCookieService.ClearUserSessionCookies(httpContext);
            throw;
        }
        catch
        {
            FsusObservability.RecordAuthRefreshCookieWriteFailed($"{phase}_verify_exception");
            authCookieService.ClearUserSessionCookies(httpContext);
            return false;
        }
    }
}
