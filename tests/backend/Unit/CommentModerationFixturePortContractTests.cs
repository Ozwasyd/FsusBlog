using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Models.Moderation;
using FsusBlog.Server.Services.Fixtures;
using FsusBlog.Server.Services.Moderation;

using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;

namespace FsusBlog.Server.Tests.Unit;

public sealed class CommentModerationFixturePortContractTests : IDisposable
{
    private readonly string _root = Path.Combine(
        Path.GetTempPath(),
        $"fsus-comment-moderation-port-{Guid.NewGuid():N}");

    [Fact]
    public void AcquireRuntimeState_AppliesOwnedManualReviewRegionAndModel()
    {
        (CommentModerationFixturePort port, ModerationRuntimeStateService runtimeState) = BuildPort();

        CommentModerationRuntimeLease lease = port.AcquireRuntimeState(
            Binding(),
            RegionCodes.UnitedStates);

        Assert.Equal("fsusblog.comment-moderation-runtime-lease.v1", lease.Schema);
        Assert.Equal(RegionCodes.UnitedStates, lease.Region);
        Assert.Equal(ModerationRegionStates.Enabled, lease.PriorRegionState);
        Assert.Equal(ModerationRegionStates.ManualReviewOnly, lease.AppliedRegionState);
        Assert.False(lease.PriorModelEnabled);
        Assert.Equal(Binding().Owner, lease.Owner);
        Assert.Matches("^sha256:[a-f0-9]{64}$", lease.PriorStateDigest);
        Assert.Matches("^sha256:[a-f0-9]{64}$", lease.AppliedStateDigest);
        Assert.NotEqual(lease.PriorStateDigest, lease.AppliedStateDigest);
        Assert.Equal(ModerationRegionStates.ManualReviewOnly,
            runtimeState.GetRegionState(RegionCodes.UnitedStates));
        Assert.True(runtimeState.CurrentModel.Enabled);
    }

    [Fact]
    public void RestoreRuntimeState_ReturnsExactPriorStateAndIsIdempotent()
    {
        (CommentModerationFixturePort port, ModerationRuntimeStateService runtimeState) = BuildPort();
        ModerationModelRuntimeSnapshot prior = runtimeState.CurrentModel;
        CommentModerationRuntimeLease lease = port.AcquireRuntimeState(
            Binding(),
            RegionCodes.UnitedStates);

        CommentModerationRuntimeRestore restore = port.RestoreRuntimeState(lease);

        Assert.Equal("fsusblog.comment-moderation-runtime-restore.v1", restore.Schema);
        Assert.True(restore.Exact);
        Assert.Equal(ModerationRegionStates.Enabled, restore.RestoredRegionState);
        Assert.Equal(prior.Enabled, restore.RestoredModelEnabled);
        Assert.Equal(prior.Provider, restore.RestoredModelProvider);
        Assert.Equal(prior.ModelProfile, restore.RestoredModelProfile);
        Assert.Equal(prior.ThresholdProfile, restore.RestoredModelThresholdProfile);
        Assert.Equal(prior.ContractVersion, restore.RestoredModelContractVersion);
        Assert.Equal(lease.PriorStateDigest, restore.RestoredStateDigest);
        Assert.Matches("^sha256:[a-f0-9]{64}$", restore.LeaseDigest);
        Assert.Equal(ModerationRegionStates.Enabled,
            runtimeState.GetRegionState(RegionCodes.UnitedStates));
        Assert.False(runtimeState.CurrentModel.Enabled);

        CommentModerationRuntimeRestore second = port.RestoreRuntimeState(lease);
        Assert.True(second.Exact);
        Assert.Equal(restore.RestoredStateDigest, second.RestoredStateDigest);
        Assert.False(runtimeState.CurrentModel.Enabled);
    }

    [Fact]
    public void RestoreRuntimeState_RejectsTamperedLease()
    {
        (CommentModerationFixturePort port, _) = BuildPort();
        CommentModerationRuntimeLease lease = port.AcquireRuntimeState(
            Binding(),
            RegionCodes.UnitedStates);

        Assert.Throws<InvalidOperationException>(() =>
            port.RestoreRuntimeState(lease with
            {
                Owner = "other-owner"
            }));
        Assert.Throws<InvalidOperationException>(() =>
            port.RestoreRuntimeState(lease with
            {
                PriorStateDigest = "not-a-digest"
            }));
    }

    private (CommentModerationFixturePort Port, ModerationRuntimeStateService RuntimeState) BuildPort()
    {
        string runtimePath = WriteRuntimePackage();
        IConfigurationRoot configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Moderation:AntiSpamModel:Enabled"] = "false",
                ["Moderation:AntiSpamModel:ModelProfile"] = "fsus-antispammodel",
                ["Moderation:AntiSpamModel:ThresholdProfile"] = "default",
                ["Moderation:AntiSpamModel:ContractVersion"] = AntiSpamModerationContract.DefaultVersion,
                ["Moderation:AntiSpamModel:TimeoutMs"] = "800",
                ["Moderation:AntiSpamModel:FailOpen"] = "true",
                ["Moderation:AntiSpamModel:RuntimeChannel"] = "stable",
                ["Moderation:AntiSpamModel:RuntimePath"] = runtimePath,
                ["Moderation:AntiSpamModel:RequireSignature"] = "false"
            })
            .Build();
        var runtimeState = new ModerationRuntimeStateService(
            configuration,
            new TestWebHostEnvironment("Development"));
        var port = new CommentModerationFixturePort(
            null!,
            null!,
            null!,
            null!,
            null!,
            runtimeState,
            null!,
            null!);
        return (port, runtimeState);
    }

    private string WriteRuntimePackage()
    {
        string directory = Path.Combine(_root, "runtime");
        Directory.CreateDirectory(directory);
        WriteJson(directory, "runtime_config.json", new
        {
            schema = "fsus.antispammodel.runtime-config.v1",
            runtime_format = FsusAntiSpamModelRuntimeLoader.RuntimeFormat,
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
                expected_label = "risky",
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
            runtime_format = FsusAntiSpamModelRuntimeLoader.RuntimeFormat,
            model_id = "fsus-antispammodel",
            model_profile = "fsus-antispammodel-portable-test",
            source = "mainline-release",
            channel = "stable",
            artifacts,
            provenance = new
            {
                build_id = "unit-test",
                format_owner = "FsusAntiSpamModel"
            }
        });
        return directory;
    }

    private static void WriteJson(string directory, string name, object value)
        => File.WriteAllText(
            Path.Combine(directory, name),
            JsonSerializer.Serialize(value, new JsonSerializerOptions(JsonSerializerDefaults.Web) { WriteIndented = true }));

    private static string Sha256File(string path)
        => Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(path)));

    private static CommentFixturePortBinding Binding()
    {
        const string Digest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        return new(
            "run-1",
            "namespace",
            "fx-0123456789abcdef01234567",
            "comment-fixture:namespace:run-1",
            "comments-moderation",
            ["comment.moderation-matrix", "comment.threaded", "moderation.policy-matrix"],
            42,
            Digest,
            [Digest, $"sha256:{new string('b', 64)}", $"sha256:{new string('c', 64)}"],
            Digest,
            Digest,
            Digest,
            Digest,
            Digest,
            Digest,
            Digest,
            Digest);
    }

    public void Dispose()
    {
        if (Directory.Exists(_root))
        {
            Directory.Delete(_root, recursive: true);
        }
    }

    private sealed class TestWebHostEnvironment(string environmentName) : IWebHostEnvironment
    {
        public string ApplicationName { get; set; } = nameof(CommentModerationFixturePortContractTests);
        public IFileProvider WebRootFileProvider { get; set; } = new NullFileProvider();
        public string WebRootPath { get; set; } = Path.Combine(Path.GetTempPath(), "fsus-moderation-port-tests-wwwroot");
        public string EnvironmentName { get; set; } = environmentName;
        public string ContentRootPath { get; set; } = Path.GetTempPath();
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }
}
