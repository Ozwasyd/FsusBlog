using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Models.Moderation;
using FsusBlog.Server.Services.Moderation;

namespace FsusBlog.Server.Tests.Unit;

public sealed class FsusAntiSpamModelRuntimeLoaderTests : IDisposable
{
    private const string TrustedSigningKey = "unit-test-trusted-key";
    private readonly string _root = Path.Combine(Path.GetTempPath(), $"fsus-antispam-runtime-{Guid.NewGuid():N}");

    [Fact]
    public void TryLoad_ValidPortableRuntimeScoresRiskSignalsOnly()
    {
        string runtimePath = WriteRuntimePackage();

        Result<FsusAntiSpamModelRuntimeSnapshot> loaded = FsusAntiSpamModelRuntimeLoader.TryLoad(
            runtimePath,
            new FsusAntiSpamModelRuntimeLoadOptions(
                RequireSignature: true,
                TrustedSigningKey: TrustedSigningKey,
                Channel: "stable"));

        Assert.True(loaded.IsSuccess);
        AntiSpamModerationResult result = loaded.Value!.Score(CreateRequest("This comment contains model_spam payload."));
        Assert.True(result.Available);
        Assert.Equal(AntiSpamModerationProviders.BuiltIn, result.Provider);
        Assert.Equal("fsus-antispammodel-portable-test", result.Model);
        Assert.Equal("risky", result.Label);
        Assert.Equal("spam_repeat", result.PrimaryReason);
        Assert.Equal("default", result.ThresholdProfile);
        Assert.Contains(result.Categories, static item => item.Id == "spam_repeat" && item.EvidencePolicy == "show_category_only");
        foreach (string forbidden in AntiSpamModerationContract.ForbiddenFinalActionFields)
        {
            Assert.DoesNotContain(forbidden, result.Metadata.Keys, StringComparer.OrdinalIgnoreCase);
        }
    }

    [Fact]
    public void TryLoad_RejectsDigestMismatchWithoutReplacingSnapshot()
    {
        string runtimePath = WriteRuntimePackage();
        File.AppendAllText(Path.Combine(runtimePath, "weights.int8.json"), "\n");

        Result<FsusAntiSpamModelRuntimeSnapshot> loaded = FsusAntiSpamModelRuntimeLoader.TryLoad(
            runtimePath,
            new FsusAntiSpamModelRuntimeLoadOptions(true, TrustedSigningKey, "stable"));

        Assert.True(loaded.IsFailure);
        Assert.Equal("fsus_antispam_runtime_digest_invalid", loaded.Error.Message);
    }

    [Fact]
    public void TryLoad_RejectsInvalidSignatureWhenRequired()
    {
        string runtimePath = WriteRuntimePackage();
        File.WriteAllText(Path.Combine(runtimePath, "manifest.sig"), "bad-signature");

        Result<FsusAntiSpamModelRuntimeSnapshot> loaded = FsusAntiSpamModelRuntimeLoader.TryLoad(
            runtimePath,
            new FsusAntiSpamModelRuntimeLoadOptions(true, TrustedSigningKey, "stable"));

        Assert.True(loaded.IsFailure);
        Assert.Equal("fsus_antispam_runtime_signature_invalid", loaded.Error.Message);
    }

    [Theory]
    [InlineData("legacy/python")]
    [InlineData("audit-only")]
    public void TryLoad_RejectsLegacyOrAuditOnlySources(string source)
    {
        string runtimePath = WriteRuntimePackage(source: source);

        Result<FsusAntiSpamModelRuntimeSnapshot> loaded = FsusAntiSpamModelRuntimeLoader.TryLoad(
            runtimePath,
            new FsusAntiSpamModelRuntimeLoadOptions(true, TrustedSigningKey, "stable"));

        Assert.True(loaded.IsFailure);
        Assert.Equal("fsus_antispam_runtime_source_invalid", loaded.Error.Message);
    }

    [Fact]
    public void TryLoad_RejectsRuntimeFormatMismatch()
    {
        string runtimePath = WriteRuntimePackage(runtimeFormat: "legacy/python");

        Result<FsusAntiSpamModelRuntimeSnapshot> loaded = FsusAntiSpamModelRuntimeLoader.TryLoad(
            runtimePath,
            new FsusAntiSpamModelRuntimeLoadOptions(true, TrustedSigningKey, "stable"));

        Assert.True(loaded.IsFailure);
        Assert.Equal("fsus_antispam_runtime_format_invalid", loaded.Error.Message);
    }

    [Fact]
    public void TryLoad_RejectsFailingTestVector()
    {
        string runtimePath = WriteRuntimePackage(testVectorExpectedLabel: "clean");

        Result<FsusAntiSpamModelRuntimeSnapshot> loaded = FsusAntiSpamModelRuntimeLoader.TryLoad(
            runtimePath,
            new FsusAntiSpamModelRuntimeLoadOptions(true, TrustedSigningKey, "stable"));

        Assert.True(loaded.IsFailure);
        Assert.Equal("fsus_antispam_runtime_test_vector_failed", loaded.Error.Message);
    }

    [Fact]
    public void ProductionSurfaces_DoNotExposeExternalAntiSpamProviders()
    {
        string[] forbidden =
        [
            string.Concat("http", "-", "json"),
            string.Concat("fsus", "-", "cli"),
            string.Concat("cli", "-", "json"),
            string.Concat("g", "rpc"),
            string.Concat("fsus", "_", "cli", "_", "provider", "_", "not", "_", "configured")
        ];
        Type[] runtimeSurfaces =
        [
            typeof(AntiSpamModerationService),
            typeof(ModerationRuntimeStateService),
            typeof(ProductionStartupValidator),
            typeof(ServiceCollectionExtensions),
            typeof(FsusAntiSpamModelRuntimeLoader)
        ];

        foreach (Type runtimeSurface in runtimeSurfaces)
        {
            string runtimeShape = RuntimeMetadataInspection.DescribeType(runtimeSurface);
            foreach (string token in forbidden)
            {
                Assert.DoesNotContain(token, runtimeShape, StringComparison.OrdinalIgnoreCase);
            }
        }

        AntiSpamModerationResult runtimeResult = Assert.IsType<FsusAntiSpamModelRuntimeSnapshot>(
                FsusAntiSpamModelRuntimeLoader.TryLoad(
                    WriteRuntimePackage(),
                    new FsusAntiSpamModelRuntimeLoadOptions(true, TrustedSigningKey, "stable"))
                .Value)
            .Score(CreateRequest("clean portable runtime request"));
        Assert.Equal(AntiSpamModerationProviders.BuiltIn, runtimeResult.Provider);
    }

    private string WriteRuntimePackage(
        string source = "mainline-release",
        string runtimeFormat = FsusAntiSpamModelRuntimeLoader.RuntimeFormat,
        string testVectorExpectedLabel = "risky")
    {
        string directory = Path.Combine(_root, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);

        WriteJson(directory, "runtime_config.json", new
        {
            schema = "fsus.antispammodel.runtime-config.v1",
            runtime_format = runtimeFormat,
            contract_version = AntiSpamModerationContract.DefaultVersion,
            model_profile = "fsus-antispammodel-portable-test",
            locale = "zh-CN"
        });
        WriteJson(directory, "model_state.json", new
        {
            schema = "fsus.antispammodel.model-state.v1",
            bias = 0
        });
        WriteJson(directory, "weights.int8.json", new
        {
            schema = "fsus.antispammodel.weights-int8.v1",
            tokens = new[]
            {
                new { token = "model_spam", category = "spam_repeat", weight = 92, reason = "spam_repeat" }
            }
        });
        WriteJson(directory, "threshold_policy.json", new
        {
            schema = "fsus.antispammodel.threshold-policy.v1",
            profiles = new Dictionary<string, object>
            {
                ["default"] = new { suspicious = 0.40, risky = 0.70, blocked_candidate = 0.95 }
            }
        });
        File.WriteAllText(
            Path.Combine(directory, "test_vectors.jsonl"),
            JsonSerializer.Serialize(new
            {
                text = "model_spam sample",
                threshold_profile = "default",
                expected_label = testVectorExpectedLabel,
                expected_primary_reason = "spam_repeat"
            }) + "\n");

        var artifacts = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (string name in FsusAntiSpamModelRuntimeLoader.RequiredArtifactFiles)
        {
            artifacts[name] = Sha256File(Path.Combine(directory, name));
        }

        WriteJson(directory, "manifest.json", new
        {
            schema = "fsus.antispammodel.portable-runtime.manifest.v1",
            runtime_format = runtimeFormat,
            model_id = "fsus-antispammodel",
            model_profile = "fsus-antispammodel-portable-test",
            source = source,
            channel = "stable",
            artifacts = artifacts,
            provenance = new
            {
                build_id = "unit-test",
                format_owner = "FsusAntiSpamModel"
            }
        });

        string manifestHash = Sha256File(Path.Combine(directory, "manifest.json"));
        File.WriteAllText(Path.Combine(directory, "manifest.sig"), SignManifest(manifestHash));
        return directory;
    }

    private static AntiSpamModerationRequest CreateRequest(string content)
        => new(
            "comment:1",
            content,
            "comment",
            "zh-CN",
            DateTime.UtcNow,
            "GLOBAL",
            "default",
            new Dictionary<string, string>(StringComparer.Ordinal));

    private static void WriteJson(string directory, string name, object value)
        => File.WriteAllText(
            Path.Combine(directory, name),
            JsonSerializer.Serialize(value, new JsonSerializerOptions(JsonSerializerDefaults.Web) { WriteIndented = true }));

    private static string Sha256File(string path)
        => Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(path)));

    private static string SignManifest(string manifestHash)
        => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes($"{TrustedSigningKey}\n{manifestHash}")));

    public void Dispose()
    {
        if (Directory.Exists(_root))
        {
            Directory.Delete(_root, recursive: true);
        }
    }
}
