using Microsoft.Extensions.Configuration;

namespace FsusBlog.Server.Services.Security;

public sealed class ZkProdOptions
{
    public const string SectionName = "AnonymousIdentity:ZkProd";
    public const string NativeGroth16Backend = "native_groth16";

    public bool Enabled { get; init; }
    public bool RequireNativeVerifier { get; init; } = true;
    public bool RequireBbsCredential { get; init; } = true;
    public bool RequireTrustedSetupVerified { get; init; } = true;
    public bool AllowDevVerifier { get; init; }
    public bool FallbackToLegacyAnonymous { get; init; }
    public string VerifierBackend { get; init; } = NativeGroth16Backend;
    public string? VerifyingKeyHash { get; init; }
    public bool TrustedSetupVerified { get; init; }
    public bool BbsCredentialReady { get; init; }

    public static ZkProdOptions FromConfiguration(IConfiguration configuration)
    {
        IConfigurationSection section = configuration.GetSection(SectionName);
        return new ZkProdOptions
        {
            Enabled = section.GetValue(nameof(Enabled), false),
            RequireNativeVerifier = section.GetValue(nameof(RequireNativeVerifier), true),
            RequireBbsCredential = section.GetValue(nameof(RequireBbsCredential), true),
            RequireTrustedSetupVerified = section.GetValue(nameof(RequireTrustedSetupVerified), true),
            AllowDevVerifier = section.GetValue(nameof(AllowDevVerifier), false),
            FallbackToLegacyAnonymous = section.GetValue(nameof(FallbackToLegacyAnonymous), false),
            VerifierBackend = Normalize(section[nameof(VerifierBackend)], NativeGroth16Backend, 64),
            VerifyingKeyHash = NormalizeNullable(section[nameof(VerifyingKeyHash)], 128),
            TrustedSetupVerified = section.GetValue(nameof(TrustedSetupVerified), false),
            BbsCredentialReady = section.GetValue(nameof(BbsCredentialReady), false)
        };
    }

    public static string ResolveVerifyingKeyHash(IConfiguration configuration, ZkProdOptions options)
        => Normalize(
            options.VerifyingKeyHash ?? configuration["AnonymousIdentity:ZkVerifier:VerifyingKeyHash"],
            fallback: string.Empty,
            maxLength: 128);

    public static bool IsNativeVerifierBackend(string? backend)
        => string.Equals(
            Normalize(backend, fallback: string.Empty, maxLength: 64),
            NativeGroth16Backend,
            StringComparison.Ordinal);

    internal static string Normalize(string? value, string fallback, int maxLength)
    {
        string normalized = string.IsNullOrWhiteSpace(value) ? fallback : value.Trim();
        return normalized.Length <= maxLength ? normalized : normalized[..maxLength];
    }

    private static string? NormalizeNullable(string? value, int maxLength)
    {
        string normalized = Normalize(value, fallback: string.Empty, maxLength);
        return normalized.Length == 0 ? null : normalized;
    }
}

public readonly record struct ZkProdRuntimeReadiness(
    bool NativeVerifierConfigured,
    bool CredentialRootReady)
{
    public static ZkProdRuntimeReadiness Missing { get; } = new(false, false);
}

public sealed record ZkProdPolicySnapshot(
    bool Enabled,
    bool NativeVerifierConfigured,
    bool TrustedSetupVerified,
    bool BbsCredentialRequired,
    bool CredentialRootReady,
    string UnavailableReason);

public static class ZkProdPolicySnapshotFactory
{
    public static ZkProdPolicySnapshot Create(
        ZkProdOptions options,
        ZkProdRuntimeReadiness readiness,
        IConfiguration configuration)
    {
        bool trustedSetupVerified = IsTrustedSetupVerified(options, configuration);
        string unavailableReason = ResolveUnavailableReason(options, readiness, trustedSetupVerified);
        return new ZkProdPolicySnapshot(
            options.Enabled,
            readiness.NativeVerifierConfigured,
            trustedSetupVerified,
            options.RequireBbsCredential,
            readiness.CredentialRootReady,
            unavailableReason);
    }

    public static bool IsTrustedSetupVerified(ZkProdOptions options, IConfiguration configuration)
        => options.TrustedSetupVerified &&
            ZkProdOptions.ResolveVerifyingKeyHash(configuration, options).Length > 0;

    private static string ResolveUnavailableReason(
        ZkProdOptions options,
        ZkProdRuntimeReadiness readiness,
        bool trustedSetupVerified)
    {
        if (!options.Enabled)
        {
            return "disabled";
        }

        if (options.AllowDevVerifier)
        {
            return "dev_verifier_disallowed";
        }

        if (options.FallbackToLegacyAnonymous)
        {
            return "legacy_fallback_disallowed";
        }

        if (options.RequireNativeVerifier && !ZkProdOptions.IsNativeVerifierBackend(options.VerifierBackend))
        {
            return "native_backend_required";
        }

        if (options.RequireNativeVerifier && !readiness.NativeVerifierConfigured)
        {
            return "native_verifier_unavailable";
        }

        if (options.RequireTrustedSetupVerified && !trustedSetupVerified)
        {
            return "trusted_setup_unverified";
        }

        if (options.RequireBbsCredential && !options.BbsCredentialReady)
        {
            return "bbs_credential_unready";
        }

        if (!readiness.CredentialRootReady)
        {
            return "credential_root_unavailable";
        }

        return string.Empty;
    }
}
