using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Authorization.Infrastructure;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.Tokens;
using System.Globalization;
using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Services.Security;
using Microsoft.AspNetCore.WebUtilities;

namespace FsusBlog.Server.Infrastructure.Helpers;

// 1. 强类型配置模型
public class JwtSettings
{
    public string SecretKey { get; set; } = string.Empty;
    public string Issuer { get; set; } = string.Empty;
    public string Audience { get; set; } = string.Empty;
    public int AccessTokenExpiresMinutes { get; set; } = 15;
}

public readonly record struct IssuedAccessToken(string Token, DateTimeOffset ExpiresAtUtc)
{
    public static implicit operator string(IssuedAccessToken issuedToken) => issuedToken.Token;
}

// 2. 服务接口
public interface IJwtHelper
{
    IssuedAccessToken GenerateAccessToken(User user, string? sessionId = null, bool mfaVerified = false);
    IssuedAccessToken GenerateAdminAccessToken(AdminPrincipal principal, AdminSession session, IReadOnlyCollection<string> permissions, bool stepUpVerified = false);
    string GenerateRefreshToken();
}

/// <summary>
/// JWT 服务实现：负责高安全性的令牌签发
/// 修复日期: 2026-02-23 (引入静态 Handler 复用，预计算签名凭证，并实现零中间分配的 CSPRNG 刷新令牌生成)
/// </summary>
public class JwtHelper : IJwtHelper
{
    private readonly JwtSettings _settings;
    private readonly IConfiguration? _configuration;

    // 核心优化 1：预计算签名凭证。由于服务是单例，避免每次签发 Token 时重复申请 byte[] 和对象
    private readonly SigningCredentials _credentials;

    // 核心优化 2：JwtSecurityTokenHandler 是线程安全的，全局复用避免高频实例化开销
    private static readonly JwtSecurityTokenHandler _tokenHandler = new();

    public JwtHelper(IOptions<JwtSettings> options, IConfiguration? configuration = null)
    {
        _settings = options.Value;
        _configuration = configuration;

        // 使用 UTF8 支持更复杂的密钥字符 (在启动时执行一次)
        var key = Encoding.UTF8.GetBytes(_settings.SecretKey);
        // HmacSha256 需要至少 128 bit 的密钥，推荐 256 bit (32 字符)
        _credentials = new SigningCredentials(
            new SymmetricSecurityKey(key),
            SecurityAlgorithms.HmacSha256Signature);
    }

    public IssuedAccessToken GenerateAccessToken(User user, string? sessionId = null, bool mfaVerified = false)
    {
        // 核心优化 3：使用数组代替 List<Claim>，省去底层 List 对象的分配开销
        string identityKind = string.IsNullOrWhiteSpace(user.IdentityKind)
            ? AnonymousIdentityRuntime.AnonymousAccountKind
            : user.IdentityKind.Trim();
        var claims = new List<Claim>(5)
        {
            new(ClaimTypes.NameIdentifier, user.Id.ToString()),
            new("identity_kind", identityKind),
            new(
                AccountSubjectHasher.ClaimType,
                AccountSubjectHashRequirement.Require(user.AccountSubjectHash, "access-token-issuance"))
        };
        if (!string.IsNullOrWhiteSpace(sessionId))
        {
            claims.Add(new Claim("sid", sessionId));
        }
        claims.Add(new Claim("mfa", mfaVerified ? "1" : "0"));

        DateTimeOffset issuedAtUtc = TruncateToUnixSecond(DateTimeOffset.UtcNow);
        DateTimeOffset expiresAtUtc = issuedAtUtc.AddMinutes(ResolveAccessTokenExpiresMinutes());
        var tokenDescriptor = new SecurityTokenDescriptor
        {
            Subject = new ClaimsIdentity(claims),
            IssuedAt = issuedAtUtc.UtcDateTime,
            NotBefore = issuedAtUtc.UtcDateTime,
            Expires = expiresAtUtc.UtcDateTime,
            Issuer = _settings.Issuer,
            Audience = _settings.Audience,
            SigningCredentials = _credentials
        };

        var token = _tokenHandler.CreateToken(tokenDescriptor);
        return new IssuedAccessToken(_tokenHandler.WriteToken(token), expiresAtUtc);
    }

    public IssuedAccessToken GenerateAdminAccessToken(
        AdminPrincipal principal,
        AdminSession session,
        IReadOnlyCollection<string> permissions,
        bool stepUpVerified = false)
    {
        var claims = new List<Claim>(9 + permissions.Count)
        {
            new(ClaimTypes.NameIdentifier, principal.Id.ToString()),
            new(ClaimTypes.Name, principal.Handle),
            new("identity_kind", AnonymousIdentityRuntime.AdminPrincipalKind),
            new("admin_id", principal.Id.ToString()),
            new("admin_handle", principal.Handle),
            new("admin_sid", session.SessionId),
            new("sid", session.SessionId),
            new("admin_step_up", stepUpVerified ? "1" : "0"),
            new("mfa", stepUpVerified ? "1" : "0")
        };

        foreach (string permission in permissions.Where(static permission => !string.IsNullOrWhiteSpace(permission)).Distinct(StringComparer.Ordinal))
        {
            claims.Add(new Claim(AdminPermissions.PermissionClaimType, permission));
        }

        DateTimeOffset issuedAtUtc = TruncateToUnixSecond(DateTimeOffset.UtcNow);
        DateTimeOffset expiresAtUtc = issuedAtUtc.AddMinutes(ResolveAccessTokenExpiresMinutes());
        var tokenDescriptor = new SecurityTokenDescriptor
        {
            Subject = new ClaimsIdentity(claims),
            IssuedAt = issuedAtUtc.UtcDateTime,
            NotBefore = issuedAtUtc.UtcDateTime,
            Expires = expiresAtUtc.UtcDateTime,
            Issuer = _settings.Issuer,
            Audience = _settings.Audience,
            SigningCredentials = _credentials
        };

        var token = _tokenHandler.CreateToken(tokenDescriptor);
        return new IssuedAccessToken(_tokenHandler.WriteToken(token), expiresAtUtc);
    }

    /// <summary>
    /// 生成加密安全的随机刷新令牌 (CSPRNG)
    /// </summary>
    public string GenerateRefreshToken()
    {
        Span<byte> randomBytes = stackalloc byte[32];
        RandomNumberGenerator.Fill(randomBytes);
        return WebEncoders.Base64UrlEncode(randomBytes);
    }

    private static DateTimeOffset TruncateToUnixSecond(DateTimeOffset value)
        => DateTimeOffset.FromUnixTimeSeconds(value.ToUnixTimeSeconds());

    private int ResolveAccessTokenExpiresMinutes()
        => _configuration?.GetValue<int?>("Jwt:AccessTokenExpiresMinutes")
            ?? _settings.AccessTokenExpiresMinutes;

}

/// <summary>
/// 扩展方法：负责将 JWT 服务注册到 DI 容器和管道
/// </summary>
public static class JwtServiceExtensions
{
    private const string AdminCookiePathDecisionItemKey = "Fsus.AdminCookiePathDecision";
    private const string AdminAccessTokenItemKey = "Fsus.AdminAccessToken";

    public static void AddJwtAuthentication(this IServiceCollection services, IConfiguration configuration)
    {
        // 1. 绑定配置
        var jwtSection = configuration.GetSection("Jwt");
        services.Configure<JwtSettings>(jwtSection);

        // 注册服务为单例
        services.AddSingleton<IJwtHelper, JwtHelper>();

        // 2. 校验配置完整性
        var settings = jwtSection.Get<JwtSettings>();
        if (settings == null ||
            string.IsNullOrEmpty(settings.SecretKey) ||
            string.IsNullOrEmpty(settings.Issuer) ||
            string.IsNullOrEmpty(settings.Audience))
        {
            throw new InvalidOperationException("JWT 配置缺失：请检查 appsettings.json 中的 SecretKey, Issuer, Audience");
        }

        var key = Encoding.UTF8.GetBytes(settings.SecretKey);

        // 3. 配置认证方案
        services.AddAuthentication(x =>
        {
            x.DefaultAuthenticateScheme = JwtBearerDefaults.AuthenticationScheme;
            x.DefaultChallengeScheme = JwtBearerDefaults.AuthenticationScheme;
        })
        .AddJwtBearer(options =>
        {
#if DEBUG
            options.RequireHttpsMetadata = false;
#else
            options.RequireHttpsMetadata = true;
#endif
            options.SaveToken = true;

            options.TokenValidationParameters = new TokenValidationParameters
            {
                ValidateIssuerSigningKey = true,
                IssuerSigningKey = new SymmetricSecurityKey(key),

                ValidateIssuer = true,
                ValidIssuer = settings.Issuer,

                ValidateAudience = true,
                ValidAudience = settings.Audience,

                ValidateLifetime = true,
                ClockSkew = TimeSpan.Zero // 严格过期策略
            };

            // 从 Cookie 提取 Token
            options.Events = new JwtBearerEvents
            {
                OnMessageReceived = context =>
                {
                    var authCookies = context.HttpContext.RequestServices.GetRequiredService<AuthCookieService>();
                    if (ShouldPreferAdminCookie(context.HttpContext) &&
                        authCookies.TryReadAdminAccessToken(context.HttpContext, out string adminToken))
                    {
                        context.Token = adminToken;
                        context.HttpContext.Items[AdminAccessTokenItemKey] = adminToken;
                    }
                    else
                    {
                        string? token = authCookies.ReadAccessToken(context.HttpContext);
                        if (!string.IsNullOrWhiteSpace(token))
                        {
                            context.Token = token;
                        }
                    }
                    return Task.CompletedTask;
                },
                OnTokenValidated = async context =>
                {
                    if (context.Principal?.IsAdminPrincipal() == true)
                    {
                        string accessToken = context.SecurityToken is JwtSecurityToken jwtToken
                            ? jwtToken.RawData
                            : string.Empty;
                        if (string.IsNullOrWhiteSpace(accessToken) &&
                            context.HttpContext.Items[AdminAccessTokenItemKey] is string cachedAdminAccessToken &&
                            !string.IsNullOrWhiteSpace(cachedAdminAccessToken))
                        {
                            accessToken = cachedAdminAccessToken;
                        }

                        var adminValidator = context.HttpContext.RequestServices.GetRequiredService<IAdminSessionValidationService>();
                        AdminSessionValidationResult adminResult = await adminValidator.ValidateAsync(
                            context.Principal,
                            accessToken,
                            context.HttpContext.RequestAborted);
                        if (!adminResult.IsValid)
                        {
                            context.HttpContext.RequestServices.GetRequiredService<AuthCookieService>().ClearAdminSessionCookies(context.HttpContext);
                            context.Fail(adminResult.Reason);
                        }
                        return;
                    }

                    var userValidator = context.HttpContext.RequestServices.GetRequiredService<IUserSessionValidationService>();
                    UserSessionValidationResult userResult = await userValidator.ValidateAsync(
                        context.Principal,
                        context.HttpContext.RequestAborted);
                    if (!userResult.IsValid)
                    {
                        context.HttpContext.RequestServices.GetRequiredService<AuthCookieService>().ClearUserSessionCookies(context.HttpContext);
                        context.Fail(userResult.Reason);
                    }
                },
                OnForbidden = async context =>
                {
                    await RecordRejectedAuthSelfServicePrincipalAsync(context.HttpContext);
                }
            };
        });
    }

    private static async Task RecordRejectedAuthSelfServicePrincipalAsync(HttpContext httpContext)
    {
        string path = httpContext.Request.Path.Value ?? string.Empty;
        bool ordinaryAuthSelfServicePath =
            path.StartsWith("/api/binary/auth/", StringComparison.OrdinalIgnoreCase) &&
            !path.StartsWith("/api/binary/auth/admin/", StringComparison.OrdinalIgnoreCase);
        if (!ordinaryAuthSelfServicePath || httpContext.User.IsAdminPrincipal() != true)
        {
            return;
        }

        _ = httpContext.User.TryGetAdminPrincipalId(out long adminPrincipalId);
        var auditEvents = httpContext.RequestServices.GetService<IAuditEventService>();
        if (auditEvents is null)
        {
            return;
        }

        await auditEvents.RecordHighValueAsync(new AuditEvent(
            Source: "auth",
            Type: AuditTypeCatalog.Security,
            Action: AuditActionCatalog.AuthSelfServicePrincipalRejected,
            Outcome: AuditOutcomeCatalog.Denied,
            Severity: "warning",
            EventInfo: "AdminPrincipal rejected from ordinary account self-service auth endpoint",
            ActorType: AnonymousIdentityRuntime.AdminPrincipalKind,
            ActorId: adminPrincipalId > 0 ? adminPrincipalId.ToString(CultureInfo.InvariantCulture) : null,
            TargetType: "auth.self_service",
            TargetId: path,
            ReasonCode: "admin_principal_forbidden",
            Context: new Dictionary<string, object?>
            {
                ["path"] = path,
                ["method"] = httpContext.Request.Method,
                ["identityKind"] = httpContext.User.FindFirst("identity_kind")?.Value
            },
            IsHighValue: true),
            httpContext.RequestAborted);
    }

    internal static bool ShouldPreferAdminCookie(HttpContext httpContext)
    {
        if (httpContext.Items.TryGetValue(AdminCookiePathDecisionItemKey, out object? cachedDecision) &&
            cachedDecision is bool preferAdminCookie)
        {
            return preferAdminCookie;
        }

        bool result = ComputeShouldPreferAdminCookie(httpContext);
        httpContext.Items[AdminCookiePathDecisionItemKey] = result;
        return result;
    }

    private static bool ComputeShouldPreferAdminCookie(HttpContext httpContext)
    {
        Endpoint? endpoint = httpContext.GetEndpoint();
        if (endpoint != null)
        {
            foreach (AuthorizationPolicy policy in endpoint.Metadata.GetOrderedMetadata<AuthorizationPolicy>())
            {
                if (PolicyRequiresAdminPrincipal(policy))
                {
                    return true;
                }
            }
        }

        PathString path = httpContext.Request.Path;
        return path.StartsWithSegments("/api/binary/auth/admin/me", StringComparison.OrdinalIgnoreCase) ||
            path.StartsWithSegments("/api/binary/admin", StringComparison.OrdinalIgnoreCase) ||
            path.StartsWithSegments("/api/binary/author", StringComparison.OrdinalIgnoreCase) ||
            path.StartsWithSegments("/api/binary/stats", StringComparison.OrdinalIgnoreCase) ||
            path.StartsWithSegments("/api/binary/system/admin", StringComparison.OrdinalIgnoreCase) ||
            path.StartsWithSegments("/api/local/auth-fixture/admin-sensitive-proof", StringComparison.OrdinalIgnoreCase) ||
            path.StartsWithSegments("/__local/auth-fixture/admin-sensitive-proof", StringComparison.OrdinalIgnoreCase);
    }

    private static bool PolicyRequiresAdminPrincipal(AuthorizationPolicy policy)
        => policy.Requirements.OfType<ClaimsAuthorizationRequirement>().Any(static requirement =>
            string.Equals(requirement.ClaimType, "identity_kind", StringComparison.Ordinal) &&
                (requirement.AllowedValues == null ||
                    requirement.AllowedValues.Contains(AnonymousIdentityRuntime.AdminPrincipalKind, StringComparer.Ordinal)) ||
            string.Equals(requirement.ClaimType, AdminPermissions.PermissionClaimType, StringComparison.Ordinal));
}
