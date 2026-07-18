using FsusBlog.Server.Models.Moderation;
using FsusBlog.Server.Services.Moderation;

using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ModerationRuntimeStateServiceTests
{
    [Fact]
    public void SetModelRuntime_DisablingModelDoesNotDisableDictionaries()
    {
        var service = new ModerationRuntimeStateService(BuildConfig(), new TestWebHostEnvironment("Development"));

        var result = service.SetModelRuntime(
            enabled: false,
            provider: "none",
            modelProfile: null,
            thresholdProfile: null,
            reason: "unit-test",
            changedBy: "admin");

        Assert.True(result.IsSuccess);
        Assert.False(service.IsModelEnabled);
        Assert.True(service.IsDictionaryEnabled("global.advertising"));
    }

    [Fact]
    public void SetDictionaryState_DisablingDictionaryDoesNotDisableRegionPolicy()
    {
        var service = new ModerationRuntimeStateService(BuildConfig(), new TestWebHostEnvironment("Development"));

        var result = service.SetDictionaryState(
            "global.advertising",
            enabled: false,
            reason: "unit-test",
            confirmPhrase: null,
            changedBy: "admin");

        Assert.True(result.IsSuccess);
        Assert.False(service.IsDictionaryEnabled("global.advertising"));
        Assert.False(service.IsRegionPolicyDisabled(RegionCodes.Singapore));
    }

    [Fact]
    public void SetGlobalState_RejectsDisabledPassThroughInProduction()
    {
        var service = new ModerationRuntimeStateService(BuildConfig(), new TestWebHostEnvironment("Production"));

        var result = service.SetGlobalState(
            ModerationGlobalStates.DisabledPassThrough,
            "unit-test",
            null,
            "admin");

        Assert.True(result.IsFailure);
        Assert.Equal(FsusBlog.Core.Common.ErrorCode.Forbidden, result.Error.Code);
        Assert.Equal(ModerationGlobalStates.Enabled, service.GetGlobalState());
    }

    [Fact]
    public void SetGlobalState_DisabledToPendingForcesManualReviewWithoutPassThrough()
    {
        var service = new ModerationRuntimeStateService(BuildConfig(), new TestWebHostEnvironment("Production"));

        var result = service.SetGlobalState(
            ModerationGlobalStates.DisabledToPending,
            "unit-test",
            null,
            "admin");

        Assert.True(result.IsSuccess);
        Assert.True(service.ShouldForceManualReview(RegionCodes.UnitedStates));
        Assert.True(service.ShouldHideUntilReviewed(RegionCodes.UnitedStates));
        Assert.False(service.ShouldRejectNewComment(RegionCodes.UnitedStates, out _));
    }

    [Fact]
    public void SetRegionState_MainlandStrictChangesRequireConfirmation()
    {
        var service = new ModerationRuntimeStateService(BuildConfig(), new TestWebHostEnvironment("Development"));

        var missingConfirmation = service.SetRegionState(
            RegionCodes.MainlandChina,
            ModerationRegionStates.NoPublicDisplay,
            "unit-test",
            null,
            confirmPhrase: null,
            changedBy: "admin");
        var disabled = service.SetRegionState(
            RegionCodes.MainlandChina,
            ModerationRegionStates.Disabled,
            "unit-test",
            null,
            ModerationRuntimeConfirmPhrases.MainlandChange,
            "admin");
        var confirmed = service.SetRegionState(
            RegionCodes.MainlandChina,
            ModerationRegionStates.NoPublicDisplay,
            "unit-test",
            null,
            ModerationRuntimeConfirmPhrases.MainlandChange,
            "admin");

        Assert.True(missingConfirmation.IsFailure);
        Assert.True(disabled.IsFailure);
        Assert.True(confirmed.IsSuccess);
        Assert.Equal(ModerationRegionStates.NoPublicDisplay, service.GetRegionState(RegionCodes.MainlandChina));
    }

    [Fact]
    public void SetModelRuntime_WhenExternalProviderRequested_RejectsChange()
    {
        IConfigurationRoot config = BuildConfig();
        var service = new ModerationRuntimeStateService(config, new TestWebHostEnvironment("Development"));
        ModerationRuntimeSnapshot previous = service.Current;

        var result = service.SetModelRuntime(
            enabled: true,
            provider: string.Concat("http", "-", "json"),
            modelProfile: null,
            thresholdProfile: null,
            reason: "unit-test",
            changedBy: "admin");

        Assert.True(result.IsFailure);
        Assert.Equal("moderation_model_provider_invalid", result.Error.Message);
        Assert.Same(previous, service.Current);
    }

    [Fact]
    public void ReloadModel_WhenBuiltInRuntimeInvalid_KeepsPreviousSnapshot()
    {
        IConfigurationRoot config = BuildConfig();
        var service = new ModerationRuntimeStateService(config, new TestWebHostEnvironment("Production"));
        ModerationRuntimeSnapshot previous = service.Current;
        config["Moderation:AntiSpamModel:Enabled"] = "true";
        config["Moderation:AntiSpamModel:RuntimePath"] = "/missing/fsus-antispammodel";

        var result = service.ReloadModel("admin");

        Assert.True(result.IsFailure);
        Assert.Equal("fsus_antispam_runtime_missing", result.Error.Message);
        Assert.Same(previous, service.Current);
    }

    [Fact]
    public void SetModelRuntime_WhenRuntimeMissing_RejectsEnablement()
    {
        var service = new ModerationRuntimeStateService(BuildConfig(), new TestWebHostEnvironment("Production"));
        ModerationRuntimeSnapshot previous = service.Current;

        var result = service.SetModelRuntime(
            enabled: true,
            provider: null,
            modelProfile: null,
            thresholdProfile: null,
            reason: "unit-test",
            changedBy: "admin");

        Assert.True(result.IsFailure);
        Assert.Equal("fsus_antispam_runtime_missing", result.Error.Message);
        Assert.Same(previous, service.Current);
    }

    [Fact]
    public void RollbackModel_RestoresPreviousModelSnapshot()
    {
        var service = new ModerationRuntimeStateService(BuildConfig(), new TestWebHostEnvironment("Development"));
        ModerationModelRuntimeSnapshot original = service.CurrentModel;
        var changed = service.SetModelRuntime(
            enabled: false,
            provider: "none",
            modelProfile: "disabled",
            thresholdProfile: "strict",
            reason: "unit-test",
            changedBy: "admin");

        var rollback = service.RollbackModel("admin");

        Assert.True(changed.IsSuccess);
        Assert.True(rollback.IsSuccess);
        Assert.Equal(original.Provider, service.CurrentModel.Provider);
        Assert.Equal(original.Enabled, service.CurrentModel.Enabled);
        Assert.Equal("rolled_back", service.CurrentModel.Status);
    }

    private static IConfigurationRoot BuildConfig()
        => new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Moderation:AntiSpamModel:Enabled"] = "false",
                ["Moderation:AntiSpamModel:ModelProfile"] = "fsus-antispammodel",
                ["Moderation:AntiSpamModel:ThresholdProfile"] = "default",
                ["Moderation:AntiSpamModel:ContractVersion"] = AntiSpamModerationContract.DefaultVersion,
                ["Moderation:AntiSpamModel:TimeoutMs"] = "800",
                ["Moderation:AntiSpamModel:FailOpen"] = "true",
                ["Moderation:AntiSpamModel:RuntimeChannel"] = "stable",
                ["Moderation:AntiSpamModel:RequireSignature"] = "true"
            })
            .Build();

    private sealed class TestWebHostEnvironment(string environmentName) : IWebHostEnvironment
    {
        public string ApplicationName { get; set; } = nameof(ModerationRuntimeStateServiceTests);
        public IFileProvider WebRootFileProvider { get; set; } = new NullFileProvider();
        public string WebRootPath { get; set; } = Path.Combine(Path.GetTempPath(), "fsus-runtime-tests-wwwroot");
        public string EnvironmentName { get; set; } = environmentName;
        public string ContentRootPath { get; set; } = Path.GetTempPath();
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }
}
