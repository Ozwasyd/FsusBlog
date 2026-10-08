using System.Globalization;
using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Services.Security;

using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Authorization.Infrastructure;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;

namespace FsusBlog.Server.Infrastructure.Helpers;

public class JwtSettings
{
    public string KeyVersion { get; set; } = string.Empty;
    public string SecretKey { get; set; } = string.Empty;
    public string Issuer { get; set; } = string.Empty;
    public string Audience { get; set; } = string.Empty;
    public int AccessTokenExpiresMinutes { get; set; } = 15;
}

public readonly record struct IssuedAccessToken(string Token, DateTimeOffset ExpiresAtUtc)
{
    public static implicit operator string(IssuedAccessToken issuedToken) => issuedToken.Token;
}

public interface IJwtHelper
{
    IssuedAccessToken GenerateAccessToken(User user, string? sessionId, UserSessionAuthenticationContext authenticationContext);
    IssuedAccessToken GenerateAdminAccessToken(AdminPrincipal principal, AdminSession session, IReadOnlyCollection<string> permissions);
    string GenerateRefreshToken();
}

/// <summary>
/// Issues signed access tokens and cryptographically random refresh tokens.
/// </summary>
public class JwtHelper : IJwtHelper
{
    private readonly JwtSettings _settings;
    private readonly IConfiguration? _configuration;
    private readonly TimeProvider _timeProvider;

    // OWNERSHIP: The singleton reuses immutable signing credentials for one configured key version.
    private readonly SigningCredentials _credentials;

    // OWNERSHIP: One immutable handler configuration is shared by all token issuances.
    private static readonly JwtSecurityTokenHandler s_tokenHandler = new();

    public JwtHelper(
        IOptions<JwtSettings> options,
        IConfiguration? configuration = null,
        TimeProvider? timeProvider = null)
    {
        _settings = options.Value;
        _configuration = configuration;
        _timeProvider = timeProvider ?? TimeProvider.System;
        IReadOnlyList<string> signingKeyErrors = CurrentJwtSigningKey.Validate(_settings, enforceProductionRules: false);
        if (signingKeyErrors.Count > 0)
        {
            throw new InvalidOperationException("JWT current signing key configuration is invalid: " + string.Join("; ", signingKeyErrors));
        }

        // The configured key material is parsed once during singleton construction.
        SymmetricSecurityKey key = CurrentJwtSigningKey.CreateKey(_settings.KeyVersion, _settings.SecretKey);
        _credentials = new SigningCredentials(
            key,
            SecurityAlgorithms.HmacSha256Signature);
    }

    public IssuedAccessToken GenerateAccessToken(
        User user,
        string? sessionId,
        UserSessionAuthenticationContext authenticationContext)
    {
        if (!AccountRegistrationStates.IsActive(user.RegistrationState))
        {
            throw new InvalidOperationException("Formal access tokens may only be issued for active accounts.");
        }

        if (!AnonymousIdentityRuntime.TryParse(user.IdentityKind, out CurrentIdentityKind identityKind) ||
            identityKind != CurrentIdentityKind.AnonymousAccount)
        {
            throw new InvalidOperationException("Ordinary access tokens require the exact current account identity kind.");
        }
        if (!authenticationContext.IsValid())
        {
            throw new InvalidOperationException("Session authentication context is invalid.");
        }

        var claims = new List<Claim>(string.IsNullOrWhiteSpace(sessionId) ? 9 : 10)
        {
            new(ClaimTypes.NameIdentifier, user.Id.ToString()),
            new(CurrentAuthSessionClaims.IdentityKind, AnonymousIdentityRuntime.ToWireValue(identityKind)),
            new(
                CurrentAuthSessionClaims.AccountSubjectHash,
                AccountSubjectHashRequirement.Require(user.AccountSubjectHash, "access-token-issuance"))
        };
        if (!string.IsNullOrWhiteSpace(sessionId))
        {
            claims.Add(new Claim("sid", sessionId));
        }
        claims.Add(new Claim(
            "mfa",
            UserSessionAuthenticationContract.IsCoarseMfa(
                authenticationContext.Method,
                authenticationContext.Strength,
                authenticationContext.CredentialRowId) ? "1" : "0"));
        claims.Add(new Claim(CurrentAuthSessionClaims.AuthenticationMethod, authenticationContext.Method));
        claims.Add(new Claim(CurrentAuthSessionClaims.AuthenticationStrength, authenticationContext.Strength));
        claims.Add(new Claim(CurrentAuthSessionClaims.DurationPolicy, authenticationContext.DurationPolicy));
        claims.Add(new Claim(
            CurrentAuthSessionClaims.SessionMode,
            UserSessionModes.ToClaimValue(authenticationContext.SessionMode)));
        claims.Add(new Claim(
            CurrentAuthSessionClaims.AuthenticatedAt,
            new DateTimeOffset(authenticationContext.AuthenticatedAtUtc)
                .ToUnixTimeSeconds()
                .ToString(System.Globalization.CultureInfo.InvariantCulture)));

        DateTimeOffset issuedAtUtc = TruncateToUnixSecond(_timeProvider.GetUtcNow());
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

        var token = s_tokenHandler.CreateToken(tokenDescriptor);
        return new IssuedAccessToken(s_tokenHandler.WriteToken(token), expiresAtUtc);
    }

    public IssuedAccessToken GenerateAdminAccessToken(
        AdminPrincipal principal,
        AdminSession session,
        IReadOnlyCollection<string> permissions)
    {
        var claims = new List<Claim>(9 + permissions.Count)
        {
            new(ClaimTypes.NameIdentifier, principal.Id.ToString()),
            new(ClaimTypes.Name, principal.Handle),
            new(CurrentAuthSessionClaims.IdentityKind, AnonymousIdentityRuntime.AdminPrincipalKind),
            new("admin_id", principal.Id.ToString()),
            new("admin_handle", principal.Handle),
            new("admin_sid", session.SessionId),
            new("sid", session.SessionId),
            new("admin_step_up", session.StepUpVerified ? "1" : "0"),
            new("mfa", session.StepUpVerified ? "1" : "0")
        };

        foreach (string permission in permissions.Where(static permission => !string.IsNullOrWhiteSpace(permission)).Distinct(StringComparer.Ordinal))
        {
            claims.Add(new Claim(AdminPermissions.PermissionClaimType, permission));
        }

        DateTimeOffset issuedAtUtc = TruncateToUnixSecond(_timeProvider.GetUtcNow());
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

        var token = s_tokenHandler.CreateToken(tokenDescriptor);
        return new IssuedAccessToken(s_tokenHandler.WriteToken(token), expiresAtUtc);
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
/// Registers token issuance and bearer validation, rejecting an invalid signing-key configuration at startup.
/// </summary>
public static class JwtServiceExtensions
{
    private const string AdminCookiePathDecisionItemKey = "Fsus.AdminCookiePathDecision";
    private const string AdminAccessTokenItemKey = "Fsus.AdminAccessToken";

    public static void AddJwtAuthentication(
        this IServiceCollection services,
        IConfiguration configuration,
        TimeProvider? businessTimeProvider = null)
    {
        TimeProvider timeProvider = businessTimeProvider ?? TimeProvider.System;
        services.TryAddSingleton(timeProvider);
        var jwtSection = configuration.GetSection("Jwt");
        services.Configure<JwtSettings>(jwtSection);

        services.AddSingleton<IJwtHelper, JwtHelper>();

        var settings = jwtSection.Get<JwtSettings>(static binder => binder.ErrorOnUnknownConfiguration = true);
        if (settings == null ||
            string.IsNullOrEmpty(settings.SecretKey) ||
            string.IsNullOrEmpty(settings.Issuer) ||
            string.IsNullOrEmpty(settings.Audience))
        {
            throw new InvalidOperationException("JWT 配置缺失：请检查 appsettings.json 中的 SecretKey, Issuer, Audience");
        }

        IReadOnlyList<string> signingKeyErrors = CurrentJwtSigningKey.Validate(settings, enforceProductionRules: false);
        if (signingKeyErrors.Count > 0)
        {
            throw new InvalidOperationException("JWT current signing key configuration is invalid: " + string.Join("; ", signingKeyErrors));
        }
        SymmetricSecurityKey currentSigningKey = CurrentJwtSigningKey.CreateKey(settings.KeyVersion, settings.SecretKey);

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
                RequireSignedTokens = true,
                TryAllIssuerSigningKeys = false,
                ValidAlgorithms = [SecurityAlgorithms.HmacSha256],
                // Business wall clock is injectable for correctness tests via the
                // registration-time TimeProvider (see AddFsusApiFoundation).
                IssuerSigningKey = currentSigningKey,
                IssuerSigningKeyValidator = (key, token, _) =>
                    CurrentJwtSigningKey.HasExactCurrentKeyId(key, token, settings.KeyVersion),
                LifetimeValidator = (notBefore, expires, _, validationParameters) =>
                    ValidateLifetimeAgainstBusinessClock(
                        notBefore,
                        expires,
                        timeProvider,
                        validationParameters.ClockSkew),

                ValidateIssuer = true,
                ValidIssuer = settings.Issuer,

                ValidateAudience = true,
                ValidAudience = settings.Audience,

                ValidateLifetime = true,
                // SECURITY-INVARIANT: Validation never extends the configured token lifetime.
                ClockSkew = TimeSpan.Zero
            };

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
                        string accessToken = context.SecurityToken switch
                        {
                            JwtSecurityToken jwtToken => jwtToken.RawData,
                            JsonWebToken jsonToken => jsonToken.EncodedToken,
                            _ => string.Empty
                        };
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
                OnAuthenticationFailed = context =>
                {
                    var authCookies = context.HttpContext.RequestServices.GetRequiredService<AuthCookieService>();
                    if (ShouldPreferAdminCookie(context.HttpContext))
                    {
                        authCookies.ClearAdminSessionCookies(context.HttpContext);
                    }
                    else
                    {
                        authCookies.ClearUserSessionCookies(context.HttpContext);
                    }
                    return Task.CompletedTask;
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
                ["identityKind"] = httpContext.User.FindFirst(CurrentAuthSessionClaims.IdentityKind)?.Value
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

    /// <summary>
    /// Lifetime validation against the injected business wall clock so expiry tests
    /// can advance time without sleeping. ClockSkew remains hard-bounded by caller.
    /// </summary>
    private static bool ValidateLifetimeAgainstBusinessClock(
        DateTime? notBefore,
        DateTime? expires,
        TimeProvider timeProvider,
        TimeSpan clockSkew)
    {
        DateTime now = timeProvider.GetUtcNow().UtcDateTime;
        if (notBefore.HasValue && now + clockSkew < notBefore.Value)
        {
            return false;
        }

        if (expires.HasValue && now - clockSkew >= expires.Value)
        {
            return false;
        }

        return notBefore.HasValue || expires.HasValue;
    }
}

internal static class CurrentJwtSigningKey
{
    private const int MinimumKeyBytes = 32;
    private static readonly char[] s_versionSeparators = ['.', '_', '-'];

    internal static SymmetricSecurityKey CreateKey(string version, string secret)
        => new(Encoding.UTF8.GetBytes(secret))
        {
            KeyId = version
        };

    internal static bool HasExactCurrentKeyId(SecurityKey key, SecurityToken token, string currentVersion)
    {
        string? keyId = token switch
        {
            JwtSecurityToken jwtToken => jwtToken.Header.Kid,
            JsonWebToken jsonToken => jsonToken.Kid,
            _ => null
        };
        return string.Equals(key.KeyId, currentVersion, StringComparison.Ordinal)
            && string.Equals(keyId, currentVersion, StringComparison.Ordinal);
    }

    internal static IReadOnlyList<string> Validate(JwtSettings settings, bool enforceProductionRules)
    {
        List<string> errors = [];
        if (!IsValidVersion(settings.KeyVersion))
        {
            errors.Add("Jwt:KeyVersion must contain 3-64 safe version characters.");
        }
        else if (enforceProductionRules && settings.KeyVersion.StartsWith("dev", StringComparison.OrdinalIgnoreCase))
        {
            errors.Add("Jwt:KeyVersion must not use a development version in production.");
        }
        ValidateKeyMaterial("Jwt:SecretKey", settings.SecretKey, errors);
        return errors;
    }

    private static bool IsValidVersion(string? value)
        => !string.IsNullOrWhiteSpace(value) &&
            value.Length is >= 3 and <= 64 &&
            value.All(character => char.IsAsciiLetterOrDigit(character) || s_versionSeparators.Contains(character));

    private static void ValidateKeyMaterial(string path, string? value, List<string> errors)
    {
        if (string.IsNullOrWhiteSpace(value) || Encoding.UTF8.GetByteCount(value) < MinimumKeyBytes)
        {
            errors.Add($"{path} must contain at least {MinimumKeyBytes} bytes of signing key material.");
            return;
        }

        if (value.Contains("CHANGE_ME", StringComparison.OrdinalIgnoreCase) ||
            value.Contains("replace-with", StringComparison.OrdinalIgnoreCase) ||
            value.Contains("MUST_BE_OVERRIDDEN", StringComparison.OrdinalIgnoreCase))
        {
            errors.Add($"{path} must not use template signing key material.");
        }
    }
}
