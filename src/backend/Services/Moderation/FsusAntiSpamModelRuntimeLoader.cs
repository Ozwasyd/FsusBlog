using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using FsusBlog.Core.Common;
using FsusBlog.Server.Models.Moderation;

namespace FsusBlog.Server.Services.Moderation;

public sealed record FsusAntiSpamModelRuntimeLoadOptions(
    bool RequireSignature,
    string? TrustedSigningKey,
    string Channel);

public sealed class FsusAntiSpamModelRuntimeSnapshot(
    string runtimePath,
    string modelProfile,
    string contractVersion,
    string thresholdProfile,
    string source,
    string channel,
    string configChecksum,
    IReadOnlyList<FsusAntiSpamModelTokenWeight> weights,
    FsusAntiSpamModelThresholds thresholds)
{
    public string RuntimePath { get; } = runtimePath;
    public string ModelProfile { get; } = modelProfile;
    public string ContractVersion { get; } = contractVersion;
    public string ThresholdProfile { get; } = thresholdProfile;
    public string Source { get; } = source;
    public string Channel { get; } = channel;
    public string ConfigChecksum { get; } = configChecksum;

    public AntiSpamModerationResult Score(AntiSpamModerationRequest request)
    {
        string content = request.Content ?? string.Empty;
        FsusAntiSpamModelTokenWeight? best = null;
        foreach (FsusAntiSpamModelTokenWeight weight in weights)
        {
            if (content.Contains(weight.Token, StringComparison.OrdinalIgnoreCase)
                && (best is null || weight.Weight > best.Weight))
            {
                best = weight;
            }
        }

        double score = best is null ? 0d : Math.Clamp(best.Weight / 100d, 0d, 1d);
        string label = ResolveLabel(score);
        string severity = label switch
        {
            "blocked_candidate" => "critical",
            "risky" => "high",
            "suspicious" => "medium",
            _ => "low"
        };
        AntiSpamModerationCategorySignal[] categories = best is null
            ? []
            :
            [
                new AntiSpamModerationCategorySignal(
                    best.Category,
                    score,
                    severity,
                    "show_category_only")
            ];

        return new AntiSpamModerationResult(
            true,
            AntiSpamModerationProviders.BuiltIn,
            ModelProfile,
            ContractVersion,
            label,
            best is null ? 0.97d : score,
            severity,
            best?.Reason,
            best is not null,
            categories,
            [],
            best?.Reason,
            TimeSpan.Zero,
            AntiSpamModerationStatuses.Ok,
            null,
            request.ThresholdProfile ?? ThresholdProfile,
            new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["runtime_format"] = FsusAntiSpamModelRuntimeLoader.RuntimeFormat,
                ["runtime_channel"] = Channel,
                ["runtime_source"] = Source,
                ["runtime_checksum"] = ConfigChecksum
            });
    }

    private string ResolveLabel(double score)
    {
        if (score >= thresholds.BlockedCandidate)
        {
            return "blocked_candidate";
        }

        if (score >= thresholds.Risky)
        {
            return "risky";
        }

        if (score >= thresholds.Suspicious)
        {
            return "suspicious";
        }

        return "clean";
    }
}

public sealed record FsusAntiSpamModelTokenWeight(
    string Token,
    string Category,
    int Weight,
    string Reason);

public sealed record FsusAntiSpamModelThresholds(
    double Suspicious,
    double Risky,
    double BlockedCandidate);

public static class FsusAntiSpamModelRuntimeLoader
{
    public const string RuntimeFormat = "fsus-antispam-portable-runtime-v1";

    public static readonly string[] RequiredArtifactFiles =
    [
        "runtime_config.json",
        "model_state.json",
        "weights.int8.json",
        "threshold_policy.json",
        "test_vectors.jsonl"
    ];

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = true
    };

    public static Result<FsusAntiSpamModelRuntimeSnapshot> TryLoad(
        string? runtimePath,
        FsusAntiSpamModelRuntimeLoadOptions options)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(runtimePath) || !Directory.Exists(runtimePath))
            {
                return Fail("fsus_antispam_runtime_missing");
            }

            string manifestPath = Path.Combine(runtimePath, "manifest.json");
            if (!File.Exists(manifestPath))
            {
                return Fail("fsus_antispam_runtime_manifest_missing");
            }

            string manifestJson = File.ReadAllText(manifestPath);
            RuntimeManifest? manifest = JsonSerializer.Deserialize<RuntimeManifest>(manifestJson, JsonOptions);
            if (manifest is null || !IsRuntimeFormat(manifest.RuntimeFormat))
            {
                return Fail("fsus_antispam_runtime_format_invalid");
            }

            if (!IsSourceAllowed(manifest.Source))
            {
                return Fail("fsus_antispam_runtime_source_invalid");
            }

            foreach (string artifact in RequiredArtifactFiles)
            {
                string artifactPath = Path.Combine(runtimePath, artifact);
                if (!File.Exists(artifactPath)
                    || manifest.Artifacts is null
                    || !manifest.Artifacts.TryGetValue(artifact, out string? expectedHash)
                    || !string.Equals(Sha256File(artifactPath), expectedHash, StringComparison.OrdinalIgnoreCase))
                {
                    return Fail("fsus_antispam_runtime_digest_invalid");
                }
            }

            string manifestHash = Sha256File(manifestPath);
            if (options.RequireSignature && !ValidateSignature(runtimePath, manifestHash, options.TrustedSigningKey))
            {
                return Fail("fsus_antispam_runtime_signature_invalid");
            }

            RuntimeConfig? runtimeConfig = ReadJson<RuntimeConfig>(runtimePath, "runtime_config.json");
            if (runtimeConfig is null
                || !IsRuntimeFormat(runtimeConfig.RuntimeFormat)
                || string.IsNullOrWhiteSpace(runtimeConfig.ContractVersion))
            {
                return Fail("fsus_antispam_runtime_format_invalid");
            }

            ThresholdPolicy? thresholdPolicy = ReadJson<ThresholdPolicy>(runtimePath, "threshold_policy.json");
            if (thresholdPolicy?.Profiles is null
                || !thresholdPolicy.Profiles.TryGetValue("default", out ThresholdProfileDto? thresholdDto))
            {
                return Fail("fsus_antispam_runtime_threshold_invalid");
            }
            var thresholds = new FsusAntiSpamModelThresholds(
                thresholdDto.Suspicious,
                thresholdDto.Risky,
                thresholdDto.BlockedCandidate);

            WeightFile? weightFile = ReadJson<WeightFile>(runtimePath, "weights.int8.json");
            FsusAntiSpamModelTokenWeight[] weights = [.. (weightFile?.Tokens ?? [])
                .Where(static item => !string.IsNullOrWhiteSpace(item.Token)
                    && !string.IsNullOrWhiteSpace(item.Category)
                    && item.Weight is > 0 and <= 100)
                .Select(static item => new FsusAntiSpamModelTokenWeight(
                    item.Token!.Trim(),
                    item.Category!.Trim(),
                    item.Weight,
                    string.IsNullOrWhiteSpace(item.Reason) ? item.Category!.Trim() : item.Reason!.Trim()))];
            if (weights.Length == 0)
            {
                return Fail("fsus_antispam_runtime_weights_invalid");
            }

            string modelProfile = string.IsNullOrWhiteSpace(runtimeConfig.ModelProfile)
                ? manifest.ModelProfile ?? "fsus-antispammodel"
                : runtimeConfig.ModelProfile!;
            string channel = string.IsNullOrWhiteSpace(options.Channel)
                ? manifest.Channel ?? "stable"
                : options.Channel.Trim();
            var snapshot = new FsusAntiSpamModelRuntimeSnapshot(
                runtimePath,
                modelProfile,
                runtimeConfig.ContractVersion!,
                "default",
                manifest.Source ?? "mainline-release",
                channel,
                manifestHash,
                weights,
                thresholds);

            Result vectorResult = ValidateTestVectors(runtimePath, snapshot);
            return vectorResult.IsFailure
                ? Result<FsusAntiSpamModelRuntimeSnapshot>.Failure(vectorResult.Error)
                : Result<FsusAntiSpamModelRuntimeSnapshot>.Success(snapshot);
        }
        catch (JsonException)
        {
            return Fail("fsus_antispam_runtime_format_invalid");
        }
        catch (IOException)
        {
            return Fail("fsus_antispam_runtime_unavailable");
        }
        catch (UnauthorizedAccessException)
        {
            return Fail("fsus_antispam_runtime_unavailable");
        }
    }

    public static bool IsSourceAllowed(string? source)
    {
        string normalized = (source ?? string.Empty).Trim().Replace('\\', '/').ToLowerInvariant();
        if (normalized.Length == 0
            || normalized.Contains("legacy/python", StringComparison.Ordinal)
            || normalized.Contains("/legacy/", StringComparison.Ordinal)
            || normalized.Contains("audit-only", StringComparison.Ordinal))
        {
            return false;
        }

        return normalized.StartsWith("mainline-release", StringComparison.Ordinal)
            || normalized.StartsWith("third-party", StringComparison.Ordinal)
            || normalized.StartsWith("fsus-antispammodel-mainline", StringComparison.Ordinal)
            || normalized.StartsWith("fsusantispammodel-mainline", StringComparison.Ordinal);
    }

    private static Result ValidateTestVectors(string runtimePath, FsusAntiSpamModelRuntimeSnapshot snapshot)
    {
        string vectorPath = Path.Combine(runtimePath, "test_vectors.jsonl");
        foreach (string line in File.ReadLines(vectorPath))
        {
            if (string.IsNullOrWhiteSpace(line))
            {
                continue;
            }

            TestVector? vector = JsonSerializer.Deserialize<TestVector>(line, JsonOptions);
            if (vector is null || string.IsNullOrWhiteSpace(vector.Text) || string.IsNullOrWhiteSpace(vector.ExpectedLabel))
            {
                return Result.Failure(ErrorCode.Validation, "fsus_antispam_runtime_test_vector_failed");
            }

            AntiSpamModerationResult scored = snapshot.Score(new AntiSpamModerationRequest(
                "test-vector",
                vector.Text!,
                "comment",
                "zh-CN",
                DateTime.UtcNow,
                null,
                vector.ThresholdProfile ?? snapshot.ThresholdProfile,
                new Dictionary<string, string>(StringComparer.Ordinal)));
            if (!string.Equals(scored.Label, vector.ExpectedLabel, StringComparison.Ordinal)
                || (!string.IsNullOrWhiteSpace(vector.ExpectedPrimaryReason)
                    && !string.Equals(scored.PrimaryReason, vector.ExpectedPrimaryReason, StringComparison.Ordinal)))
            {
                return Result.Failure(ErrorCode.Validation, "fsus_antispam_runtime_test_vector_failed");
            }
        }

        return Result.Success();
    }

    private static bool ValidateSignature(string runtimePath, string manifestHash, string? trustedSigningKey)
    {
        if (string.IsNullOrWhiteSpace(trustedSigningKey))
        {
            return false;
        }

        string signaturePath = Path.Combine(runtimePath, "manifest.sig");
        if (!File.Exists(signaturePath))
        {
            return false;
        }

        string expected = Convert.ToHexStringLower(
            SHA256.HashData(Encoding.UTF8.GetBytes($"{trustedSigningKey.Trim()}\n{manifestHash}")));
        string actual = File.ReadAllText(signaturePath).Trim();
        return string.Equals(expected, actual, StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsRuntimeFormat(string? value)
        => string.Equals(value?.Trim(), RuntimeFormat, StringComparison.Ordinal);

    private static T? ReadJson<T>(string runtimePath, string fileName)
        => JsonSerializer.Deserialize<T>(File.ReadAllText(Path.Combine(runtimePath, fileName)), JsonOptions);

    private static string Sha256File(string path)
        => Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(path)));

    private static Result<FsusAntiSpamModelRuntimeSnapshot> Fail(string message)
        => Result<FsusAntiSpamModelRuntimeSnapshot>.Failure(ErrorCode.Validation, message);

    private sealed class RuntimeManifest
    {
        [JsonPropertyName("runtime_format")]
        public string? RuntimeFormat { get; set; }

        [JsonPropertyName("model_profile")]
        public string? ModelProfile { get; set; }

        [JsonPropertyName("source")]
        public string? Source { get; set; }

        [JsonPropertyName("channel")]
        public string? Channel { get; set; }

        [JsonPropertyName("artifacts")]
        public Dictionary<string, string>? Artifacts { get; set; }
    }

    private sealed class RuntimeConfig
    {
        [JsonPropertyName("runtime_format")]
        public string? RuntimeFormat { get; set; }

        [JsonPropertyName("contract_version")]
        public string? ContractVersion { get; set; }

        [JsonPropertyName("model_profile")]
        public string? ModelProfile { get; set; }
    }

    private sealed class WeightFile
    {
        [JsonPropertyName("tokens")]
        public List<TokenWeightDto>? Tokens { get; set; }
    }

    private sealed class TokenWeightDto
    {
        [JsonPropertyName("token")]
        public string? Token { get; set; }

        [JsonPropertyName("category")]
        public string? Category { get; set; }

        [JsonPropertyName("weight")]
        public int Weight { get; set; }

        [JsonPropertyName("reason")]
        public string? Reason { get; set; }
    }

    private sealed class ThresholdPolicy
    {
        [JsonPropertyName("profiles")]
        public Dictionary<string, ThresholdProfileDto>? Profiles { get; set; }
    }

    private sealed class ThresholdProfileDto
    {
        [JsonPropertyName("suspicious")]
        public double Suspicious { get; set; }

        [JsonPropertyName("risky")]
        public double Risky { get; set; }

        [JsonPropertyName("blocked_candidate")]
        public double BlockedCandidate { get; set; }
    }

    private sealed class TestVector
    {
        [JsonPropertyName("text")]
        public string? Text { get; set; }

        [JsonPropertyName("threshold_profile")]
        public string? ThresholdProfile { get; set; }

        [JsonPropertyName("expected_label")]
        public string? ExpectedLabel { get; set; }

        [JsonPropertyName("expected_primary_reason")]
        public string? ExpectedPrimaryReason { get; set; }
    }
}
