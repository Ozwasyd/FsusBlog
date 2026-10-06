using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Services.Security;

using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace FsusBlog.Server.Services.Fixtures;

public sealed record AuthFixturePrivateIdentity(string RunId, string Namespace, string ProfileId,
    string SourceCommit, string SourceFingerprint, string ServiceGeneration, string CatalogDigest,
    string VariantPlanDigest, string PlanDigest);

public sealed record AuthFixturePrivateCarrier(AuthFixturePrivateIdentity Identity,
    string Opaque, AuthFixtureEntityObservation PublicFact);

public sealed record AuthFixturePrivateVerificationRequest(AuthFixturePrivateIdentity Identity,
    string Opaque, AuthFixtureEntityObservation PublicFact, bool Reveal = false, string? FixtureReceiptDigest = null);

public sealed record AuthFixturePrivateVerificationResult(bool Ok, AuthFixturePrivateIdentity Identity,
    string CarrierDigest, AuthFixtureEntityObservation PublicFact, AdminSessionTokens? Credentials = null);

internal sealed record AuthFixturePrivatePayload(AuthFixturePrivateIdentity Identity,
    AuthFixtureEntityObservation PublicFact, AdminSessionTokens Credentials, DateTimeOffset NotAfter);

internal sealed class AuthFixturePrivatePrepareFailure(IReadOnlyList<AuthFixturePrivateCarrier> recovery, Exception cause)
    : InvalidOperationException("auth fixture failed; private exact recovery required", cause)
{
    internal IReadOnlyList<AuthFixturePrivateCarrier> RecoveryCarriers() => recovery;
}

public sealed partial class AuthFixtureSeeder
{
    internal const string PrivatePurpose = "FsusBlog.Test.AuthFixture.AdminPrivateProjection.v1";
    private static readonly JsonSerializerOptions s_privateJson = new(JsonSerializerDefaults.Web);
    private readonly List<AuthFixturePrivateCarrier> _privateCarriers = [];

    private T PrivateService<T>() where T : notnull
        => (privateServices ?? throw new InvalidOperationException("auth private application ports missing"))
            .GetRequiredService<T>();

    private void ValidatePrivateIdentity(AuthFixturePrivateIdentity identity)
    {
        if (!environment.IsDevelopment())
        {
            throw new InvalidOperationException("auth private projection requires Development");
        }
        string? fingerprint = Environment.GetEnvironmentVariable("FSUSBLOG_TEST_SOURCE_FINGERPRINT");
        fingerprint = fingerprint is null || fingerprint.StartsWith("sha256:", StringComparison.Ordinal)
            ? fingerprint : "sha256:" + fingerprint;
        string? generation = Environment.GetEnvironmentVariable("FSUSBLOG_FIXTURE_SERVICE_GENERATION");
        generation = generation is null || generation.StartsWith("sha256:", StringComparison.Ordinal)
            ? generation : "sha256:" + generation;
        if (new[] { identity.RunId, identity.Namespace, identity.ProfileId, identity.SourceCommit,
                identity.SourceFingerprint, identity.ServiceGeneration, identity.CatalogDigest,
                identity.VariantPlanDigest, identity.PlanDigest }.Any(string.IsNullOrWhiteSpace)
            || identity.SourceCommit != Environment.GetEnvironmentVariable("FSUSBLOG_TEST_SOURCE_COMMIT")
            || identity.SourceFingerprint != fingerprint
            || identity.ServiceGeneration != generation
            || identity.RunId != Environment.GetEnvironmentVariable("FSUSBLOG_TEST_RUN_ID")
            || identity.Namespace != Environment.GetEnvironmentVariable("FSUSBLOG_TEST_NAMESPACE"))
        {
            throw new InvalidOperationException("auth private source identity mismatch");
        }
    }

    private void ValidatePrivatePlan(AuthFixturePlan plan)
    {
        if (plan.PrivateProjectionIdentity is not { } identity)
        {
            if (environment.IsDevelopment() && plan.Roles.Any(role => role.Kind == "admin" && role.ExpectedState == "active"))
            {
                throw new InvalidOperationException("auth private plan binding required before issuance");
            }
            return;
        }
        ValidatePrivateIdentity(identity);
        if (identity.RunId != plan.RunId || identity.Namespace != plan.Namespace || identity.ProfileId != plan.ProfileId
            || identity.CatalogDigest != plan.CatalogDigest || identity.VariantPlanDigest != plan.FixtureVariantPlanDigest
            || identity.PlanDigest != plan.PlanDigest || plan.Roles.Any(role => role.Kind == "admin"
                && role.FixtureIdentity != OwnedAdminHandle(plan.Namespace, plan.RunId, role.SemanticRole)))
        {
            throw new InvalidOperationException("auth private owned plan mismatch");
        }
        _ = PrivateService<IDataProtectionProvider>();
        _ = PrivateService<IAdminSessionIssuancePort>();
    }

    internal static string OwnedAdminHandle(string ns, string runId, string role)
        => "fxauth-" + Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(
            string.Join('\0', "fsusblog-auth-fixture-v1", ns, runId, role))))[..24];

    private async Task<AuthFixtureEntityObservation> PreparePrivateAdminAsync(
        AuthFixturePlan plan, AuthFixtureRolePlan role, CancellationToken cancellationToken)
    {
        AuthFixtureEntityObservation original = await PrepareAdminAsync(role, cancellationToken);
        if (plan.PrivateProjectionIdentity is not { } identity || role.ExpectedState != "active")
        {
            return original;
        }
        // Authenticate the complete ownership binding before entering the sole production writer.
        IDataProtector protector = PrivateService<IDataProtectionProvider>().CreateProtector(PrivatePurpose);
        string boundPlan = protector.Protect(JsonSerializer.Serialize(new
        {
            identity,
            original
        }, s_privateJson));
        _ = protector.Unprotect(boundPlan);
        AdminSessionTokens credentials;
        try
        {
            credentials = await PrivateService<IAdminSessionIssuancePort>().IssueAsync(
                long.Parse(original.Id, System.Globalization.CultureInfo.InvariantCulture), role.FixtureIdentity,
                new AdminAuthClientContext("127.0.0.1", null, "FsusBlog typed fixture"), cancellationToken)
                ?? throw new InvalidOperationException("owned admin issuance failed");
        }
        catch (AdminSessionIssuanceRecoveryException failure)
        {
            credentials = failure.RecoveryCredentials();
            string recovery = protector.Protect(JsonSerializer.Serialize(
                new AuthFixturePrivatePayload(identity, original, credentials, credentials.AccessTokenExpiresAtUtc), s_privateJson));
            _privateCarriers.Add(new(identity, recovery, original));
            throw new AuthFixturePrivatePrepareFailure([.. _privateCarriers], failure);
        }
        try
        {
            AdminSessionProjectionSessionUpdate authority = await PrivateService<IAdminSessionProjectionAuthorityReader>()
                .ReadSessionAsync(credentials.SessionId, cancellationToken)
                ?? throw new InvalidOperationException("owned admin session authority missing");
            var fields = new Dictionary<string, object?>(original.Fields)
            {
                ["adminSessionId"] = credentials.SessionId,
                ["adminFixturePlanDigest"] = plan.PlanDigest,
                ["adminSessionVersion"] = authority.Version,
                ["adminPrincipalVersion"] = authority.Principal.Version,
                ["adminSessionIdleExpiresAtUtc"] = authority.IdleExpiresAtUtc,
                ["adminSessionAbsoluteExpiresAtUtc"] = authority.AbsoluteExpiresAtUtc,
                ["adminAccessExpiresAtUtc"] = credentials.AccessTokenExpiresAtUtc
            };
            AuthFixtureEntityObservation fact = original with
            {
                Fields = fields
            };
            DateTimeOffset expiry = new[] { credentials.AccessTokenExpiresAtUtc,
                authority.IdleExpiresAtUtc, authority.AbsoluteExpiresAtUtc }.Min();
            string opaque = protector.Protect(JsonSerializer.Serialize(
                new AuthFixturePrivatePayload(identity, fact, credentials, expiry), s_privateJson));
            _privateCarriers.Add(new(identity, opaque, fact));
            return fact;
        }
        catch (Exception primary)
        {
            try
            {
                if (await PrivateService<IAdminPrincipalService>().RevokeAdminSessionAsync(
                    long.Parse(original.Id, System.Globalization.CultureInfo.InvariantCulture), credentials.SessionId,
                    "fixture-prepare-failed", CancellationToken.None) == AdminSessionRevokeResult.Conflict)
                {
                    throw new InvalidOperationException("auth private exact prepare recovery conflict");
                }
            }
            catch (Exception cleanup)
            {
                string recovery = protector.Protect(JsonSerializer.Serialize(
                    new AuthFixturePrivatePayload(identity, original, credentials, credentials.AccessTokenExpiresAtUtc), s_privateJson));
                _privateCarriers.Add(new(identity, recovery, original));
                throw new AuthFixturePrivatePrepareFailure([.. _privateCarriers], new AggregateException(primary, cleanup));
            }
            throw;
        }
    }

    internal static AuthFixturePrivatePayload OpenPrivateCarrier(IDataProtectionProvider provider,
        AuthFixturePrivateVerificationRequest request, DateTimeOffset now)
    {
        if (string.IsNullOrEmpty(request.Opaque) || request.Opaque.Length > 65536)
        {
            throw new InvalidOperationException("auth private carrier bounds invalid");
        }
        AuthFixturePrivatePayload value;
        try
        {
            value = JsonSerializer.Deserialize<AuthFixturePrivatePayload>(
                provider.CreateProtector(PrivatePurpose).Unprotect(request.Opaque), s_privateJson)
                ?? throw new InvalidOperationException("auth private carrier missing");
        }
        catch (CryptographicException)
        {
            throw new InvalidOperationException("auth private carrier invalid");
        }
        if (value.Identity != request.Identity || value.NotAfter <= now
            || !EquivalentPrivateFact(value.PublicFact, request.PublicFact))
        {
            throw new InvalidOperationException("auth private carrier identity/fact/expiry mismatch");
        }
        return value;
    }

    public async Task<AuthFixturePrivateVerificationResult> VerifyPrivateAsync(
        AuthFixturePrivateVerificationRequest request, CancellationToken cancellationToken = default)
    {
        ValidatePrivateIdentity(request.Identity);
        AuthFixturePrivatePayload payload = OpenPrivateCarrier(PrivateService<IDataProtectionProvider>(), request, timeProvider.GetUtcNow());
        if (request.Reveal && string.IsNullOrWhiteSpace(request.FixtureReceiptDigest))
        {
            throw new InvalidOperationException("verified fixture receipt binding required for private projection");
        }
        AuthFixtureEntityObservation fact = payload.PublicFact;
        if (!await VerifyAdminAsync(new(fact.Kind, fact.Id, fact.SemanticRole, fact.FixtureIdentity, fact.CapabilityHint)))
        {
            throw new InvalidOperationException("auth private principal permissions/ownership drift");
        }
        long principalId = long.Parse(fact.Id, System.Globalization.CultureInfo.InvariantCulture);
        IAdminSessionProjectionAuthorityReader reader = PrivateService<IAdminSessionProjectionAuthorityReader>();
        AdminSessionProjectionSessionUpdate session = await reader.ReadSessionAsync(payload.Credentials.SessionId, cancellationToken)
            ?? throw new InvalidOperationException("auth private session authority missing/expired");
        AdminSessionProjectionPrincipalUpdate principal = await reader.ReadPrincipalAsync(principalId, cancellationToken)
            ?? throw new InvalidOperationException("auth private principal authority missing");
        RequirePrivateAuthority(payload, session, principal);
        JwtBearerOptions options = PrivateService<IOptionsMonitor<JwtBearerOptions>>().Get(JwtBearerDefaults.AuthenticationScheme);
        var currentPrincipal = await repository.FindAdminByIdAsync(principalId, cancellationToken)
            ?? throw new InvalidOperationException("auth private principal disappeared");
        AdminPrincipalService.RequireOwnedIssuancePrincipal(currentPrincipal, principalId, fact.FixtureIdentity);
        if (currentPrincipal.ValidationVersion != principal.Version)
        {
            throw new InvalidOperationException("auth private principal changed during verification");
        }
        await RequirePrivateJwtAsync(options, payload, session, Permissions(currentPrincipal.Permissions));
        byte[] hash = SHA256.HashData(Encoding.UTF8.GetBytes(payload.Credentials.AccessToken));
        if (!PrivateService<AdminSessionProjection>().Validate(session.SessionId, principalId, hash).IsValid)
        {
            throw new InvalidOperationException("auth private current projection drift");
        }
        return new(true, request.Identity, Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(request.Opaque))),
            fact, request.Reveal ? payload.Credentials : null);
    }

    internal static async Task RequirePrivateJwtAsync(JwtBearerOptions options, AuthFixturePrivatePayload payload,
        AdminSessionProjectionSessionUpdate session, string[] expectedPermissions)
    {
        // Consume the registered production handlers AND validation parameters, never a fixture validator.
        ClaimsPrincipal? claims = null;
        if (options.UseSecurityTokenValidators)
        {
#pragma warning disable CS0618
            foreach (var handler in options.SecurityTokenValidators)
            {
                if (handler.CanReadToken(payload.Credentials.AccessToken))
                {
                    claims = handler.ValidateToken(payload.Credentials.AccessToken, options.TokenValidationParameters, out _);
                    break;
                }
            }
#pragma warning restore CS0618
        }
        else
        {
            foreach (var handler in options.TokenHandlers)
            {
                var validated = await handler.ValidateTokenAsync(payload.Credentials.AccessToken, options.TokenValidationParameters);
                if (validated.IsValid)
                {
                    claims = new ClaimsPrincipal(validated.ClaimsIdentity);
                    break;
                }
            }
        }
        if (claims is null || claims.FindFirst("admin_id")?.Value != payload.PublicFact.Id
            || claims.FindFirst("admin_sid")?.Value != session.SessionId || claims.FindFirst("admin_step_up")?.Value != "0"
            || !claims.FindAll(AdminPermissions.PermissionClaimType).Select(item => item.Value).Order(StringComparer.Ordinal).SequenceEqual(expectedPermissions))
        {
            throw new InvalidOperationException("auth private production JWT validation/claims mismatch");
        }
    }

    internal static void RequirePrivateAuthority(AuthFixturePrivatePayload payload,
        AdminSessionProjectionSessionUpdate session, AdminSessionProjectionPrincipalUpdate principal)
    {
        var fields = payload.PublicFact.Fields;
        bool Equal(string name, object current) => fields.TryGetValue(name, out object? expected)
            && EquivalentPrivateFact(expected, current);
        if (session.PrincipalId.ToString(System.Globalization.CultureInfo.InvariantCulture) != payload.PublicFact.Id
            || session.SessionId != payload.Credentials.SessionId || principal.PrincipalId != session.PrincipalId
            || principal != session.Principal
            || principal.Status != AdminSessionProjectionPrincipalStatus.Active || session.RevokedAtUtc is not null
            || !CryptographicOperations.FixedTimeEquals(session.AccessTokenHash.Span,
                SHA256.HashData(Encoding.UTF8.GetBytes(payload.Credentials.AccessToken)))
            || !Equal("adminSessionVersion", session.Version) || !Equal("adminPrincipalVersion", principal.Version)
            || !Equal("adminSessionIdleExpiresAtUtc", session.IdleExpiresAtUtc)
            || !Equal("adminSessionAbsoluteExpiresAtUtc", session.AbsoluteExpiresAtUtc))
        {
            throw new InvalidOperationException("auth private durable authority drift");
        }
    }

    internal static bool EquivalentPrivateFact(object? left, object? right)
        => JsonNode.DeepEquals(JsonNode.Parse(JsonSerializer.Serialize(left, s_privateJson)),
            JsonNode.Parse(JsonSerializer.Serialize(right, s_privateJson)));

    public async Task CleanupPrivateAsync(AuthFixturePrivateVerificationRequest request, CancellationToken cancellationToken = default)
    {
        ValidatePrivateIdentity(request.Identity);
        // Expiry prevents admission, not exact owned cleanup of the authenticated reference.
        AuthFixturePrivatePayload payload = OpenPrivateCarrier(PrivateService<IDataProtectionProvider>(), request, DateTimeOffset.MinValue);
        var owned = await repository.FindAdminByIdAsync(long.Parse(payload.PublicFact.Id, System.Globalization.CultureInfo.InvariantCulture), cancellationToken);
        if (owned is not null && (owned.IsRoot || owned.Handle != payload.PublicFact.FixtureIdentity))
        {
            throw new InvalidOperationException("auth private cleanup owned identity mismatch");
        }
        await PrivateService<IAdminSessionIssuancePort>().CleanupAsync(
            long.Parse(payload.PublicFact.Id, System.Globalization.CultureInfo.InvariantCulture), payload.Credentials.SessionId,
            cancellationToken);
        byte[] hash = SHA256.HashData(Encoding.UTF8.GetBytes(payload.Credentials.AccessToken));
        if (PrivateService<AdminSessionProjection>().Validate(payload.Credentials.SessionId,
            long.Parse(payload.PublicFact.Id, System.Globalization.CultureInfo.InvariantCulture), hash).IsValid)
        {
            throw new InvalidOperationException("auth private cleanup projection still admits session");
        }
    }
}
