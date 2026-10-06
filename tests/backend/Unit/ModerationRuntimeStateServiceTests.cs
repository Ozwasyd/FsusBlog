using FsusBlog.Server.Models.Moderation;
using FsusBlog.Server.Services.Moderation;

using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;
namespace FsusBlog.Server.Tests.Unit;

public sealed class ModerationRuntimeStateServiceTests
{
    [Fact]
    public void RuntimeSnapshots_ReplayInjectedBusinessTimeAndAdvanceOnlyExplicitly()
    {
        var clock = new MutableTimeProvider(new DateTimeOffset(2024, 2, 29, 23, 59, 59, TimeSpan.Zero));
        var first = new ModerationRuntimeStateService(BuildConfig(), new TestWebHostEnvironment("Development"), clock);
        var replay = new ModerationRuntimeStateService(BuildConfig(), new TestWebHostEnvironment("Development"), clock);
        Assert.Equal(clock.UtcNow.UtcDateTime, first.Current.ChangedAtUtc);
        Assert.Equal(clock.UtcNow.UtcDateTime, first.CurrentModel.LoadedAtUtc);
        Assert.Equal(first.Current.SnapshotId, replay.Current.SnapshotId);
        Assert.Equal(first.CurrentModel.SnapshotId, replay.CurrentModel.SnapshotId);

        clock.UtcNow = clock.UtcNow.AddSeconds(2);
        Func<ModerationRuntimeStateService, FsusBlog.Core.Common.Result<ModerationRuntimeSnapshot>>[] mutations =
        [
            service => service.SetGlobalState(ModerationGlobalStates.ReadOnly, "clock", null, "admin"),
            service => service.SetRegionState(RegionCodes.UnitedStates, ModerationRegionStates.ManualReviewOnly, "clock", clock.UtcNow.UtcDateTime.AddMinutes(15), null, "admin"),
            service => service.SetDictionaryState("global.advertising", false, "clock", null, "admin"),
            service => service.ReloadModel("admin"),
            service => service.SetModelRuntime(false, "none", "disabled", "strict", "clock", "admin"),
            service => service.RollbackModel("admin")
        ];
        foreach (var mutate in mutations)
        {
            var result = mutate(first);
            var replayResult = mutate(replay);
            Assert.True(result.IsSuccess);
            Assert.True(replayResult.IsSuccess);
            Assert.Equal(clock.UtcNow.UtcDateTime, result.Value!.ChangedAtUtc);
            Assert.Equal(System.Text.Json.JsonSerializer.Serialize(result.Value),
                System.Text.Json.JsonSerializer.Serialize(replayResult.Value));
        }
        Assert.Equal(clock.UtcNow.UtcDateTime, first.CurrentModel.LoadedAtUtc);
    }

    private sealed class MutableTimeProvider(DateTimeOffset utcNow) : TimeProvider
    {
        public DateTimeOffset UtcNow { get; set; } = utcNow;
        public override DateTimeOffset GetUtcNow() => UtcNow;
    }

    [Fact]
    public void SetModelRuntime_DisablingModelDoesNotDisableDictionaries()
    {
        var service = new ModerationRuntimeStateService(BuildConfig(), new TestWebHostEnvironment("Development"), TimeProvider.System);

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
        var service = new ModerationRuntimeStateService(BuildConfig(), new TestWebHostEnvironment("Development"), TimeProvider.System);

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
        var service = new ModerationRuntimeStateService(BuildConfig(), new TestWebHostEnvironment("Production"), TimeProvider.System);

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
        var service = new ModerationRuntimeStateService(BuildConfig(), new TestWebHostEnvironment("Production"), TimeProvider.System);

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
        var service = new ModerationRuntimeStateService(BuildConfig(), new TestWebHostEnvironment("Development"), TimeProvider.System);

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
        var service = new ModerationRuntimeStateService(config, new TestWebHostEnvironment("Development"), TimeProvider.System);
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
        var service = new ModerationRuntimeStateService(config, new TestWebHostEnvironment("Production"), TimeProvider.System);
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
        var service = new ModerationRuntimeStateService(BuildConfig(), new TestWebHostEnvironment("Production"), TimeProvider.System);
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
        var service = new ModerationRuntimeStateService(BuildConfig(), new TestWebHostEnvironment("Development"), TimeProvider.System);
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

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void CommentFixtureAcquire_WhenModelLoadFails_PreservesWholeSnapshotAndOriginalRollbackSlot(bool hasRollbackSlot)
    {
        var clock = new MutableTimeProvider(new DateTimeOffset(2024, 2, 29, 23, 59, 59, TimeSpan.Zero));
        var service = new ModerationRuntimeStateService(BuildConfig(), new TestWebHostEnvironment("Development"), clock);
        ModerationModelRuntimeSnapshot originalModel = service.CurrentModel;
        if (hasRollbackSlot)
            Assert.True(service.SetModelRuntime(false, "none", "prior-disabled", "strict", "prior-model-reason", "prior-model-actor").IsSuccess);
        DateTime expiry = clock.UtcNow.UtcDateTime.AddHours(2);
        Assert.True(service.SetRegionState(RegionCodes.UnitedStates, ModerationRegionStates.NoPublicDisplay,
            "prior-region-reason", expiry, null, "prior-region-actor").IsSuccess);
        ModerationRuntimeSnapshot prior = service.Current;

        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() =>
            service.AcquireCommentFixtureRuntimeState(RegionCodes.UnitedStates, "fixture-owner", "run", clock.UtcNow.UtcDateTime.AddMinutes(15)));

        Assert.Contains("fsus_antispam_runtime_missing", error.Message, StringComparison.Ordinal);
        Assert.Same(prior, service.Current);
        Assert.Equal(expiry, service.Current.ExpiresAtUtc);
        Assert.Equal("prior-region-reason", service.Current.Reason);
        Assert.Equal("prior-region-actor", service.Current.ChangedBy);
        var rollback = service.RollbackModel("after-failed-acquire");
        if (hasRollbackSlot)
        {
            Assert.True(rollback.IsSuccess);
            Assert.Equal(originalModel with
            {
                LoadedAtUtc = clock.UtcNow.UtcDateTime,
                LoadedBy = "after-failed-acquire",
                Status = "rolled_back"
            }, service.CurrentModel);
        }
        else
        {
            Assert.True(rollback.IsFailure);
            Assert.Equal("moderation_model_rollback_snapshot_missing", rollback.Error.Message);
            Assert.Same(prior, service.Current);
        }
    }

    [Theory]
    [InlineData("Production", "US")]
    [InlineData("Development", "CN")]
    public void CommentFixtureAcquire_RejectsNonDevelopmentAndUnconfirmedMainlandWithoutMutation(string environment, string region)
    {
        var service = new ModerationRuntimeStateService(BuildConfig(), new TestWebHostEnvironment(environment), TimeProvider.System);
        ModerationRuntimeSnapshot prior = service.Current;
        Assert.Throws<InvalidOperationException>(() => service.AcquireCommentFixtureRuntimeState(
            region, "fixture-owner", "run", new DateTime(2024, 3, 1, 0, 15, 0, DateTimeKind.Utc)));
        Assert.Same(prior, service.Current);
        Assert.True(service.RollbackModel("admin").IsFailure);
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
