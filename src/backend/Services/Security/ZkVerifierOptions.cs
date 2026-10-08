using System.Text.Json;

using FsusBlog.Server.Infrastructure.Helpers;

namespace FsusBlog.Server.Services.Security;

// This owner is independent of the comment product policy and has no administrative mutation port.
public sealed record ZkVerifierOptions
{
    public const string SectionName = "AnonymousIdentity:ZkVerifier";
    public const string NativeGroth16Backend = "native_groth16";
    public bool Enabled { get; init; }
    public string CircuitId { get; init; } = string.Empty;
    public string VerifyingKeyHash { get; init; } = string.Empty;
    public string Backend { get; init; } = string.Empty;
    public string? TrustedSetupManifestPath { get; init; }
    public string? VerifyingKeyManifestPath { get; init; }
    public int PublicInputLayoutVersion { get; init; }
    public int MaxProofBytes { get; init; } = 16 * 1024;
    public int BackendTimeoutMs { get; init; } = 2000;
    public int MaxConcurrentVerifications { get; init; } = Math.Max(1, Environment.ProcessorCount / 2);

    public static ZkVerifierOptions FromConfiguration(IConfiguration configuration)
    {
        IConfigurationSection section = configuration.GetSection(SectionName);
        ZkConfigurationAdmission.RequireKnownKeys(section,
            nameof(Enabled), nameof(CircuitId), nameof(VerifyingKeyHash), nameof(Backend),
            nameof(TrustedSetupManifestPath), nameof(VerifyingKeyManifestPath), nameof(PublicInputLayoutVersion),
            nameof(MaxProofBytes), nameof(BackendTimeoutMs), nameof(MaxConcurrentVerifications), "NativeGroth16", "LocalDevFixture");
        ZkConfigurationAdmission.RequireKnownKeys(section.GetSection("NativeGroth16"), "LibraryPath", "VerifyingKeyPath", "EntryPoint");
        ZkConfigurationAdmission.RequireKnownKeys(section.GetSection("LocalDevFixture"), "Enabled");
        return new ZkVerifierOptions
        {
            Enabled = section.GetValue(nameof(Enabled), false),
            CircuitId = section[nameof(CircuitId)]?.Trim() ?? string.Empty,
            VerifyingKeyHash = section[nameof(VerifyingKeyHash)]?.Trim() ?? string.Empty,
            Backend = section[nameof(Backend)]?.Trim() ?? string.Empty,
            TrustedSetupManifestPath = section[nameof(TrustedSetupManifestPath)],
            VerifyingKeyManifestPath = section[nameof(VerifyingKeyManifestPath)],
            PublicInputLayoutVersion = section.GetValue(nameof(PublicInputLayoutVersion), 0),
            MaxProofBytes = section.GetValue(nameof(MaxProofBytes), 16 * 1024),
            BackendTimeoutMs = section.GetValue(nameof(BackendTimeoutMs), 2000),
            MaxConcurrentVerifications = section.GetValue(nameof(MaxConcurrentVerifications), Math.Max(1, Environment.ProcessorCount / 2))
        };
    }
}

public readonly record struct ZkVerifierReadinessSnapshot(
    bool NativeBackendConfigured, bool NativeVerifierConfigured, bool TrustedSetupVerified);

public interface IZkVerifierReadiness
{
    ZkVerifierReadinessSnapshot Current { get; }
}

// Manifest admission runs once when this immutable verifier capability is constructed.
// A changed verifier configuration requires reconstruction of the verifier and its readiness together.
public sealed class ZkVerifierReadiness : IZkVerifierReadiness
{
    public ZkVerifierReadiness(ZkVerifierOptions options, IZkProofVerifier verifier)
    {
        bool nativeBackend = string.Equals(options.Backend, ZkVerifierOptions.NativeGroth16Backend, StringComparison.Ordinal);
        bool trustedSetup = TextHelpers.IsSha256Hex(options.VerifyingKeyHash) &&
            ManifestAllowsProduction(options.TrustedSetupManifestPath, options.VerifyingKeyHash) &&
            ManifestAllowsProduction(options.VerifyingKeyManifestPath, options.VerifyingKeyHash);
        Current = new ZkVerifierReadinessSnapshot(nativeBackend, options.Enabled && nativeBackend && verifier.IsConfigured, trustedSetup);
    }

    public ZkVerifierReadinessSnapshot Current { get; }

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
            return root.ValueKind == JsonValueKind.Object &&
                TryGetBoolean(root, "production_usable", out bool productionUsable) &&
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

}
