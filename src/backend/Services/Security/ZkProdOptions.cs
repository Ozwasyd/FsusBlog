using System.Text.Json;
using Microsoft.Extensions.Configuration;

namespace FsusBlog.Server.Services.Security;

public sealed class ZkProdOptions
{
    public const string SectionName = "AnonymousIdentity:ZkProd";
    public const string NativeGroth16Backend = "native_groth16";

    public bool Enabled { get; init; }
    public bool RequireNativeVerifier { get; init; } = true;
    public bool RequireCredential { get; init; } = true;
    public bool RequireTrustedSetupVerified { get; init; } = true;
    public bool AllowDevVerifier { get; init; }
    public bool FallbackToLegacyAnonymous { get; init; }
    public string VerifierBackend { get; init; } = NativeGroth16Backend;
    public string? VerifyingKeyHash { get; init; }
    public string? TrustedSetupManifestPath { get; init; }
    public string? VerifyingKeyManifestPath { get; init; }
    public bool TrustedSetupVerified { get; init; }
    public bool CredentialReady { get; init; }

    public static ZkProdOptions FromConfiguration(IConfiguration configuration)
    {
        IConfigurationSection section = configuration.GetSection(SectionName);
        return new ZkProdOptions
        {
            Enabled = section.GetValue(nameof(Enabled), false),
            RequireNativeVerifier = section.GetValue(nameof(RequireNativeVerifier), true),
            RequireCredential = section.GetValue(nameof(RequireCredential), true),
            RequireTrustedSetupVerified = section.GetValue(nameof(RequireTrustedSetupVerified), true),
            AllowDevVerifier = section.GetValue(nameof(AllowDevVerifier), false),
            FallbackToLegacyAnonymous = section.GetValue(nameof(FallbackToLegacyAnonymous), false),
            VerifierBackend = Normalize(section[nameof(VerifierBackend)], NativeGroth16Backend, 64),
            VerifyingKeyHash = NormalizeNullable(section[nameof(VerifyingKeyHash)], 128),
            TrustedSetupManifestPath = NormalizeNullable(section[nameof(TrustedSetupManifestPath)], 512),
            VerifyingKeyManifestPath = NormalizeNullable(section[nameof(VerifyingKeyManifestPath)], 512),
            TrustedSetupVerified = section.GetValue(nameof(TrustedSetupVerified), false),
            CredentialReady = section.GetValue(nameof(CredentialReady), false)
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
    bool CredentialRootReady,
    bool CredentialIssuerConfigured = false)
{
    public static ZkProdRuntimeReadiness Missing { get; } = new(false, false, false);
}

public sealed record ZkProdPolicySnapshot(
    bool Enabled,
    bool NativeVerifierConfigured,
    bool TrustedSetupVerified,
    bool CredentialRequired,
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
            options.RequireCredential,
            readiness.CredentialRootReady,
            unavailableReason);
    }

    public static bool IsTrustedSetupVerified(ZkProdOptions options, IConfiguration configuration)
    {
        string verifyingKeyHash = ZkProdOptions.ResolveVerifyingKeyHash(configuration, options);
        return options.TrustedSetupVerified &&
            IsHexHash(verifyingKeyHash) &&
            ProductionManifestsAllowUse(options, verifyingKeyHash);
    }

    private static bool ProductionManifestsAllowUse(ZkProdOptions options, string verifyingKeyHash)
    {
        if (string.IsNullOrWhiteSpace(options.TrustedSetupManifestPath) &&
            string.IsNullOrWhiteSpace(options.VerifyingKeyManifestPath))
        {
            return true;
        }

        return ManifestAllowsProduction(options.TrustedSetupManifestPath, verifyingKeyHash) &&
            ManifestAllowsProduction(options.VerifyingKeyManifestPath, verifyingKeyHash);
    }

    private static bool ManifestAllowsProduction(string? path, string verifyingKeyHash)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return false;
        }

        try
        {
            string resolvedPath = ResolveManifestPath(path);
            if (!File.Exists(resolvedPath))
            {
                return false;
            }

            using FileStream stream = File.OpenRead(resolvedPath);
            using JsonDocument document = JsonDocument.Parse(stream);
            JsonElement root = document.RootElement;
            return TryGetBoolean(root, "production_usable", out bool productionUsable) &&
                productionUsable &&
                TryGetString(root, "verifying_key_hash", out string? manifestHash) &&
                string.Equals(manifestHash, verifyingKeyHash, StringComparison.OrdinalIgnoreCase);
        }
        catch (JsonException)
        {
            return false;
        }
        catch (IOException)
        {
            return false;
        }
        catch (UnauthorizedAccessException)
        {
            return false;
        }
    }

    private static string ResolveManifestPath(string path)
    {
        if (Path.IsPathRooted(path))
        {
            return Path.GetFullPath(path);
        }

        string currentDirectoryPath = Path.GetFullPath(path, Directory.GetCurrentDirectory());
        if (File.Exists(currentDirectoryPath))
        {
            return currentDirectoryPath;
        }

        return Path.GetFullPath(path, AppContext.BaseDirectory);
    }

    private static bool TryGetBoolean(JsonElement root, string propertyName, out bool value)
    {
        value = false;
        if (!root.TryGetProperty(propertyName, out JsonElement property) ||
            (property.ValueKind != JsonValueKind.True && property.ValueKind != JsonValueKind.False))
        {
            return false;
        }

        value = property.GetBoolean();
        return true;
    }

    private static bool TryGetString(JsonElement root, string propertyName, out string? value)
    {
        value = null;
        if (!root.TryGetProperty(propertyName, out JsonElement property) ||
            property.ValueKind != JsonValueKind.String)
        {
            return false;
        }

        value = property.GetString();
        return !string.IsNullOrWhiteSpace(value);
    }

    private static bool IsHexHash(string value)
    {
        string normalized = ZkProdOptions.Normalize(value, fallback: string.Empty, maxLength: 65);
        if (normalized.Length != 64)
        {
            return false;
        }

        for (int i = 0; i < normalized.Length; i++)
        {
            if (!Uri.IsHexDigit(normalized[i]))
            {
                return false;
            }
        }

        return true;
    }

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

        if (options.RequireCredential && !options.CredentialReady)
        {
            return "credential_unready";
        }

        if (options.RequireCredential && !readiness.CredentialIssuerConfigured)
        {
            return "credential_issuer_unavailable";
        }

        if (!readiness.CredentialRootReady)
        {
            return "credential_root_unavailable";
        }

        return string.Empty;
    }
}
