using System.Collections.Immutable;
using System.Security.Cryptography;

using FsusBlog.Contracts.Migration;
using FsusBlog.Contracts.Schema;

using Xunit;

namespace FsusBlog.Migration.Tests;

public sealed class OfflineMigrationPlanTests
{
    // These are contract fixtures, not registered production source baselines or backup proofs.
    // The real provider/backup owners must supply complete observations before CLI admission.
    private const string DigestA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string DigestB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private static readonly DateTimeOffset s_admissionTime = new(2026, 10, 2, 0, 0, 0, TimeSpan.Zero);

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
            Source = fixture.Source with
            {
                Schema = fixture.Source.Schema.Reverse().ToImmutableArray()
            },
            Dag = fixture.Dag with
            {
                Steps = fixture.Dag.Steps.Reverse().ToImmutableArray()
            },
            Backup = fixture.Backup with
            {
                ArtifactDigests = fixture.Backup.ArtifactDigests.Reverse().ToImmutableArray()
            }
        };
        Assert.Equal(OfflineMigrationPlanValidation.Serialize(first), OfflineMigrationPlanValidation.Serialize(reordered.Build(s_admissionTime.AddMinutes(1))));
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
            fixture.Backup, fixture.Target, fixture.Tool, fixture.Registry, fixture.Dag, s_admissionTime, TimeSpan.FromHours(24)).Plan);
        Assert.Throws<InvalidOperationException>(() => OfflineMigrationPlanVerifier.VerifyForCompletedApplyBindings(plan,
            bytes.Concat(new byte[] { 10 }).ToArray(), artifact, fixture.Backup, fixture.Target, fixture.Tool,
            fixture.Registry, fixture.Dag, s_admissionTime, TimeSpan.FromHours(24)));
        Assert.Throws<InvalidOperationException>(() => OfflineMigrationPlanVerifier.VerifyForCompletedApplyBindings(plan,
            bytes, artifact with
            {
                Sha256 = plan.ContentDigest
            }, fixture.Backup, fixture.Target, fixture.Tool,
            fixture.Registry, fixture.Dag, s_admissionTime, TimeSpan.FromHours(24)));
        Assert.Throws<InvalidOperationException>(() => OfflineMigrationPlanVerifier.VerifyForCompletedApplyBindings(plan,
            bytes, artifact, fixture.Backup with
            {
                SourceAtCapture = fixture.Source with
                {
                    ContentDigest = DigestB
                }
            },
            fixture.Target, fixture.Tool, fixture.Registry, fixture.Dag, s_admissionTime, TimeSpan.FromHours(24)));
        Assert.Throws<InvalidOperationException>(() => OfflineMigrationPlanVerifier.VerifyForCompletedApplyBindings(plan,
            bytes, artifact, fixture.Backup, fixture.Target, fixture.Tool, fixture.Registry, fixture.Dag,
            s_admissionTime.AddDays(2), TimeSpan.FromHours(24)));
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
        Assert.Equal(first.ContentDigest, (fixture with
        {
            Registry = reordered
        }).Build().ContentDigest);
    }

    [Fact]
    public void Plan_OneColumnDriftReportsExactDifferenceWithoutNearestBaseline()
    {
        Fixture fixture = CreateFixture(CurrentSchemaProviderKind.PostgreSql, true);
        var changed = fixture.Source with
        {
            Schema = [new("table.article", "present"), new("column.article.id", "text")]
        };
        string message = Assert.Throws<InvalidOperationException>(() => fixture.Registry.Match(changed)).Message;
        Assert.StartsWith("source_fingerprint_unknown:", message);
        Assert.Contains("old:schema:changed:column.article.id:expected=uuid:actual=text", message);
    }

    [Fact]
    public void Plan_PartialAndCombinedBaselinesAreUnknown()
    {
        Fixture fixture = CreateFixture(CurrentSchemaProviderKind.MySql, true);
        var partial = fixture.Source with
        {
            History = ImmutableArray<OfflineMigrationFact>.Empty
        };
        Assert.StartsWith("source_fingerprint_unknown:", Assert.Throws<InvalidOperationException>(() => fixture.Registry.Match(partial)).Message);
        var combined = fixture.Source with
        {
            BusinessShape = [new("article.identity", "legacy"), new("unregistered.column", "present")]
        };
        Assert.StartsWith("source_fingerprint_unknown:", Assert.Throws<InvalidOperationException>(() => fixture.Registry.Match(combined)).Message);
    }

    [Fact]
    public void Plan_AmbiguousExactBaselinesAreRejected()
    {
        Fixture fixture = CreateFixture(CurrentSchemaProviderKind.Sqlite, true);
        ImmutableArray<OfflineMigrationFingerprintDefinition> definitions = Definitions();
        var ambiguous = new OfflineMigrationSourceRegistry("v1", definitions.Add(definitions[1] with
        {
            Id = "duplicate-shape"
        }));
        Assert.StartsWith("source_fingerprint_ambiguous:", Assert.Throws<InvalidOperationException>(() => ambiguous.Match(fixture.Source)).Message);
    }

    [Fact]
    public void Plan_UnobservedCategoryAndDuplicateFactsAreRejected()
    {
        Fixture fixture = CreateFixture(CurrentSchemaProviderKind.PostgreSql, false);
        Assert.Equal("source_observation_category_missing", Assert.Throws<InvalidOperationException>(() =>
            fixture.Registry.Match(fixture.Source with
            {
                Schema = default
            })).Message);
        Assert.Equal("source_observation_duplicate_or_null", Assert.Throws<InvalidOperationException>(() =>
            fixture.Registry.Match(fixture.Source with
            {
                Schema = [new("x", "a"), new("x", "b")]
            })).Message);
    }

    [Fact]
    public void Plan_DestructiveStepWithoutBackupIsRejected()
    {
        Fixture fixture = CreateFixture(CurrentSchemaProviderKind.PostgreSql, true);
        Assert.Contains(fixture.Dag.Steps, step => step.Destructive);
        Assert.Equal("offline_backup_required", Assert.Throws<InvalidOperationException>(() =>
            (fixture with
            {
                Backup = null!
            }).Build()).Message);
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
            CapturedAt = s_admissionTime.AddHours(capturedHours),
            RestoreVerifiedAt = s_admissionTime.AddHours(restoredHours)
        };
        Assert.Equal("offline_backup_stale_or_unverified", Assert.Throws<InvalidOperationException>(() => (fixture with { Backup = backup }).Build()).Message);
    }

    [Fact]
    public void Plan_BackupForAnotherDatabaseAndPartialArtifactClosureAreRejected()
    {
        Fixture fixture = CreateFixture(CurrentSchemaProviderKind.PostgreSql, true);
        var other = fixture.Backup with
        {
            SourceAtCapture = fixture.Source with
            {
                Database = fixture.Source.Database with
                {
                    DatabaseId = "other"
                }
            }
        };
        Assert.Equal("offline_backup_source_database_mismatch", Assert.Throws<InvalidOperationException>(() => (fixture with { Backup = other }).Build()).Message);
        var partial = fixture.Backup with
        {
            ArtifactDigests = fixture.Backup.ArtifactDigests.RemoveAt(0)
        };
        Assert.Equal("offline_backup_artifact_closure_invalid", Assert.Throws<InvalidOperationException>(() => (fixture with { Backup = partial }).Build()).Message);
    }

    [Fact]
    public void Plan_BackupMustMatchCurrentShapeAndActuallyIsolatedRestoreShape()
    {
        Fixture fixture = CreateFixture(CurrentSchemaProviderKind.PostgreSql, true);
        var drift = fixture.Backup with
        {
            SourceAtCapture = fixture.Source with
            {
                History = []
            }
        };
        Assert.Equal("offline_backup_source_database_mismatch", Assert.Throws<InvalidOperationException>(() => (fixture with { Backup = drift }).Build()).Message);
        var active = fixture.Backup with
        {
            RestoredSource = fixture.Source
        };
        Assert.Equal("offline_backup_restore_not_isolated_or_changed", Assert.Throws<InvalidOperationException>(() => (fixture with { Backup = active }).Build()).Message);
        var changedRestore = fixture.Backup with
        {
            RestoredSource = fixture.Backup.RestoredSource with
            {
                History = []
            }
        };
        Assert.Equal("offline_backup_restore_not_isolated_or_changed", Assert.Throws<InvalidOperationException>(() => (fixture with { Backup = changedRestore }).Build()).Message);
    }

    [Fact]
    public void Plan_EqualShapeAndEqualLengthDataChangesInvalidateCapturedSource()
    {
        Fixture fixture = CreateFixture(CurrentSchemaProviderKind.PostgreSql, true);
        OfflineMigrationSourceObservation changed = fixture.Source with
        {
            ContentDigest = DigestB
        };
        Assert.Empty(OfflineMigrationPlanValidation.Differences(
            OfflineMigrationPlanValidation.Shape(fixture.Source), OfflineMigrationPlanValidation.Shape(changed)));
        Assert.Equal("old", fixture.Registry.Match(changed).Id);
        Assert.Equal("offline_backup_source_database_mismatch", Assert.Throws<InvalidOperationException>(() =>
            (fixture with
            {
                Source = changed
            }).Build()).Message);
    }

    [Fact]
    public void Plan_RestoredDataContentMustMatchCapturedSnapshotNotOnlyShape()
    {
        Fixture fixture = CreateFixture(CurrentSchemaProviderKind.PostgreSql, true);
        var changed = fixture.Backup with
        {
            RestoredSource = fixture.Backup.RestoredSource with
            {
                ContentDigest = DigestB
            }
        };
        Assert.Equal("offline_backup_restore_not_isolated_or_changed", Assert.Throws<InvalidOperationException>(() =>
            (fixture with
            {
                Backup = changed
            }).Build()).Message);
    }

    [Fact]
    public void Plan_CaptureAndRestoreDumpDigestsMustBindOriginalDatabaseArtifact()
    {
        Fixture fixture = CreateFixture(CurrentSchemaProviderKind.PostgreSql, true);
        Assert.Equal("offline_backup_snapshot_dump_binding_mismatch", Assert.Throws<InvalidOperationException>(() =>
            (fixture with
            {
                Backup = fixture.Backup with
                {
                    DatabaseDumpSha256 = DigestB
                }
            }).Build()).Message);
        Assert.Equal("offline_backup_snapshot_dump_binding_mismatch", Assert.Throws<InvalidOperationException>(() =>
            (fixture with
            {
                Backup = fixture.Backup with
                {
                    RestoredDatabaseDumpSha256 = DigestB
                }
            }).Build()).Message);
        Assert.Equal("offline_backup_snapshot_identity_missing", Assert.Throws<InvalidOperationException>(() =>
            (fixture with
            {
                Backup = fixture.Backup with
                {
                    CaptureSnapshotId = ""
                }
            }).Build()).Message);
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
        var divergent = entry with
        {
            Operations = entry.Operations.SetItem(1, entry.Operations[1] with
            {
                SemanticDigest = DigestB
            })
        };
        Assert.Equal("offline_step_provider_semantics_diverge", Assert.Throws<InvalidOperationException>(() =>
            (fixture with
            {
                Dag = fixture.Dag with
                {
                    Steps = fixture.Dag.Steps.SetItem(0, divergent)
                }
            }).Build()).Message);
        var missing = entry with
        {
            Operations = entry.Operations.RemoveAt(0)
        };
        Assert.Equal("offline_plan_provider_closure_invalid", Assert.Throws<InvalidOperationException>(() =>
            (fixture with
            {
                Dag = fixture.Dag with
                {
                    Steps = fixture.Dag.Steps.SetItem(0, missing)
                }
            }).Build()).Message);
    }

    [Fact]
    public void Verify_TargetToolAndFreshSourceDriftAreRejectedEvenWithResealedPayload()
    {
        Fixture fixture = CreateFixture(CurrentSchemaProviderKind.PostgreSql, true);
        OfflineMigrationPlan plan = fixture.Build();
        Assert.Equal("offline_plan_target_or_tool_changed", Assert.Throws<InvalidOperationException>(() =>
            fixture.Verify(Reseal(plan with
            {
                Target = plan.Target with
                {
                    ContentDigest = DigestB
                }
            }))).Message);
        Assert.Equal("offline_plan_target_or_tool_changed", Assert.Throws<InvalidOperationException>(() =>
            fixture.Verify(Reseal(plan with
            {
                Tool = plan.Tool with
                {
                    ConfigurationDigest = DigestB
                }
            }))).Message);
        Assert.Equal("offline_plan_source_changed", Assert.Throws<InvalidOperationException>(() =>
            (fixture with
            {
                Source = fixture.Source with
                {
                    Database = fixture.Source.Database with
                    {
                        DatabaseId = "other"
                    }
                },
                Backup = fixture.Backup with
                {
                    SourceAtCapture = fixture.Source with
                    {
                        Database = fixture.Source.Database with
                        {
                            DatabaseId = "other"
                        }
                    }
                }
            }).Verify(plan)).Message);
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
        var changed = plan with
        {
            Backup = plan.Backup with
            {
                Package = new("another-package", DigestB)
            }
        };
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

    [Fact]
    public void Verify_CurrentControlTargetVersionChangeRejectsOriginalValidPlanWithoutResealing()
    {
        Fixture previous = CreateFixture(CurrentSchemaProviderKind.PostgreSql, true);
        previous = previous with
        {
            Target = previous.Target with
            {
                ModelVersion = "fsusblog.current-schema.v2",
                ExtractorVersion = "fsusblog.current-schema-reflection.v2",
                GeneratorVersion = "fsusblog.current-schema-projection.v2"
            }
        };
        OfflineMigrationPlan old = previous.Build();
        Assert.Equal(old, previous.Verify(old).Plan);
        byte[] original = OfflineMigrationPlanCodec.Serialize(old);
        Fixture current = previous with
        {
            Target = previous.Target with
            {
                ModelVersion = CurrentSchemaCanonicalAuthority.ModelVersion,
                GeneratorVersion = CurrentSchemaCanonicalAuthority.GeneratorVersion,
                SourceDigest = DigestB,
                ContentDigest = CurrentSchemaCanonicalAuthority.ComputeContentDigest(new Dictionary<string, SchemaTableModel>
                {
                    [CurrentSchemaControlShape.ApplyJournalTableName] = CurrentSchemaControlShape.DescribeApplyJournal()
                })
            }
        };
        Assert.Equal("offline_plan_target_or_tool_changed", Assert.Throws<InvalidOperationException>(() => current.Verify(old)).Message);
        Assert.Equal(original, OfflineMigrationPlanCodec.Serialize(old));
    }

    private static OfflineMigrationPlan Reseal(OfflineMigrationPlan plan)
        => plan with
        {
            ContentDigest = OfflineMigrationPlanValidation.ComputeContentDigest(plan)
        };

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
            "contract-test-only", "v1", s_admissionTime.AddHours(-1), s_admissionTime.AddMinutes(-1),
            "contract-snapshot", DigestA, DigestA, source,
            source with
            {
                Database = new(provider, "isolated-instance", "restore-database")
            },
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

    private sealed record Fixture(
        OfflineMigrationSourceObservation Source,
        OfflineMigrationBackupObservation Backup,
        CurrentSchemaTargetIdentity Target,
        CurrentSchemaVerifierIdentity Tool,
        OfflineMigrationSourceRegistry Registry,
        OfflineMigrationDag Dag)
    {
        internal OfflineMigrationPlan Build(DateTimeOffset? time = null)
            => OfflineMigrationPlanBuilder.Create(Source, Backup, Target, Tool, Registry, Dag, time ?? s_admissionTime, TimeSpan.FromHours(24));

        internal VerifiedOfflineMigrationPlan Verify(OfflineMigrationPlan plan)
            => OfflineMigrationPlanVerifier.Verify(plan, Source, Backup, Target, Tool, Registry, Dag, s_admissionTime, TimeSpan.FromHours(24));
    }
}
