using Microsoft.Extensions.Primitives;

namespace FsusBlog.Server.Services.Security;

public sealed record ZkCommentPolicyOptions
{
    public const string SectionName = "AnonymousIdentity:ZkCommentPolicy";

    public bool Enabled { get; init; }
    public bool RequireCredential { get; init; } = true;
    public bool RequireTrustedSetupVerified { get; init; } = true;

    public static ZkCommentPolicyOptions FromConfiguration(IConfiguration configuration)
    {
        // Retired sections and unknown keys are rejected even when the feature is disabled.
        IConfigurationSection? retiredSection = configuration.GetSection("AnonymousIdentity").GetChildren().FirstOrDefault(static child =>
            string.Equals(child.Key, "ZkProd", StringComparison.OrdinalIgnoreCase));
        if (retiredSection is not null)
        {
            string forbiddenPath = retiredSection.GetChildren().FirstOrDefault()?.Path ?? retiredSection.Path;
            throw new InvalidOperationException($"{forbiddenPath} belongs to a retired configuration section.");
        }

        IConfigurationSection section = configuration.GetSection(SectionName);
        ZkConfigurationAdmission.RequireKnownKeys(section,
            nameof(Enabled), nameof(RequireCredential), nameof(RequireTrustedSetupVerified));
        return new ZkCommentPolicyOptions
        {
            Enabled = section.GetValue(nameof(Enabled), false),
            RequireCredential = section.GetValue(nameof(RequireCredential), true),
            RequireTrustedSetupVerified = section.GetValue(nameof(RequireTrustedSetupVerified), true)
        };
    }
}

public readonly record struct ZkCommentRuntimeReadiness(
    bool NativeVerifierConfigured,
    bool CredentialRootReady,
    bool CredentialIssuerConfigured = false,
    bool TrustedSetupVerified = false,
    bool NativeBackendConfigured = false)
{
    public static ZkCommentRuntimeReadiness Missing { get; } = new(false, false);
}

public sealed record ZkCommentPolicySnapshot(
    bool Enabled,
    bool NativeVerifierConfigured,
    bool TrustedSetupVerified,
    bool CredentialRequired,
    bool CredentialRootReady,
    string UnavailableReason);

public static class ZkCommentPolicySnapshotFactory
{
    public static ZkCommentPolicySnapshot Create(
        ZkCommentPolicyOptions options,
        ZkCommentRuntimeReadiness readiness)
        => new(options.Enabled, readiness.NativeVerifierConfigured, readiness.TrustedSetupVerified,
            options.RequireCredential, readiness.CredentialRootReady, ResolveUnavailableReason(options, readiness));

    private static string ResolveUnavailableReason(ZkCommentPolicyOptions options, ZkCommentRuntimeReadiness readiness)
    {
        if (!options.Enabled) return "disabled";
        if (!readiness.NativeBackendConfigured) return "native_backend_required";
        if (!readiness.NativeVerifierConfigured) return "native_verifier_unavailable";
        if (options.RequireTrustedSetupVerified && !readiness.TrustedSetupVerified) return "trusted_setup_unverified";
        if (options.RequireCredential && !readiness.CredentialIssuerConfigured) return "credential_issuer_unavailable";
        if (!readiness.CredentialRootReady) return "credential_root_unavailable";
        return string.Empty;
    }
}

internal static class ZkConfigurationAdmission
{
    public static void RequireKnownKeys(IConfigurationSection section, params string[] keys)
    {
        foreach (IConfigurationSection child in section.GetChildren())
        {
            if (!keys.Contains(child.Key, StringComparer.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException($"{child.Path} is an unknown or forbidden ZK configuration key.");
            }
        }
    }
}

public interface IZkCommentPolicyAuthority
{
    ZkCommentPolicyOptions Current { get; }
}

// Only product policy can reload. Verifier identity and its cryptographic artifacts are startup capabilities.
public sealed class ZkCommentPolicyAuthority : IZkCommentPolicyAuthority, IDisposable
{
    private ZkCommentPolicyOptions _current;
    private readonly IDisposable _reloadSubscription;

    public ZkCommentPolicyAuthority(IConfiguration configuration)
    {
        _current = ZkCommentPolicyOptions.FromConfiguration(configuration);
        _reloadSubscription = ChangeToken.OnChange(configuration.GetReloadToken, () =>
        {
            ZkCommentPolicyOptions next;
            try { next = ZkCommentPolicyOptions.FromConfiguration(configuration); }
            catch (InvalidOperationException) { next = new ZkCommentPolicyOptions(); }
            Volatile.Write(ref _current, next);
        });
    }

    public ZkCommentPolicyOptions Current => Volatile.Read(ref _current);
    public void Dispose() => _reloadSubscription.Dispose();
}
