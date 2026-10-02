using System.Collections.Immutable;
using System.Security.Cryptography;

using FsusBlog.Contracts.Migration;

using Xunit;

namespace FsusBlog.Migration.Tests;

public sealed class OfflineMigrationPlanTests
{
    // These are contract fixtures, not registered production source baselines or backup proofs.
    // The real provider/backup owners must supply complete observations before CLI admission.
    private const string DigestA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string DigestB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private static readonly DateTimeOffset AdmissionTime = new(2026, 10, 2, 0, 0, 0, TimeSpan.Zero);

    [Theory]
    [InlineData(CurrentSchemaProviderKind.PostgreSql, false)]
    [InlineData(CurrentSchemaProviderKind.MySql, false)]
    [InlineData(CurrentSchemaProviderKind.Sqlite, false)]
    [InlineData(CurrentSchemaProviderKind.PostgreSql, true)]
    [InlineData(CurrentSchemaProviderKind.MySql, true)]
    [InlineData(CurrentSchemaProviderKind.Sqlite, true)]
    public void Plan_KnownCompleteContractObservationsFreezeSharedDag(CurrentSchemaProviderKind provider, bool old)
    {
        Fixture fixture = CreateFixture(provider, old);
        OfflineMigrationPlan plan = fixture.Build();
        Assert.Equal(old ? "old" : "empty", plan.SourceFingerprintId);
        Assert.Equal(new[] { "entry", "finish" }, plan.OrderedSteps.Select(step => step.StepId));
        Assert.Equal(provider, plan.Source.Database.Provider);
        Assert.All(plan.OrderedSteps, step => Assert.Equal(3, step.Operations.Length));
        Assert.Equal(plan, fixture.Verify(plan).Plan);
    }

    [Fact]
    public void Plan_ObservationOrderAndInvocationTimeDoNotAlterContentBytes()
    {
        Fixture fixture = CreateFixture(CurrentSchemaProviderKind.PostgreSql, true);
        OfflineMigrationPlan first = fixture.Build();
        Fixture reordered = fixture with
        {
            Source = fixture.Source with { Schema = fixture.Source.Schema.Reverse().ToImmutableArray() },
            Dag = fixture.Dag with { Steps = fixture.Dag.Steps.Reverse().ToImmutableArray() },
            Backup = fixture.Backup with { ArtifactDigests = fixture.Backup.ArtifactDigests.Reverse().ToImmutableArray() }
        };
        Assert.Equal(OfflineMigrationPlanValidation.Serialize(first), OfflineMigrationPlanValidation.Serialize(reordered.Build(AdmissionTime.AddMinutes(1))));
    }

    [Fact]
    public void CompletedApply_UsesAuthenticatedCaptureAndOriginalAdmissionWithActualArtifactBytes()
    {
        Fixture fixture = CreateFixture(CurrentSchemaProviderKind.PostgreSql, true);
        OfflineMigrationPlan plan = fixture.Build();
        byte[] bytes = OfflineMigrationPlanCodec.Serialize(plan);
        var artifact = new CurrentSchemaArtifactReference("contract-plan", Convert.ToHexStringLower(SHA256.HashData(bytes)));
        Assert.NotEqual(plan.ContentDigest, artifact.Sha256);
        Assert.Equal(plan, OfflineMigrationPlanVerifier.VerifyForCompletedApplyBindings(plan, bytes, artifact,
            fixture.Backup, fixture.Target, fixture.Tool, fixture.Registry, fixture.Dag, AdmissionTime, TimeSpan.FromHours(24)).Plan);
        Assert.Throws<InvalidOperationException>(() => OfflineMigrationPlanVerifier.VerifyForCompletedApplyBindings(plan,
            bytes.Concat(new byte[] { 10 }).ToArray(), artifact, fixture.Backup, fixture.Target, fixture.Tool,
            fixture.Registry, fixture.Dag, AdmissionTime, TimeSpan.FromHours(24)));
        Assert.Throws<InvalidOperationException>(() => OfflineMigrationPlanVerifier.VerifyForCompletedApplyBindings(plan,
            bytes, artifact with { Sha256 = plan.ContentDigest }, fixture.Backup, fixture.Target, fixture.Tool,
            fixture.Registry, fixture.Dag, AdmissionTime, TimeSpan.FromHours(24)));
        Assert.Throws<InvalidOperationException>(() => OfflineMigrationPlanVerifier.VerifyForCompletedApplyBindings(plan,
            bytes, artifact, fixture.Backup with { SourceAtCapture = fixture.Source with { ContentDigest = DigestB } },
            fixture.Target, fixture.Tool, fixture.Registry, fixture.Dag, AdmissionTime, TimeSpan.FromHours(24)));
        Assert.Throws<InvalidOperationException>(() => OfflineMigrationPlanVerifier.VerifyForCompletedApplyBindings(plan,
            bytes, artifact, fixture.Backup, fixture.Target, fixture.Tool, fixture.Registry, fixture.Dag,
            AdmissionTime.AddDays(2), TimeSpan.FromHours(24)));
    }

    [Fact]
    public void Plan_RegistryInputOrderDoesNotAlterRegistryOrContentDigest()
    {
        Fixture fixture = CreateFixture(CurrentSchemaProviderKind.PostgreSql, true);
        OfflineMigrationPlan first = fixture.Build();
        var reordered = new OfflineMigrationSourceRegistry("v1", Definitions().Reverse().Select(entry => entry with
        {
            Providers = entry.Providers.Reverse().Select(shape => shape with
            {
                Schema = shape.Schema.Reverse().ToImmutableArray()
            }).ToImmutableArray()
        }).ToImmutableArray());
        Assert.Equal(fixture.Registry.Digest, reordered.Digest);
        Assert.Equal(first.ContentDigest, (fixture with { Registry = reordered }).Build().ContentDigest);
    }

    [Fact]
    public async Task OwnedEvidence_ReadsActualSourceAndOwnedInvocationRestoreObservationsBeforeFreezing()
    {
        Fixture fixture = CreateFixture(CurrentSchemaProviderKind.PostgreSql, true);
        EvidenceFixture evidence = new(fixture);
        VerifiedOfflineMigrationPlan verified = await OfflineMigrationPlanEvidence.ReadAndVerifyAsync(
            evidence.Options, evidence.CreateReader(), CancellationToken.None);
        Assert.Equal(fixture.Source, verified.Plan.Source);
        Assert.Equal(evidence.Backup.RestoredSource, verified.Plan.Backup.RestoredSource);
        Assert.Equal(new[] { "source.env" }, evidence.SourceConnections);
        Assert.Equal(1, evidence.Inspections);
        Assert.Equal(2, evidence.AuthorityReads);
    }

    [Fact]
    public async Task OwnedEvidence_MatchesActualRouteBeforeAndAfterTerminalAuthorityRead()
    {
        Fixture fixture = CreateFixture(CurrentSchemaProviderKind.PostgreSql, true);
        var evidence = new EvidenceFixture(fixture);
        var route = new MatchedRouteFixture(fixture);
        _ = await OfflineMigrationPlanEvidence.ReadAndVerifyAsync(evidence.Options,
            evidence.CreateReader(route), CancellationToken.None);
        Assert.Equal(2, route.Matches);
        Assert.Equal(new[] { fixture.Source, fixture.Source }, route.Sources);
    }

    [Theory]
    [InlineData("fingerprint")]
    [InlineData("dag")]
    [InlineData("ordered-steps")]
    [InlineData("terminal")]
    public async Task OwnedEvidence_RejectsMatchedRouteDriftWithoutSubstitutingPlanSteps(string drift)
    {
        Fixture fixture = CreateFixture(CurrentSchemaProviderKind.PostgreSql, true);
        var evidence = new EvidenceFixture(fixture);
        var route = new MatchedRouteFixture(fixture) { Drift = drift };
        Assert.Equal("offline_plan_matched_source_route_changed", (await Assert.ThrowsAsync<InvalidOperationException>(() =>
            OfflineMigrationPlanEvidence.ReadAndVerifyAsync(evidence.Options, evidence.CreateReader(route),
                CancellationToken.None))).Message);
        Assert.Equal(drift == "terminal" ? 2 : 1, route.Matches);
    }

    // Structural route controls, not actual compiled provider or native capabilities.
    private sealed class MatchedRouteFixture(Fixture fixture) : IOfflineMigrationMatchedSourceRoute
    {
        internal string? Drift { get; init; }
        internal int Matches { get; private set; }
        internal List<OfflineMigrationSourceObservation> Sources { get; } = [];

        public OfflineMigrationSourceRouteSelection MatchSource(OfflineMigrationSourceObservation source, CancellationToken token)
        {
            token.ThrowIfCancellationRequested();
            Sources.Add(source);
            Matches++;
            OfflineMigrationFingerprintDefinition fingerprint = fixture.Registry.Match(source);
            OfflineMigrationDag dag = fixture.Dag;
            ImmutableArray<OfflineMigrationStep> steps = OfflineMigrationPlanValidation.OrderSteps(dag, fingerprint.EntryStepId);
            return new(Drift == "fingerprint" ? fingerprint with { Id = "changed-route" } : fingerprint,
                Drift == "dag" || Drift == "terminal" && Matches == 2 ? dag with { Version = "changed-route" } : dag,
                Drift == "ordered-steps" ? [] : steps);
        }
    }

    [Theory]
    [InlineData("source")]
    [InlineData("restore")]
    [InlineData("manifest")]
    [InlineData("authority")]
    public async Task OwnedEvidence_RejectsActualSourceRestoreAuthenticatedReferenceOrAuthorityDrift(string drift)
    {
        var evidence = new EvidenceFixture(CreateFixture(CurrentSchemaProviderKind.PostgreSql, true)) { Drift = drift };
        await Assert.ThrowsAsync<InvalidOperationException>(() => OfflineMigrationPlanEvidence.ReadAndVerifyAsync(
            evidence.Options, evidence.CreateReader(), CancellationToken.None));
        Assert.Equal(1, evidence.Inspections);
    }

    [Fact]
    public async Task OwnedEvidence_MissingCompleteTargetRefusesBeforeCredentialBackupOrNativeReads()
    {
        var evidence = new EvidenceFixture(CreateFixture(CurrentSchemaProviderKind.PostgreSql, true)) { Drift = "missing-capability" };
        Assert.Equal("contract_complete_target_missing", (await Assert.ThrowsAsync<InvalidOperationException>(() =>
            OfflineMigrationPlanEvidence.ReadAndVerifyAsync(evidence.Options, evidence.CreateReader(), CancellationToken.None))).Message);
        Assert.Equal(0, evidence.Inspections);
        Assert.Empty(evidence.SourceConnections);
    }

    [Fact]
    public void Plan_OneColumnDriftReportsExactDifferenceWithoutNearestBaseline()
    {
        Fixture fixture = CreateFixture(CurrentSchemaProviderKind.PostgreSql, true);
        var changed = fixture.Source with { Schema = [new("table.article", "present"), new("column.article.id", "text")] };
        OfflineMigrationSourceFingerprintException failure = Assert.Throws<OfflineMigrationSourceFingerprintException>(() => fixture.Registry.Match(changed));
        Assert.Equal("source_fingerprint_unknown", failure.Code);
        Assert.Contains(failure.Differences, difference => difference.BaselineIdSha256 == OfflineMigrationSourceFingerprintException.HashText("old")
            && difference.Category == OfflineMigrationFingerprintCategory.Schema
            && difference.Kind == OfflineMigrationFingerprintDifferenceKind.Changed
            && difference.FactNameSha256 == OfflineMigrationSourceFingerprintException.HashText("column.article.id")
            && difference.ExpectedValueSha256 == OfflineMigrationSourceFingerprintException.HashText("uuid")
            && difference.ActualValueSha256 == OfflineMigrationSourceFingerprintException.HashText("text")
            && difference.ExpectedFactCount == 2 && difference.ActualFactCount == 2);
    }

    [Fact]
    public void Plan_PartialAndCombinedBaselinesAreUnknown()
    {
        Fixture fixture = CreateFixture(CurrentSchemaProviderKind.MySql, true);
        var partial = fixture.Source with { History = ImmutableArray<OfflineMigrationFact>.Empty };
        Assert.Equal("source_fingerprint_unknown", Assert.Throws<OfflineMigrationSourceFingerprintException>(() => fixture.Registry.Match(partial)).Code);
        var combined = fixture.Source with { BusinessShape = [new("article.identity", "legacy"), new("unregistered.column", "present")] };
        Assert.Equal("source_fingerprint_unknown", Assert.Throws<OfflineMigrationSourceFingerprintException>(() => fixture.Registry.Match(combined)).Code);
    }

    [Fact]
    public void Plan_AmbiguousExactBaselinesAreRejected()
    {
        Fixture fixture = CreateFixture(CurrentSchemaProviderKind.Sqlite, true);
        ImmutableArray<OfflineMigrationFingerprintDefinition> definitions = Definitions();
        var ambiguous = new OfflineMigrationSourceRegistry("v1", definitions.Add(definitions[1] with { Id = "duplicate-shape" }));
        OfflineMigrationSourceFingerprintException failure = Assert.Throws<OfflineMigrationSourceFingerprintException>(() => ambiguous.Match(fixture.Source));
        Assert.Equal("source_fingerprint_ambiguous", failure.Code);
        Assert.Empty(failure.Differences);
        Assert.Equal(new[] { "old", "duplicate-shape" }.Select(OfflineMigrationSourceFingerprintException.HashText)
            .OrderBy(value => value, StringComparer.Ordinal), failure.AmbiguousBaselineIdSha256s);
    }

    [Fact]
    public void Plan_UnobservedCategoryAndDuplicateFactsAreRejected()
    {
        Fixture fixture = CreateFixture(CurrentSchemaProviderKind.PostgreSql, false);
        Assert.Equal("source_observation_category_missing", Assert.Throws<InvalidOperationException>(() =>
            fixture.Registry.Match(fixture.Source with { Schema = default })).Message);
        Assert.Equal("source_observation_duplicate_or_null", Assert.Throws<InvalidOperationException>(() =>
            fixture.Registry.Match(fixture.Source with { Schema = [new("x", "a"), new("x", "b")] })).Message);
    }

    [Fact]
    public void Plan_DestructiveStepWithoutBackupIsRejected()
    {
        Fixture fixture = CreateFixture(CurrentSchemaProviderKind.PostgreSql, true);
        Assert.Contains(fixture.Dag.Steps, step => step.Destructive);
        Assert.Equal("offline_backup_required", Assert.Throws<InvalidOperationException>(() =>
            (fixture with { Backup = null! }).Build()).Message);
    }

    [Theory]
    [InlineData(-25, -24)]
    [InlineData(1, 2)]
    [InlineData(-1, -2)]
    public void Plan_StaleFutureOrUnverifiedBackupIsRejected(int capturedHours, int restoredHours)
    {
        Fixture fixture = CreateFixture(CurrentSchemaProviderKind.PostgreSql, true);
        var backup = fixture.Backup with
        {
            CapturedAt = AdmissionTime.AddHours(capturedHours),
            RestoreVerifiedAt = AdmissionTime.AddHours(restoredHours)
        };
        Assert.Equal("offline_backup_stale_or_unverified", Assert.Throws<InvalidOperationException>(() => (fixture with { Backup = backup }).Build()).Message);
    }

    [Fact]
    public void Plan_BackupForAnotherDatabaseAndPartialArtifactClosureAreRejected()
    {
        Fixture fixture = CreateFixture(CurrentSchemaProviderKind.PostgreSql, true);
        var other = fixture.Backup with
        {
            SourceAtCapture = fixture.Source with { Database = fixture.Source.Database with { DatabaseId = "other" } }
        };
        Assert.Equal("offline_backup_source_database_mismatch", Assert.Throws<InvalidOperationException>(() => (fixture with { Backup = other }).Build()).Message);
        var partial = fixture.Backup with { ArtifactDigests = fixture.Backup.ArtifactDigests.RemoveAt(0) };
        Assert.Equal("offline_backup_artifact_closure_invalid", Assert.Throws<InvalidOperationException>(() => (fixture with { Backup = partial }).Build()).Message);
    }

    [Fact]
    public void Plan_BackupMustMatchCurrentShapeAndActuallyIsolatedRestoreShape()
    {
        Fixture fixture = CreateFixture(CurrentSchemaProviderKind.PostgreSql, true);
        var drift = fixture.Backup with { SourceAtCapture = fixture.Source with { History = [] } };
        Assert.Equal("offline_backup_source_database_mismatch", Assert.Throws<InvalidOperationException>(() => (fixture with { Backup = drift }).Build()).Message);
        var active = fixture.Backup with { RestoredSource = fixture.Source };
        Assert.Equal("offline_backup_restore_not_isolated_or_changed", Assert.Throws<InvalidOperationException>(() => (fixture with { Backup = active }).Build()).Message);
        var changedRestore = fixture.Backup with { RestoredSource = fixture.Backup.RestoredSource with { History = [] } };
        Assert.Equal("offline_backup_restore_not_isolated_or_changed", Assert.Throws<InvalidOperationException>(() => (fixture with { Backup = changedRestore }).Build()).Message);
    }

    [Fact]
    public void Plan_EqualShapeAndEqualLengthDataChangesInvalidateCapturedSource()
    {
        Fixture fixture = CreateFixture(CurrentSchemaProviderKind.PostgreSql, true);
        OfflineMigrationSourceObservation changed = fixture.Source with { ContentDigest = DigestB };
        Assert.Empty(OfflineMigrationPlanValidation.Differences(
            OfflineMigrationPlanValidation.Shape(fixture.Source), OfflineMigrationPlanValidation.Shape(changed)));
        Assert.Equal("old", fixture.Registry.Match(changed).Id);
        Assert.Equal("offline_backup_source_database_mismatch", Assert.Throws<InvalidOperationException>(() =>
            (fixture with { Source = changed }).Build()).Message);
    }

    [Fact]
    public void Plan_RestoredDataContentMustMatchCapturedSnapshotNotOnlyShape()
    {
        Fixture fixture = CreateFixture(CurrentSchemaProviderKind.PostgreSql, true);
        var changed = fixture.Backup with { RestoredSource = fixture.Backup.RestoredSource with { ContentDigest = DigestB } };
        Assert.Equal("offline_backup_restore_not_isolated_or_changed", Assert.Throws<InvalidOperationException>(() =>
            (fixture with { Backup = changed }).Build()).Message);
    }

    [Fact]
    public void Plan_CaptureAndRestoreDumpDigestsMustBindOriginalDatabaseArtifact()
    {
        Fixture fixture = CreateFixture(CurrentSchemaProviderKind.PostgreSql, true);
        Assert.Equal("offline_backup_snapshot_dump_binding_mismatch", Assert.Throws<InvalidOperationException>(() =>
            (fixture with { Backup = fixture.Backup with { DatabaseDumpSha256 = DigestB } }).Build()).Message);
        Assert.Equal("offline_backup_snapshot_dump_binding_mismatch", Assert.Throws<InvalidOperationException>(() =>
            (fixture with { Backup = fixture.Backup with { RestoredDatabaseDumpSha256 = DigestB } }).Build()).Message);
        Assert.Equal("offline_backup_snapshot_identity_missing", Assert.Throws<InvalidOperationException>(() =>
            (fixture with { Backup = fixture.Backup with { CaptureSnapshotId = "" } }).Build()).Message);
    }

    [Theory]
    [InlineData("duplicate")]
    [InlineData("missing")]
    [InlineData("cycle")]
    [InlineData("disconnected")]
    public void Plan_DagClosureRejectsDuplicateMissingCyclicAndDisconnectedSteps(string mutation)
    {
        Fixture fixture = CreateFixture(CurrentSchemaProviderKind.Sqlite, true);
        ImmutableArray<OfflineMigrationStep> steps = mutation switch
        {
            "duplicate" => fixture.Dag.Steps.Add(fixture.Dag.Steps[0]),
            "missing" => [fixture.Dag.Steps[0], fixture.Dag.Steps[1] with { Dependencies = ["missing"] }],
            "cycle" => [fixture.Dag.Steps[0] with { Dependencies = ["finish"] }, fixture.Dag.Steps[1]],
            "disconnected" => [fixture.Dag.Steps[0], fixture.Dag.Steps[1] with { Dependencies = [] }],
            _ => throw new InvalidOperationException()
        };
        Assert.Throws<InvalidOperationException>(() => (fixture with { Dag = fixture.Dag with { Steps = steps } }).Build());
    }

    [Fact]
    public void Plan_ProviderSemanticDivergenceAndMissingProviderAreRejected()
    {
        Fixture fixture = CreateFixture(CurrentSchemaProviderKind.MySql, true);
        OfflineMigrationStep entry = fixture.Dag.Steps[0];
        var divergent = entry with { Operations = entry.Operations.SetItem(1, entry.Operations[1] with { SemanticDigest = DigestB }) };
        Assert.Equal("offline_step_provider_semantics_diverge", Assert.Throws<InvalidOperationException>(() =>
            (fixture with { Dag = fixture.Dag with { Steps = fixture.Dag.Steps.SetItem(0, divergent) } }).Build()).Message);
        var missing = entry with { Operations = entry.Operations.RemoveAt(0) };
        Assert.Equal("offline_plan_provider_closure_invalid", Assert.Throws<InvalidOperationException>(() =>
            (fixture with { Dag = fixture.Dag with { Steps = fixture.Dag.Steps.SetItem(0, missing) } }).Build()).Message);
    }

    [Fact]
    public void Verify_TargetToolAndFreshSourceDriftAreRejectedEvenWithResealedPayload()
    {
        Fixture fixture = CreateFixture(CurrentSchemaProviderKind.PostgreSql, true);
        OfflineMigrationPlan plan = fixture.Build();
        Assert.Equal("offline_plan_target_or_tool_changed", Assert.Throws<InvalidOperationException>(() =>
            fixture.Verify(Reseal(plan with { Target = plan.Target with { ContentDigest = DigestB } }))).Message);
        Assert.Equal("offline_plan_target_or_tool_changed", Assert.Throws<InvalidOperationException>(() =>
            fixture.Verify(Reseal(plan with { Tool = plan.Tool with { ConfigurationDigest = DigestB } }))).Message);
        Assert.Equal("offline_plan_source_changed", Assert.Throws<InvalidOperationException>(() =>
            (fixture with { Source = fixture.Source with { Database = fixture.Source.Database with { DatabaseId = "other" } },
                Backup = fixture.Backup with { SourceAtCapture = fixture.Source with { Database = fixture.Source.Database with { DatabaseId = "other" } } } }).Verify(plan)).Message);
    }

    [Theory]
    [InlineData("fingerprint")]
    [InlineData("registry")]
    [InlineData("order")]
    [InlineData("resume")]
    [InlineData("operation")]
    [InlineData("precondition")]
    [InlineData("destructive")]
    public void Verify_ResealedFingerprintStepsAndRediscoveryFieldsCannotChangeAuthority(string mutation)
    {
        Fixture fixture = CreateFixture(CurrentSchemaProviderKind.PostgreSql, true);
        OfflineMigrationPlan plan = fixture.Build();
        OfflineMigrationStep step = plan.OrderedSteps[0];
        OfflineMigrationPlan changed = mutation switch
        {
            "fingerprint" => plan with { SourceFingerprintId = "empty" },
            "registry" => plan with { SourceRegistryDigest = DigestB },
            "order" => plan with { OrderedSteps = plan.OrderedSteps.Reverse().ToImmutableArray() },
            "resume" => plan with { OrderedSteps = plan.OrderedSteps.SetItem(0, step with { ResumePolicy = step.ResumePolicy with { ReplayPostcondition = "omitted" } }) },
            "operation" => plan with { OrderedSteps = plan.OrderedSteps.SetItem(0, step with { Operations = step.Operations.SetItem(0, step.Operations[0] with { OperationReference = "unregistered" }) }) },
            "precondition" => plan with { OrderedSteps = plan.OrderedSteps.SetItem(0, step with { SourcePrecondition = "" }) },
            "destructive" => plan with { OrderedSteps = plan.OrderedSteps.SetItem(0, step with { Destructive = false }) },
            _ => throw new InvalidOperationException()
        };
        Assert.Equal("offline_plan_authority_or_steps_changed", Assert.Throws<InvalidOperationException>(() => fixture.Verify(Reseal(changed))).Message);
    }

    [Fact]
    public void Verify_BackupReferenceTamperAndDigestTamperAreRejected()
    {
        Fixture fixture = CreateFixture(CurrentSchemaProviderKind.Sqlite, true);
        OfflineMigrationPlan plan = fixture.Build();
        var changed = plan with { Backup = plan.Backup with { Package = new("another-package", DigestB) } };
        Assert.Equal("offline_plan_backup_changed", Assert.Throws<InvalidOperationException>(() => fixture.Verify(Reseal(changed))).Message);
        Assert.Equal("offline_plan_digest_mismatch", Assert.Throws<InvalidOperationException>(() => fixture.Verify(plan with { ContentDigest = DigestB })).Message);
    }

    [Fact]
    public void Plan_ArtifactHashBindsCompleteBytesNotSelfExcludedContentDigest()
    {
        OfflineMigrationPlan plan = CreateFixture(CurrentSchemaProviderKind.PostgreSql, true).Build();
        string actualArtifactSha256 = Convert.ToHexStringLower(SHA256.HashData(OfflineMigrationPlanCodec.Serialize(plan)));
        Assert.NotEqual(plan.ContentDigest, actualArtifactSha256);
        Assert.Equal(plan.ContentDigest, OfflineMigrationPlanCodec.ComputeContentDigest(plan));
    }

    private static OfflineMigrationPlan Reseal(OfflineMigrationPlan plan)
        => plan with { ContentDigest = OfflineMigrationPlanValidation.ComputeContentDigest(plan) };

    private static ImmutableArray<OfflineMigrationFingerprintDefinition> Definitions()
    {
        return [Definition("empty", false), Definition("old", true)];

        static OfflineMigrationFingerprintDefinition Definition(string id, bool old)
            => new(id, "v1", "contract-test-only", ["OfflineMigrationPlanTests"], "entry",
                Enum.GetValues<CurrentSchemaProviderKind>().Select(provider => OfflineMigrationPlanValidation.Shape(Source(provider, old))).ToImmutableArray());
    }

    private static OfflineMigrationSourceObservation Source(CurrentSchemaProviderKind provider, bool old)
        => new(new(provider, "source-instance", "source-database"), "contract-fixture", "v1",
            old ? [new("table.article", "present"), new("column.article.id", "uuid")] : [],
            old ? [new("migration.original", "checksum:succeeded")] : [],
            old ? [new("article.identity", "legacy")] : [], DigestA);

    private static Fixture CreateFixture(CurrentSchemaProviderKind provider, bool old)
    {
        OfflineMigrationSourceObservation source = Source(provider, old);
        var backup = new OfflineMigrationBackupObservation(
            new("package", DigestA), new("manifest", DigestA), new("drill", DigestA),
            "contract-test-only", "v1", AdmissionTime.AddHours(-1), AdmissionTime.AddMinutes(-1),
            "contract-snapshot", DigestA, DigestA, source,
            source with { Database = new(provider, "isolated-instance", "restore-database") },
            [new("database", DigestA), new("uploads", DigestA), new("dataProtectionKeyRing", DigestA),
                new("configRedacted", DigestA), new("aotCache", DigestA), new("searchIndex", DigestA)]);
        var target = new CurrentSchemaTargetIdentity("model", "extractor", "generator", DigestA, DigestA);
        var tool = new CurrentSchemaVerifierIdentity(new string('a', 40), DigestA, DigestA, DigestA);
        var operations = Enum.GetValues<CurrentSchemaProviderKind>().Select(value => new OfflineMigrationProviderOperation(
            value, $"contract-operation:{value}", DigestA, DigestA, OfflineMigrationExecutionMode.Transaction)).ToImmutableArray();
        var resume = new OfflineMigrationResumePolicy("v1", 0, "transaction", "postcondition:replay");
        var dag = new OfflineMigrationDag("contract-dag", "v1",
            [new("entry", "source:exact", "target:entry", [], "idempotency:entry", true, resume, operations),
                new("finish", "target:entry", "target:current", ["entry"], "idempotency:finish", false, resume, operations)]);
        return new(source, backup, target, tool, new("v1", Definitions()), dag);
    }

    // Pure owner-port fixtures, not authenticated packages, native databases or actual targets.
    private sealed class EvidenceFixture : IOfflineMigrationSourceObserver,
        IOfflineMigrationOwnedBackupAdmission, IOfflineMigrationPlanningAuthorityReader
    {
        private readonly Fixture _fixture;
        internal EvidenceFixture(Fixture fixture)
        {
            _fixture = fixture;
            Options = new(fixture.Source.Database, "source.env", Path.GetFullPath("contract-package"),
                Path.GetFullPath("contract-manifest"), Path.GetFullPath("contract-drill"), "restore.env",
                Path.GetFullPath("contract-plan"), 30);
            Backup = fixture.Backup with
            {
                Package = new(Options.BackupPackagePath, DigestA),
                Manifest = new(Options.BackupManifestPath, DigestA),
                RestoreDrill = new(Options.RestoreDrillPath, DigestA),
                BackupOwner = "tools/operations/backup-site.sh",
                BackupOwnerVersion = "3"
            };
        }

        internal OfflineMigrationPlanCommandOptions Options { get; }
        internal OfflineMigrationBackupObservation Backup { get; }
        internal string? Drift { get; init; }
        internal List<string> SourceConnections { get; } = [];
        internal int Inspections { get; private set; }
        internal int AuthorityReads { get; private set; }
        internal IOfflineMigrationPlanningEvidence CreateReader(IOfflineMigrationMatchedSourceRoute? route = null)
            => new OfflineMigrationOwnedPlanningEvidence(this, this, this, _fixture.Registry,
                (path, token) => { token.ThrowIfCancellationRequested(); return Task.FromResult(path); }, new AdmissionClock(), route);

        public Task<OfflineMigrationBackupObservation> ReadAndVerifyAsync(OfflineMigrationPlanCommandOptions options, CancellationToken token)
        {
            token.ThrowIfCancellationRequested();
            Assert.Equal(Options, options);
            Inspections++;
            OfflineMigrationBackupObservation result = Drift == "manifest"
                ? Backup with { Manifest = new(Path.GetFullPath("another-manifest"), DigestA) }
                : Drift == "restore" ? Backup with { RestoredSource = Backup.RestoredSource with { ContentDigest = DigestB } } : Backup;
            return Task.FromResult(result);
        }

        public Task<OfflineMigrationSourceObservation> ObserveAsync(CurrentSchemaProviderKind provider, string connectionString, CancellationToken token)
        {
            token.ThrowIfCancellationRequested();
            Assert.Equal(_fixture.Source.Database.Provider, provider);
            SourceConnections.Add(connectionString);
            OfflineMigrationSourceObservation source = _fixture.Source;
            if (Drift == "source" && connectionString == "source.env")
            {
                source = source with { ContentDigest = DigestB };
            }
            return Task.FromResult(source);
        }

        public Task<OfflineMigrationPlanningAuthority> ReadAsync(CurrentSchemaProviderKind provider, CancellationToken token)
        {
            token.ThrowIfCancellationRequested();
            AuthorityReads++;
            if (Drift == "missing-capability")
            {
                throw new InvalidOperationException("contract_complete_target_missing");
            }
            var target = Drift == "authority" && AuthorityReads == 2
                ? _fixture.Target with { SourceDigest = DigestB } : _fixture.Target;
            return Task.FromResult(new OfflineMigrationPlanningAuthority(target, _fixture.Tool, _fixture.Dag, TimeSpan.FromHours(24)));
        }

        private sealed class AdmissionClock : TimeProvider
        {
            public override DateTimeOffset GetUtcNow() => AdmissionTime;
        }
    }

    private sealed record Fixture(
        OfflineMigrationSourceObservation Source,
        OfflineMigrationBackupObservation Backup,
        CurrentSchemaTargetIdentity Target,
        CurrentSchemaVerifierIdentity Tool,
        OfflineMigrationSourceRegistry Registry,
        OfflineMigrationDag Dag)
    {
        internal OfflineMigrationPlan Build(DateTimeOffset? time = null)
            => OfflineMigrationPlanBuilder.Create(Source, Backup, Target, Tool, Registry, Dag, time ?? AdmissionTime, TimeSpan.FromHours(24));

        internal VerifiedOfflineMigrationPlan Verify(OfflineMigrationPlan plan)
            => OfflineMigrationPlanVerifier.Verify(plan, Source, Backup, Target, Tool, Registry, Dag, AdmissionTime, TimeSpan.FromHours(24));
    }
}
