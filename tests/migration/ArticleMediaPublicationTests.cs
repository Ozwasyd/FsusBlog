using System.Collections.Immutable;
using System.Data;
using System.Data.Common;
using System.Runtime.CompilerServices;
using System.Runtime.Versioning;

using FsusBlog.Contracts.Migration;

using NSubstitute;

using Xunit;

namespace FsusBlog.Migration.Tests;

// These controls execute the actual Linux filesystem owner. The journal fixture supplies
// only the existing caller port; it does not prove a database commit or admission receipt.
[SupportedOSPlatform("linux")]
public sealed class ArticleMediaPublicationTests
{
    [Fact]
    public async Task Publication_CopiesExactBytesAndPermissionsBeforeJournalAppendAndIsIdempotent()
    {
        using var fixture = new PublicationFixture();
        ArticleMediaCopyPlan plan = await fixture.Plan();
        var journal = new BoundJournal(plan.Binding);
        journal.BeforeAppend = publication =>
        {
            Assert.Equal(fixture.Bytes, File.ReadAllBytes(fixture.PublishedFile));
            Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(fixture.PublishedFile));
            Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute,
                File.GetUnixFileMode(fixture.Generation));
        };

        ArticleMediaPublication first = await fixture.Publish(plan, journal);
        ArticleMediaPublication second = await fixture.Publish(plan, journal);

        Assert.Equal(first, second);
        Assert.Equal(1, journal.Appends);
        Assert.Equal(fixture.Bytes, File.ReadAllBytes(fixture.SourceFile));
        Assert.False(Directory.Exists(Path.Combine(fixture.Target, plan.TemporaryDirectoryName)));
        await ArticleMediaPreservation.VerifyPublicationAsync(first, plan.Inventory, fixture.Target, fixture.Limits, default);
    }

    [Fact]
    public async Task Publication_RecoversExactGenerationAfterRenameAndFailedJournalAppend()
    {
        using var fixture = new PublicationFixture();
        ArticleMediaCopyPlan plan = await fixture.Plan();
        var journal = new BoundJournal(plan.Binding) { FailNextAppend = true };

        await Assert.ThrowsAsync<InvalidOperationException>(() => fixture.Publish(plan, journal));

        Assert.Equal(ArticleMediaJournalState.Prepared, journal.State);
        Assert.Equal(0, journal.Appends);
        using var parent = ArticleMediaDirectory.Open(fixture.Target, writable: false);
        using ArticleMediaDirectory generation = parent.TryOpenDirectory(plan.Binding.TargetDirectoryName)!;
        string identity = generation.Identity;
        File.SetLastWriteTimeUtc(fixture.Generation, DateTime.UnixEpoch);
        Directory.CreateDirectory(Path.Combine(fixture.Target, ".media-unrelated-latest.tmp"));

        ArticleMediaPublication recovered = await fixture.Publish(plan, journal);

        Assert.Equal(identity, recovered.GenerationIdentity);
        Assert.Equal(1, journal.Appends);
        Assert.True(Directory.Exists(Path.Combine(fixture.Target, ".media-unrelated-latest.tmp")));
    }

    [Fact]
    public async Task Publication_ResumesOnlyItsOwnedPartialStage()
    {
        using var fixture = new PublicationFixture();
        ArticleMediaCopyPlan plan = await fixture.Plan();
        using (var parent = ArticleMediaDirectory.Open(fixture.Target, writable: true))
        using (var source = ArticleMediaDirectory.Open(fixture.Source, writable: false))
        using (ArticleMediaDirectory stage = await parent.OpenOwnedStageAsync(plan.TemporaryDirectoryName, plan.Binding, default))
        {
            await stage.CopyVerifiedAsync(source, plan.Inventory.Files[0], fixture.Limits.FileBytes, default);
        }
        var journal = new BoundJournal(plan.Binding);

        ArticleMediaPublication publication = await fixture.Publish(plan, journal);

        Assert.Equal(1, journal.Appends);
        await ArticleMediaPreservation.VerifyPublicationAsync(publication, plan.Inventory, fixture.Target, fixture.Limits, default);
    }

    [Theory]
    [InlineData("source-missing")]
    [InlineData("source-hash")]
    [InlineData("source-identity")]
    [InlineData("source-permissions")]
    [InlineData("write-denied")]
    [InlineData("journal-binding")]
    [InlineData("journal-state")]
    public async Task Publication_RejectsSourceAndAuthorityFailuresWithoutJournalSuccess(string change)
    {
        using var fixture = new PublicationFixture();
        ArticleMediaCopyPlan plan = await fixture.Plan();
        var journal = new BoundJournal(plan.Binding);
        switch (change)
        {
            case "source-missing":
                File.Delete(fixture.SourceFile);
                break;
            case "source-hash":
                File.WriteAllBytes(fixture.SourceFile, [9, 9, 9, 9]);
                break;
            case "source-identity":
                string replacement = Path.Combine(fixture.Source, "replacement.bin");
                File.WriteAllBytes(replacement, fixture.Bytes);
                File.Move(replacement, fixture.SourceFile, overwrite: true);
                break;
            case "source-permissions":
                File.SetUnixFileMode(fixture.SourceFile, UnixFileMode.UserRead);
                break;
            case "write-denied":
                File.SetUnixFileMode(fixture.Target, UnixFileMode.UserRead | UnixFileMode.UserExecute);
                break;
            case "journal-binding":
                journal = new BoundJournal(plan.Binding with
                {
                    RunId = Guid.NewGuid()
                });
                break;
            case "journal-state":
                journal.State = (ArticleMediaJournalState)99;
                break;
        }

        await Assert.ThrowsAnyAsync<Exception>(() => fixture.Publish(plan, journal));

        Assert.Equal(0, journal.Appends);
        Assert.False(Directory.Exists(fixture.Generation));
    }

    [Theory]
    [InlineData("target-same-bytes")]
    [InlineData("target-wrong-bytes")]
    [InlineData("unowned-stage")]
    [InlineData("stage-symlink")]
    [InlineData("target-symlink")]
    public async Task Publication_RejectsExistingUserAndForeignPathsWithoutOverwritingOrDeleting(string change)
    {
        using var fixture = new PublicationFixture();
        ArticleMediaCopyPlan plan = await fixture.Plan();
        var journal = new BoundJournal(plan.Binding);
        string protectedFile = Path.Combine(fixture.Root, "user.bin");
        File.WriteAllBytes(protectedFile, [4, 5, 6]);
        switch (change)
        {
            case "target-same-bytes":
            case "target-wrong-bytes":
                Directory.CreateDirectory(Path.GetDirectoryName(fixture.PublishedFile)!);
                File.WriteAllBytes(fixture.PublishedFile, change == "target-same-bytes" ? fixture.Bytes : [0]);
                break;
            case "unowned-stage":
                Directory.CreateDirectory(Path.Combine(fixture.Target, plan.TemporaryDirectoryName));
                break;
            case "stage-symlink":
                Directory.CreateSymbolicLink(Path.Combine(fixture.Target, plan.TemporaryDirectoryName), fixture.Root);
                break;
            case "target-symlink":
                Directory.CreateSymbolicLink(fixture.Generation, fixture.Root);
                break;
        }

        await Assert.ThrowsAsync<ArticleMediaException>(() => fixture.Publish(plan, journal));

        Assert.Equal(0, journal.Appends);
        Assert.Equal(new byte[] { 4, 5, 6 }, File.ReadAllBytes(protectedFile));
        Assert.Equal(fixture.Bytes, File.ReadAllBytes(fixture.SourceFile));
        if (change is "target-same-bytes" or "target-wrong-bytes")
        {
            Assert.Equal(change == "target-same-bytes" ? fixture.Bytes : [0], File.ReadAllBytes(fixture.PublishedFile));
        }
    }

    [Theory]
    [InlineData("run")]
    [InlineData("plan")]
    [InlineData("source")]
    public async Task Publication_RejectsCrossOperationAdoptionEvenWhenEveryFileHashMatches(string changed)
    {
        using var fixture = new PublicationFixture();
        ArticleMediaCopyPlan plan = await fixture.Plan();
        ArticleMediaPublication original = await fixture.Publish(plan, new BoundJournal(plan.Binding));
        ArticleMediaBinding binding = changed switch
        {
            "run" => plan.Binding with { RunId = Guid.NewGuid() },
            "plan" => plan.Binding with { PlanContentDigest = new string('d', 64) },
            _ => plan.Binding with { SourceContentDigest = new string('e', 64) }
        };
        ArticleMediaCopyPlan changedPlan = ArticleMediaPreservation.CreateCopyPlan(plan.Inventory, binding, fixture.Limits);
        var journal = new BoundJournal(binding);

        await Assert.ThrowsAsync<ArticleMediaException>(() => fixture.Publish(changedPlan, journal));

        Assert.Equal(0, journal.Appends);
        await ArticleMediaPreservation.VerifyPublicationAsync(original, plan.Inventory, fixture.Target, fixture.Limits, default);
    }

    [Theory]
    [InlineData("file-hash")]
    [InlineData("file-missing")]
    [InlineData("file-permissions")]
    [InlineData("directory-permissions")]
    [InlineData("extra-user-file")]
    [InlineData("marker-tamper")]
    [InlineData("generation-identity")]
    public async Task Verifier_RejectsPhysicalGenerationDriftAndRetryDoesNotRepairIt(string change)
    {
        using var fixture = new PublicationFixture();
        ArticleMediaCopyPlan plan = await fixture.Plan();
        var journal = new BoundJournal(plan.Binding);
        ArticleMediaPublication publication = await fixture.Publish(plan, journal);
        switch (change)
        {
            case "file-hash":
                File.WriteAllBytes(fixture.PublishedFile, [0, 0, 0, 0]);
                break;
            case "file-missing":
                File.Delete(fixture.PublishedFile);
                break;
            case "file-permissions":
                File.SetUnixFileMode(fixture.PublishedFile, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.GroupRead);
                break;
            case "directory-permissions":
                File.SetUnixFileMode(fixture.Generation, UnixFileMode.UserRead | UnixFileMode.UserWrite
                    | UnixFileMode.UserExecute | UnixFileMode.GroupExecute);
                break;
            case "extra-user-file":
                File.WriteAllBytes(Path.Combine(fixture.Generation, "user.bin"), [6]);
                break;
            case "marker-tamper":
                File.WriteAllBytes(Path.Combine(fixture.Target, ".media-" + plan.Binding.RunId.ToString("N") + ".owner"), [1]);
                break;
            case "generation-identity":
                Directory.Move(fixture.Generation, fixture.Generation + "-retained");
                Directory.CreateDirectory(fixture.Generation);
                break;
        }

        await Assert.ThrowsAsync<ArticleMediaException>(() => ArticleMediaPreservation.VerifyPublicationAsync(
            publication, plan.Inventory, fixture.Target, fixture.Limits, default));
        await Assert.ThrowsAsync<ArticleMediaException>(() => fixture.Publish(plan, journal));

        Assert.Equal(1, journal.Appends);
        Assert.Equal(fixture.Bytes, File.ReadAllBytes(fixture.SourceFile));
        if (change == "extra-user-file")
        {
            Assert.Equal(new byte[] { 6 }, File.ReadAllBytes(Path.Combine(fixture.Generation, "user.bin")));
        }
    }

    [Fact]
    public async Task Publication_PreCancelledRequestCreatesNoPhysicalFiles()
    {
        using var fixture = new PublicationFixture();
        ArticleMediaCopyPlan plan = await fixture.Plan();
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        var journal = new BoundJournal(plan.Binding);

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => ArticleMediaPreservation.StageAndPublishAsync(
            plan, fixture.Source, fixture.Target, fixture.Limits, journal, cancelled.Token));

        Assert.Empty(Directory.EnumerateFileSystemEntries(fixture.Target));
        Assert.Equal(0, journal.Appends);
    }

    [Theory]
    [InlineData("connection")]
    [InlineData("transaction")]
    [InlineData("isolation")]
    public async Task OriginalJournal_RejectsTransactionCustodyLossBeforeMediaEffects(string change)
    {
        OfflineMigrationApplyJournalVerifier committed = PreparedJournal();
        OfflineMigrationApplyJournalVerifier staged = committed.Fork();
        DbConnection connection = Substitute.For<DbConnection>();
        DbTransaction transaction = Substitute.For<DbTransaction>();
        connection.State.Returns(ConnectionState.Open);
        transaction.Connection.Returns(connection);
        transaction.IsolationLevel.Returns(IsolationLevel.RepeatableRead);
        var journal = new OfflineMigrationArticleMediaJournal(committed, staged, connection, transaction, 1);
        ArticleMediaBinding binding = committed.PendingMedia!.Media!.Binding;
        if (change == "connection")
        {
            connection.State.Returns(ConnectionState.Closed);
        }
        else if (change == "transaction")
        {
            transaction.Connection.Returns((DbConnection?)null);
        }
        else
        {
            transaction.IsolationLevel.Returns(IsolationLevel.ReadCommitted);
        }

        InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            journal.RequirePreparedAsync(binding, default));
        Assert.Equal("offline_apply_media_original_transaction_required", failure.Message);
        await Assert.ThrowsAsync<InvalidOperationException>(() => journal.RecordPublishedAsync(
            new(binding, "generation"), ArticleMediaJournalState.Prepared, default));
        Assert.Same(committed.Last, staged.Last);
        connection.DidNotReceive().CreateCommand();
        transaction.DidNotReceive().Commit();
        transaction.DidNotReceive().Rollback();
    }

    private static OfflineMigrationApplyJournalVerifier PreparedJournal()
    {
        // Reuse the original pure Apply plan/journal contracts for a synthetic port control.
        // Empty shapes here are fixture inputs, never an admitted legacy baseline or native grant.
        string digest = new('a', 64);
        DateTimeOffset recordedAt = DateTimeOffset.UnixEpoch;
        var database = new CurrentSchemaDatabaseIdentity(CurrentSchemaProviderKind.PostgreSql, "fixture-instance", "fixture-database");
        var source = new OfflineMigrationSourceObservation(database, "fixture", "v1", [], [], [], digest);
        var artifact = new CurrentSchemaArtifactReference("fixture-backup", digest);
        var backup = new OfflineMigrationBackupObservation(artifact, artifact, artifact, "fixture", "v1",
            recordedAt, recordedAt, "fixture-snapshot", digest, digest, source,
            source with { Database = database with { DatabaseId = "fixture-restored" } },
            new[] { "aotCache", "configRedacted", "dataProtectionKeyRing", "database", "searchIndex", "uploads" }
                .Select(name => new OfflineMigrationFact(name, digest)).ToImmutableArray());
        var step = new OfflineMigrationStep("fixture-media", "fixture-source", "fixture-target", [], "fixture-idempotency", false,
            new("v1", 0, "fixture-watermark", "fixture-replay"),
            Enum.GetValues<CurrentSchemaProviderKind>().Select(provider => new OfflineMigrationProviderOperation(
                provider, "fixture-media", digest, digest, OfflineMigrationExecutionMode.Transaction)).ToImmutableArray());
        var registry = new OfflineMigrationSourceRegistry("v1",
            [new("fixture-profile", "v1", "fixture", [nameof(OriginalJournal_RejectsTransactionCustodyLossBeforeMediaEffects)],
                step.StepId, Enum.GetValues<CurrentSchemaProviderKind>().Select(provider => new OfflineMigrationSourceShape(
                    provider, source.ExtractorId, source.ExtractorVersion, [], [], [])).ToImmutableArray())]);
        var target = new CurrentSchemaTargetIdentity("v1", "v1", "v1", digest, digest);
        var tool = new CurrentSchemaVerifierIdentity(new('a', 40), digest, digest, digest);
        OfflineMigrationPlan plan = OfflineMigrationPlanBuilder.Create(source, backup, target, tool, registry,
            new("fixture-dag", "v1", [step]), recordedAt, TimeSpan.FromHours(1));
        var reference = new CurrentSchemaArtifactReference("fixture-plan", OfflineMigrationApplyJournalVerifier.ComputePlanArtifactDigest(plan));
        var verifier = new OfflineMigrationApplyJournalVerifier(plan, reference, "fixture-invocation");
        verifier.BindOperationOwners(new JournalPortRegistry());
        var started = new OfflineMigrationApplyJournalEntry(OfflineMigrationApplyJournalVerifier.Format, reference,
            plan.ContentDigest, database, "fixture-invocation", 1, 1, null, null, null,
            OfflineMigrationApplyJournalState.AttemptStarted, null, null, null, null, 0, 0, false, null, null,
            OfflineMigrationApplyJournalVerifier.GenesisDigest, string.Empty, null, recordedAt);
        verifier.Accept(started with { ContentDigest = OfflineMigrationApplyJournalVerifier.ComputeEntryDigest(started) });
        var observation = new OfflineMigrationPredicateObservation(step.SourcePrecondition, step.Operations[0].OperationReference,
            digest, digest, [new("rows", "1")], [new("rows", "1")], string.Empty);
        observation = observation with { ContentDigest = OfflineMigrationApplyJournalVerifier.ComputeObservationDigest(observation) };
        var binding = new ArticleMediaBinding(Guid.NewGuid(), reference.Sha256, plan.ContentDigest,
            plan.Source.ContentDigest, digest, "fixture-source-root", "fixture-target-root", "generation");
        OfflineMigrationApplyJournalEntry prepared = started with
        {
            Format = OfflineMigrationApplyJournalVerifier.MediaFormat,
            Sequence = 2,
            State = OfflineMigrationApplyJournalState.MediaPrepared,
            StepId = step.StepId,
            OperationReference = step.Operations[0].OperationReference,
            Mode = OfflineMigrationExecutionMode.Transaction,
            IdempotencyKey = step.IdempotencyDefinition,
            Before = observation,
            PreviousDigest = verifier.Last!.ContentDigest,
            Media = new("fixture-invocation", binding, null)
        };
        verifier.Accept(prepared with { ContentDigest = OfflineMigrationApplyJournalVerifier.ComputeEntryDigest(prepared) });
        return verifier;
    }

    private sealed class JournalPortRegistry : IOfflineMigrationApplyOperationRegistry
    {
        public OfflineMigrationApplyOperation Resolve(OfflineMigrationStep step, OfflineMigrationProviderOperation operation)
            => new JournalPortOperation(operation);
    }

    private sealed class JournalPortOperation(OfflineMigrationProviderOperation identity) : OfflineMigrationArticleMediaOperation
    {
        internal override OfflineMigrationProviderOperation Identity => identity;

        internal override Task<OfflineMigrationPredicateObservation> ObserveAsync(string predicateReference,
            DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken)
            => throw new NotSupportedException("fixture_has_no_native_observer");

        internal override Task<OfflineMigrationMediaJournalEvidence> GetMediaBindingAsync(VerifiedOfflineMigrationPlan plan,
            CurrentSchemaArtifactReference artifact, string invocationId, DbConnection connection, DbTransaction transaction,
            CancellationToken cancellationToken)
            => throw new NotSupportedException("fixture_has_no_native_source");

        internal override Task<OfflineMigrationApplyUnit> ExecuteMediaAsync(OfflineMigrationStep step,
            OfflineMigrationApplyJournalEntry? previousUnit, DbConnection connection, DbTransaction transaction,
            IArticleMediaPreservationJournal journal, CancellationToken cancellationToken)
            => throw new NotSupportedException("fixture_has_no_native_writer");
    }

    private sealed class BoundJournal(ArticleMediaBinding binding) : IArticleMediaPreservationJournal
    {
        public int Appends
        {
            get; private set;
        }
        public ArticleMediaJournalState State { get; set; } = ArticleMediaJournalState.Prepared;
        public bool FailNextAppend
        {
            get; set;
        }
        public Action<ArticleMediaPublication>? BeforeAppend
        {
            get; set;
        }

        public Task<ArticleMediaJournalState> RequirePreparedAsync(ArticleMediaBinding actual, CancellationToken token)
        {
            token.ThrowIfCancellationRequested();
            if (actual != binding)
            {
                throw new InvalidOperationException("fixture_binding_changed");
            }
            return Task.FromResult(State);
        }

        public Task RecordPublishedAsync(ArticleMediaPublication publication, ArticleMediaJournalState expected,
            CancellationToken token)
        {
            token.ThrowIfCancellationRequested();
            Assert.Equal(binding, publication.Binding);
            Assert.Equal(ArticleMediaJournalState.Prepared, expected);
            Assert.Equal(expected, State);
            BeforeAppend?.Invoke(publication);
            if (FailNextAppend)
            {
                FailNextAppend = false;
                throw new InvalidOperationException("fixture_journal_append_failed");
            }
            Appends++;
            State = ArticleMediaJournalState.MediaPublished;
            return Task.CompletedTask;
        }
    }

    private sealed class PublicationFixture : IDisposable
    {
        public PublicationFixture()
        {
            Root = Path.Combine(Path.GetTempPath(), "fsusblog-media-publication-" + Guid.NewGuid().ToString("N"));
            Source = Path.Combine(Root, "source");
            Target = Path.Combine(Root, "target");
            Directory.CreateDirectory(Source, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            Directory.CreateDirectory(Target, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            Directory.CreateDirectory(Path.GetDirectoryName(SourceFile)!);
            File.WriteAllBytes(SourceFile, Bytes);
        }

        public string Root
        {
            get;
        }
        public string Source
        {
            get;
        }
        public string Target
        {
            get;
        }
        public byte[] Bytes { get; } = [0, 255, 13, 10];
        public ArticleMediaLimits Limits { get; } = new(10, 100, 100, 1_000_000, 4096, 1_000_000, 1_000_000, 10_000_000);
        public string SourceFile => Path.Combine(Source, "nested", "file.bin");
        public string Generation => Path.Combine(Target, "generation");
        public string PublishedFile => Path.Combine(Generation, "nested", "file.bin");

        public async Task<ArticleMediaCopyPlan> Plan()
        {
            ArticleMediaInventory inventory = await ArticleMediaPreservation.InventoryAsync(Documents(), Source,
                new Uri("https://legacy.example/"), "/uploads/illustration/", Limits, default);
            using var parent = ArticleMediaDirectory.Open(Target, writable: true);
            var binding = new ArticleMediaBinding(Guid.NewGuid(), new string('a', 64), new string('b', 64),
                new string('c', 64), inventory.ManifestDigest, inventory.SourceRootIdentity, parent.Identity, "generation");
            return ArticleMediaPreservation.CreateCopyPlan(inventory, binding, Limits);
        }

        public Task<ArticleMediaPublication> Publish(ArticleMediaCopyPlan plan, IArticleMediaPreservationJournal journal)
            => ArticleMediaPreservation.StageAndPublishAsync(plan, Source, Target, Limits, journal, default);

        private static async IAsyncEnumerable<ArticleMediaSource> Documents([EnumeratorCancellation] CancellationToken token = default)
        {
            token.ThrowIfCancellationRequested();
            yield return new(7, null, "![x](/uploads/illustration/nested/file.bin)", new Uri("https://legacy.example/articles/7"));
            await Task.CompletedTask;
        }

        public void Dispose()
        {
            File.SetUnixFileMode(Target, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            Directory.Delete(Root, recursive: true);
        }
    }
}
