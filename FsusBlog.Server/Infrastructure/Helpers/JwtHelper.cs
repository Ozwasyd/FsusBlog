using FsusBlog.Server.Entities;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.Tokens;
using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.Server.Infrastructure.Helpers;

// 1. 强类型配置模型
public class JwtSettings
{
    public string SecretKey { get; set; } = string.Empty;
    public string Issuer { get; set; } = string.Empty;
    public string Audience { get; set; } = string.Empty;
    public int AccessTokenExpiresMinutes { get; set; } = 15;
}

// 2. 服务接口
public interface IJwtHelper
{
    string GenerateAccessToken(User user);
    string GenerateRefreshToken();
}

/// <summary>
/// JWT 服务实现：负责高安全性的令牌签发
/// </summary>
public class JwtHelper(IOptions<JwtSettings> _options) : IJwtHelper
{
    private readonly JwtSettings _settings = _options.Value;

    public string GenerateAccessToken(User user)
    {
        // 使用 UTF8 支持更复杂的密钥字符
        var key = Encoding.UTF8.GetBytes(_settings.SecretKey);

        var claims = new List<Claim>
        {
            new(ClaimTypes.NameIdentifier, user.Id.ToString()),
            new(ClaimTypes.Name, user.Username ?? "Unknown"),
            new(ClaimTypes.Role, user.Role ?? "guest")
        };

        var tokenDescriptor = new SecurityTokenDescriptor
        {
            Subject = new ClaimsIdentity(claims),
            Expires = DateTime.UtcNow.AddMinutes(_settings.AccessTokenExpiresMinutes),
            Issuer = _settings.Issuer,
            Audience = _settings.Audience,
            // HmacSha256 需要至少 128 bit 的密钥，推荐 256 bit (32 字符)
            SigningCredentials = new SigningCredentials(
                new SymmetricSecurityKey(key),
                SecurityAlgorithms.HmacSha256Signature)
        };

        var tokenHandler = new JwtSecurityTokenHandler();
        var token = tokenHandler.CreateToken(tokenDescriptor);
        return tokenHandler.WriteToken(token);
    }

    /// <summary>
    /// 生成加密安全的随机刷新令牌 (CSPRNG)
    /// </summary>
    public string GenerateRefreshToken()
    {
        var randomNumber = new byte[32]; // 256 bits
        using var rng = RandomNumberGenerator.Create();
        rng.GetBytes(randomNumber);
        // 转换为 Base64 字符串并移除可能干扰 URL 的字符
        return Convert.ToBase64String(randomNumber)
            .Replace("+", "").Replace("/", "").Replace("=", "");
    }
}

/// <summary>
/// 扩展方法：负责将 JWT 服务注册到 DI 容器和管道
/// </summary>
public static class JwtServiceExtensions
{
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
                    if (context.Request.Cookies.TryGetValue("AccessToken", out var token))
                    {
                        context.Token = token;
                    }
                    return Task.CompletedTask;
                }
            };
        });
    }
}
