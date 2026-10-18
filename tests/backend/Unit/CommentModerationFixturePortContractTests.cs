using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Models.Moderation;
using FsusBlog.Server.Services.Fixtures;
using FsusBlog.Server.Services.Moderation;

using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class CommentModerationFixturePortContractTests : IDisposable
{
    private readonly string _root = Path.Combine(
        Path.GetTempPath(),
        $"fsus-comment-moderation-port-{Guid.NewGuid():N}");

    [Fact]
    public void AcquireRuntimeState_AppliesOwnedManualReviewRegionAndModel()
    {
        var clock = new MutableTimeProvider(new DateTimeOffset(2024, 2, 29, 23, 59, 59, TimeSpan.Zero));
        (CommentModerationFixturePort port, ModerationRuntimeStateService runtimeState) = BuildPort(clock);
        Assert.Equal(clock.UtcNow.UtcDateTime, runtimeState.Current.ChangedAtUtc);
        Assert.Equal(clock.UtcNow.UtcDateTime, runtimeState.CurrentModel.LoadedAtUtc);

        clock.UtcNow = clock.UtcNow.AddSeconds(2);

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
        Assert.Equal(clock.UtcNow.UtcDateTime, runtimeState.Current.ChangedAtUtc);
        Assert.Equal(clock.UtcNow.UtcDateTime, runtimeState.CurrentModel.LoadedAtUtc);
        Assert.Equal(clock.UtcNow.UtcDateTime.AddMinutes(15), runtimeState.Current.ExpiresAtUtc);
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

    [Fact]
    public void RestoreRuntimeState_RetainsWholePriorMetadataAndAbsentRollbackSlot()
    {
        var clock = new MutableTimeProvider(new DateTimeOffset(2024, 2, 29, 23, 59, 59, TimeSpan.Zero));
        (CommentModerationFixturePort port, ModerationRuntimeStateService runtime) = BuildPort(clock, modelEnabled: true);
        Assert.True(runtime.SetDictionaryState("global.advertising", false, "prior-dictionary", null, "dictionary-actor").IsSuccess);
        DateTime expiry = clock.UtcNow.UtcDateTime.AddHours(2);
        Assert.True(runtime.SetRegionState(RegionCodes.UnitedStates, ModerationRegionStates.NoPublicDisplay,
            "prior-region", expiry, null, "region-actor").IsSuccess);
        ModerationRuntimeSnapshot prior = runtime.Current;
        Assert.NotNull(prior.Model.BuiltInRuntime);
        clock.UtcNow = clock.UtcNow.AddSeconds(5);
        CommentModerationRuntimeLease lease = port.AcquireRuntimeState(Binding(), RegionCodes.UnitedStates);

        CommentModerationRuntimeRestore first = port.RestoreRuntimeState(lease);
        CommentModerationRuntimeRestore second = port.RestoreRuntimeState(lease);

        // Object identity covers all runtime/model metadata and the private
        // scorer's weights/thresholds, rather than just the wire scalar tuple.
        Assert.Same(prior, runtime.Current);
        Assert.Same(prior.Model, runtime.CurrentModel);
        Assert.Same(prior.Model.BuiltInRuntime, runtime.CurrentModel.BuiltInRuntime);
        Assert.Equal(expiry, runtime.Current.ExpiresAtUtc);
        Assert.Equal("prior-region", runtime.Current.Reason);
        Assert.Equal("region-actor", runtime.Current.ChangedBy);
        Assert.Equal(lease.PriorStateDigest, first.RestoredStateDigest);
        Assert.Equal(first, second);
        Assert.True(runtime.RollbackModel("admin").IsFailure);
        Assert.Same(prior, runtime.Current);
    }

    [Fact]
    public void RestoreRuntimeState_RetainsExistingRollbackSlotAndInitialErrors()
    {
        var clock = new MutableTimeProvider(new DateTimeOffset(2024, 2, 29, 23, 59, 59, TimeSpan.Zero));
        (CommentModerationFixturePort port, ModerationRuntimeStateService runtime) = BuildPort(clock, initialRuntimeInvalid: true);
        ModerationRuntimeSnapshot initial = runtime.Current;
        Assert.NotNull(initial.LastError);
        Assert.NotNull(initial.Model.LastError);
        CommentModerationRuntimeLease first = port.AcquireRuntimeState(Binding(), RegionCodes.UnitedStates);
        port.RestoreRuntimeState(first);
        Assert.Same(initial, runtime.Current);
        Assert.True(runtime.RollbackModel("admin").IsFailure);

        Assert.True(runtime.SetModelRuntime(false, "none", "prior-profile", "strict", "prior-model-reason", "prior-model-actor").IsSuccess);
        ModerationRuntimeSnapshot prior = runtime.Current;
        clock.UtcNow = clock.UtcNow.AddSeconds(5);
        CommentModerationRuntimeLease second = port.AcquireRuntimeState(Binding(), RegionCodes.UnitedStates);
        port.RestoreRuntimeState(second);
        Assert.Same(prior, runtime.Current);
        Assert.Equal(initial.Model with
        {
            LoadedAtUtc = clock.UtcNow.UtcDateTime,
            LoadedBy = "admin",
            Status = "rolled_back"
        }, runtime.RollbackModel("admin").Value!.Model);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void RestoreRuntimeState_RejectsInterveningOwnerEvenWhenScalarTupleIsUnchanged(bool afterRelease)
    {
        (CommentModerationFixturePort port, ModerationRuntimeStateService runtime) = BuildPort();
        CommentModerationRuntimeLease lease = port.AcquireRuntimeState(Binding(), RegionCodes.UnitedStates);
        if (afterRelease)
            port.RestoreRuntimeState(lease);
        string sameRegionState = runtime.GetRegionState(RegionCodes.UnitedStates);
        Assert.True(runtime.SetRegionState(RegionCodes.UnitedStates, sameRegionState,
            "intervening-owner", runtime.Current.ExpiresAtUtc, null, "other-owner").IsSuccess);
        ModerationRuntimeSnapshot intervening = runtime.Current;

        Assert.Throws<InvalidOperationException>(() => port.RestoreRuntimeState(lease));

        Assert.Same(intervening, runtime.Current);
        Assert.Equal("other-owner", runtime.Current.ChangedBy);
    }

    [Fact]
    public void RestoreRuntimeState_RejectsImportedReceiptAndValidDigestTampering()
    {
        (CommentModerationFixturePort port, ModerationRuntimeStateService runtime) = BuildPort();
        CommentModerationRuntimeLease lease = port.AcquireRuntimeState(Binding(), RegionCodes.UnitedStates);
        ModerationRuntimeSnapshot applied = runtime.Current;
        string payload = JsonSerializer.Serialize(lease);
        CommentModerationRuntimeLease imported = JsonSerializer.Deserialize<CommentModerationRuntimeLease>(payload)!;
        Assert.Equal(payload, JsonSerializer.Serialize(imported));
        Assert.Throws<InvalidOperationException>(() => port.RestoreRuntimeState(imported));
        Assert.Throws<InvalidOperationException>(() => port.RestoreRuntimeState(lease with
        {
            PriorStateDigest = $"sha256:{new string('d', 64)}"
        }));
        Assert.Throws<InvalidOperationException>(() => port.RestoreRuntimeState(lease with
        {
            PriorModelThresholdProfile = "forged-prior"
        }));
        Assert.Same(applied, runtime.Current);
        Assert.True(port.RestoreRuntimeState(lease).Exact);
    }

    [Fact]
    public void NativeRuntimeLease_NestedOwnedReleaseRestoresActualParentIncarnation()
    {
        var clock = new MutableTimeProvider(new DateTimeOffset(2024, 2, 29, 23, 59, 59, TimeSpan.Zero));
        var (_, runtime) = BuildPort(clock);
        ModerationRuntimeSnapshot original = runtime.Current;
        var parent = runtime.AcquireCommentFixtureRuntimeState(RegionCodes.UnitedStates, "parent-owner", "parent", clock.UtcNow.UtcDateTime.AddMinutes(15));
        var child = runtime.AcquireCommentFixtureRuntimeState(RegionCodes.Germany, "child-owner", "child", clock.UtcNow.UtcDateTime.AddMinutes(15));
        Assert.Throws<InvalidOperationException>(() => parent.Restore());
        Assert.Same(child.Applied, runtime.Current);
        Assert.Same(parent.Applied, child.Restore());
        Assert.Same(original, parent.Restore());
        Assert.Same(original, parent.Restore());
        Assert.True(runtime.RollbackModel("admin").IsFailure);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void AcquireRuntimeState_WhenReceiptConstructionFails_CompensatesActualPublishedStateOrReportsRejectedRelease(bool interleave)
    {
        (CommentModerationFixturePort port, ModerationRuntimeStateService runtime) = BuildPort(modelEnabled: true);
        Assert.True(runtime.SetRegionState(RegionCodes.UnitedStates, ModerationRegionStates.NoPublicDisplay,
            "prior", new DateTime(2024, 3, 1, 1, 0, 0, DateTimeKind.Utc), null, "prior-owner").IsSuccess);
        ModerationRuntimeSnapshot prior = runtime.Current;
        ModerationRuntimeSnapshot? intervening = null;
        var cause = new NullMessageException();
        CommentFixturePortBinding binding = Binding();
        binding = binding with
        {
            // Validation observes the actual prior snapshot. Only serialization
            // after native publication fails, before a caller receives its lease.
            Capabilities = new FailAfterAcquireList(binding.Capabilities,
                () => !ReferenceEquals(prior, runtime.Current),
                interleave ? () =>
                {
                    Assert.True(runtime.SetGlobalState(ModerationGlobalStates.ReadOnly,
                        "intervening", null, "other-owner").IsSuccess);
                    intervening = runtime.Current;
                }
            : null,
                cause)
        };

        if (interleave)
        {
            CommentModerationRuntimeAcquisitionException failure = Assert.Throws<CommentModerationRuntimeAcquisitionException>(() =>
                port.AcquireRuntimeState(binding, RegionCodes.UnitedStates));
            Assert.Same(cause, failure.InnerException);
            Assert.IsType<InvalidOperationException>(failure.CleanupError);
            Assert.Same(intervening, runtime.Current);
            Assert.Equal("other-owner", runtime.Current.ChangedBy);
        }
        else
        {
            Assert.Same(cause, Assert.Throws<NullMessageException>(() => port.AcquireRuntimeState(binding, RegionCodes.UnitedStates)));
            Assert.Same(prior, runtime.Current);
            Assert.True(runtime.RollbackModel("admin").IsFailure);
            Assert.Same(prior, runtime.Current);
        }
        Assert.Equal(0, cause.MessageReads);
    }

    private sealed class FailAfterAcquireList(
        IReadOnlyList<string> values,
        Func<bool> hasApplied,
        Action? interleave,
        Exception cause) : IReadOnlyList<string>
    {
        public int Count => values.Count;
        public string this[int index] => values[index];
        public IEnumerator<string> GetEnumerator()
        {
            if (hasApplied())
            {
                interleave?.Invoke();
                throw cause;
            }
            return values.GetEnumerator();
        }
        System.Collections.IEnumerator System.Collections.IEnumerable.GetEnumerator() => GetEnumerator();
    }

    [Fact]
    public async Task Seeder_RuntimeAcquisitionFailureKeepsOriginalCauseAndIndependentCleanupFailure()
    {
        CommentFixturePortBinding binding = Binding();
        var threads = Substitute.For<ICommentThreadFixturePort>();
        var moderation = Substitute.For<ICommentModerationFixturePort>();
        var cause = new NullMessageException();
        var cleanup = new InvalidOperationException("intervening owner rejected release");
        var failure = new CommentModerationRuntimeAcquisitionException(cause, cleanup);
        moderation.ReadCommentCacheGenerationAsync(binding.ArticleId, Arg.Any<CancellationToken>()).Returns("11");
        moderation.AcquireRuntimeState(Arg.Any<CommentFixturePortBinding>(), Arg.Any<string>()).Returns(_ => throw failure);
        var plan = new CommentFixturePlan(
            "fsusblog.comment-fixture-plan.v1", "comment-moderation", "transaction-fixture",
            binding.RunId, binding.Namespace, binding.TestSession, binding.ProfileId, binding.Capabilities,
            new CommentFixtureIdentityReferences(11, 12, 7, binding.AuthProducerResultDigest, binding.AuthPrepareReferenceDigests)
            {
                AdminActorReferenceDigest = binding.AuthPrepareReferenceDigests[0]
            },
            new CommentFixtureArticleReference(binding.ArticleId, binding.PublicContentProducerResultDigest, binding.ArticleProjectionDigest),
            binding.InventoryDigest, binding.CapabilityCatalogDigest, binding.VariantCatalogDigest,
            binding.TemporalContextDigest, binding.ProducerPlanDigest, binding.PlanDigest);
        var seeder = new CommentFixtureSeeder(threads, moderation,
            new ConfigurationBuilder().Build(), new MutableTimeProvider(new DateTimeOffset(2024, 2, 29, 23, 59, 59, TimeSpan.Zero)));

        CommentFixturePreparationException observed = await Assert.ThrowsAsync<CommentFixturePreparationException>(() => seeder.PrepareAsync(plan));

        Assert.Same(cause, observed.InnerException);
        Assert.Same(cleanup, observed.CleanupError);
        Assert.Contains("incomplete", observed.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("completed.", observed.Message, StringComparison.Ordinal);
        moderation.DidNotReceiveWithAnyArgs().RestoreRuntimeState(default!);
        await threads.DidNotReceiveWithAnyArgs().ExecuteAsync(default!, default);
        await threads.DidNotReceiveWithAnyArgs().CleanupAsync(default!, default);
        Assert.Equal(0, cause.MessageReads);
    }

    private sealed class NullMessageException : Exception
    {
        public int MessageReads
        {
            get; private set;
        }
        public override string Message
        {
            get
            {
                MessageReads++;
                return null!;
            }
        }
    }

    private (CommentModerationFixturePort Port, ModerationRuntimeStateService RuntimeState) BuildPort(TimeProvider? clock = null, bool modelEnabled = false, bool initialRuntimeInvalid = false)
    {
        clock ??= new MutableTimeProvider(new DateTimeOffset(2024, 2, 29, 23, 59, 59, TimeSpan.Zero));
        string runtimePath = WriteRuntimePackage();
        IConfigurationRoot configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Moderation:AntiSpamModel:Enabled"] = (modelEnabled || initialRuntimeInvalid).ToString(),
                ["Moderation:AntiSpamModel:ModelProfile"] = "fsus-antispammodel",
                ["Moderation:AntiSpamModel:ThresholdProfile"] = "default",
                ["Moderation:AntiSpamModel:ContractVersion"] = AntiSpamModerationContract.DefaultVersion,
                ["Moderation:AntiSpamModel:TimeoutMs"] = "800",
                ["Moderation:AntiSpamModel:FailOpen"] = "true",
                ["Moderation:AntiSpamModel:RuntimeChannel"] = "stable",
                ["Moderation:AntiSpamModel:RuntimePath"] = initialRuntimeInvalid ? Path.Combine(_root, "missing-runtime") : runtimePath,
                ["Moderation:AntiSpamModel:RequireSignature"] = "false"
            })
            .Build();
        var runtimeState = new ModerationRuntimeStateService(
            configuration,
            new TestWebHostEnvironment("Development"),
            clock);
        configuration["Moderation:AntiSpamModel:RuntimePath"] = runtimePath;
        var port = new CommentModerationFixturePort(
            null!,
            null!,
            null!,
            null!,
            null!,
            runtimeState,
            null!,
            null!,
            clock);
        return (port, runtimeState);
    }

    private sealed class MutableTimeProvider(DateTimeOffset utcNow) : TimeProvider
    {
        public DateTimeOffset UtcNow { get; set; } = utcNow;
        public override DateTimeOffset GetUtcNow() => UtcNow;
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
