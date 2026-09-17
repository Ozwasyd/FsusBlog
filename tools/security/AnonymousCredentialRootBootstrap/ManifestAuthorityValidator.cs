using System.Text.Json;
using System.Text.RegularExpressions;

namespace FsusBlog.Tools.Security.AnonymousCredentialRootBootstrap;

internal static partial class ManifestAuthorityValidator
{
    private const string ExpectedCircuitId = "fsus.anonymous.comment.v5";
    private const int ExpectedLayoutVersion = 6;
    private const string TrustedSetupSchema = "fsusblog.zk.trusted-setup-manifest.v2";
    private const string VerifyingKeySchema = "fsusblog.zk.verifying-key-config.v2";
    private const string CircuitManifestPath = "security/zk/contracts/comment-v5-circuit.manifest.json";
    private const string TrustedSetupManifestPath = "security/zk/provenance/comment-v5-trusted-setup.manifest.json";

    public static void Validate(
        JsonElement trustedSetup,
        JsonElement verifyingKey,
        string expectedVerifyingKeyHash,
        List<string> errors)
    {
        ValidateTrustedSetup(trustedSetup, expectedVerifyingKeyHash, errors);
        ValidateVerifyingKeyManifest(verifyingKey, expectedVerifyingKeyHash, trustedSetup, errors);
    }

    private static void ValidateTrustedSetup(JsonElement manifest, string expectedVkHash, List<string> errors)
    {
        RequireEqual(ReadString(manifest, "schema"), TrustedSetupSchema, "trusted setup manifest schema is invalid.", errors);
        RequireEqual(
            ReadString(manifest, "circuit_id"),
            ExpectedCircuitId,
            $"trusted setup manifest circuit_id must be {ExpectedCircuitId}.",
            errors);
        if (ReadInt(manifest, "public_input_layout_version") != ExpectedLayoutVersion)
        {
            errors.Add($"trusted setup manifest public_input_layout_version must be {ExpectedLayoutVersion}.");
        }

        RequireEqual(
            ReadRepoPath(manifest, "circuit_manifest_path"),
            CircuitManifestPath,
            $"trusted setup manifest circuit_manifest_path must be {CircuitManifestPath}.",
            errors);
        if (!ReadBoolean(manifest, "production_usable"))
        {
            errors.Add("trusted setup manifest production_usable must be true for root bootstrap.");
        }

        RequireEqual(
            ReadString(manifest, "ceremony_status"),
            "verified",
            "trusted setup manifest ceremony_status must be verified for root bootstrap.",
            errors);
        ValidateManifestHash(ReadString(manifest, "verifying_key_hash"), expectedVkHash, "trusted setup manifest", errors);
    }

    private static void ValidateVerifyingKeyManifest(
        JsonElement manifest,
        string expectedVkHash,
        JsonElement trustedSetup,
        List<string> errors)
    {
        RequireEqual(ReadString(manifest, "schema"), VerifyingKeySchema, "verifying key manifest schema is invalid.", errors);
        RequireEqual(
            ReadString(manifest, "circuit_id"),
            ExpectedCircuitId,
            $"verifying key manifest circuit_id must be {ExpectedCircuitId}.",
            errors);
        if (ReadInt(manifest, "public_input_layout_version") != ExpectedLayoutVersion)
        {
            errors.Add($"verifying key manifest public_input_layout_version must be {ExpectedLayoutVersion}.");
        }

        RequireEqual(
            ReadRepoPath(manifest, "trusted_setup_manifest"),
            TrustedSetupManifestPath,
            $"verifying key manifest trusted_setup_manifest must be {TrustedSetupManifestPath}.",
            errors);
        RequireEqual(
            ReadRepoPath(manifest, "circuit_manifest"),
            CircuitManifestPath,
            $"verifying key manifest circuit_manifest must be {CircuitManifestPath}.",
            errors);

        string trustedVerifyingKeyPath = ReadNestedRepoPath(trustedSetup, "artifacts", "verifying_key", "path");
        string configuredVerifyingKeyPath = ReadRepoPath(manifest, "verifying_key_path");
        if (string.IsNullOrEmpty(trustedVerifyingKeyPath) ||
            !string.Equals(configuredVerifyingKeyPath, trustedVerifyingKeyPath, StringComparison.Ordinal))
        {
            errors.Add("verifying key manifest verifying_key_path must match trusted setup artifacts.verifying_key.path.");
        }

        if (!ReadBoolean(manifest, "production_usable"))
        {
            errors.Add("verifying key manifest production_usable must be true for root bootstrap.");
        }

        string manifestVkHash = ReadString(manifest, "verifying_key_hash").ToLowerInvariant();
        string trustedVkHash = ReadString(trustedSetup, "verifying_key_hash").ToLowerInvariant();
        ValidateManifestHash(manifestVkHash, expectedVkHash, "verifying key manifest", errors);
        if (Sha256Regex().IsMatch(manifestVkHash) && Sha256Regex().IsMatch(trustedVkHash) && manifestVkHash != trustedVkHash)
        {
            errors.Add("trusted setup manifest verifying_key_hash does not match verifying key manifest.");
        }
    }

    private static void ValidateManifestHash(string rawHash, string expectedVkHash, string label, List<string> errors)
    {
        string normalized = NormalizeHash(rawHash);
        if (!Sha256Regex().IsMatch(normalized))
        {
            errors.Add($"{label} verifying_key_hash must be a 64-char hex SHA-256 digest.");
        }
        else if (!string.Equals(normalized, expectedVkHash, StringComparison.Ordinal))
        {
            errors.Add($"input verifying_key_hash does not match {label}.");
        }
    }

    private static void RequireEqual(string actual, string expected, string message, List<string> errors)
    {
        if (!string.Equals(actual, expected, StringComparison.Ordinal))
        {
            errors.Add(message);
        }
    }

    private static string ReadString(JsonElement parent, string propertyName)
        => parent.TryGetProperty(propertyName, out JsonElement value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()?.Trim() ?? string.Empty
            : string.Empty;

    private static string ReadRepoPath(JsonElement parent, string propertyName)
        => NormalizeRepoPath(ReadString(parent, propertyName));

    private static string ReadNestedRepoPath(JsonElement parent, params string[] path)
    {
        JsonElement current = parent;
        foreach (string segment in path)
        {
            if (current.ValueKind != JsonValueKind.Object || !current.TryGetProperty(segment, out current))
            {
                return string.Empty;
            }
        }

        return current.ValueKind == JsonValueKind.String
            ? NormalizeRepoPath(current.GetString() ?? string.Empty)
            : string.Empty;
    }

    private static int ReadInt(JsonElement parent, string propertyName)
        => parent.TryGetProperty(propertyName, out JsonElement value) && value.TryGetInt32(out int result) ? result : 0;

    private static bool ReadBoolean(JsonElement parent, string propertyName)
        => parent.TryGetProperty(propertyName, out JsonElement value) && value.ValueKind == JsonValueKind.True;

    private static string NormalizeRepoPath(string value)
        => value.Replace('\\', '/').TrimStart('.', '/');

    private static string NormalizeHash(string value)
        => value.Trim().StartsWith("0x", StringComparison.OrdinalIgnoreCase)
            ? value.Trim()[2..].ToLowerInvariant()
            : value.Trim().ToLowerInvariant();

    [GeneratedRegex("^[0-9a-f]{64}$", RegexOptions.CultureInvariant)]
    private static partial Regex Sha256Regex();
}
