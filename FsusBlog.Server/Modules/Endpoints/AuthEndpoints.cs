using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Responses;
using Microsoft.AspNetCore.Http.HttpResults;
using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;

namespace FsusBlog.Server.Modules.Endpoints;

/// <summary>
/// 身份认证高频端点 (Minimal API)
/// 修复日期: 2026-02-23 (严格使用 C# 标准联合返回类型)
/// </summary>
public static class AuthEndpoints
{
    // 性能优化：JwtSecurityTokenHandler 是线程安全的，全局复用
    private static readonly JwtSecurityTokenHandler _jwtHandler = new();

    public static void MapAuthEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("api/Auth").WithTags("Auth-Core");

        // 1. 获取 PoW 挑战
        group.MapGet("pow-challenge", async (
            HttpContext context,
            IPowService powService) =>
        {
            var clientIp = context.GetClientIp();
            var challenge = await powService.GenerateChallengeAsync(clientIp);
            return TypedResults.Ok(challenge);
        })
        .RequireRateLimiting("fixed_ip")
        .AllowAnonymous();

        // 2. 用户注册
        group.MapPost("register", async Task<Results<Ok<ApiResponse>, BadRequest<ApiResponse>, JsonHttpResult<ApiResponse>>> (
            RegisterDto dto,
            IUserService userService,
            HttpContext context) =>
        {
            var (success, message) = await userService.RegisterAsync(dto);
            return success
                ? TypedResults.Ok(ApiResponse.Success("注册成功"))
                : TypedResults.BadRequest(ApiResponse.Fail(message, 400));
        })
        .RequireRateLimiting("fixed_ip")
        .AllowAnonymous()
        .AddEndpointFilter<RequiresPowFilter>();

        // 3. 用户登录
        group.MapPost("login", async Task<Results<Ok<ApiResponse<LoginResponseDto>>, BadRequest<ApiResponse>, JsonHttpResult<ApiResponse>>> (
            LoginDto dto,
            IUserService userService,
            IWebHostEnvironment env,
            HttpContext context) =>
        {
            if (string.IsNullOrWhiteSpace(dto.Username) || string.IsNullOrWhiteSpace(dto.Password))
                return TypedResults.BadRequest(ApiResponse.Fail("用户名或密码不能为空"));

            string clientIp = context.GetClientIp();

            var (success, message, token, userEntity) = await userService.LoginAsync(dto, clientIp);

            if (!success || token == null || userEntity == null)
                return TypedResults.Json(ApiResponse.Fail(message, 401), statusCode: 401);

            var jwtToken = _jwtHandler.ReadJwtToken(token.Value.AccessToken);
            var roleStr = jwtToken.Claims.FirstOrDefault(c => c.Type == ClaimTypes.Role || c.Type == "role")?.Value;

            SetTokenCookies(context, env, token.Value.AccessToken, token.Value.RefreshToken);

            var responseDto = new LoginResponseDto(userEntity.Id, userEntity.Username, roleStr?.ToLowerInvariant() ?? "user");
            return TypedResults.Ok(ApiResponse<LoginResponseDto>.Success(responseDto));
        })
        .RequireRateLimiting("fixed_ip")
        .AllowAnonymous()
        .AddEndpointFilter<RequiresPowFilter>();

        // 4. 获取当前用户信息
        group.MapGet("me", async Task<Results<Ok<ApiResponse<LoginResponseDto>>, NotFound<ApiResponse>>> (
            ClaimsPrincipal userPrincipal,
            IUserService userService) =>
        {
            var userId = userPrincipal.GetUserId();
            var user = await userService.GetByIdAsync(userId);

            if (user == null) return TypedResults.NotFound(ApiResponse.Fail("用户不存在", 404));

            var responseDto = new LoginResponseDto(user.Id, user.Username, user.Role);
            return TypedResults.Ok(ApiResponse<LoginResponseDto>.Success(responseDto));
        })
        .RequireAuthorization();

        // 5. 刷新令牌
        group.MapPost("refresh-token", async Task<Results<Ok<ApiResponse>, JsonHttpResult<ApiResponse>>> (
            HttpContext context,
            IUserService userService,
            IWebHostEnvironment env) =>
        {
            if (!context.Request.Cookies.TryGetValue("RefreshToken", out var oldRefreshToken) || string.IsNullOrEmpty(oldRefreshToken))
                return TypedResults.Json(ApiResponse.Fail("会话已失效，请重新登录", 401), statusCode: 401);

            var (success, newTokens) = await userService.RefreshTokenAsync(oldRefreshToken);

            if (!success || newTokens == null)
            {
                ClearTokenCookies(context);
                return TypedResults.Json(ApiResponse.Fail("刷新凭证已失效", 401), statusCode: 401);
            }

            SetTokenCookies(context, env, newTokens.Value.AccessToken, newTokens.Value.RefreshToken);
            return TypedResults.Ok(ApiResponse.Success("Token 已刷新"));
        })
        .RequireRateLimiting("fixed_ip")
        .AllowAnonymous();

        // 6. 退出登录
        group.MapPost("logout", async (
            HttpContext context,
            IUserService userService) =>
        {
            if (context.Request.Cookies.TryGetValue("RefreshToken", out var refreshToken) && !string.IsNullOrEmpty(refreshToken))
            {
                await userService.RevokeRefreshTokenAsync(refreshToken);
            }

            ClearTokenCookies(context);
            return TypedResults.Ok(ApiResponse.Success("安全退出成功"));
        })
        .RequireAuthorization();
    }

    private static void SetTokenCookies(HttpContext context, IWebHostEnvironment env, string access, string refresh)
    {
        var isProd = !env.IsDevelopment();
        var baseOptions = new CookieOptions
        {
            HttpOnly = true,
            Secure = isProd,
            SameSite = SameSiteMode.Strict,
            Path = "/"
        };

        context.Response.Cookies.Append("AccessToken", access, new CookieOptions(baseOptions)
        {
            Expires = DateTime.UtcNow.AddMinutes(15)
        });

        context.Response.Cookies.Append("RefreshToken", refresh, new CookieOptions(baseOptions)
        {
            Expires = DateTime.UtcNow.AddDays(7)
        });
    }

    private static void ClearTokenCookies(HttpContext context)
    {
        context.Response.Cookies.Delete("AccessToken");
        context.Response.Cookies.Delete("RefreshToken");
    }
}