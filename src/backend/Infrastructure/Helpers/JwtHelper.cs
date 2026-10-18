using System.Globalization;
using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Security;
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
    public string KeyVersion { get; set; } = "legacy-current";
    public string SecretKey { get; set; } = string.Empty;
    public string Issuer { get; set; } = string.Empty;
    public string Audience { get; set; } = string.Empty;
    public int AccessTokenExpiresMinutes { get; set; } = 15;
    public int RotationWindowDays { get; set; } = 30;
    public DateTimeOffset? LegacyNoKidAcceptUntilUtc
    {
        get; set;
    }
    public List<JwtPreviousKeySettings> PreviousKeys { get; set; } = [];
}

public sealed class JwtPreviousKeySettings
{
    public string Version { get; set; } = string.Empty;
    public string Key { get; set; } = string.Empty;
    public DateTimeOffset AcceptUntilUtc
    {
        get; set;
    }
}

public readonly record struct IssuedAccessToken(string Token, DateTimeOffset ExpiresAtUtc)
{
    public static implicit operator string(IssuedAccessToken issuedToken) => issuedToken.Token;
}

public interface IJwtHelper
{
    IssuedAccessToken GenerateAccessToken(User user, string? sessionId = null, bool mfaVerified = false);
    IssuedAccessToken GenerateAccessToken(User user, string? sessionId, UserSessionAuthenticationContext authenticationContext);
    IssuedAccessToken GenerateAdminAccessToken(AdminPrincipal principal, AdminSession session, IReadOnlyCollection<string> permissions, bool stepUpVerified = false);
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

        // The configured key material is parsed once during singleton construction.
        SymmetricSecurityKey key = JwtSigningKeyRing.CreateKey(_settings.KeyVersion, _settings.SecretKey);
        _credentials = new SigningCredentials(
            key,
            SecurityAlgorithms.HmacSha256Signature);
    }

    public IssuedAccessToken GenerateAccessToken(User user, string? sessionId = null, bool mfaVerified = false)
        => GenerateAccessToken(
            user,
            sessionId,
            UserSessionAuthenticationContext.FromLegacy(mfaVerified, rememberMe: false));

    public IssuedAccessToken GenerateAccessToken(
        User user,
        string? sessionId,
        UserSessionAuthenticationContext authenticationContext)
    {
        if (!AccountRegistrationStates.IsActive(user.RegistrationState))
        {
            throw new InvalidOperationException("Formal access tokens may only be issued for active accounts.");
        }

        string identityKind = string.IsNullOrWhiteSpace(user.IdentityKind)
            ? AnonymousIdentityRuntime.AnonymousAccountKind
            : user.IdentityKind.Trim();
        if (!UserSessionAuthenticationMethods.IsValid(authenticationContext.Method) ||
            !UserSessionAuthenticationStrengths.IsValid(authenticationContext.Strength) ||
            authenticationContext.AuthenticatedAtUtc == default)
        {
            throw new InvalidOperationException("Session authentication context is invalid.");
        }

        var claims = new List<Claim>(9)
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
        claims.Add(new Claim(
            "mfa",
            UserSessionAuthenticationStrengths.IsCoarseMfa(authenticationContext.Strength) ? "1" : "0"));
        claims.Add(new Claim("auth_method", authenticationContext.Method));
        claims.Add(new Claim("auth_strength", authenticationContext.Strength));
        claims.Add(new Claim(
            UserSessionModes.ClaimType,
            UserSessionModes.ToClaimValue(authenticationContext.SessionMode)));
        claims.Add(new Claim(
            "auth_time",
            new DateTimeOffset(DateTime.SpecifyKind(authenticationContext.AuthenticatedAtUtc, DateTimeKind.Utc))
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

        var settings = jwtSection.Get<JwtSettings>();
        if (settings == null ||
            string.IsNullOrEmpty(settings.SecretKey) ||
            string.IsNullOrEmpty(settings.Issuer) ||
            string.IsNullOrEmpty(settings.Audience))
        {
            throw new InvalidOperationException("JWT 配置缺失：请检查 appsettings.json 中的 SecretKey, Issuer, Audience");
        }

        IReadOnlyList<string> keyRingErrors = JwtSigningKeyRing.Validate(
            settings,
            enforceProductionRules: false,
            timeProvider.GetUtcNow());
        if (keyRingErrors.Count > 0)
        {
            throw new InvalidOperationException("JWT key ring configuration is invalid: " + string.Join("; ", keyRingErrors));
        }

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
                IssuerSigningKeyResolver = (_, _, kid, _) =>
                    JwtSigningKeyRing.ResolveValidationKeys(settings, kid, timeProvider.GetUtcNow()),
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
                    context.HttpContext.Features.Set<IAdminAuthenticatedRequestFeature>(null);
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
                        else if (adminResult.RequestLifetime is { } lifetime)
                        {
                            lifetime.BindRequest(context.HttpContext.RequestAborted);
                            context.HttpContext.Response.RegisterForDispose(lifetime);
                            if (!lifetime.IsCurrent)
                            {
                                lifetime.Dispose();
                                context.Fail("admin_request_lifetime_invalid");
                                return;
                            }
                            context.HttpContext.Features.Set<IAdminAuthenticatedRequestFeature>(
                                new AdminAuthenticatedRequestFeature(lifetime));
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

internal static class JwtSigningKeyRing
{
    private const int MinimumKeyBytes = 32;
    private const int MaximumRotationWindowDays = 90;
    private static readonly char[] s_versionSeparators = ['.', '_', '-'];

    internal static SymmetricSecurityKey CreateKey(string version, string secret)
        => new(Encoding.UTF8.GetBytes(secret))
        {
            KeyId = version
        };

    internal static IReadOnlyList<SecurityKey> ResolveValidationKeys(
        JwtSettings settings,
        string? keyId,
        DateTimeOffset now)
    {
        if (!string.IsNullOrWhiteSpace(keyId))
        {
            if (string.Equals(keyId, settings.KeyVersion, StringComparison.Ordinal))
            {
                return [CreateKey(settings.KeyVersion, settings.SecretKey)];
            }

            JwtPreviousKeySettings? previous = settings.PreviousKeys.FirstOrDefault(candidate =>
                string.Equals(candidate.Version, keyId, StringComparison.Ordinal) &&
                candidate.AcceptUntilUtc > now);
            return previous is null ? [] : [CreateKey(previous.Version, previous.Key)];
        }

        if (settings.LegacyNoKidAcceptUntilUtc is not { } legacyDeadline || legacyDeadline <= now)
        {
            return [];
        }

        List<SecurityKey> legacyKeys = [CreateKey(settings.KeyVersion, settings.SecretKey)];
        legacyKeys.AddRange(settings.PreviousKeys
            .Where(previous => previous.AcceptUntilUtc > now)
            .Select(previous => (SecurityKey)CreateKey(previous.Version, previous.Key)));
        return legacyKeys;
    }

    internal static IReadOnlyList<string> Validate(
        JwtSettings settings,
        bool enforceProductionRules,
        DateTimeOffset now)
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
        if (settings.RotationWindowDays is < 1 or > MaximumRotationWindowDays)
        {
            errors.Add($"Jwt:RotationWindowDays must be between 1 and {MaximumRotationWindowDays}.");
        }

        DateTimeOffset maximumDeadline = now.AddDays(Math.Clamp(settings.RotationWindowDays, 1, MaximumRotationWindowDays));
        HashSet<string> versions = new(StringComparer.Ordinal) { settings.KeyVersion };
        HashSet<string> secrets = new(StringComparer.Ordinal) { settings.SecretKey };
        for (int index = 0; index < settings.PreviousKeys.Count; index++)
        {
            JwtPreviousKeySettings previous = settings.PreviousKeys[index];
            string prefix = $"Jwt:PreviousKeys:{index}";
            if (!IsValidVersion(previous.Version))
            {
                errors.Add($"{prefix}:Version must contain 3-64 safe version characters.");
            }
            else if (!versions.Add(previous.Version))
            {
                errors.Add($"{prefix}:Version must be unique and differ from Jwt:KeyVersion.");
            }

            ValidateKeyMaterial($"{prefix}:Key", previous.Key, errors);
            if (!string.IsNullOrEmpty(previous.Key) && !secrets.Add(previous.Key))
            {
                errors.Add($"{prefix}:Key must be independent from every other JWT signing key.");
            }

            if (previous.AcceptUntilUtc <= now)
            {
                errors.Add($"{prefix}:AcceptUntilUtc must be in the future while the key is configured.");
            }
            else if (previous.AcceptUntilUtc > maximumDeadline)
            {
                errors.Add($"{prefix}:AcceptUntilUtc must not exceed Jwt:RotationWindowDays.");
            }
        }

        if (settings.LegacyNoKidAcceptUntilUtc is { } legacyDeadline)
        {
            if (legacyDeadline <= now)
            {
                errors.Add("Jwt:LegacyNoKidAcceptUntilUtc must be removed after it expires.");
            }
            else if (legacyDeadline > maximumDeadline)
            {
                errors.Add("Jwt:LegacyNoKidAcceptUntilUtc must not exceed Jwt:RotationWindowDays.");
            }
        }

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
