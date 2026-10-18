using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using Xunit;

using FsusBlog.Contracts.Migration;

namespace FsusBlog.Migration.Tests;

/// <summary>
/// Real retained-file consumer fixtures with an explicitly fake invocation port. They do
/// not prove package authentication, restoration, PostgreSQL, or a production factory.
/// </summary>
public sealed class OfflineMigrationBackupAdmissionTests
{
    [Fact]
    public async Task OwnedTerminalConsumesActualPackageManifestReportAndNativeBytes()
    {
        using var fixture = new EvidenceFixture();
        OfflineMigrationBackupObservation actual = await fixture.ReadAsync();
        Assert.Equal(1, fixture.Calls);
        Assert.Equal(fixture.Options.BackupManifestPath, actual.Manifest.Reference);
        Assert.Equal(fixture.Options.RestoreDrillPath, actual.RestoreDrill.Reference);
        Assert.Equal(Hash(File.ReadAllBytes(fixture.Options.BackupPackagePath)), actual.Package.Sha256);
        Assert.Equal(Hash(File.ReadAllBytes(actual.Manifest.Reference)), actual.Manifest.Sha256);
        Assert.Equal(Hash(File.ReadAllBytes(actual.RestoreDrill.Reference)), actual.RestoreDrill.Sha256);
        Assert.Equal("captured-instance", actual.SourceAtCapture.Database.InstanceId);
        Assert.Equal("isolated-instance", actual.RestoredSource.Database.InstanceId);
        Assert.Equal(actual.SourceAtCapture.ContentDigest, actual.RestoredSource.ContentDigest);
        Assert.Equal(6, actual.ArtifactDigests.Length);
    }

    [Theory]
    [InlineData("exit", "offline_backup_owned_producer_terminal_failed")]
    [InlineData("nonce", "offline_backup_owned_invocation_binding_invalid")]
    [InlineData("root", "offline_backup_owned_invocation_binding_invalid")]
    [InlineData("raw-path", "offline_backup_owned_artifact_reference_mismatch")]
    [InlineData("raw-bytes", "offline_backup_owned_artifact_bytes_changed")]
    [InlineData("checks", "offline_backup_owned_recoverability_checks_missing")]
    [InlineData("runtime", "offline_backup_owned_runtime_qualification_not_backup_proof")]
    [InlineData("stage", "offline_backup_owned_recoverability_report_invalid")]
    [InlineData("native", "offline_backup_owned_native_restore_projection_changed")]
    [InlineData("manifest", "offline_backup_owned_manifest_projection_changed")]
    [InlineData("duplicate", "offline_backup_owned_duplicate_json_property")]
    public async Task ChangedOwnedTerminalEvidenceIsRefused(string mutation, string code)
    {
        using var fixture = new EvidenceFixture { Mutation = mutation };
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() => fixture.ReadAsync());
        Assert.Equal(code, error.Message);
    }

    [Fact]
    public async Task ExistingOutputRootIsNotReusedAsAnInvocation()
    {
        using var fixture = new EvidenceFixture();
        Directory.CreateDirectory(fixture.OutputRoot);
        await Assert.ThrowsAsync<InvalidOperationException>(() => fixture.ReadAsync());
        Assert.Equal(0, fixture.Calls);
    }

    [Fact]
    public async Task FakeInvocationCannotCreateRetainedProductionBackupCapability()
    {
        using var fixture = new EvidenceFixture();
        var admission = new OfflineMigrationBackupAdmission(fixture);
        InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            admission.ReadAndRetainAsync(fixture.Options, CancellationToken.None));
        Assert.Equal("offline_backup_owned_retained_original_bound_producer_required", failure.Message);
        Assert.Equal(0, fixture.Calls);
        Assert.False(Directory.Exists(fixture.OutputRoot));
        // The original explicitly fake invocation fixture remains valid only for
        // retained-file consumer coverage; it does not become an authenticated cap.
        OfflineMigrationBackupObservation observed = await fixture.ReadAsync();
        Assert.Equal(1, fixture.Calls);
        Assert.Equal(fixture.Options.BackupPackagePath, observed.Package.Reference);
    }

    [Fact]
    public void RetainedBackupCannotBeImportedFromPlanObservationOrCallerJson()
    {
        var constructors = typeof(OfflineMigrationRetainedOwnedBackup).GetConstructors(
            System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic);
        Assert.True(Assert.Single(constructors).IsPrivate);
        Assert.Throws<NotSupportedException>(() => JsonSerializer.Deserialize<OfflineMigrationRetainedOwnedBackup>("{}"));
    }

    [Theory]
    [InlineData("unchanged")]
    [InlineData("empty-log")]
    [InlineData("changed")]
    [InlineData("duplicate")]
    [InlineData("missing")]
    [InlineData("cancelled")]
    public async Task RetainedRawClosureUsesOriginalWholeByteAndTerminalFilePredicate(string mutation)
    {
        // Byte-retention fixture only: this does not construct an invocation cap,
        // authenticate a package or prove an actual restore operation.
        using var fixture = new EvidenceFixture();
        var artifacts = System.Collections.Immutable.ImmutableArray.CreateBuilder<CurrentSchemaArtifactReference>();
        for (int index = 0; index < 8; index++)
        {
            string path = Path.Combine(fixture.Parent, "retained-" + index);
            byte[] bytes = mutation == "empty-log" && index == 7 ? [] : Encoding.UTF8.GetBytes("raw-" + index);
            await File.WriteAllBytesAsync(path, bytes);
            artifacts.Add(new(path, Hash(bytes)));
        }
        var originals = artifacts.ToImmutable();
        if (mutation == "changed")
        {
            await File.WriteAllTextAsync(originals[7].Reference, "new-7");
        }
        else if (mutation == "duplicate")
        {
            originals = originals.SetItem(7, originals[0]);
        }
        else if (mutation == "missing")
        {
            originals = originals.RemoveAt(7);
        }
        using var cancellation = new CancellationTokenSource();
        if (mutation == "cancelled")
        {
            cancellation.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
                OfflineMigrationBackupAdmission.ValidateRetainedArtifactsAsync(originals, cancellation.Token));
        }
        else if (mutation is "changed" or "duplicate" or "missing")
        {
            string code = mutation == "changed" ? "offline_backup_owned_retained_artifact_bytes_changed"
                : "offline_backup_owned_retained_artifact_closure_changed";
            Assert.Equal(code, (await Assert.ThrowsAsync<InvalidOperationException>(() =>
                OfflineMigrationBackupAdmission.ValidateRetainedArtifactsAsync(originals, cancellation.Token))).Message);
        }
        else
        {
            await OfflineMigrationBackupAdmission.ValidateRetainedArtifactsAsync(originals, cancellation.Token);
        }
        Assert.Equal(0, fixture.Calls);
    }

    [Fact]
    public async Task ExternalManifestPathCannotReplaceTheOwnedInnerManifest()
    {
        using var fixture = new EvidenceFixture();
        await Assert.ThrowsAsync<InvalidOperationException>(() => fixture.ReadAsync(
            fixture.Options with { BackupManifestPath = Path.Combine(fixture.Parent, "external.json") }));
        Assert.Equal(0, fixture.Calls);
    }

    [Fact]
    public async Task CancellationBeforeInvocationDoesNotStartAProducer()
    {
        using var fixture = new EvidenceFixture();
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => fixture.ReadAsync(token: cancellation.Token));
        Assert.Equal(0, fixture.Calls);
    }

    [Fact]
    public async Task UnsupportedSnapshotProviderIsRefusedBeforeInvokingOriginalProducer()
    {
        using var fixture = new EvidenceFixture();
        await Assert.ThrowsAsync<InvalidOperationException>(() => fixture.ReadAsync(fixture.Options with
        {
            ExpectedDatabase = fixture.Options.ExpectedDatabase with { Provider = CurrentSchemaProviderKind.MySql }
        }));
        Assert.Equal(0, fixture.Calls);
    }

    [Fact]
    public async Task SymlinkRawArtifactIsNotReadAsAnOwnedFile()
    {
        using var fixture = new EvidenceFixture { Mutation = "symlink" };
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() => fixture.ReadAsync());
        Assert.Equal("offline_backup_owned_regular_artifact_required", error.Message);
    }

    [Fact]
    public async Task FifoRawArtifactIsRefusedWithoutOpeningAWriterOrDiscardingARead()
    {
        using var fixture = new EvidenceFixture { Mutation = "fifo" };
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() => fixture.ReadAsync());
        Assert.Equal("offline_backup_owned_regular_artifact_required", error.Message);
    }

    [Fact]
    public async Task SoleOpenedArtifactFdDoesNotFollowAnAncestorReplacement()
    {
        using var fixture = new EvidenceFixture();
        string ancestor = Path.Combine(fixture.Parent, "ancestor");
        string retired = Path.Combine(fixture.Parent, "retired");
        string substitute = Path.Combine(fixture.Parent, "substitute");
        Directory.CreateDirectory(ancestor);
        Directory.CreateDirectory(substitute);
        string path = Path.Combine(ancestor, "original.bin");
        byte[] original = "original fd bytes"u8.ToArray();
        byte[] other = "substituted pathname bytes"u8.ToArray();
        await File.WriteAllBytesAsync(path, original);
        await File.WriteAllBytesAsync(Path.Combine(substitute, "original.bin"), other);
        using var handle = OfflineMigrationCurrentSchemaArtifactReader.OpenOriginalRegularFile(path, CancellationToken.None);
        await using var input = new FileStream(handle, FileAccess.Read);
        Directory.Move(ancestor, retired);
        Directory.CreateSymbolicLink(ancestor, substitute);
        using var bytes = new MemoryStream();
        await input.CopyToAsync(bytes);
        Assert.Equal(original, bytes.ToArray());
        Assert.Equal(other, File.ReadAllBytes(path));
        Assert.Throws<InvalidOperationException>(() =>
            OfflineMigrationCurrentSchemaArtifactReader.OpenOriginalRegularFile(path, CancellationToken.None));
    }

    [Theory]
    [InlineData("unchanged", false)]
    [InlineData("empty", false)]
    [InlineData("same-bytes-leaf", true)]
    [InlineData("same-inode-ancestor", true)]
    public async Task OriginalProductionFinalIdentityPredicateRejectsReplacementEvenWithIdenticalBytes(string mutation, bool refuse)
    {
        using var fixture = new EvidenceFixture();
        string ancestor = Path.Combine(fixture.Parent, "original-parent");
        string retired = Path.Combine(fixture.Parent, "retired-parent");
        string substitute = Path.Combine(fixture.Parent, "substitute-parent");
        Directory.CreateDirectory(ancestor);
        Directory.CreateDirectory(substitute);
        string path = Path.Combine(ancestor, "original.bin");
        byte[] original = mutation == "empty" ? [] : "identical original bytes"u8.ToArray();
        await File.WriteAllBytesAsync(path, original);
        if (mutation == "same-inode-ancestor")
        {
            // Establish both hard links before capture so replacing only the ancestor
            // changes neither the opened leaf's link count nor its complete metadata.
            Assert.Equal(0, Link(path, Path.Combine(substitute, "original.bin")));
        }
        using var handle = OfflineMigrationCurrentSchemaArtifactReader.OpenOriginalRegularFile(path, CancellationToken.None);
        await using var input = new FileStream(handle, FileAccess.Read);
        var initial = OfflineMigrationBackupAdmission.CaptureRegularFileIdentity(path, input, CancellationToken.None);
        if (mutation == "same-bytes-leaf")
        {
            string replacement = Path.Combine(substitute, "replacement.bin");
            await File.WriteAllBytesAsync(replacement, original);
            File.Move(replacement, path, overwrite: true);
        }
        else if (mutation == "same-inode-ancestor")
        {
            Directory.Move(ancestor, retired);
            Directory.Move(substitute, ancestor);
        }
        using var bytes = new MemoryStream();
        await input.CopyToAsync(bytes);
        Assert.Equal(original, bytes.ToArray());
        Assert.Equal(original, await File.ReadAllBytesAsync(path));
        Assert.Equal(Hash(original), Hash(bytes.ToArray()));
        if (refuse)
        {
            InvalidOperationException failure = Assert.Throws<InvalidOperationException>(() =>
                OfflineMigrationBackupAdmission.ValidateRegularFileUnchanged(path, input, initial, CancellationToken.None));
            Assert.Equal("offline_backup_owned_artifact_identity_changed", failure.Message);
        }
        else
        {
            OfflineMigrationBackupAdmission.ValidateRegularFileUnchanged(path, input, initial, CancellationToken.None);
        }
    }

    [Fact]
    public async Task CancellationDuringProducerAwaitDoesNotReturnBeforeItsTerminal()
    {
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var cancellation = new CancellationTokenSource();
        using var fixture = new EvidenceFixture
        {
            BeforeTerminal = async token =>
            {
                entered.SetResult();
                await release.Task;
                token.ThrowIfCancellationRequested();
            }
        };
        Task<OfflineMigrationBackupObservation> pending = fixture.ReadAsync(token: cancellation.Token);
        try
        {
            await entered.Task;
            cancellation.Cancel();
            Assert.False(pending.IsCompleted);
        }
        finally
        {
            release.TrySetResult();
        }
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => pending);
        Assert.True(fixture.TerminalObserved);
    }

    [Fact]
    public async Task CancelledTokenDoesNotHideOriginalProducerCleanupRefusal()
    {
        using var cancellation = new CancellationTokenSource();
        using var fixture = new EvidenceFixture
        {
            BeforeTerminal = _ =>
            {
                cancellation.Cancel();
                throw new InvalidOperationException("original_backup_cleanup_unverified");
            }
        };
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() => fixture.ReadAsync(token: cancellation.Token));
        Assert.Equal("original_backup_cleanup_unverified", error.Message);
        Assert.True(fixture.TerminalObserved);
    }

    [Fact]
    public async Task MissingHostDeadlineIsRefusedBeforeProducerInvocation()
    {
        using var fixture = new EvidenceFixture();
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() => fixture.ReadAsync(
            fixture.Options with { OperationDeadline = null }));
        Assert.Equal("offline_backup_owned_operation_deadline_required", error.Message);
        Assert.Equal(0, fixture.Calls);
    }

    [Fact]
    public void MonotonicRemainingBudgetNeverRestartsOrRoundsPastOriginalDeadline()
    {
        var clock = new BudgetClock();
        var deadline = new OfflineMigrationOperationDeadline(clock, 30);
        Assert.Equal(30, deadline.RemainingWholeSeconds(CancellationToken.None));
        clock.Advance(TimeSpan.FromMilliseconds(7250));
        Assert.Equal(22, deadline.RemainingWholeSeconds(CancellationToken.None));
        clock.Advance(TimeSpan.FromSeconds(22));
        Assert.Equal("offline_backup_owned_remaining_budget_unrepresentable",
            Assert.Throws<InvalidOperationException>(() => deadline.RemainingWholeSeconds(CancellationToken.None)).Message);
    }

    [DllImport("libc", EntryPoint = "link", SetLastError = true)]
    private static extern int Link([MarshalAs(UnmanagedType.LPUTF8Str)] string existingPath,
        [MarshalAs(UnmanagedType.LPUTF8Str)] string newPath);

    private sealed class BudgetClock : TimeProvider
    {
        private long _ticks;
        public override long TimestampFrequency => TimeSpan.TicksPerSecond;
        public override long GetTimestamp() => _ticks;
        public void Advance(TimeSpan elapsed) => _ticks += elapsed.Ticks;
    }

    private static string Hash(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));

    private sealed class EvidenceFixture : IOfflineMigrationBackupDrillProducer, IDisposable
    {
        public string Parent { get; } = Directory.CreateTempSubdirectory("fsusblog-owned-backup-consumer-").FullName;
        public string OutputRoot => Path.Combine(Parent, "new-invocation");
        public string Mutation { get; init; } = "";
        public int Calls { get; private set; }
        public Func<CancellationToken, Task>? BeforeTerminal { get; init; }
        public bool TerminalObserved { get; private set; }
        public OfflineMigrationPlanCommandOptions Options { get; }

        public EvidenceFixture()
        {
            string package = Path.Combine(Parent, "package.enc");
            File.WriteAllText(package, "fake encrypted fixture; not authenticated backup proof");
            Options = new(new(CurrentSchemaProviderKind.PostgreSql, "captured-instance", "1/source"),
                Path.Combine(Parent, "source.env"), package, Path.Combine(OutputRoot, "package-manifest.json"),
                Path.Combine(OutputRoot, "backup-restore-drill.json"), Path.Combine(Parent, "restore.env"),
                Path.Combine(Parent, "plan.json"), 30)
            {
                OperationDeadline = new(TimeProvider.System, 30)
            };
        }

        public Task<OfflineMigrationBackupObservation> ReadAsync(OfflineMigrationPlanCommandOptions? options = null,
            CancellationToken token = default)
            => new OfflineMigrationBackupAdmission(this).ReadAndVerifyAsync(options ?? Options, token);

        public async Task<OfflineMigrationBackupDrillTerminal> RunAsync(OfflineMigrationPlanCommandOptions options,
            string privateRoot, string invocation, CancellationToken token)
        {
            token.ThrowIfCancellationRequested();
            if (!OperatingSystem.IsLinux())
            {
                throw new PlatformNotSupportedException("The original backup evidence fixture requires Linux.");
            }
            Calls++;
            Directory.CreateDirectory(privateRoot, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            string digest = new('a', 64);
            var source = new OfflineMigrationSourceObservation(options.ExpectedDatabase, "source-owner", "1",
                [new("tables", "0")], [new("history", "absent")], [new("rows", "0")], digest);
            OfflineMigrationSourceObservation restored = source with
            {
                Database = new(CurrentSchemaProviderKind.PostgreSql, "isolated-instance", "2/restored")
            };
            var capturedAt = new DateTimeOffset(2026, 10, 2, 0, 0, 0, TimeSpan.Zero);
            var capture = new OfflineMigrationBackupCaptureEvidence(source, "1-2-3", capturedAt,
                source.ExtractorId, source.ExtractorVersion, digest, 30);
            var binding = new Dictionary<string, object?>
            {
                ["owner"] = "tools/operations/backup-site.sh", ["ownerVersion"] = "3",
                ["capture"] = capture, ["databaseDumpSha256"] = digest
            };
            string[] labels = ["aotCache", "configRedacted", "dataProtectionKeyRing", "database", "searchIndex", "uploads"];
            var manifest = new Dictionary<string, object?>
            {
                ["kind"] = "fsusblog-site-backup", ["version"] = 3, ["sourceBinding"] = binding,
                ["artifactDigests"] = labels.ToDictionary(label => label, _ => digest)
            };
            string[] checks = ["site-backup-package:authenticated-unpacked", "database-restored-source:verified",
                "postgres-restore:ok", "uploads-recoverable:verified", "dataProtectionKeyRing-recoverable:verified",
                "configRedacted-recoverable:verified", "aotCache-recoverable:verified", "searchIndex-recoverable:verified",
                "owned-postgres-container-removed:verified", "owned-pre-migration-resources-terminal:verified"];
            var report = new Dictionary<string, object?>
            {
                ["status"] = "ok", ["mode"] = Mutation == "stage" ? "real" : "migration-recoverability",
                ["scope"] = "pre-migration-backup", ["baseUrl"] = null, ["runId"] = invocation,
                ["generatedAt"] = "2026-10-02T00:01:00Z", ["sourceCleanupVerified"] = true,
                ["packageSha256"] = Hash(File.ReadAllBytes(options.BackupPackagePath)),
                ["sourceBinding"] = binding, ["restoredSource"] = restored,
                ["restoredDatabaseDumpSha256"] = digest, ["checks"] = Mutation == "checks" ? Array.Empty<string>() : checks,
                ["blockers"] = Array.Empty<string>()
            };
            var output = new Dictionary<string, object?>
            {
                ["version"] = 2, ["owner"] = "tools/operations/backup-restore-drill.sh", ["ownerVersion"] = "2",
                ["operation"] = "migration-evidence", ["producerExitCode"] = 0,
                ["invocation"] = Mutation == "nonce" ? "another-invocation" : invocation,
                ["privateRoot"] = Mutation == "root" ? Parent : privateRoot,
                ["packageSha256"] = report["packageSha256"], ["manifest"] = manifest,
                ["sourceBinding"] = binding, ["restoredSource"] = restored, ["restoredDatabaseDumpSha256"] = digest
            };
            WriteJson("manifest", "package-manifest.json", manifest);
            report["manifestSha256"] = output["manifestSha256"];
            WriteJson("report", "backup-restore-drill.json", report);
            WriteJson("nativeRestoredSource", "native-restored-source.json", restored);
            foreach ((string prefix, string name) in new (string, string)[]
            {
                ("drillManifest", "backup-restore-manifest.json"),
                ("stdout", "owned-drill.stdout"), ("stderr", "owned-drill.stderr"),
                ("nativeStderr", $"backup-restore-drill-{invocation}.source-stderr.log")
            })
            {
                WriteBytes(prefix, name, []);
            }
            foreach (string prefix in new[] { "residue", "backendLog", "backendListenerStart", "backendListenerEnd" })
            {
                output[prefix + "Reference"] = null;
                output[prefix + "Sha256"] = null;
            }
            if (Mutation == "runtime")
            {
                output["backendLogReference"] = Path.Combine(privateRoot, "backend.log");
            }
            if (Mutation == "raw-path")
            {
                output["stdoutReference"] = Path.Combine(Parent, "foreign.log");
            }
            if (Mutation == "raw-bytes")
            {
                File.AppendAllText(Path.Combine(privateRoot, "owned-drill.stdout"), "late-change");
            }
            if (Mutation == "native")
            {
                output["restoredSource"] = restored with { ContentDigest = new string('b', 64) };
            }
            if (Mutation == "manifest")
            {
                output["manifest"] = new { version = 2 };
            }
            if (Mutation == "symlink")
            {
                string path = Path.Combine(privateRoot, "owned-drill.stdout");
                File.Delete(path);
                File.CreateSymbolicLink(path, options.BackupPackagePath);
            }
            if (Mutation == "fifo")
            {
                string path = Path.Combine(privateRoot, "owned-drill.stdout");
                File.Delete(path);
                Assert.Equal(0, MakeFifo(path, 0x180));
            }
            byte[] stdout = JsonSerializer.SerializeToUtf8Bytes(output);
            if (Mutation == "duplicate")
            {
                stdout = Encoding.UTF8.GetBytes("{\"version\":1," + Encoding.UTF8.GetString(stdout)[1..]);
            }
            try
            {
                if (BeforeTerminal is not null)
                {
                    await BeforeTerminal(token);
                }
                return new OfflineMigrationBackupDrillTerminal(Mutation == "exit" ? 1 : 0, stdout);
            }
            finally
            {
                TerminalObserved = true;
            }

            void WriteJson(string prefix, string name, object value) => WriteBytes(prefix, name, JsonSerializer.SerializeToUtf8Bytes(value));
            void WriteBytes(string prefix, string name, byte[] bytes)
            {
                string path = Path.Combine(privateRoot, name);
                File.WriteAllBytes(path, bytes);
                output[prefix + "Reference"] = path;
                output[prefix + "Sha256"] = Hash(bytes);
            }
        }

        public void Dispose() => Directory.Delete(Parent, recursive: true);
    }

    [DllImport("libc", EntryPoint = "mkfifo", SetLastError = true)]
    private static extern int MakeFifo([MarshalAs(UnmanagedType.LPUTF8Str)] string path, uint mode);
}
