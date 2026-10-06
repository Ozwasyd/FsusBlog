using System.Collections.Immutable;
using System.Data.Common;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Contracts.Migration;

using NSubstitute;

using Xunit;

namespace FsusBlog.Migration.Tests;

public sealed class OfflineMigrationApplyCommandValue5259Tests
{
    private const string Digest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private static readonly DateTimeOffset s_admissionTime = new(2026, 10, 2, 0, 0, 0, TimeSpan.Zero);

    [Fact]
    public void ApplyExplicitInitialAndResumeInputsPreserveOriginalReferences()
    {
        using var directory = new OwnedDirectory();
        OfflineMigrationApplyCommandOptions initial = OfflineMigrationCommandLine.ParseApply(Arguments(directory.Path));
        Assert.Equal(1, initial.Attempt);
        Assert.Null(initial.Checkpoint);
        Assert.False(initial.ConfirmDestructive);
        Assert.Equal(30, initial.TimeoutSeconds);
        Assert.Equal(5, initial.CleanupTimeoutSeconds);
        string[] resume = ResumeArguments(directory.Path, "2");
        OfflineMigrationApplyCommandOptions parsed = OfflineMigrationCommandLine.ParseApply(resume);
        Assert.Equal(2, parsed.Attempt);
        Assert.Equal(System.IO.Path.Combine(directory.Path, "previous-checkpoint.json"), parsed.Checkpoint!.Reference);
        Assert.Equal(Digest, parsed.Checkpoint.Sha256);
        Assert.True(OfflineMigrationCommandLine.ParseApply(resume.Concat(new[] { "--confirm-destructive" }).ToArray()).ConfirmDestructive);
        // Completed replay keeps its original attempt and exact checkpoint. The native
        // journal, not the parser, decides whether it is a verified no-op.
        Assert.Equal(1, OfflineMigrationCommandLine.ParseApply(ResumeArguments(directory.Path, "1")).Attempt);
        Assert.Empty(Directory.EnumerateFileSystemEntries(directory.Path));
    }

    [Theory]
    [InlineData("--timeout-seconds", "0")]
    [InlineData("--timeout-seconds", "01")]
    [InlineData("--timeout-seconds", "+1")]
    [InlineData("--timeout-seconds", "1e2")]
    [InlineData("--timeout-seconds", "2147484")]
    [InlineData("--cleanup-timeout-seconds", "0")]
    [InlineData("--cleanup-timeout-seconds", "-1")]
    [InlineData("--cleanup-timeout-seconds", "2147484")]
    [InlineData("--cleanup-timeout-seconds", " 5")]
    [InlineData("--attempt", "0")]
    [InlineData("--attempt", "01")]
    [InlineData("--attempt", "2147483648")]
    [InlineData("--provider", "mysql")]
    [InlineData("--provider", "sqlite")]
    [InlineData("--plan", "relative.json")]
    [InlineData("--plan-sha256", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")]
    [InlineData("--invocation-id", "run\n")]
    public void ApplyInvalidExplicitInputsRefuseWithoutIo(string flag, string value)
    {
        using var directory = new OwnedDirectory();
        string[] args = Arguments(directory.Path);
        args[Array.IndexOf(args, flag) + 1] = value;
        Assert.Throws<InvalidOperationException>(() => OfflineMigrationCommandLine.ParseApply(args));
        Assert.Empty(Directory.EnumerateFileSystemEntries(directory.Path));
    }

    [Fact]
    public void ApplyUnknownDuplicateMissingAndConflictingArtifactSelectorsRefuse()
    {
        using var directory = new OwnedDirectory();
        string[] args = Arguments(directory.Path);
        Assert.Throws<InvalidOperationException>(() => OfflineMigrationCommandLine.ParseApply(args[..^1]));
        Assert.Throws<InvalidOperationException>(() => OfflineMigrationCommandLine.ParseApply(args.Concat(new[] { "--sql", "SELECT 1" }).ToArray()));
        Assert.Throws<InvalidOperationException>(() => OfflineMigrationCommandLine.ParseApply(args.Concat(new[] { "--provider", "postgresql" }).ToArray()));
        Assert.Throws<InvalidOperationException>(() => OfflineMigrationCommandLine.ParseApply(args.Concat(new[] { "--confirm-destructive", "--confirm-destructive" }).ToArray()));
        Assert.Throws<InvalidOperationException>(() => OfflineMigrationCommandLine.ParseApply(args.Concat(new[] { "--checkpoint", System.IO.Path.Combine(directory.Path, "checkpoint.json") }).ToArray()));
        string[] changed = (string[])args.Clone();
        changed[Array.IndexOf(changed, "--attempt") + 1] = "2";
        Assert.Throws<InvalidOperationException>(() => OfflineMigrationCommandLine.ParseApply(changed));
        changed = (string[])args.Clone();
        changed[Array.IndexOf(changed, "--plan") + 1] = System.IO.Path.Combine(directory.Path, "latest", "plan.json");
        Assert.Throws<InvalidOperationException>(() => OfflineMigrationCommandLine.ParseApply(changed));
        changed = (string[])args.Clone();
        changed[Array.IndexOf(changed, "--output") + 1] = changed[Array.IndexOf(changed, "--plan") + 1];
        Assert.Throws<InvalidOperationException>(() => OfflineMigrationCommandLine.ParseApply(changed));
        changed = (string[])args.Clone();
        changed[Array.IndexOf(changed, "--checkpoint-output") + 1] = changed[Array.IndexOf(changed, "--output") + 1];
        Assert.Throws<InvalidOperationException>(() => OfflineMigrationCommandLine.ParseApply(changed));
    }

    [Fact]
    public void ApplyOriginalPlanBytesCannotBeReplacedBySemanticSealOrReconstructedJson()
    {
        using var directory = new OwnedDirectory();
        Fixture fixture = CreateFixture(directory.Path);
        Assert.Equal(fixture.Plan, OfflineMigrationOwnedApplyEvidence.DecodePlan(fixture.Options, fixture.Bytes));
        Assert.NotEqual(fixture.Plan.ContentDigest, fixture.Options.Plan.Sha256);
        Assert.Throws<InvalidOperationException>(() => OfflineMigrationOwnedApplyEvidence.DecodePlan(
            fixture.Options with { Plan = fixture.Options.Plan with { Sha256 = fixture.Plan.ContentDigest } }, fixture.Bytes));
        byte[] trailing = fixture.Bytes.Concat(new byte[] { 10 }).ToArray();
        Assert.Throws<InvalidOperationException>(() => OfflineMigrationOwnedApplyEvidence.DecodePlan(
            fixture.Options with { Plan = Reference(fixture.Options.Plan.Reference, trailing) }, trailing));
        Assert.Throws<InvalidOperationException>(() => OfflineMigrationOwnedApplyEvidence.DecodePlan(
            fixture.Options with { Database = fixture.Options.Database with { DatabaseId = "another" } }, fixture.Bytes));
        byte[] unknown = Encoding.UTF8.GetBytes(Encoding.UTF8.GetString(fixture.Bytes)[..^1] + ",\"unknown\":true}");
        Assert.Throws<InvalidOperationException>(() => OfflineMigrationOwnedApplyEvidence.DecodePlan(
            fixture.Options with { Plan = Reference(fixture.Options.Plan.Reference, unknown) }, unknown));
    }

    [Fact]
    public void ApplyCheckpointRawByteHashAndSemanticJournalAnchorStayDistinct()
    {
        var checkpoint = new OfflineMigrationApplyCheckpoint(new("offline-apply/v1/" + Digest, Digest), "invocation", 3);
        byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(checkpoint);
        CurrentSchemaArtifactReference reference = Reference("original-checkpoint", bytes);
        Assert.NotEqual(Digest, reference.Sha256);
        Assert.Equal(checkpoint, OfflineMigrationOwnedApplyEvidence.DecodeCheckpoint(reference, bytes, "invocation"));
        Assert.Throws<InvalidOperationException>(() => OfflineMigrationOwnedApplyEvidence.DecodeCheckpoint(reference with { Sha256 = Digest }, bytes, "invocation"));
        Assert.Throws<InvalidOperationException>(() => OfflineMigrationOwnedApplyEvidence.DecodeCheckpoint(reference, bytes, "another-invocation"));
        byte[] invalid = JsonSerializer.SerializeToUtf8Bytes(checkpoint with { Sequence = 0 });
        Assert.Throws<InvalidOperationException>(() => OfflineMigrationOwnedApplyEvidence.DecodeCheckpoint(Reference("original", invalid), invalid, "invocation"));
    }

    [Fact]
    public void ApplyIndependentAuthorityAndOriginalAdmissionTimeCloseTheCarrier()
    {
        using var directory = new OwnedDirectory();
        Fixture fixture = CreateFixture(directory.Path);
        Assert.Equal(fixture.Plan, OfflineMigrationOwnedApplyEvidence.BindCarrier(fixture.Plan, fixture.Bytes, fixture.Options.Plan,
            fixture.Planning, fixture.Authority, s_admissionTime).Plan);
        Assert.Throws<InvalidOperationException>(() => OfflineMigrationOwnedApplyEvidence.BindCarrier(fixture.Plan, fixture.Bytes,
            fixture.Options.Plan, fixture.Planning, fixture.Authority, s_admissionTime.AddDays(2)));
        Assert.Throws<InvalidOperationException>(() => OfflineMigrationOwnedApplyEvidence.BindCarrier(fixture.Plan, fixture.Bytes,
            fixture.Options.Plan, fixture.Planning with { Tool = fixture.Planning.Tool with { ConfigurationDigest = new string('b', 64) } }, fixture.Authority, s_admissionTime));
        Assert.Throws<InvalidOperationException>(() => OfflineMigrationOwnedApplyEvidence.BindCarrier(fixture.Plan, fixture.Bytes,
            fixture.Options.Plan, fixture.Planning with { MaximumBackupAge = TimeSpan.FromDays(2) }, fixture.Authority, s_admissionTime));
        Assert.Throws<InvalidOperationException>(() => OfflineMigrationOwnedApplyEvidence.BindCarrier(fixture.Plan, fixture.Bytes,
            fixture.Options.Plan, fixture.Planning, fixture.Authority with { AuthenticatedBackup = fixture.Plan.Backup with { CaptureSnapshotId = "another" } }, s_admissionTime));
    }

    [Theory]
    [InlineData(OfflineMigrationApplyStatus.Completed, true)]
    [InlineData(OfflineMigrationApplyStatus.NoOpVerified, true)]
    [InlineData(OfflineMigrationApplyStatus.Failed, false)]
    [InlineData(OfflineMigrationApplyStatus.RecoveryRequired, false)]
    public async Task ApplyTerminalArtifactsUseActualWholeBytesWithoutIssuingCurrentReceipt(OfflineMigrationApplyStatus status, bool completed)
    {
        using var directory = new OwnedDirectory();
        Fixture fixture = CreateFixture(directory.Path);
        OfflineMigrationApplyResult result = Outcome(fixture, status);
        using var output = new StringWriter();
        bool actual = await OfflineMigrationHost.ApplyWithinBudgetAsync(fixture.Options,
            () => new FixtureProducer((_, _) => Task.FromResult(result)), output, CancellationToken.None);
        Assert.Equal(completed, actual);
        Assert.Equal(JsonSerializer.SerializeToUtf8Bytes(result), await File.ReadAllBytesAsync(fixture.Options.OutputPath));
        Assert.Equal(JsonSerializer.SerializeToUtf8Bytes(result.Checkpoint), await File.ReadAllBytesAsync(fixture.Options.CheckpointOutputPath));
        using JsonDocument response = JsonDocument.Parse(output.ToString());
        Assert.Equal(fixture.Options.OutputPath, response.RootElement.GetProperty("apply").GetProperty("Reference").GetString());
        Assert.Equal(Hash(await File.ReadAllBytesAsync(fixture.Options.OutputPath)), response.RootElement.GetProperty("apply").GetProperty("Sha256").GetString());
        Assert.False(response.RootElement.TryGetProperty("receipt", out _));
    }

    [Fact]
    public async Task ApplyExistingOutputsRefuseBeforeProducerAndAreNeverOverwritten()
    {
        using var directory = new OwnedDirectory();
        Fixture fixture = CreateFixture(directory.Path);
        byte[] original = new byte[] { 1, 2, 3 };
        await File.WriteAllBytesAsync(fixture.Options.OutputPath, original);
        bool constructed = false;
        await Assert.ThrowsAsync<InvalidOperationException>(() => OfflineMigrationHost.ApplyWithinBudgetAsync(fixture.Options,
            () =>
            {
                constructed = true;
                throw new InvalidOperationException();
            }, TextWriter.Null, CancellationToken.None));
        Assert.False(constructed);
        Assert.Equal(original, await File.ReadAllBytesAsync(fixture.Options.OutputPath));
    }

    [Fact]
    public async Task ApplyCancellationAwaitsActualProducerAndDoesNotClaimNoEffects()
    {
        using var directory = new OwnedDirectory();
        Fixture fixture = CreateFixture(directory.Path);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var cancellation = new CancellationTokenSource();
        Task<bool> operation = OfflineMigrationHost.ApplyWithinBudgetAsync(fixture.Options, () => new FixtureProducer(async (_, token) =>
        {
            entered.SetResult();
            await release.Task;
            Assert.True(token.IsCancellationRequested);
            return Outcome(fixture, OfflineMigrationApplyStatus.Cancelled);
        }), TextWriter.Null, cancellation.Token);
        try
        {
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            cancellation.Cancel();
            Assert.False(operation.IsCompleted);
        }
        finally
        {
            cancellation.Cancel();
        release.TrySetResult();
            try
        {
            await operation;
        }
        catch
        {
        }
        }
        Assert.Equal("offline_apply_terminal_artifacts_unpublished",
            (await Assert.ThrowsAsync<InvalidOperationException>(() => operation)).Message);
        Assert.Empty(Directory.EnumerateFileSystemEntries(directory.Path));
    }

    [Fact]
    public async Task ApplyPartialPublicationKeepsCheckpointAndReportsApplyArtifactFailure()
    {
        using var directory = new OwnedDirectory();
        Fixture fixture = CreateFixture(directory.Path);
        OfflineMigrationApplyCommandOptions options = fixture.Options with { OutputPath = System.IO.Path.Combine(directory.Path, "missing", "apply.json") };
        Assert.Equal("offline_apply_checkpoint_published_apply_unpublished", (await Assert.ThrowsAsync<InvalidOperationException>(() =>
            OfflineMigrationHost.ApplyWithinBudgetAsync(options, () => new FixtureProducer((_, _) => Task.FromResult(Outcome(fixture,
                OfflineMigrationApplyStatus.Completed))), TextWriter.Null, CancellationToken.None))).Message);
        Assert.True(File.Exists(options.CheckpointOutputPath));
        Assert.False(File.Exists(options.OutputPath));
    }

    [Fact]
    public async Task ApplyResponseFailureKeepsBothOriginalPublishedArtifacts()
    {
        using var directory = new OwnedDirectory();
        Fixture fixture = CreateFixture(directory.Path);
        OfflineMigrationApplyResult result = Outcome(fixture, OfflineMigrationApplyStatus.Completed);
        using var output = new FailingResponseWriter();
        InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            OfflineMigrationHost.ApplyWithinBudgetAsync(fixture.Options,
                () => new FixtureProducer((_, _) => Task.FromResult(result)), output, CancellationToken.None));
        Assert.Equal("offline_apply_artifacts_published_response_failed", failure.Message);
        Assert.Equal(JsonSerializer.SerializeToUtf8Bytes(result), await File.ReadAllBytesAsync(fixture.Options.OutputPath));
        Assert.Equal(JsonSerializer.SerializeToUtf8Bytes(result.Checkpoint), await File.ReadAllBytesAsync(fixture.Options.CheckpointOutputPath));
        Assert.Equal(2, Directory.EnumerateFileSystemEntries(directory.Path).Count());
    }

    [Fact]
    public async Task ApplyExistingCheckpointRefusesBeforeProducerConstruction()
    {
        using var directory = new OwnedDirectory();
        Fixture fixture = CreateFixture(directory.Path);
        byte[] original = [1, 2, 3];
        await File.WriteAllBytesAsync(fixture.Options.CheckpointOutputPath, original);
        bool constructed = false;
        InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            OfflineMigrationHost.ApplyWithinBudgetAsync(fixture.Options, () =>
            {
                constructed = true;
                throw new InvalidOperationException();
            }, TextWriter.Null, CancellationToken.None));
        Assert.Equal("offline_apply_output_already_exists", failure.Message);
        Assert.False(constructed);
        Assert.Equal(original, await File.ReadAllBytesAsync(fixture.Options.CheckpointOutputPath));
        Assert.False(File.Exists(fixture.Options.OutputPath));
    }

    [Theory]
    [InlineData("plan")]
    [InlineData("database")]
    [InlineData("checkpoint")]
    [InlineData("code")]
    public void ApplyChangedResultBindingsCannotBePublished(string change)
    {
        using var directory = new OwnedDirectory();
        Fixture fixture = CreateFixture(directory.Path);
        OfflineMigrationApplyResult result = Outcome(fixture, OfflineMigrationApplyStatus.Completed);
        result = change switch
        {
            "plan" => result with { Plan = result.Plan with { Sha256 = Digest } },
            "database" => result with { Database = result.Database with { DatabaseId = "another" } },
            "checkpoint" => result with { Checkpoint = result.Checkpoint! with { InvocationId = "another" } },
            "code" => result with { Status = OfflineMigrationApplyStatus.Failed, Codes = ["private password"] },
            _ => throw new InvalidOperationException()
        };
        Assert.Throws<InvalidOperationException>(() => OfflineMigrationHost.ValidateApplyOutcome(fixture.Options, result));
    }

    [Fact]
    public void ApplyCompiledConsumersDoNotTurnRawShellConfigurationIntoProductionAdmission()
    {
        // Capability wiring fixture only. These substitutes are never production owners
        // and no configured consumer is invoked against a database or backup.
        IOfflineMigrationPlanningAuthorityReader planning = Substitute.For<IOfflineMigrationPlanningAuthorityReader>();
        IOfflineMigrationVerificationArtifactReader artifacts = Substitute.For<IOfflineMigrationVerificationArtifactReader>();
        IOfflineMigrationCurrentSchemaObserver current = Substitute.For<IOfflineMigrationCurrentSchemaObserver>();
        IOfflineMigrationCurrentSchemaVerificationAuthority authority = Substitute.For<IOfflineMigrationCurrentSchemaVerificationAuthority>();
        IOfflineMigrationApplyOperationRegistry operations = Substitute.For<IOfflineMigrationApplyOperationRegistry>();
        var backup = new OfflineMigrationShellBackupDrillConfiguration("/fixture", "/fixture/bash", "/fixture/setsid",
            "/fixture/dotnet", "/fixture/FsusBlog.Migration.dll", "/fixture/identity", null, new Dictionary<string, string>(), 1, 1);
        var capabilities = new OfflineMigrationCurrentSchemaVerificationCapabilities(artifacts, current, authority, operations);
        Assert.IsType<OfflineMigrationOwnedApplyEvidence>(OfflineMigrationApplyEvidence.ComposeOwned(
            new(artifacts, planning, authority, operations)));
        Assert.IsType<OfflineMigrationOwnedVerifyEvidence>(OfflineMigrationVerifyEvidence.ComposeOwned(capabilities));
        InvalidOperationException failure = Assert.Throws<InvalidOperationException>(() =>
            new OfflineMigrationHostOwnedConfiguration(planning, backup, capabilities));
        Assert.Equal("offline_backup_owned_tool_configuration_required", failure.Message);
        Assert.Empty(planning.ReceivedCalls());
        Assert.Empty(artifacts.ReceivedCalls());
        Assert.Empty(current.ReceivedCalls());
        Assert.Empty(authority.ReceivedCalls());
        Assert.Empty(operations.ReceivedCalls());
        Assert.Throws<InvalidOperationException>(() => new OfflineMigrationHostOwnedConfiguration(planning, backup,
            new(artifacts, current, authority, null!)));
    }

    [Fact]
    public async Task ApplyCancelledHostConfigurationDoesNotObserveToolsOrNativePorts()
    {
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        var backup = new OfflineMigrationShellBackupDrillConfiguration("/fixture", "/fixture/bash", "/fixture/setsid",
            "/fixture/dotnet", "/fixture/FsusBlog.Migration.dll", "/fixture/identity", null, new Dictionary<string, string>(), 1, 1);
        var artifact = new CurrentSchemaArtifactReference("/fixture/tool", Digest);
        var inputs = new OfflineMigrationShellBackupDrillOwnedInputs(backup,
            new(artifact, artifact, artifact, artifact, artifact, artifact, artifact),
            new(new(CurrentSchemaProviderKind.PostgreSql, "instance", "database"), "/fixture/source.env",
                "/fixture/restore.env", "/fixture/package", "/fixture/output", "/fixture/plan"));
        IOfflineMigrationPlanningAuthorityReader planning = Substitute.For<IOfflineMigrationPlanningAuthorityReader>();
        var verification = new OfflineMigrationCurrentSchemaVerificationCapabilities(
            Substitute.For<IOfflineMigrationVerificationArtifactReader>(), Substitute.For<IOfflineMigrationCurrentSchemaObserver>(),
            Substitute.For<IOfflineMigrationCurrentSchemaVerificationAuthority>(), Substitute.For<IOfflineMigrationApplyOperationRegistry>());
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => OfflineMigrationHostOwnedConfiguration.CreateAsync(
            planning, inputs, verification, cancellation.Token));
        Assert.Empty(planning.ReceivedCalls());
        Assert.Empty(verification.Artifacts.ReceivedCalls());
        Assert.Empty(verification.Authority.ReceivedCalls());
        Assert.Empty(verification.Operations.ReceivedCalls());
    }

    [Fact]
    public void PlanOriginalRetentionPortCompositionDoesNotImportAnyBackupObservation()
    {
        // Wiring fixture only; the substitutes are not a production retention owner.
        IOfflineMigrationPlanningAuthorityReader planning = Substitute.For<IOfflineMigrationPlanningAuthorityReader>();
        IOfflineMigrationOwnedBackupAdmission backup = Substitute.For<IOfflineMigrationOwnedBackupAdmission>();
        Assert.IsType<OfflineMigrationOwnedPlanningEvidence>(OfflineMigrationPlanEvidence.ComposeOwnedReader(planning, backup));
        Assert.Empty(planning.ReceivedCalls());
        Assert.Empty(backup.ReceivedCalls());
        Assert.Throws<ArgumentNullException>(() => OfflineMigrationPlanEvidence.ComposeOwnedReader(
            planning, (IOfflineMigrationOwnedBackupAdmission)null!));
    }

    [Fact]
    public async Task ApplyMissingBudgetRefusesBeforeConfiguredProducerConstruction()
    {
        using var directory = new OwnedDirectory();
        Fixture fixture = CreateFixture(directory.Path);
        bool constructed = false;
        await Assert.ThrowsAsync<InvalidOperationException>(() => OfflineMigrationHost.ApplyWithinBudgetAsync(
            fixture.Options with { CleanupTimeoutSeconds = 0 }, () =>
            {
                constructed = true;
                throw new InvalidOperationException();
            },
            TextWriter.Null, CancellationToken.None));
        Assert.False(constructed);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ApplyPreflightBindsAllOriginalProviderOwnersBeforeFirstJournalEntry(bool media)
    {
        using var directory = new OwnedDirectory();
        Fixture fixture = CreateFixture(directory.Path);
        var registry = new BindingRegistry(media);
        OfflineMigrationApplyJournalVerifier progress = OfflineMigrationApplyEvidence.CreateBoundPreflight(
            fixture.Plan, fixture.Options.Plan, fixture.Options.InvocationId, registry, CancellationToken.None);
        Assert.Null(progress.First);
        Assert.Null(progress.Last);
        Assert.Equal(media, progress.RequiresMedia(fixture.Plan.OrderedSteps[0].StepId));
        Assert.Equal(Enum.GetValues<CurrentSchemaProviderKind>(), registry.Resolved);
        Assert.Equal(0, registry.NativeCalls);
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("changed")]
    public void ApplyPreflightRejectsMissingOrChangedOwnerRatherThanReadingAnUnboundJournal(string refusal)
    {
        using var directory = new OwnedDirectory();
        Fixture fixture = CreateFixture(directory.Path);
        var registry = new BindingRegistry(true) { Refusal = refusal };
        InvalidOperationException failure = Assert.Throws<InvalidOperationException>(() =>
            OfflineMigrationApplyEvidence.CreateBoundPreflight(fixture.Plan, fixture.Options.Plan,
                fixture.Options.InvocationId, registry, CancellationToken.None));
        Assert.Equal(refusal == "missing" ? "offline_apply_operation_owner_missing" : "offline_apply_operation_binding_changed",
            failure.Message);
        Assert.Single(registry.Resolved);
        Assert.Equal(0, registry.NativeCalls);
    }

    [Fact]
    public void ApplyCancelledPreflightDoesNotResolveAnyOwner()
    {
        using var directory = new OwnedDirectory();
        Fixture fixture = CreateFixture(directory.Path);
        var registry = new BindingRegistry(true);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        Assert.ThrowsAny<OperationCanceledException>(() => OfflineMigrationApplyEvidence.CreateBoundPreflight(
            fixture.Plan, fixture.Options.Plan, fixture.Options.InvocationId, registry, cancellation.Token));
        Assert.Empty(registry.Resolved);
        Assert.Equal(0, registry.NativeCalls);
    }

    private static string[] Arguments(string root) => ["apply", "--provider", "postgresql", "--instance-id", "instance",
        "--database-id", "database", "--env-file", System.IO.Path.Combine(root, "connection.env"), "--plan", System.IO.Path.Combine(root, "plan.json"),
        "--plan-sha256", Digest, "--invocation-id", "invocation", "--attempt", "1", "--output", System.IO.Path.Combine(root, "apply.json"),
        "--checkpoint-output", System.IO.Path.Combine(root, "checkpoint.json"), "--timeout-seconds", "30", "--cleanup-timeout-seconds", "5"];

    private static string[] ResumeArguments(string root, string attempt)
    {
        string[] args = Arguments(root);
        args[Array.IndexOf(args, "--attempt") + 1] = attempt;
        return args.Concat(new[] { "--checkpoint", System.IO.Path.Combine(root, "previous-checkpoint.json"), "--checkpoint-sha256", Digest }).ToArray();
    }

    private static Fixture CreateFixture(string root)
    {
        // Pure structural contract fixture: no real source registration, backup, native
        // operation, database or issued receipt. Production must supply independent owners.
        OfflineMigrationApplyCommandOptions options = OfflineMigrationCommandLine.ParseApply(Arguments(root));
        var source = new OfflineMigrationSourceObservation(options.Database, "fixture-extractor", "v1", [], [], [], Digest);
        var backup = new OfflineMigrationBackupObservation(new("fixture-package", Digest), new("fixture-manifest", Digest), new("fixture-drill", Digest),
            "fixture-owner", "v1", s_admissionTime, s_admissionTime, "fixture-snapshot", Digest, Digest, source,
            source with { Database = source.Database with { InstanceId = "isolated", DatabaseId = "restored" } },
            new[] { "aotCache", "configRedacted", "dataProtectionKeyRing", "database", "searchIndex", "uploads" }
                .Select(name => new OfflineMigrationFact(name, Digest)).ToImmutableArray());
        var step = new OfflineMigrationStep("fixture-step", "fixture-source", "fixture-target", [], "fixture-idempotency", false,
            new("v1", 0, "fixture-watermark", "fixture-replay"), Enum.GetValues<CurrentSchemaProviderKind>().Select(provider =>
                new OfflineMigrationProviderOperation(provider, "fixture-operation", Digest, Digest, OfflineMigrationExecutionMode.Transaction)).ToImmutableArray());
        var registry = new OfflineMigrationSourceRegistry("v1", [new("fixture-profile", "v1", "fixture-owner", [nameof(ApplyIndependentAuthorityAndOriginalAdmissionTimeCloseTheCarrier)],
            step.StepId, Enum.GetValues<CurrentSchemaProviderKind>().Select(provider => new OfflineMigrationSourceShape(provider, source.ExtractorId,
                source.ExtractorVersion, [], [], [])).ToImmutableArray())]);
        var dag = new OfflineMigrationDag("fixture-dag", "v1", [step]);
        var target = new CurrentSchemaTargetIdentity("v1", "v1", "v1", Digest, Digest);
        var tool = new CurrentSchemaVerifierIdentity(new string('a', 40), Digest, Digest, Digest);
        OfflineMigrationPlan plan = OfflineMigrationPlanBuilder.Create(source, backup, target, tool, registry, dag, s_admissionTime, TimeSpan.FromHours(1));
        byte[] bytes = OfflineMigrationPlanCodec.Serialize(plan);
        options = options with { Plan = Reference(options.Plan.Reference, bytes) };
        return new(options, plan, bytes, new(target, tool, dag, TimeSpan.FromHours(1)),
            new(backup, tool, tool, registry, dag, TimeSpan.FromHours(1), []));
    }

    private static OfflineMigrationApplyResult Outcome(Fixture fixture, OfflineMigrationApplyStatus status)
        => new(status, fixture.Options.Plan, fixture.Plan.ContentDigest, fixture.Options.Database,
            new(new("offline-apply/v1/" + Digest, Digest), fixture.Options.InvocationId, 3), [],
            status is OfflineMigrationApplyStatus.Completed or OfflineMigrationApplyStatus.NoOpVerified ? [] : ["offline_apply_fixture_failed"]);
    private static string Hash(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));
    private static CurrentSchemaArtifactReference Reference(string path, byte[] bytes) => new(path, Hash(bytes));
    private sealed record Fixture(OfflineMigrationApplyCommandOptions Options, OfflineMigrationPlan Plan, byte[] Bytes,
        OfflineMigrationPlanningAuthority Planning, OfflineMigrationCurrentSchemaAuthoritySnapshot Authority);
    private sealed class FixtureProducer(Func<OfflineMigrationApplyCommandOptions, CancellationToken, Task<OfflineMigrationApplyResult>> apply)
        : IOfflineMigrationApplyProducer
    {
        public Task<OfflineMigrationApplyResult> ApplyAsync(OfflineMigrationApplyCommandOptions options, CancellationToken token) => apply(options, token);
    }

    // Owner-binding controls only: these objects cannot execute any database or media work.
    private sealed class BindingRegistry(bool media) : IOfflineMigrationApplyOperationRegistry
    {
        internal string? Refusal { get; init; }
        internal List<CurrentSchemaProviderKind> Resolved { get; } = [];
        internal int NativeCalls { get; private set; }

        public OfflineMigrationApplyOperation Resolve(OfflineMigrationStep step, OfflineMigrationProviderOperation operation)
        {
            Resolved.Add(operation.Provider);
            if (Refusal == "missing")
            {
                throw new InvalidOperationException("offline_apply_operation_owner_missing");
            }
            OfflineMigrationProviderOperation actual = Refusal == "changed"
                ? operation with { SemanticDigest = new string('b', 64) } : operation;
            return media ? new BindingMediaOperation(actual, this) : new BindingPlainOperation(actual, this);
        }

        internal Task<T> RefuseNative<T>()
        {
            NativeCalls++;
            throw new NotSupportedException("fixture_owner_binding_only");
        }
    }

    private sealed class BindingPlainOperation(OfflineMigrationProviderOperation identity, BindingRegistry registry)
        : OfflineMigrationApplyOperation
    {
        internal override OfflineMigrationProviderOperation Identity => identity;
        internal override Task<OfflineMigrationPredicateObservation> ObserveAsync(string predicateReference,
            DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken)
            => registry.RefuseNative<OfflineMigrationPredicateObservation>();
        internal override Task<OfflineMigrationApplyUnit> ExecuteAsync(OfflineMigrationStep step,
            OfflineMigrationApplyJournalEntry? previousUnit, DbConnection connection, DbTransaction transaction,
            CancellationToken cancellationToken) => registry.RefuseNative<OfflineMigrationApplyUnit>();
    }

    private sealed class BindingMediaOperation(OfflineMigrationProviderOperation identity, BindingRegistry registry)
        : OfflineMigrationArticleMediaOperation
    {
        internal override OfflineMigrationProviderOperation Identity => identity;
        internal override Task<OfflineMigrationPredicateObservation> ObserveAsync(string predicateReference,
            DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken)
            => registry.RefuseNative<OfflineMigrationPredicateObservation>();
        internal override Task<OfflineMigrationMediaJournalEvidence> GetMediaBindingAsync(VerifiedOfflineMigrationPlan plan,
            CurrentSchemaArtifactReference artifact, string invocationId, DbConnection connection, DbTransaction transaction,
            CancellationToken cancellationToken) => registry.RefuseNative<OfflineMigrationMediaJournalEvidence>();
        internal override Task<OfflineMigrationApplyUnit> ExecuteMediaAsync(OfflineMigrationStep step,
            OfflineMigrationApplyJournalEntry? previousUnit, DbConnection connection, DbTransaction transaction,
            IArticleMediaPreservationJournal journal, CancellationToken cancellationToken)
            => registry.RefuseNative<OfflineMigrationApplyUnit>();
    }

    private sealed class FailingResponseWriter : StringWriter
    {
        public override Task WriteLineAsync(ReadOnlyMemory<char> buffer, CancellationToken cancellationToken = default)
        {
            throw new IOException("fixture_response_failed");
        }
    }
    private sealed class OwnedDirectory : IDisposable
    {
        internal string Path { get; } = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "fsusblog-apply-" + Guid.NewGuid().ToString("N"));
        internal OwnedDirectory() => Directory.CreateDirectory(Path);
        public void Dispose() => Directory.Delete(Path, recursive: true);
    }
}
