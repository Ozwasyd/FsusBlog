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
using FsusBlog.Server.Infrastructure.Policies;
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

        group.MapPost("/auth/login", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            AuthBinaryApplicationFacade authFacade,
            IWebHostEnvironment env,
            AuthCookieService authCookieService,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var request = await AuthBinaryRequestReader.ReadLoginAsync(httpContext, aeds, cancellationToken);
            if (!request.IsSuccess)
            {
                return AuthBinaryResponseWriter.Error(aeds, request.Error);
            }

            var result = await authFacade.LoginAsync(request.Value, AuthBinaryClientContext.From(httpContext));
            if (!result.Success)
            {
                return AuthBinaryResponseWriter.Error(aeds, result.Error);
            }

            if (result.SessionTokens is { } tokens)
            {
                authCookieService.SetTokenCookies(httpContext, env, tokens.AccessToken, tokens.RefreshToken, tokens.RefreshTokenExpiresAt);
            }

            return AuthBinaryResponseWriter.LoginFlow(aeds, result.Flow);
        })
        .RequireRateLimiting("fixed_ip")
        .AllowAnonymous()
        .AddEndpointFilter<RequiresPowFilter>()
        .RequireNoStoreResponse();

        group.MapPost("/auth/register", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            AuthBinaryApplicationFacade authFacade,
            IWebHostEnvironment env,
            AuthCookieService authCookieService,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var request = await AuthBinaryRequestReader.ReadRegisterAsync(httpContext, aeds, cancellationToken);
            if (!request.IsSuccess)
            {
                return AuthBinaryResponseWriter.Error(aeds, request.Error);
            }

            var result = await authFacade.RegisterAsync(request.Value, AuthBinaryClientContext.From(httpContext));
            if (!result.Success)
            {
                return AuthBinaryResponseWriter.Error(aeds, result.Error);
            }

            if (result.SessionTokens is { } tokens)
            {
                authCookieService.SetTokenCookies(httpContext, env, tokens.AccessToken, tokens.RefreshToken, tokens.RefreshTokenExpiresAt);
            }

            return AuthBinaryResponseWriter.LoginFlow(aeds, result.Flow);
        })
        .RequireRateLimiting("fixed_ip")
        .AllowAnonymous()
        .AddEndpointFilter<RequiresPowFilter>()
        .RequireNoStoreResponse();

        group.MapGet("/auth/me", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IUserAccountReader users,
            IAedsEncoder aeds) =>
        {
            var userContext = EndpointUserContext.From(httpContext.User);
            UserAccountSnapshot? user = await users.GetAccountByIdAsync(userContext.UserId);
            if (user == null)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.NotFound, "用户不存在"), aeds);
            }

            if (user.Value.Status == 2 || user.Value.DeletedAt.HasValue)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Unauthorized, "账户已注销"), aeds);
            }

            var snapshot = new CurrentUserSnapshotDto(user.Value.Id, user.Value.Username, user.Value.Role, user.Value.Status, user.Value.BanReason, user.Value.DeletedAt);
            return BinaryResults.Frame(aeds, AedsFrameType.CurrentUserSnapshot, writer => PodBinaryCodec.WriteCurrentUserSnapshot(snapshot, writer));
        })
        .RequireAuthorization();

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

            var snapshot = new CurrentUserSnapshotDto(user.Value.Id, user.Value.Username, user.Value.Role, user.Value.Status, user.Value.BanReason, user.Value.DeletedAt);
            return BinaryResults.Frame(aeds, AedsFrameType.CurrentUserSnapshot, writer => PodBinaryCodec.WriteCurrentUserSnapshot(snapshot, writer));
        })
        .RequireAuthorization(policy => policy.RequireRole("admin"));

        group.MapGet("/auth/find/{username}", static async Task<BinaryFrameResult> (
            string username,
            IUserAccountReader users,
            IAedsEncoder aeds) =>
        {
            UserAccountSnapshot? user = await users.GetAccountByUsernameAsync(username);
            if (user == null)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.NotFound, "未找到该用户"), aeds);
            }

            var snapshot = new CurrentUserSnapshotDto(user.Value.Id, user.Value.Username, user.Value.Role, user.Value.Status, user.Value.BanReason, user.Value.DeletedAt);
            return BinaryResults.Frame(aeds, AedsFrameType.CurrentUserSnapshot, writer => PodBinaryCodec.WriteCurrentUserSnapshot(snapshot, writer));
        })
        .RequireAuthorization(policy => policy.RequireRole("admin"));

        group.MapPut("/auth/update-username", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IUserProfileCommandService profileCommands,
            IUserAccountReader users,
            IMfaChallengeService mfaChallengeService,
            IContentFilterService contentFilterService,
            IWebHostEnvironment env,
            AuthCookieService authCookieService,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var payload = await ReadBinaryRequestPayloadAsync(httpContext, aeds, AedsFrameType.AuthUpdateUsernameRequest, cancellationToken);
            if (!payload.IsSuccess)
            {
                return BinaryResults.FromError(payload.Error, aeds);
            }

            if (!PodBinaryCodec.TryDecodeStringMutationRequest(payload.Payload, out string newUsername) ||
                string.IsNullOrWhiteSpace(newUsername))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "新用户名不能为空"), aeds);
            }

            ContentValidationResult validation = contentFilterService.ValidateContent(newUsername);
            if (!validation.IsValid)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, validation.Message, validation.ReasonCode), aeds);
            }

            int userId = httpContext.User.GetUserId();
            UserAccountSnapshot? userForMfaCheck = await users.GetAccountByIdAsync(userId);
            if (userForMfaCheck != null && userForMfaCheck.Value.MfaEnabled)
            {
                if (!TryReadMfaProof(httpContext, out string proofToken) ||
                    !await mfaChallengeService.ValidateAndConsumeProofTokenAsync(userId, "update-username", proofToken))
                {
                    return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "MFA_REQUIRED"), aeds, StatusCodes.Status428PreconditionRequired);
                }
            }

            var (success, message, newToken) = await profileCommands.UpdateUsernameAsync(userId, newUsername);
            if (!success || newToken == null)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, message), aeds);
            }

            authCookieService.SetAccessTokenCookie(httpContext, env, newToken.Value.AccessToken);
            return BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess);
        })
        .RequireRateLimiting("fixed_ip")
        .RequireAuthorization()
        .RequireNoStoreResponse();

        group.MapPut("/auth/update-password", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IUserProfileCommandService profileCommands,
            IUserAccountReader users,
            IMfaChallengeService mfaChallengeService,
            AuthCookieService authCookieService,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var payload = await ReadBinaryRequestPayloadAsync(httpContext, aeds, AedsFrameType.AuthUpdatePasswordRequest, cancellationToken);
            if (!payload.IsSuccess)
            {
                return BinaryResults.FromError(payload.Error, aeds);
            }

            if (!PodBinaryCodec.TryDecodeAuthUpdatePasswordRequest(payload.Payload, out var request))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "修改密码请求体非法"), aeds);
            }

            int userId = httpContext.User.GetUserId();
            string clientIp = httpContext.GetClientIp();
            UserAccountSnapshot? userForMfaCheck = await users.GetAccountByIdAsync(userId);
            if (userForMfaCheck != null && userForMfaCheck.Value.MfaEnabled)
            {
                if (!TryReadMfaProof(httpContext, out string proofToken) ||
                    !await mfaChallengeService.ValidateAndConsumeProofTokenAsync(userId, "update-password", proofToken))
                {
                    return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "MFA_REQUIRED"), aeds, StatusCodes.Status428PreconditionRequired);
                }
            }

            var (success, message) = await profileCommands.UpdatePasswordAsync(userId, new UpdatePasswordDto
            {
                OldPassword = request.OldPassword,
                NewPassword = request.NewPassword,
                ConfirmPassword = request.ConfirmPassword
            });
            if (!success)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, message), aeds);
            }

            authCookieService.ClearTokenCookies(httpContext);
            using var _ = AuditLogScope.Push(
                AuditSourceCatalog.Auth,
                AuditTypeCatalog.Security,
                new KeyValuePair<string, object?>("AuditAction", "password.update"),
                new KeyValuePair<string, object?>("UserId", userId),
                new KeyValuePair<string, object?>("ClientIp", clientIp));
            return BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess);
        })
        .RequireRateLimiting("fixed_ip")
        .RequireAuthorization()
        .AddEndpointFilter<RequiresPowFilter>()
        .RequireNoStoreResponse();

        group.MapPost("/auth/delete-account", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IUserProfileCommandService profileCommands,
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

            int userId = httpContext.User.GetUserId();
            var result = await profileCommands.DeleteAccountAsync(userId, new DeleteAccountRequestDto
            {
                Password = request.Password,
                ConfirmText = request.ConfirmText,
                Code = request.Code,
                RecoveryCode = request.RecoveryCode
            });
            if (!result.Success)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, result.Message), aeds, StatusCodes.Status422UnprocessableEntity);
            }

            authCookieService.ClearTokenCookies(httpContext);
            return BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess);
        })
        .RequireAuthorization()
        .AllowBannedUserWrite()
        .RequireNoStoreResponse()
        .AddEndpointFilter<RequiresPowFilter>();

        group.MapGet("/auth/sessions", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IUserSessionCommandService sessions,
            IAedsEncoder aeds) =>
        {
            var userContext = EndpointUserContext.From(httpContext.User);
            var result = await sessions.GetUserSessionsAsync(userContext.UserId, userContext.SessionId);
            return BinaryResults.Frame(aeds, AedsFrameType.AuthSessionList, writer => PodBinaryCodec.WriteUserSessions(result, writer));
        })
        .RequireAuthorization();

        group.MapPost("/auth/sessions/{id}/revoke", static async Task<BinaryFrameResult> (
            string id,
            HttpContext httpContext,
            IUserSessionCommandService sessions,
            IAedsEncoder aeds) =>
        {
            var userContext = EndpointUserContext.From(httpContext.User);
            bool revoked = await sessions.RevokeSessionAsync(userContext.UserId, id);
            return revoked
                ? BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess)
                : BinaryResults.FromError(ErrorDetail.Create(ErrorCode.NotFound, "会话不存在"), aeds);
        })
        .RequireAuthorization();

        group.MapPost("/auth/sessions/revoke-others", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IUserSessionCommandService sessions,
            IAedsEncoder aeds) =>
        {
            var userContext = EndpointUserContext.From(httpContext.User);
            _ = await sessions.RevokeOtherSessionsAsync(userContext.UserId, userContext.SessionId);
            return BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess);
        })
        .RequireAuthorization();

        group.MapPost("/auth/mfa/setup/start", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IUserMfaCommandService mfaCommands,
            IUserAccountReader users,
            ISystemService systemService,
            IAedsEncoder aeds) =>
        {
            int userId = httpContext.User.GetUserId();
            string? password = null;
            string? code = null;
            string? recoveryCode = null;
            UserAccountSnapshot? account = await users.GetAccountByIdAsync(userId);
            if (account?.MfaEnabled == true)
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
            var result = await mfaCommands.StartMfaSetupAsync(userId, issuer, password, code, recoveryCode);
            return result.Success && result.Data != null
                ? BinaryResults.Frame(aeds, AedsFrameType.MfaSetupStart, writer => PodBinaryCodec.WriteMfaSetupStart(result.Data.Value, writer))
                : BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, result.Message), aeds, StatusCodes.Status428PreconditionRequired);
        })
        .RequireRateLimiting("fixed_ip")
        .RequireAuthorization()
        .RequireNoStoreResponse();

        group.MapGet("/auth/mfa/profile", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IUserMfaCommandService mfaCommands,
            IAedsEncoder aeds) =>
        {
            int userId = httpContext.User.GetUserId();
            var profile = await mfaCommands.GetMfaProfileAsync(userId);
            return profile.HasValue
                ? BinaryResults.Frame(aeds, AedsFrameType.MfaProfile, writer => PodBinaryCodec.WriteMfaProfile(profile.Value, writer))
                : BinaryResults.FromError(ErrorDetail.Create(ErrorCode.NotFound, "用户不存在"), aeds);
        })
        .RequireAuthorization();

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

            int userId = httpContext.User.GetUserId();
            var result = await mfaCommands.VerifyMfaSetupAsync(userId, code);
            return result.Success && result.Data != null
                ? BinaryResults.Frame(aeds, AedsFrameType.MfaSetupVerify, writer => PodBinaryCodec.WriteMfaSetupVerify(result.Data, writer))
                : BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, result.Message), aeds, StatusCodes.Status422UnprocessableEntity);
        })
        .RequireAuthorization();

        group.MapPost("/auth/mfa/disable", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IUserMfaCommandService mfaCommands,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
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

            int userId = httpContext.User.GetUserId();
            var result = await mfaCommands.DisableMfaAsync(userId, request.Password, request.Code, request.RecoveryCode);
            return result.Success
                ? BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess)
                : BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, result.Message), aeds, StatusCodes.Status422UnprocessableEntity);
        })
        .RequireAuthorization();

        group.MapPost("/auth/mfa/recovery/regenerate", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IUserMfaCommandService mfaCommands,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
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

            int userId = httpContext.User.GetUserId();
            var result = await mfaCommands.RegenerateMfaRecoveryCodesAsync(userId, request.Password, request.Code, request.RecoveryCode);
            return result.Success && result.Data != null
                ? BinaryResults.Frame(aeds, AedsFrameType.MfaSetupVerify, writer => PodBinaryCodec.WriteMfaSetupVerify(result.Data, writer))
                : BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, result.Message), aeds, StatusCodes.Status422UnprocessableEntity);
        })
        .RequireAuthorization();

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

            int userId = httpContext.User.GetUserId();
            UserAccountSnapshot? user = await users.GetAccountByIdAsync(userId);
            if (user == null)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.NotFound, "用户不存在"), aeds);
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

                string proofToken = await challengeService.CreateProofTokenAsync(user.Value.Id, action, TimeSpan.FromMinutes(5));
                var noMfa = new MfaChallengeResultDto(true, action, proofToken, null);
                return BinaryResults.Frame(aeds, AedsFrameType.MfaChallengeResult, writer => PodBinaryCodec.WriteMfaChallengeResult(noMfa, writer));
            }

            string? deviceFp = GetDeviceFingerprint(httpContext);
            var risk = await loginWorkflow.EvaluateLoginRiskAsync(userId, httpContext.GetClientIp(), deviceFp, httpContext.Request.Headers.UserAgent.ToString());
            var ticket = await challengeService.CreateActionChallengeAsync(user.Value.Id, action, risk.RequiresMfa);
            var challenge = new MfaChallengeResultDto(false, action, ticket.TicketId, null);
            return BinaryResults.Frame(aeds, AedsFrameType.MfaChallengeResult, writer => PodBinaryCodec.WriteMfaChallengeResult(challenge, writer));
        })
        .RequireAuthorization();

        group.MapPost("/auth/mfa/challenge", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IUserLoginWorkflowService loginWorkflow,
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

            bool verified = await loginWorkflow.VerifyMfaOrRecoveryCodeAsync(ticket.UserId, request.Code, request.RecoveryCode, persistRecoveryConsumption: true);
            if (!verified)
            {
                bool locked = await challengeService.RecordFailureAsync(
                    ticket,
                    httpContext.GetClientIp(),
                    httpContext.Request.Headers.UserAgent.ToString());
                return BinaryResults.FromError(
                    ErrorDetail.Create(ErrorCode.Unauthorized, locked ? "MFA_CHALLENGE_LOCKED" : "MFA_CHALLENGE_INVALID"),
                    aeds);
            }

            await challengeService.ConsumeChallengeAsync(ticket.TicketId);

            if (ticket.Type == "login")
            {
                var login = await loginWorkflow.CompleteLoginAsync(
                    ticket.UserId,
                    httpContext.GetClientIp(),
                    GetDeviceFingerprint(httpContext),
                    httpContext.Request.Headers.UserAgent.ToString(),
                    mfaVerified: true,
                    rememberMe: ticket.RememberMe);
                if (!login.Success || login.Data == null || login.User == null)
                {
                    return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Unauthorized, "LOGIN_FINALIZE_FAILED"), aeds);
                }

                authCookieService.SetTokenCookies(httpContext, env, login.Data.Value.AccessToken, login.Data.Value.RefreshToken, login.Data.Value.RefreshTokenExpiresAt);
                var loginResult = new MfaChallengeResultDto(
                    true,
                    "login",
                    null,
                    new AuthIdentitySnapshotDto(login.User.Value.Id, login.User.Value.Username, login.User.Value.Role));
                return BinaryResults.Frame(aeds, AedsFrameType.MfaChallengeResult, writer => PodBinaryCodec.WriteMfaChallengeResult(loginResult, writer));
            }

            string proofToken = await challengeService.CreateProofTokenAsync(ticket.UserId, ticket.Action, TimeSpan.FromMinutes(5));
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
            IAedsEncoder aeds) =>
        {
            string? oldRefreshToken = authCookieService.ReadRefreshToken(httpContext);
            if (string.IsNullOrEmpty(oldRefreshToken))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Unauthorized, "会话已失效，请重新登录"), aeds);
            }

            string? sessionId = authCookieService.ReadSessionId(httpContext);
            var (success, newTokens, expiresAt) = await sessions.RefreshTokenWithExpiryAsync(oldRefreshToken, sessionId);
            if (!success || newTokens == null)
            {
                authCookieService.ClearTokenCookies(httpContext);
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Unauthorized, "刷新凭证已失效"), aeds);
            }

            authCookieService.SetTokenCookies(
                httpContext,
                env,
                newTokens.Value.AccessToken,
                newTokens.Value.RefreshToken,
                expiresAt);
            return BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess);
        })
        .RequireRateLimiting("fixed_ip")
        .AllowAnonymous()
        .RequireNoStoreResponse();

        group.MapPost("/auth/logout", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IUserSessionCommandService sessions,
            AuthCookieService authCookieService,
            IAedsEncoder aeds) =>
        {
            string? refreshToken = authCookieService.ReadRefreshToken(httpContext);
            if (!string.IsNullOrEmpty(refreshToken))
            {
                await sessions.RevokeRefreshTokenAsync(refreshToken);
            }

            authCookieService.ClearTokenCookies(httpContext);
            return BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess);
        })
        .RequireAuthorization()
        .AllowBannedUserWrite()
        .RequireNoStoreResponse();

        group.MapPost("/auth/passkey/register/begin", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IPasskeyService passkeyService,
            IUserAccountReader users,
            IAedsEncoder aeds) =>
        {
            var userContext = EndpointUserContext.From(httpContext.User);
            UserAccountSnapshot? user = await users.GetAccountByIdAsync(userContext.UserId);
            if (user == null)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.NotFound, "用户不存在"), aeds);
            }

            var (success, message, data) = await passkeyService.BeginRegistrationAsync(user.Value.Id, user.Value.Username);
            return success && data != null
                ? BinaryResults.Frame(aeds, AedsFrameType.PasskeyRegisterBegin, writer => PodBinaryCodec.WritePasskeyRegisterBegin(data.Options, writer))
                : BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, message), aeds);
        })
        .RequireAuthorization();

        group.MapPost("/auth/passkey/register/complete", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IPasskeyService passkeyService,
            IMfaChallengeService mfaChallengeService,
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
            UserAccountSnapshot? user = await users.GetAccountByIdAsync(userContext.UserId);
            if (user == null)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.NotFound, "用户不存在"), aeds);
            }

            if (user.Value.MfaEnabled)
            {
                if (string.IsNullOrWhiteSpace(request.MfaProofToken))
                {
                    return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Forbidden, "注册通行密钥需要先完成 MFA 验证"), aeds);
                }

                bool proofValid = await mfaChallengeService.ValidateAndConsumeProofTokenAsync(user.Value.Id, "passkey_register", request.MfaProofToken);
                if (!proofValid)
                {
                    return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Forbidden, "MFA 验证令牌无效或已过期"), aeds);
                }
            }

            var (success, message) = await passkeyService.CompleteRegistrationAsync(user.Value.Id, request);
            return success
                ? BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess)
                : BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, message), aeds);
        })
        .RequireAuthorization();

        group.MapPost("/auth/passkey/login/begin", static async Task<BinaryFrameResult> (
            IPasskeyService passkeyService,
            IAedsEncoder aeds) =>
        {
            var (success, message, data) = await passkeyService.BeginAssertionAsync();
            return success && data != null
                ? BinaryResults.Frame(aeds, AedsFrameType.PasskeyLoginBegin, writer => PodBinaryCodec.WritePasskeyLoginBegin(data.Options, writer))
                : BinaryResults.FromError(ErrorDetail.Create(ErrorCode.InfraFailure, message), aeds);
        })
        .AllowAnonymous()
        .RequireRateLimiting("fixed_ip")
        .RequireNoStoreResponse();

        group.MapPost("/auth/passkey/login/complete", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IPasskeyService passkeyService,
            IUserLoginWorkflowService loginWorkflow,
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

            var (success, message, user) = await passkeyService.CompleteAssertionAsync(request);
            if (!success || user == null)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Unauthorized, message), aeds);
            }

            string clientIp = httpContext.GetClientIp();
            string? deviceFp = GetDeviceFingerprint(httpContext);
            string? userAgent = httpContext.Request.Headers.UserAgent.ToString();
            var login = await loginWorkflow.CompleteLoginAsync(user.Id, clientIp, deviceFp, userAgent, mfaVerified: true, rememberMe: request.RememberMe);
            if (!login.Success || login.Data == null || login.User == null)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Unauthorized, login.Message), aeds);
            }

            authCookieService.SetTokenCookies(
                httpContext,
                env,
                login.Data.Value.AccessToken,
                login.Data.Value.RefreshToken,
                login.Data.Value.RefreshTokenExpiresAt);
            var flow = new AuthLoginFlowDto(
                new AuthIdentitySnapshotDto(login.User.Value.Id, login.User.Value.Username, login.User.Value.Role.ToLowerInvariant()),
                "authenticated",
                null,
                null);
            return BinaryResults.Frame(aeds, AedsFrameType.AuthLoginFlow, writer => PodBinaryCodec.WriteAuthLoginFlow(flow, writer));
        })
        .AllowAnonymous()
        .RequireRateLimiting("fixed_ip");

        group.MapGet("/auth/passkey/credentials", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IPasskeyService passkeyService,
            IAedsEncoder aeds) =>
        {
            int userId = httpContext.User.GetUserId();
            var credentials = await passkeyService.GetCredentialsAsync(userId);
            return BinaryResults.Frame(aeds, AedsFrameType.PasskeyCredentialList, writer => PodBinaryCodec.WritePasskeyCredentialList([.. credentials], writer));
        })
        .RequireAuthorization();

        group.MapDelete("/auth/passkey/credentials/{id:int}", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IPasskeyService passkeyService,
            int id,
            IAedsEncoder aeds) =>
        {
            int userId = httpContext.User.GetUserId();
            bool deleted = await passkeyService.RemoveCredentialAsync(userId, id);
            return deleted
                ? BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess)
                : BinaryResults.FromError(ErrorDetail.Create(ErrorCode.NotFound, "通行密钥不存在"), aeds);
        })
        .RequireAuthorization();

        group.MapPut("/auth/passkey/credentials/{id:int}/name", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IPasskeyService passkeyService,
            int id,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var payload = await ReadBinaryRequestPayloadAsync(httpContext, aeds, AedsFrameType.PasskeyRenameRequest, cancellationToken);
            if (!payload.IsSuccess)
            {
                return BinaryResults.FromError(payload.Error, aeds);
            }

            if (!PodBinaryCodec.TryDecodeStringMutationRequest(payload.Payload, out string name) ||
                string.IsNullOrWhiteSpace(name))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "名称不能为空"), aeds);
            }

            int userId = httpContext.User.GetUserId();
            bool renamed = await passkeyService.RenameCredentialAsync(userId, id, name);
            return renamed
                ? BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess)
                : BinaryResults.FromError(ErrorDetail.Create(ErrorCode.NotFound, "通行密钥不存在"), aeds);
        })
        .RequireAuthorization();
    }
}
