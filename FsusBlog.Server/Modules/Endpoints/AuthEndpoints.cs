using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Responses;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.Outputs;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using System.Security.Claims;

namespace FsusBlog.Server.Modules.Endpoints;

public static class AuthEndpoints
{
    public static void MapAuthEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("api/Auth").WithTags("Auth-Core");

        group.MapGet("pow-challenge", async (HttpContext context, IPowService powService) =>
        {
            string clientIp = context.GetClientIp();
            var challenge = await powService.GenerateChallengeAsync(clientIp);
            return TypedResults.Ok(challenge);
        })
        .RequireRateLimiting("fixed_ip")
        .AllowAnonymous();

        group.MapPost("register", async Task<Results<Ok<ApiResponse>, BadRequest<ApiResponse>>> (
            RegisterDto dto,
            IUserService userService) =>
        {
            var (success, message) = await userService.RegisterAsync(dto);
            return success
                ? ApiResults.Ok("注册成功")
                : ApiResults.BadRequest(message, 400);
        })
        .RequireRateLimiting("fixed_ip")
        .AllowAnonymous()
        .AddEndpointFilter<RequiresPowFilter>();

        group.MapPost("login", async Task<Results<Ok<ApiResponse<AuthLoginFlowDto>>, JsonHttpResult<ApiResponse>>> (
            LoginDto dto,
            UserService userService,
            IMfaChallengeService mfaChallengeService,
            IWebHostEnvironment env,
            HttpContext context,
            AuthCookieService authCookieService) =>
        {
            if (string.IsNullOrWhiteSpace(dto.Username) || string.IsNullOrWhiteSpace(dto.Password))
            {
                return ApiResults.Status(400, "用户名或密码不能为空");
            }

            string clientIp = context.GetClientIp();
            string? deviceFp = GetDeviceFingerprint(context);
            string? userAgent = context.Request.Headers.UserAgent.ToString();

            var check = await userService.ValidateCredentialsAsync(dto, clientIp);
            if (!check.Success || check.User == null)
            {
                return ApiResults.Unauthorized(check.Message);
            }

            if (check.User.MfaEnabled)
            {
                var risk = await userService.EvaluateLoginRiskAsync(check.User.Id, clientIp, deviceFp, userAgent);
                var ticket = await mfaChallengeService.CreateLoginChallengeAsync(
                    check.User.Id,
                    risk.RequiresMfa,
                    dto.RememberMe);

                var flow = new AuthLoginFlowDto(
                    new AuthIdentitySnapshotDto(check.User.Id, check.User.Username, check.User.Role),
                    "mfa_required",
                    risk.RequiresMfa ? "risk" : "standard",
                    ticket.TicketId);

                return ApiResults.Ok(flow, "MFA_REQUIRED");
            }

            var login = await userService.CompleteLoginAsync(
                check.User,
                clientIp,
                deviceFp,
                userAgent,
                mfaVerified: !check.User.MfaEnabled,
                rememberMe: dto.RememberMe);
            if (!login.Success || login.Data == null || login.UserEntity == null)
            {
                return ApiResults.Unauthorized(login.Message);
            }

            authCookieService.SetTokenCookies(context, env, login.Data.Value.AccessToken, login.Data.Value.RefreshToken, login.UserEntity.RefreshTokenExpiryTime ?? DateTime.UtcNow.AddDays(7));

            var done = new AuthLoginFlowDto(
                new AuthIdentitySnapshotDto(login.UserEntity.Id, login.UserEntity.Username, login.UserEntity.Role.ToLowerInvariant()),
                "authenticated",
                null,
                null);
            return ApiResults.Ok(done, "登录成功");
        })
        .RequireRateLimiting("fixed_ip")
        .AllowAnonymous()
        .AddEndpointFilter<RequiresPowFilter>();

        group.MapGet("me", async Task<Results<Ok<ApiResponse<CurrentUserSnapshotDto>>, JsonHttpResult<ApiResponse>, NotFound<ApiResponse>>> (
            ClaimsPrincipal userPrincipal,
            IUserService userService) =>
        {
            var userContext = EndpointUserContext.From(userPrincipal);
            int userId = userContext.UserId;
            var user = await userService.GetByIdAsync(userId);
            if (user == null) return ApiResults.NotFound("用户不存在");
            if (user.Status == 2 || user.DeletedAt.HasValue)
            {
                return ApiResults.Unauthorized("账户已注销");
            }

            var responseDto = new CurrentUserSnapshotDto(user.Id, user.Username, user.Role, user.Status, user.BanReason, user.DeletedAt);
            return ApiResults.Ok(responseDto);
        })
        .RequireAuthorization();

        group.MapPost("refresh-token", async Task<Results<Ok<ApiResponse>, JsonHttpResult<ApiResponse>>> (
            HttpContext context,
            UserService userService,
            IWebHostEnvironment env,
            AuthCookieService authCookieService) =>
        {
            string? oldRefreshToken = authCookieService.ReadRefreshToken(context);
            if (string.IsNullOrEmpty(oldRefreshToken))
            {
                return ApiResults.Unauthorized("会话已失效，请重新登录");
            }

            string? sessionId = authCookieService.ReadSessionId(context);
            var (success, newTokens) = await userService.RefreshTokenAsync(oldRefreshToken, sessionId);
            if (!success || newTokens == null)
            {
                authCookieService.ClearTokenCookies(context);
                return ApiResults.Unauthorized("刷新凭证已失效");
            }

            var session = await userService.GetSessionByRefreshTokenAsync(newTokens.Value.RefreshToken);
            authCookieService.SetTokenCookies(
                context,
                env,
                newTokens.Value.AccessToken,
                newTokens.Value.RefreshToken,
                session?.IdleExpiresAt ?? DateTime.UtcNow.AddDays(7));
            return ApiResults.Ok("Token 已刷新");
        })
        .RequireRateLimiting("fixed_ip")
        .AllowAnonymous();

        group.MapPost("logout", async (
            HttpContext context,
            UserService userService,
            AuthCookieService authCookieService) =>
        {
            string? refreshToken = authCookieService.ReadRefreshToken(context);
            if (!string.IsNullOrEmpty(refreshToken))
            {
                await userService.RevokeRefreshTokenAsync(refreshToken);
            }

            authCookieService.ClearTokenCookies(context);
            return ApiResults.Ok("安全退出成功");
        })
        .RequireAuthorization();

        group.MapPost("delete-account", async Task<IResult> (
            HttpContext context,
            UserService userService,
            AuthCookieService authCookieService) =>
        {
            int userId = context.User.GetUserId();
            var dto = await context.Request.ReadFromJsonAsync<DeleteAccountRequestDto>(context.RequestAborted);
            if (dto == null)
            {
                return AuthErrorResults.InvalidRequest();
            }

            var result = await userService.DeleteAccountAsync(userId, dto);
            if (!result.Success)
            {
                return ApiResults.Unprocessable(result.Message);
            }

            authCookieService.ClearTokenCookies(context);
            return ApiResults.Ok(result.Message);
        })
        .RequireAuthorization()
        .AddEndpointFilter<RequiresPowFilter>();

        group.MapGet("sessions", async (ClaimsPrincipal user, UserService userService) =>
        {
            var userContext = EndpointUserContext.From(user);
            var sessions = await userService.GetUserSessionsAsync(userContext.UserId, userContext.SessionId);
            return ApiResults.Ok(sessions);
        })
        .RequireAuthorization();

        group.MapPost("sessions/{id}/revoke", async Task<Results<Ok<ApiResponse>, NotFound<ApiResponse>>> (
            ClaimsPrincipal user,
            UserService userService,
            string id) =>
        {
            var userContext = EndpointUserContext.From(user);
            bool revoked = await userService.RevokeSessionAsync(userContext.UserId, id);
            return revoked
                ? ApiResults.Ok("会话已下线")
                : ApiResults.NotFound("会话不存在");
        })
        .RequireAuthorization();

        group.MapPost("sessions/revoke-others", async (ClaimsPrincipal user, UserService userService) =>
        {
            var userContext = EndpointUserContext.From(user);
            int count = await userService.RevokeOtherSessionsAsync(userContext.UserId, userContext.SessionId);
            return ApiResults.Ok($"已下线 {count} 个会话");
        })
        .RequireAuthorization();

        group.MapPost("mfa/setup/start", async Task<IResult> (HttpContext context) =>
        {
            var userService = context.RequestServices.GetRequiredService<UserService>();
            var systemService = context.RequestServices.GetRequiredService<ISystemService>();
            int userId = context.User.GetUserId();
            var site = await systemService.GetSeoConfigAsync();
            string issuer = string.IsNullOrWhiteSpace(site.Title) ? "FsusBlog" : site.Title;
            var result = await userService.StartMfaSetupAsync(userId, issuer);
            return result.Success && result.Data != null
                ? ApiResults.Ok(result.Data.Value, result.Message)
                : ApiResults.BadRequest(result.Message);
        }).RequireAuthorization();

        group.MapGet("mfa/profile", async Task<IResult> (ClaimsPrincipal user, UserService userService) =>
        {
            int userId = user.GetUserId();
            var profile = await userService.GetMfaProfileAsync(userId);
            if (profile == null)
            {
                return ApiResults.NotFound("用户不存在");
            }

            return ApiResults.Ok(profile.Value);
        }).RequireAuthorization();

        group.MapPost("mfa/setup/verify", async Task<IResult> (HttpContext context) =>
        {
            var userService = context.RequestServices.GetRequiredService<UserService>();
            int userId = context.User.GetUserId();
            var dto = await context.Request.ReadFromJsonAsync<MfaSetupVerifyRequestDto>(context.RequestAborted);
            if (dto == null || string.IsNullOrWhiteSpace(dto.Code))
            {
                return AuthErrorResults.InvalidRequest();
            }

            var result = await userService.VerifyMfaSetupAsync(userId, dto.Code);
            return result.Success && result.Data != null
                ? ApiResults.Ok(result.Data, result.Message)
                : ApiResults.Unprocessable(result.Message);
        }).RequireAuthorization();

        group.MapPost("mfa/disable", async Task<IResult> (HttpContext context) =>
        {
            var userService = context.RequestServices.GetRequiredService<UserService>();
            int userId = context.User.GetUserId();
            var dto = await context.Request.ReadFromJsonAsync<MfaDisableRequestDto>(context.RequestAborted);
            if (dto == null)
            {
                return AuthErrorResults.InvalidRequest();
            }

            var result = await userService.DisableMfaAsync(userId, dto.Password, dto.Code, dto.RecoveryCode);
            return result.Success
                ? ApiResults.Ok(result.Message)
                : ApiResults.Unprocessable(result.Message);
        }).RequireAuthorization();

        group.MapPost("mfa/recovery/regenerate", async Task<IResult> (HttpContext context) =>
        {
            var userService = context.RequestServices.GetRequiredService<UserService>();
            int userId = context.User.GetUserId();
            var dto = await context.Request.ReadFromJsonAsync<MfaDisableRequestDto>(context.RequestAborted);
            if (dto == null)
            {
                return AuthErrorResults.InvalidRequest();
            }

            var result = await userService.RegenerateMfaRecoveryCodesAsync(userId, dto.Password, dto.Code, dto.RecoveryCode);
            return result.Success && result.Data != null
                ? ApiResults.Ok(result.Data, result.Message)
                : ApiResults.Unprocessable(result.Message);
        }).RequireAuthorization();

        group.MapPost("mfa/challenge/start", async Task<IResult> (HttpContext context) =>
        {
            var userService = context.RequestServices.GetRequiredService<UserService>();
            var challengeService = context.RequestServices.GetRequiredService<IMfaChallengeService>();
            int userId = context.User.GetUserId();
            var dto = await context.Request.ReadFromJsonAsync<MfaChallengeRequestDto>(context.RequestAborted);
            string action = string.IsNullOrWhiteSpace(dto?.Action) ? "generic" : dto!.Action!;
            var userEntity = await userService.GetByIdAsync(userId);
            if (userEntity == null)
            {
                return AuthErrorResults.UserNotFound();
            }

            if (!userEntity.MfaEnabled)
            {
                string proofToken = await challengeService.CreateProofTokenAsync(userEntity.Id, action, TimeSpan.FromMinutes(5));
                return ApiResults.Ok(new MfaChallengeResultDto(true, action, proofToken, null), "MFA_NOT_REQUIRED");
            }

            string? deviceFp = GetDeviceFingerprint(context);
            var risk = await userService.EvaluateLoginRiskAsync(userId, context.GetClientIp(), deviceFp, context.Request.Headers.UserAgent.ToString());
            var ticket = await challengeService.CreateActionChallengeAsync(userEntity.Id, action, risk.RequiresMfa);
            return ApiResults.Ok(new MfaChallengeResultDto(false, action, ticket.TicketId, null), "MFA_CHALLENGE_CREATED");
        }).RequireAuthorization();

        group.MapPost("mfa/challenge", async Task<IResult> (HttpContext context) =>
        {
            var userService = context.RequestServices.GetRequiredService<UserService>();
            var challengeService = context.RequestServices.GetRequiredService<IMfaChallengeService>();
            var env = context.RequestServices.GetRequiredService<IWebHostEnvironment>();
            var dto = await context.Request.ReadFromJsonAsync<MfaChallengeRequestDto>(context.RequestAborted);
            if (dto == null || string.IsNullOrWhiteSpace(dto.ChallengeToken))
            {
                return AuthErrorResults.ChallengeRequired();
            }

            var ticket = await challengeService.GetChallengeAsync(dto.ChallengeToken);
            if (ticket == null)
            {
                return AuthErrorResults.ChallengeExpired();
            }

            var userEntity = await userService.GetByIdAsync(ticket.UserId);
            if (userEntity == null)
            {
                await challengeService.ConsumeChallengeAsync(ticket.TicketId);
                return AuthErrorResults.UserNotFound("USER_NOT_FOUND");
            }

            bool verified = await userService.VerifyMfaOrRecoveryCodeAsync(userEntity, dto.Code, dto.RecoveryCode, persistRecoveryConsumption: true);
            if (!verified)
            {
                return AuthErrorResults.InvalidTotp();
            }

            await challengeService.ConsumeChallengeAsync(ticket.TicketId);

            if (ticket.Type == "login")
            {
                var login = await userService.CompleteLoginAsync(
                    userEntity,
                    context.GetClientIp(),
                    GetDeviceFingerprint(context),
                    context.Request.Headers.UserAgent.ToString(),
                    mfaVerified: true,
                    rememberMe: ticket.RememberMe);
                if (!login.Success || login.Data == null || login.UserEntity == null)
                {
                    return ApiResults.Unauthorized("LOGIN_FINALIZE_FAILED");
                }

                var authCookieService = context.RequestServices.GetRequiredService<AuthCookieService>();
                authCookieService.SetTokenCookies(context, env, login.Data.Value.AccessToken, login.Data.Value.RefreshToken, login.UserEntity.RefreshTokenExpiryTime ?? DateTime.UtcNow.AddDays(7));
                return ApiResults.Ok(new MfaChallengeResultDto(
                    true,
                    "login",
                    null,
                    new AuthIdentitySnapshotDto(login.UserEntity.Id, login.UserEntity.Username, login.UserEntity.Role)
                ), "MFA_VERIFIED");
            }

            string proofToken = await challengeService.CreateProofTokenAsync(ticket.UserId, ticket.Action, TimeSpan.FromMinutes(5));
            return ApiResults.Ok(new MfaChallengeResultDto(true, ticket.Action, proofToken, null), "MFA_VERIFIED");
        }).AllowAnonymous();

        group.MapPost("admin/users/{id:int}/mfa/reset", async Task<Results<Ok<ApiResponse>, NotFound<ApiResponse>>> (
            int id,
            UserService userService,
            ClaimsPrincipal principal) =>
        {
            if (!principal.IsInRole("admin"))
            {
                return ApiResults.NotFound("无权限");
            }

            var user = await userService.GetByIdAsync(id);
            if (user == null)
            {
                return ApiResults.NotFound("用户不存在");
            }

            await userService.ResetMfaByAdminAsync(id);
            return ApiResults.Ok("MFA 已重置");
        })
        .RequireAuthorization(policy => policy.RequireRole("admin"));
    }

    private static string? GetDeviceFingerprint(HttpContext context)
    {
        if (!context.Request.Headers.TryGetValue("X-Fsus-Device-Fp", out var raw))
        {
            return null;
        }
        string? value = raw.ToString();
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }
        return value.Length <= 128 ? value : value[..128];
    }
}
