using System.Collections.Immutable;
using System.Data.Common;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using NSubstitute;

using FsusBlog.Contracts.Migration;
using FsusBlog.Contracts.SchemaMigration;

using Xunit;

namespace FsusBlog.Migration.Tests;

// These are production-validator refusal/positive controls, not native issuer
// success fixtures. No fake connection, operation or backup signs a receipt here.
public sealed class OfflineMigrationCurrentSchemaIssuerTests
{
    private static readonly DateTimeOffset s_recordedAt = new(2026, 10, 3, 0, 0, 0, TimeSpan.Zero);
    private static readonly string s_digest = new('a', 64);

    // Component lifecycle doubles call the original helper. They do not model
    // Npgsql protocol state, native ReadyForQuery failure or receipt qualification.
    [Theory]
    [InlineData(true, false)]
    [InlineData(false, true)]
    [InlineData(true, true)]
    public async Task NativeIdentityCleanup_PreservesOriginalValidationRefusal(bool readerFails, bool commandFails)
    {
        NativeIdentityLifecycleFixture fixture = CreateNativeIdentityLifecycleFixture("blog ");
        ConfigureNativeIdentityCleanup(fixture, readerFails, commandFails);
        InvalidOperationException expected = Assert.Throws<InvalidOperationException>(() =>
            CurrentSchemaReceiptCodec.ValidateDatabase(new(CurrentSchemaProviderKind.PostgreSql, "123", "456/blog ")));
        InvalidOperationException actual = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            OfflineMigrationCurrentSchemaIssuer.ReadNativeIdentityAsync(fixture.Connection, fixture.Transaction, default));
        Assert.Equal(expected.Message, actual.Message);
        Assert.Contains(nameof(OfflineMigrationCurrentSchemaIssuer.ReadNativeIdentityAsync), actual.StackTrace);
        AssertNativeIdentityCleanupCodes(actual, readerFails, commandFails);
        AssertNativeIdentityLifecycle(fixture);
    }

    [Theory]
    [InlineData(true, false)]
    [InlineData(false, true)]
    [InlineData(true, true)]
    public async Task NativeIdentityCleanup_RefusesWhenOnlyCleanupFails(bool readerFails, bool commandFails)
    {
        NativeIdentityLifecycleFixture fixture = CreateNativeIdentityLifecycleFixture("blog");
        ConfigureNativeIdentityCleanup(fixture, readerFails, commandFails);
        Exception actual = await Assert.ThrowsAnyAsync<Exception>(() =>
            OfflineMigrationCurrentSchemaIssuer.ReadNativeIdentityAsync(fixture.Connection, fixture.Transaction, default));
        Assert.Same(readerFails ? fixture.ReaderCleanupFailure : fixture.CommandCleanupFailure, actual);
        AssertNativeIdentityCleanupCodes(actual, readerFails, commandFails);
        AssertNativeIdentityLifecycle(fixture);
    }

    [Fact]
    public async Task NativeIdentityCleanup_PreservesExactBodyCancellationAndToken()
    {
        NativeIdentityLifecycleFixture fixture = CreateNativeIdentityLifecycleFixture("blog");
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        var first = new OperationCanceledException("fixture_body_cancellation", cancellation.Token);
        fixture.Reader.ReadAsync(Arg.Any<CancellationToken>()).Returns(Task.FromException<bool>(first));
        ConfigureNativeIdentityCleanup(fixture, readerFails: true, commandFails: true);
        OperationCanceledException actual = await Assert.ThrowsAsync<OperationCanceledException>(() =>
            OfflineMigrationCurrentSchemaIssuer.ReadNativeIdentityAsync(fixture.Connection, fixture.Transaction, cancellation.Token));
        Assert.Same(first, actual);
        Assert.Equal(cancellation.Token, actual.CancellationToken);
        AssertNativeIdentityCleanupCodes(actual, readerFails: true, commandFails: true);
        AssertNativeIdentityLifecycle(fixture);
    }

    [Fact]
    public async Task NativeIdentityCleanup_DisposesCommandWhenReaderCreationFails()
    {
        NativeIdentityLifecycleFixture fixture = CreateNativeIdentityLifecycleFixture("blog");
        var first = new InvalidOperationException("fixture_execute_failure");
        fixture.Command.ExecuteReaderAsync(Arg.Any<CancellationToken>()).Returns(Task.FromException<DbDataReader>(first));
        ConfigureNativeIdentityCleanup(fixture, readerFails: true, commandFails: true);
        InvalidOperationException actual = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            OfflineMigrationCurrentSchemaIssuer.ReadNativeIdentityAsync(fixture.Connection, fixture.Transaction, default));
        Assert.Same(first, actual);
        AssertNativeIdentityCleanupCodes(actual, readerFails: false, commandFails: true);
        AssertNativeIdentityLifecycle(fixture, readerCreated: false);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task NativeIdentityCleanup_AwaitsReaderThenCommandBeforeReturningOrThrowing(bool bodyRefuses)
    {
        NativeIdentityLifecycleFixture fixture = CreateNativeIdentityLifecycleFixture(bodyRefuses ? "blog " : "blog");
        var readerEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var readerFinished = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var commandEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var commandFinished = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        fixture.Reader.DisposeAsync().Returns(_ =>
        {
            readerEntered.SetResult();
            return new ValueTask(readerFinished.Task);
        });
        fixture.Command.DisposeAsync().Returns(_ =>
        {
            commandEntered.SetResult();
            return new ValueTask(commandFinished.Task);
        });
        Task<CurrentSchemaDatabaseIdentity> operation = OfflineMigrationCurrentSchemaIssuer.ReadNativeIdentityAsync(
            fixture.Connection, fixture.Transaction, default);
        try
        {
            await readerEntered.Task;
            Assert.False(operation.IsCompleted);
            Assert.False(commandEntered.Task.IsCompleted);
            if (bodyRefuses)
            {
                readerFinished.SetException(fixture.ReaderCleanupFailure);
            }
            else
            {
                readerFinished.SetResult();
            }
            await commandEntered.Task;
            Assert.False(operation.IsCompleted);
            if (bodyRefuses)
            {
                commandFinished.SetException(fixture.CommandCleanupFailure);
                InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(() => operation);
                Assert.Equal("current_receipt_text_invalid", failure.Message);
                AssertNativeIdentityCleanupCodes(failure, readerFails: true, commandFails: true);
            }
            else
            {
                commandFinished.SetResult();
                Assert.Equal(new CurrentSchemaDatabaseIdentity(CurrentSchemaProviderKind.PostgreSql, "123", "456/blog"), await operation);
            }
            AssertNativeIdentityLifecycle(fixture);
        }
        finally
        {
            readerFinished.TrySetResult();
            commandFinished.TrySetResult();
        }
    }

    [Theory]
    [InlineData("blog")]
    [InlineData("blog ")]
    public async Task NativeIdentityCleanup_KeepsOrdinaryIdentityAndRefusalControls(string databaseName)
    {
        NativeIdentityLifecycleFixture fixture = CreateNativeIdentityLifecycleFixture(databaseName);
        if (databaseName == "blog")
        {
            Assert.Equal(new CurrentSchemaDatabaseIdentity(CurrentSchemaProviderKind.PostgreSql, "123", "456/blog"),
                await OfflineMigrationCurrentSchemaIssuer.ReadNativeIdentityAsync(fixture.Connection, fixture.Transaction, default));
        }
        else
        {
            InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(() =>
                OfflineMigrationCurrentSchemaIssuer.ReadNativeIdentityAsync(fixture.Connection, fixture.Transaction, default));
            Assert.Equal("current_receipt_text_invalid", failure.Message);
            Assert.False(failure.Data.Contains(OfflineMigrationCurrentSchemaIssuer.NativeIdentityCleanupFailuresKey));
        }
        AssertNativeIdentityLifecycle(fixture);
    }

    private static NativeIdentityLifecycleFixture CreateNativeIdentityLifecycleFixture(string databaseName)
    {
        DbConnection connection = Substitute.For<DbConnection>();
        DbTransaction transaction = Substitute.For<DbTransaction>();
        DbCommand command = Substitute.For<DbCommand>();
        DbDataReader reader = Substitute.For<DbDataReader>();
        connection.CreateCommand().Returns(command);
        command.ExecuteReaderAsync(Arg.Any<CancellationToken>()).Returns(Task.FromResult(reader));
        reader.ReadAsync(Arg.Any<CancellationToken>()).Returns(Task.FromResult(true), Task.FromResult(false));
        reader.GetString(0).Returns("123");
        reader.GetString(1).Returns("456");
        reader.GetString(2).Returns(databaseName);
        reader.DisposeAsync().Returns(ValueTask.CompletedTask);
        command.DisposeAsync().Returns(ValueTask.CompletedTask);
        return new(connection, transaction, command, reader,
            new IOException("fixture_reader_secondary_secret"),
            new InvalidOperationException("fixture_command_secondary_secret"));
    }

    private static void ConfigureNativeIdentityCleanup(NativeIdentityLifecycleFixture fixture, bool readerFails, bool commandFails)
    {
        if (readerFails)
        {
            fixture.Reader.DisposeAsync().Returns(ValueTask.FromException(fixture.ReaderCleanupFailure));
        }
        if (commandFails)
        {
            fixture.Command.DisposeAsync().Returns(ValueTask.FromException(fixture.CommandCleanupFailure));
        }
    }

    private static void AssertNativeIdentityCleanupCodes(Exception failure, bool readerFails, bool commandFails)
    {
        ImmutableArray<string> actual = Assert.IsType<ImmutableArray<string>>(
            failure.Data[OfflineMigrationCurrentSchemaIssuer.NativeIdentityCleanupFailuresKey]);
        var expected = new List<string>();
        if (readerFails)
        {
            expected.Add("current_verify_native_identity_reader_cleanup_failed");
        }
        if (commandFails)
        {
            expected.Add("current_verify_native_identity_command_cleanup_failed");
        }
        Assert.Equal(expected, actual);
        Assert.DoesNotContain(actual, value => value.Contains("secondary_secret", StringComparison.Ordinal));
    }

    private static void AssertNativeIdentityLifecycle(NativeIdentityLifecycleFixture fixture, bool readerCreated = true)
    {
        Assert.Same(fixture.Transaction, fixture.Command.Transaction);
        Assert.Equal("""
            SELECT control.system_identifier::text, database_identity.oid::text, current_database()::text
            FROM pg_catalog.pg_control_system() AS control
            CROSS JOIN pg_catalog.pg_database AS database_identity
            WHERE database_identity.datname = current_database()
            """, fixture.Command.CommandText);
        Assert.Equal(readerCreated ? 1 : 0,
            fixture.Reader.ReceivedCalls().Count(call => call.GetMethodInfo().Name == nameof(DbDataReader.DisposeAsync)));
        Assert.Single(fixture.Command.ReceivedCalls(), call => call.GetMethodInfo().Name == nameof(DbCommand.DisposeAsync));
        fixture.Transaction.DidNotReceive().Commit();
        fixture.Transaction.DidNotReceive().Rollback();
        fixture.Connection.DidNotReceive().Open();
    }

    private sealed record NativeIdentityLifecycleFixture(DbConnection Connection, DbTransaction Transaction,
        DbCommand Command, DbDataReader Reader, Exception ReaderCleanupFailure, Exception CommandCleanupFailure);

    [Theory]
    [InlineData("original-bytes")]
    [InlineData("semantic-seal-is-not-file-sha")]
    [InlineData("mutated-file")]
    [InlineData("empty-file")]
    [InlineData("oversized-file")]
    public async Task OwnedArtifactReader_ReadsOriginalFileAndBindsWholeBytes(string variant)
    {
        Fixture fixture = CreateFixture();
        byte[] original = OfflineMigrationPlanCodec.Serialize(fixture.Plan);
        string sha256 = Convert.ToHexStringLower(SHA256.HashData(original));
        Assert.NotEqual(fixture.Plan.ContentDigest, sha256);
        string directory = Path.Combine(Path.GetTempPath(), $"fsusblog-current-artifact-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        string path = Path.Combine(directory, "sealed-plan.json");
        try
        {
            await File.WriteAllBytesAsync(path, original);
            var reference = new CurrentSchemaArtifactReference(path, sha256);
            IOfflineMigrationVerificationArtifactReader reader = OfflineMigrationCurrentSchemaVerificationOwners.CreateOwnedArtifactReader();
            ReadOnlyMemory<byte> observed = await reader.ReadAsync(reference, CancellationToken.None);
            Assert.Equal(original, observed.ToArray());
            if (variant == "original-bytes")
            {
                return;
            }
            if (variant == "semantic-seal-is-not-file-sha")
            {
                reference = reference with
                {
                    Sha256 = fixture.Plan.ContentDigest
                };
            }
            else
            {
                byte[] changed = variant switch
                {
                    "mutated-file" => [.. original, (byte)' '],
                    "empty-file" => [],
                    "oversized-file" => new byte[CurrentSchemaReceiptCodec.MaximumEncodedBytes + 1],
                    _ => throw new InvalidOperationException("Unknown file mutation.")
                };
                await File.WriteAllBytesAsync(path, changed);
            }
            await Assert.ThrowsAsync<InvalidOperationException>(() => reader.ReadAsync(reference, CancellationToken.None));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Theory]
    [InlineData("relative")]
    [InlineData("latest")]
    [InlineData("cancelled")]
    public async Task OwnedArtifactReader_RefusesDiscoveryAndCancellationBeforeFileAccess(string variant)
    {
        IOfflineMigrationVerificationArtifactReader reader = OfflineMigrationCurrentSchemaVerificationOwners.CreateOwnedArtifactReader();
        using var cancellation = new CancellationTokenSource();
        if (variant == "cancelled")
        {
            cancellation.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => reader.ReadAsync(
                new("relative-plan.json", s_digest), cancellation.Token));
            return;
        }
        string path = variant == "relative" ? "relative-plan.json"
            : Path.Combine(Path.GetTempPath(), "latest", "sealed-plan.json");
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() => reader.ReadAsync(
            new(path, s_digest), CancellationToken.None));
        Assert.Equal("current_verify_original_artifact_path_required", error.Message);
    }

    [Fact]
    public async Task NormalIssuer_RefusesMissingOwnersBeforeNativeAccessOrArtifactPublication()
    {
        Fixture fixture = CreateFixture();
        OfflineMigrationCurrentSchemaIssuer.ValidateRequest(fixture.Request);

        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            OfflineMigrationCurrentSchemaIssuer.IssueArtifactAsync(fixture.Request, null!, CancellationToken.None));

        Assert.Equal("current_verify_native_owners_not_configured", error.Message);
    }

    [Fact]
    public async Task NormalIssuer_CancellationDoesNotLookUpOwnersOrReadArtifacts()
    {
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            OfflineMigrationCurrentSchemaIssuer.IssueArtifactAsync(CreateFixture().Request, null!, cancellation.Token));
    }

    [Fact]
    public async Task IndependentVerifier_DoesNotTreatReceiptExistenceAsConfiguredNativeOwners()
    {
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            OfflineMigrationCurrentSchemaIssuer.VerifyExistingAsync(new("fixture-receipt", s_digest),
                CreateFixture().Request, null!, CancellationToken.None));

        Assert.Equal("current_verify_native_owners_not_configured", error.Message);
    }

    [Theory]
    [InlineData("unobserved-physical-schema")]
    [InlineData("cross-instance")]
    [InlineData("cross-database")]
    [InlineData("target-source")]
    [InlineData("target-content")]
    public void CurrentObservation_BindsOwnedTargetAndSoleNativeSessionIdentity(string invalid)
    {
        Fixture fixture = CreateFixture();
        var observed = new CurrentSchemaAdmissionObservation(fixture.Plan.Target, fixture.Request.Database, s_digest);
        OfflineMigrationCurrentSchemaIssuer.ValidateCurrentObservation(observed, fixture.Request.Database, fixture.Plan.Target);
        CurrentSchemaAdmissionObservation changed = invalid switch
        {
            "unobserved-physical-schema" => observed with { ActualSchemaDigest = string.Empty },
            "cross-instance" => observed with { Database = observed.Database with { InstanceId = "other-instance" } },
            "cross-database" => observed with { Database = observed.Database with { DatabaseId = "other-database" } },
            "target-source" => observed with { Target = observed.Target with { SourceDigest = new string('b', 64) } },
            "target-content" => observed with { Target = observed.Target with { ContentDigest = new string('b', 64) } },
            _ => throw new InvalidOperationException("Unknown current-observation mutation.")
        };

        Assert.Throws<InvalidOperationException>(() => OfflineMigrationCurrentSchemaIssuer.ValidateCurrentObservation(
            changed, fixture.Request.Database, fixture.Plan.Target));
    }

    [Theory]
    [InlineData("physical-schema")]
    [InlineData("target-shape")]
    [InlineData("semantic-vector")]
    [InlineData("verifier-source")]
    [InlineData("rejected-status")]
    public void IndependentReceiptComparison_RejectsResealedClaimsAgainstReobservedFacts(string invalid)
    {
        Fixture fixture = CreateFixture();
        CurrentSchemaReceipt observed = CreateReceiptMetadata(fixture);
        OfflineMigrationCurrentSchemaIssuer.ValidateObservedReceipt(observed, observed);
        CurrentSchemaReceipt changed = invalid switch
        {
            "physical-schema" => observed with { ActualSchemaDigest = new string('b', 64) },
            "target-shape" => observed with { Target = observed.Target with { ContentDigest = new string('b', 64) } },
            "semantic-vector" => observed with
            {
                SemanticPostconditions = [observed.SemanticPostconditions[0] with { EvidenceDigest = new string('b', 64) }]
            },
            "verifier-source" => observed with { Verifier = observed.Verifier with { SourceRevision = new string('b', 40) } },
            "rejected-status" => observed with { Status = CurrentSchemaReceiptStatus.Rejected, Reasons = ["postcondition_failed"] },
            _ => throw new InvalidOperationException("Unknown receipt mutation.")
        };
        changed = changed with
        {
            ContentDigest = CurrentSchemaReceiptCodec.ComputeContentDigest(changed)
        };

        Assert.Throws<InvalidOperationException>(() => OfflineMigrationCurrentSchemaIssuer.ValidateObservedReceipt(changed, observed));
    }

    [Theory]
    [InlineData("latest-plan")]
    [InlineData("latest-checkpoint")]
    [InlineData("unknown-provider")]
    [InlineData("unsupported-provider")]
    [InlineData("empty-checkpoints")]
    [InlineData("default-checkpoints")]
    [InlineData("duplicate-checkpoints")]
    [InlineData("invalid-invocation")]
    public void RequestAdmission_RequiresClosedExplicitNativeInputs(string invalid)
    {
        Fixture fixture = CreateFixture();
        OfflineMigrationCurrentSchemaIssuer.ValidateRequest(fixture.Request);
        OfflineMigrationCurrentSchemaVerifyRequest changed = invalid switch
        {
            "latest-plan" => fixture.Request with { Plan = fixture.Request.Plan with { Reference = "offline-plan/latest" } },
            "latest-checkpoint" => fixture.Request with
            {
                Checkpoints = [fixture.Request.Checkpoints[0] with { Reference = "checkpoint/latest" }]
            },
            "unknown-provider" => fixture.Request with
            {
                Database = fixture.Request.Database with
                {
                    Provider = (CurrentSchemaProviderKind)999
                }
            },
            "unsupported-provider" => fixture.Request with
            {
                Database = fixture.Request.Database with
                {
                    Provider = CurrentSchemaProviderKind.MySql
                }
            },
            "empty-checkpoints" => fixture.Request with { Checkpoints = [] },
            "default-checkpoints" => fixture.Request with { Checkpoints = default },
            "duplicate-checkpoints" => fixture.Request with
            {
                Checkpoints = [fixture.Request.Checkpoints[0], fixture.Request.Checkpoints[0]]
            },
            "invalid-invocation" => fixture.Request with { InvocationId = "invocation\n" },
            _ => throw new InvalidOperationException("Unknown request mutation.")
        };

        Assert.Throws<InvalidOperationException>(() => OfflineMigrationCurrentSchemaIssuer.ValidateRequest(changed));
    }

    [Theory]
    [InlineData("partial")]
    [InlineData("recovery-required")]
    [InlineData("unknown-status")]
    [InlineData("warning")]
    [InlineData("missing-step")]
    [InlineData("cross-database")]
    [InlineData("wrong-plan-artifact")]
    [InlineData("wrong-plan-semantic-seal")]
    [InlineData("wrong-terminal-checkpoint")]
    [InlineData("wrong-invocation")]
    public void ReportedApplyAdmission_DoesNotTrustStatusOrPartialClosure(string invalid)
    {
        Fixture fixture = CreateFixture();
        OfflineMigrationCurrentSchemaIssuer.ValidateReportedApply(
            fixture.Request, fixture.Plan, fixture.Apply, [fixture.Checkpoint]);
        OfflineMigrationApplyResult changed = invalid switch
        {
            "partial" => fixture.Apply with { Status = OfflineMigrationApplyStatus.Failed },
            "recovery-required" => fixture.Apply with { Status = OfflineMigrationApplyStatus.RecoveryRequired },
            "unknown-status" => fixture.Apply with { Status = (OfflineMigrationApplyStatus)999 },
            "warning" => fixture.Apply with { Codes = ["warning"] },
            "missing-step" => fixture.Apply with { StepProofs = [] },
            "cross-database" => fixture.Apply with { Database = fixture.Apply.Database with { DatabaseId = "other" } },
            "wrong-plan-artifact" => fixture.Apply with { Plan = fixture.Apply.Plan with { Sha256 = new string('b', 64) } },
            "wrong-plan-semantic-seal" => fixture.Apply with { PlanContentDigest = new string('b', 64) },
            "wrong-terminal-checkpoint" => fixture.Apply with
            {
                Checkpoint = fixture.Checkpoint with
                {
                    Sequence = fixture.Checkpoint.Sequence - 1
                }
            },
            "wrong-invocation" => fixture.Apply with
            {
                Checkpoint = fixture.Checkpoint with
                {
                    InvocationId = "other-invocation"
                }
            },
            _ => throw new InvalidOperationException("Unknown apply mutation.")
        };

        Assert.Throws<InvalidOperationException>(() => OfflineMigrationCurrentSchemaIssuer.ValidateReportedApply(
            fixture.Request, fixture.Plan, changed, [fixture.Checkpoint]));
    }

    [Theory]
    [InlineData("empty")]
    [InlineData("changed-bytes")]
    [InlineData("semantic-as-artifact-sha")]
    public void ArtifactAdmission_BindsOriginalWholeFileBytesNotSemanticSeal(string invalid)
    {
        Fixture fixture = CreateFixture();
        byte[] bytes = OfflineMigrationPlanCodec.Serialize(fixture.Plan);
        OfflineMigrationCurrentSchemaIssuer.ValidateArtifactBytes(fixture.Request.Plan, bytes);
        Assert.NotEqual(fixture.Plan.ContentDigest, fixture.Request.Plan.Sha256);
        CurrentSchemaArtifactReference reference = fixture.Request.Plan;
        ReadOnlyMemory<byte> changed = bytes;
        switch (invalid)
        {
            case "empty":
                changed = ReadOnlyMemory<byte>.Empty;
                break;
            case "changed-bytes":
                changed = new byte[] { (byte)' ' }.Concat(bytes).ToArray();
                break;
            case "semantic-as-artifact-sha":
                reference = reference with
                {
                    Sha256 = fixture.Plan.ContentDigest
                };
                break;
        }

        Assert.Throws<InvalidOperationException>(() => OfflineMigrationCurrentSchemaIssuer.ValidateArtifactBytes(reference, changed));
    }

    [Fact]
    public void CheckpointArtifactSha_IsSeparateFromItsSemanticEntryAnchor()
    {
        Fixture fixture = CreateFixture();
        byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(fixture.Checkpoint);

        OfflineMigrationCurrentSchemaIssuer.ValidateArtifactBytes(fixture.Request.Checkpoints[0], bytes);
        OfflineMigrationApplyCheckpoint decoded = OfflineMigrationCurrentSchemaIssuer.DecodeArtifact<OfflineMigrationApplyCheckpoint>(bytes);

        Assert.Equal(fixture.Checkpoint, decoded);
        Assert.NotEqual(decoded.JournalHead.EntryDigest, fixture.Request.Checkpoints[0].Sha256);
        Assert.Equal(OfflineMigrationApplyJournalVerifier.Reference(fixture.Journal.Last!), decoded.JournalHead);
    }

    [Theory]
    [InlineData("unknown-field")]
    [InlineData("duplicate-status")]
    [InlineData("missing-status")]
    public void ArtifactDecoder_RejectsAmbiguousOrDefaultedApplyStatus(string invalid)
    {
        Fixture fixture = CreateFixture();
        string json = JsonSerializer.Serialize(fixture.Apply);
        Assert.Equal(fixture.Apply.Status,
            OfflineMigrationCurrentSchemaIssuer.DecodeArtifact<OfflineMigrationApplyResult>(Encoding.UTF8.GetBytes(json)).Status);
        string changed = invalid switch
        {
            "unknown-field" => "{\"Unknown\":true," + json[1..],
            "duplicate-status" => "{\"Status\":0," + json[1..],
            "missing-status" => json.Replace("\"Status\":0,", string.Empty, StringComparison.Ordinal),
            _ => throw new InvalidOperationException("Unknown JSON mutation.")
        };
        Assert.NotEqual(json, changed);

        Assert.ThrowsAny<Exception>(() => OfflineMigrationCurrentSchemaIssuer.DecodeArtifact<OfflineMigrationApplyResult>(
            Encoding.UTF8.GetBytes(changed)));
    }

    [Theory]
    [InlineData("foreign-key")]
    [InlineData("row-count")]
    [InlineData("digest")]
    [InlineData("missing-dimension")]
    [InlineData("unobserved")]
    [InlineData("wrong-predicate")]
    [InlineData("wrong-operation-owner")]
    [InlineData("wrong-owner-source")]
    [InlineData("wrong-semantic-implementation")]
    public void PostconditionAdmission_RequiresActualFactsAndRecordedExpectedVector(string invalid)
    {
        Fixture fixture = CreateFixture();
        OfflineMigrationStep step = fixture.Plan.OrderedSteps[0];
        OfflineMigrationProviderOperation owner = step.Operations[0];
        OfflineMigrationPredicateObservation valid = fixture.Apply.StepProofs[0].After!;
        OfflineMigrationCurrentSchemaIssuer.ValidatePostcondition(step.TargetPostcondition, owner, valid, valid);
        OfflineMigrationPredicateObservation changed = invalid switch
        {
            "foreign-key" => valid with { ActualFacts = ReplaceFact(valid.ActualFacts, "foreign-keys", "1") },
            "row-count" => valid with { ActualFacts = ReplaceFact(valid.ActualFacts, "rows", "1") },
            "digest" => valid with { ActualFacts = ReplaceFact(valid.ActualFacts, "digest", new string('b', 64)) },
            "missing-dimension" => valid with
            {
                ExpectedFacts = valid.ExpectedFacts.Where(fact => fact.Name != "identity").ToImmutableArray(),
                ActualFacts = valid.ActualFacts.Where(fact => fact.Name != "identity").ToImmutableArray()
            },
            "unobserved" => valid with { ExpectedFacts = [], ActualFacts = [] },
            "wrong-predicate" => valid with { PredicateReference = "unknown-predicate" },
            "wrong-operation-owner" => valid with { OperationReference = "unknown-operation" },
            "wrong-owner-source" => valid with { OperationSourceDigest = new string('b', 64) },
            "wrong-semantic-implementation" => valid with { SemanticDigest = new string('b', 64) },
            _ => throw new InvalidOperationException("Unknown postcondition mutation.")
        };
        changed = Seal(changed);

        Assert.Throws<InvalidOperationException>(() => OfflineMigrationCurrentSchemaIssuer.ValidatePostcondition(
            step.TargetPostcondition, owner, changed, valid));
    }

    [Fact]
    public void NativeProofComparison_RejectsResealedReportedProofSubstitution()
    {
        Fixture fixture = CreateFixture();
        OfflineMigrationCurrentSchemaIssuer.ValidateNativeProofs(fixture.Plan, fixture.Apply, fixture.Journal);
        OfflineMigrationApplyJournalEntry changed = fixture.Apply.StepProofs[0] with
        {
            RecordedAt = s_recordedAt.AddTicks(1)
        };
        changed = Seal(changed);
        OfflineMigrationApplyResult substituted = fixture.Apply with
        {
            StepProofs = [changed]
        };

        Assert.Throws<InvalidOperationException>(() => OfflineMigrationCurrentSchemaIssuer.ValidateNativeProofs(
            fixture.Plan, substituted, fixture.Journal));
    }

    [Theory]
    [InlineData("missing-time")]
    [InlineData("non-utc")]
    [InlineData("wrong-sequence")]
    [InlineData("non-genesis")]
    public void FirstAdmission_RequiresOriginalSealedFirstAttemptUtcBoundary(string invalid)
    {
        Fixture fixture = CreateFixture();
        OfflineMigrationCurrentSchemaIssuer.ValidateFirstAdmission(fixture.Plan, fixture.Request, fixture.First);
        OfflineMigrationApplyJournalEntry changed = invalid switch
        {
            "missing-time" => fixture.First with { RecordedAt = default },
            "non-utc" => fixture.First with { RecordedAt = s_recordedAt.ToOffset(TimeSpan.FromHours(1)) },
            "wrong-sequence" => fixture.First with { Sequence = 2 },
            "non-genesis" => fixture.First with { PreviousDigest = new string('b', 64) },
            _ => throw new InvalidOperationException("Unknown first-admission mutation.")
        };
        changed = Seal(changed);

        Assert.Throws<InvalidOperationException>(() => OfflineMigrationCurrentSchemaIssuer.ValidateFirstAdmission(
            fixture.Plan, fixture.Request, changed));
    }

    private static Fixture CreateFixture()
    {
        // Synthetic closed records exercise the real binding predicates only.
        // They are never supplied to IssueAsync as native/backup capabilities.
        var database = new CurrentSchemaDatabaseIdentity(CurrentSchemaProviderKind.PostgreSql, "instance", "database");
        var source = new OfflineMigrationSourceObservation(database, "extractor", "v1", [], [], [], s_digest);
        var backupRef = new CurrentSchemaArtifactReference("fixture-backup", s_digest);
        var backup = new OfflineMigrationBackupObservation(backupRef, backupRef, backupRef, "fixture-owner", "v1",
            s_recordedAt, s_recordedAt, "fixture-snapshot", s_digest, s_digest,
            source, source with
            {
                Database = database with
                {
                    DatabaseId = "restored"
                }
            },
            new[] { "aotCache", "configRedacted", "dataProtectionKeyRing", "database", "searchIndex", "uploads" }
                .Select(name => new OfflineMigrationFact(name, s_digest)).ToImmutableArray());
        var step = new OfflineMigrationStep("owned-step", "owned-source", "owned-target", [], "owned-idempotency", false,
            new("v1", 0, "owned-watermark", "owned-replay"),
            Enum.GetValues<CurrentSchemaProviderKind>().Select(provider => new OfflineMigrationProviderOperation(
                provider, "fixture-operation", s_digest, s_digest, OfflineMigrationExecutionMode.Transaction)).ToImmutableArray());
        var registry = new OfflineMigrationSourceRegistry("v1",
            [new("fixture-profile", "v1", "fixture-owner", [nameof(PostconditionAdmission_RequiresActualFactsAndRecordedExpectedVector)],
                step.StepId, Enum.GetValues<CurrentSchemaProviderKind>().Select(provider => new OfflineMigrationSourceShape(
                    provider, source.ExtractorId, source.ExtractorVersion, [], [], [])).ToImmutableArray())]);
        var dag = new OfflineMigrationDag("fixture-dag", "v1", [step]);
        var target = new CurrentSchemaTargetIdentity("v1", "v1", "v1", s_digest, s_digest);
        var tool = new CurrentSchemaVerifierIdentity(new string('a', 40), s_digest, s_digest, s_digest);
        OfflineMigrationPlan plan = OfflineMigrationPlanBuilder.Create(source, backup, target, tool, registry, dag,
            s_recordedAt, TimeSpan.FromHours(1));
        plan = OfflineMigrationPlanVerifier.Verify(plan, source, backup, target, tool, registry, dag,
            s_recordedAt, TimeSpan.FromHours(1)).Plan;
        var artifact = new CurrentSchemaArtifactReference("fixture-plan", OfflineMigrationApplyJournalVerifier.ComputePlanArtifactDigest(plan));
        var journal = new OfflineMigrationApplyJournalVerifier(plan, artifact, "invocation");
        OfflineMigrationApplyJournalEntry first = Control(plan, artifact, journal, OfflineMigrationApplyJournalState.AttemptStarted);
        journal.Accept(first);
        OfflineMigrationApplyJournalEntry unit = Seal(Control(plan, artifact, journal,
            OfflineMigrationApplyJournalState.TransactionCommitted) with
        {
            StepId = step.StepId,
            OperationReference = step.Operations[0].OperationReference,
            Mode = OfflineMigrationExecutionMode.Transaction,
            IdempotencyKey = step.IdempotencyDefinition,
            RowsProcessed = 2,
            ExpectedRows = 2,
            UnitComplete = true,
            Before = Observation(step, step.SourcePrecondition),
            After = Observation(step, step.TargetPostcondition)
        });
        journal.Accept(unit);
        journal.Accept(Seal(unit with
        {
            Sequence = journal.Last!.Sequence + 1,
            State = OfflineMigrationApplyJournalState.StepVerified,
            PreviousDigest = journal.Last.ContentDigest
        }));
        journal.Accept(Control(plan, artifact, journal, OfflineMigrationApplyJournalState.ApplyCompleted));
        var checkpoint = new OfflineMigrationApplyCheckpoint(
            OfflineMigrationApplyJournalVerifier.Reference(journal.Last!), "invocation", journal.Last!.Sequence);
        journal.Complete(checkpoint);
        var apply = new OfflineMigrationApplyResult(OfflineMigrationApplyStatus.Completed, artifact, plan.ContentDigest,
            database, checkpoint, journal.StepProofs, []);
        var request = new OfflineMigrationCurrentSchemaVerifyRequest(artifact,
            ByteReference("fixture-apply", JsonSerializer.SerializeToUtf8Bytes(apply)),
            [ByteReference("fixture-checkpoint", JsonSerializer.SerializeToUtf8Bytes(checkpoint))], database, "invocation");
        return new(plan, apply, checkpoint, request, journal, first);
    }

    private static CurrentSchemaReceipt CreateReceiptMetadata(Fixture fixture)
    {
        // Codec/binding data only, not an issued receipt or a native schema proof.
        var receipt = new CurrentSchemaReceipt(CurrentSchemaReceiptCodec.Format, CurrentSchemaReceiptStatus.VerifiedCurrent,
            fixture.Plan.Target, fixture.Plan.SourceFingerprintId, fixture.Plan.SourceFingerprintVersion,
            fixture.Plan.SourceRegistryDigest, fixture.Plan.Source.ContentDigest, fixture.Request.Plan,
            fixture.Request.Apply, fixture.Request.Checkpoints, fixture.Request.Database, s_digest,
            [new(fixture.Plan.OrderedSteps[0].StepId, fixture.Plan.OrderedSteps[0].TargetPostcondition,
                s_digest, s_digest, fixture.Apply.StepProofs[0].After!.ContentDigest)],
            fixture.Plan.Backup.Package, fixture.Plan.Backup.Manifest, fixture.Plan.Backup.RestoreDrill,
            [], fixture.Plan.Tool, [], string.Empty);
        return receipt with
        {
            ContentDigest = CurrentSchemaReceiptCodec.ComputeContentDigest(receipt)
        };
    }

    private static OfflineMigrationApplyJournalEntry Control(OfflineMigrationPlan plan, CurrentSchemaArtifactReference artifact,
        OfflineMigrationApplyJournalVerifier journal, OfflineMigrationApplyJournalState state)
        => Seal(new OfflineMigrationApplyJournalEntry(OfflineMigrationApplyJournalVerifier.Format, artifact, plan.ContentDigest, plan.Source.Database,
            "invocation", (journal.Last?.Sequence ?? 0) + 1, 1, null, null, null, state, null, null, null, null,
            0, 0, false, null, null, journal.Last?.ContentDigest ?? OfflineMigrationApplyJournalVerifier.GenesisDigest,
            string.Empty, null, s_recordedAt));

    private static OfflineMigrationPredicateObservation Observation(OfflineMigrationStep step, string predicate)
    {
        ImmutableArray<OfflineMigrationFact> facts =
        [new("cardinality", "2"), new("digest", s_digest), new("foreign-keys", "0"),
            new("identity", "keys:1,2"), new("provider-invariants", "current"), new("rows", "2")];
        OfflineMigrationProviderOperation operation = step.Operations[0];
        return Seal(new OfflineMigrationPredicateObservation(predicate, operation.OperationReference, operation.OperationSourceDigest,
            operation.SemanticDigest, facts, facts, string.Empty));
    }

    private static OfflineMigrationPredicateObservation Seal(OfflineMigrationPredicateObservation observation)
        => observation with
        {
            ContentDigest = OfflineMigrationApplyJournalVerifier.ComputeObservationDigest(observation)
        };

    private static OfflineMigrationApplyJournalEntry Seal(OfflineMigrationApplyJournalEntry entry)
        => entry with
        {
            ContentDigest = OfflineMigrationApplyJournalVerifier.ComputeEntryDigest(entry)
        };

    private static CurrentSchemaArtifactReference ByteReference(string reference, byte[] bytes)
        => new(reference, Convert.ToHexStringLower(SHA256.HashData(bytes)));

    private static ImmutableArray<OfflineMigrationFact> ReplaceFact(ImmutableArray<OfflineMigrationFact> facts, string name, string value)
        => facts.Select(fact => fact.Name == name ? fact with { Value = value } : fact).ToImmutableArray();

    private sealed record Fixture(OfflineMigrationPlan Plan, OfflineMigrationApplyResult Apply,
        OfflineMigrationApplyCheckpoint Checkpoint, OfflineMigrationCurrentSchemaVerifyRequest Request,
        OfflineMigrationApplyJournalVerifier Journal, OfflineMigrationApplyJournalEntry First);
}
