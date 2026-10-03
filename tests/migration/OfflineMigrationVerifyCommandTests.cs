using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using NSubstitute;
using Xunit;

using FsusBlog.Contracts.Migration;
using FsusBlog.Contracts.SchemaMigration;

namespace FsusBlog.Migration.Tests;

public sealed class OfflineMigrationVerifyCommandTests
{
    private const string Digest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    [Theory]
    [InlineData("postgresql", CurrentSchemaProviderKind.PostgreSql)]
    [InlineData("mysql", CurrentSchemaProviderKind.MySql)]
    [InlineData("sqlite", CurrentSchemaProviderKind.Sqlite)]
    public void VerifyExisting_OriginalExplicitInputsHaveNoPublicationDestination(string provider, CurrentSchemaProviderKind expected)
    {
        using var directory = new OwnedDirectory();
        string[] args = ExistingArguments(directory.Path);
        args[Array.IndexOf(args, "--provider") + 1] = provider;
        OfflineMigrationVerifyExistingCommandOptions options = OfflineMigrationCommandLine.ParseVerifyExisting(args);
        Assert.Equal(expected, options.Request.Database.Provider);
        Assert.Equal(System.IO.Path.Combine(directory.Path, "current-receipt.json"), options.Receipt.Reference);
        Assert.Equal(Digest, options.Receipt.Sha256);
        Assert.Equal(2, options.Request.Checkpoints.Length);
        Assert.Equal("invocation", options.Request.InvocationId);
        Assert.Equal(30, options.TimeoutSeconds);
        OfflineMigrationHost.ValidateExistingVerifyOptions(options);
        Assert.Throws<InvalidOperationException>(() => OfflineMigrationCommandLine.ParseVerify(args));
        Assert.Empty(Directory.EnumerateFileSystemEntries(directory.Path));
    }

    [Theory]
    [InlineData("output")]
    [InlineData("missing-path")]
    [InlineData("missing-sha")]
    [InlineData("duplicate")]
    [InlineData("relative")]
    [InlineData("latest")]
    [InlineData("seal-as-file-sha")]
    [InlineData("plan-conflict")]
    [InlineData("env-conflict")]
    public void VerifyExisting_AmbiguousOrUnboundReceiptArgumentsRefuseBeforeIo(string change)
    {
        using var directory = new OwnedDirectory();
        var args = ExistingArguments(directory.Path).ToList();
        if (change == "output") args.AddRange(["--output", System.IO.Path.Combine(directory.Path, "new.json")]);
        else if (change is "missing-path" or "missing-sha")
            args.RemoveRange(args.IndexOf(change == "missing-path" ? "--receipt" : "--receipt-sha256"), 2);
        else if (change == "duplicate") args.AddRange(["--receipt", System.IO.Path.Combine(directory.Path, "other.json")]);
        else if (change == "seal-as-file-sha") args[args.IndexOf("--receipt-sha256") + 1] = "semantic-seal";
        else args[args.IndexOf("--receipt") + 1] = change switch
        {
            "relative" => "current-receipt.json",
            "latest" => System.IO.Path.Combine(directory.Path, "latest", "current-receipt.json"),
            "plan-conflict" => args[args.IndexOf("--plan") + 1],
            "env-conflict" => args[args.IndexOf("--env-file") + 1],
            _ => throw new InvalidOperationException()
        };
        Assert.Throws<InvalidOperationException>(() => OfflineMigrationCommandLine.ParseVerifyExisting(args));
        Assert.Empty(Directory.EnumerateFileSystemEntries(directory.Path));
    }

    [Theory]
    [InlineData("postgresql")]
    [InlineData("mysql")]
    [InlineData("sqlite")]
    public async Task VerifyExisting_MissingOwnerRefusesBeforeCredentialsOrNative(string provider)
    {
        using var directory = new OwnedDirectory();
        string[] args = ExistingArguments(directory.Path);
        args[Array.IndexOf(args, "--provider") + 1] = provider;
        OfflineMigrationVerifyExistingCommandOptions options = OfflineMigrationCommandLine.ParseVerifyExisting(args);
        var artifacts = Substitute.For<IOfflineMigrationVerificationArtifactReader>();
        var authority = Substitute.For<IOfflineMigrationCurrentSchemaVerificationAuthority>();
        var operations = Substitute.For<IOfflineMigrationApplyOperationRegistry>();
        OfflineMigrationOwnedVerifyEvidence verifier = OfflineMigrationVerifyEvidence.ComposeOwnedExisting(
            new(artifacts, null!, authority, operations));
        InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            OfflineMigrationHost.VerifyExistingWithinBudgetAsync(options, () => verifier, TextWriter.Null, CancellationToken.None));
        Assert.Equal("current_verify_native_owners_not_configured", failure.Message);
        Assert.Empty(artifacts.ReceivedCalls());
        Assert.Empty(authority.ReceivedCalls());
        Assert.Empty(operations.ReceivedCalls());
        Assert.Empty(Directory.EnumerateFileSystemEntries(directory.Path));
    }

    [Theory]
    [InlineData("cancel")]
    [InlineData("budget")]
    public async Task VerifyExisting_OriginalCancellationAndBudgetRefuseBeforeConstruction(string change)
    {
        using var directory = new OwnedDirectory();
        OfflineMigrationVerifyExistingCommandOptions options = OfflineMigrationCommandLine.ParseVerifyExisting(ExistingArguments(directory.Path));
        using var cancellation = new CancellationTokenSource();
        if (change == "cancel") cancellation.Cancel();
        else options = options with { TimeoutSeconds = 0 };
        bool constructed = false;
        Task Invoke() => OfflineMigrationHost.VerifyExistingWithinBudgetAsync(options, () =>
        {
            constructed = true;
            throw new InvalidOperationException("fixture must not construct");
        }, TextWriter.Null, cancellation.Token);
        if (change == "cancel") await Assert.ThrowsAnyAsync<OperationCanceledException>(Invoke);
        else await Assert.ThrowsAsync<InvalidOperationException>(Invoke);
        Assert.False(constructed);
        Assert.Empty(Directory.EnumerateFileSystemEntries(directory.Path));
    }

    [Theory]
    [InlineData("unchanged")]
    [InlineData("bytes")]
    [InlineData("seal")]
    [InlineData("cancel-after-read")]
    public async Task VerifyExisting_OriginalArtifactRecheckIsOnlyAByteBoundaryNotNativeAdmission(string change)
    {
        using var directory = new OwnedDirectory();
        OfflineMigrationVerifyCommandOptions original = OfflineMigrationCommandLine.ParseVerify(Arguments(directory.Path));
        OfflineMigrationCurrentSchemaIssuedArtifact artifact = CodecFixture(original);
        CurrentSchemaArtifactReference reference = new(original.OutputPath, artifact.Reference.Sha256);
        var reader = Substitute.For<IOfflineMigrationVerificationArtifactReader>();
        using var cancellation = new CancellationTokenSource();
        byte[] returned = artifact.Bytes.ToArray();
        if (change == "bytes") returned[^1] ^= 1;
        reader.ReadAsync(reference, Arg.Any<CancellationToken>()).Returns(_ =>
        {
            if (change == "cancel-after-read") cancellation.Cancel();
            return Task.FromResult<ReadOnlyMemory<byte>>(returned);
        });
        CurrentSchemaReceipt reported = artifact.Receipt;
        if (change == "seal")
        {
            reported = reported with { ActualSchemaDigest = new string('b', 64) };
            reported = reported with { ContentDigest = CurrentSchemaReceiptCodec.ComputeContentDigest(reported) };
        }
        var owners = new OfflineMigrationCurrentSchemaVerificationCapabilities(reader,
            Substitute.For<IOfflineMigrationCurrentSchemaObserver>(),
            Substitute.For<IOfflineMigrationCurrentSchemaVerificationAuthority>(),
            Substitute.For<IOfflineMigrationApplyOperationRegistry>());
        Task<OfflineMigrationCurrentSchemaIssuedArtifact> Invoke() => OfflineMigrationCurrentSchemaIssuer.RecheckExistingArtifactAsync(
            reference, reported, artifact.Bytes, owners, cancellation.Token);
        if (change == "unchanged")
        {
            OfflineMigrationCurrentSchemaIssuedArtifact same = await Invoke();
            Assert.Equal(reference, same.Reference);
            Assert.Equal(artifact.Bytes.ToArray(), same.Bytes.ToArray());
            Assert.Equal(artifact.Receipt.ContentDigest, same.Receipt.ContentDigest);
            Assert.NotEqual(same.Reference.Sha256, same.Receipt.ContentDigest);
        }
        else if (change == "cancel-after-read") await Assert.ThrowsAnyAsync<OperationCanceledException>(Invoke);
        else await Assert.ThrowsAsync<InvalidOperationException>(Invoke);
        Assert.Empty(owners.CurrentSchema.ReceivedCalls());
        Assert.Empty(owners.Authority.ReceivedCalls());
        Assert.Empty(owners.Operations.ReceivedCalls());
        Assert.Empty(Directory.EnumerateFileSystemEntries(directory.Path));
    }

    [Theory]
    [InlineData("postgresql")]
    [InlineData("mysql")]
    [InlineData("sqlite")]
    public async Task Verify_MissingCurrentOwnerRefusesBeforeCredentialsAndNativeSession(string provider)
    {
        using var directory = new OwnedDirectory();
        string[] args = Arguments(directory.Path);
        args[Array.IndexOf(args, "--provider") + 1] = provider;
        OfflineMigrationVerifyCommandOptions options = OfflineMigrationCommandLine.ParseVerify(args);
        var artifacts = Substitute.For<IOfflineMigrationVerificationArtifactReader>();
        var authority = Substitute.For<IOfflineMigrationCurrentSchemaVerificationAuthority>();
        var operations = Substitute.For<IOfflineMigrationApplyOperationRegistry>();
        IOfflineMigrationVerifiedReceiptProducer producer = OfflineMigrationVerifyEvidence.ComposeOwned(
            new(artifacts, null!, authority, operations));
        using var cancellation = new CancellationTokenSource();
        InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            producer.IssueAsync(options, cancellation.Token));
        Assert.Equal("current_verify_native_owners_not_configured", failure.Message);
        Assert.Empty(artifacts.ReceivedCalls());
        Assert.Empty(authority.ReceivedCalls());
        Assert.Empty(operations.ReceivedCalls());
        Assert.Empty(Directory.EnumerateFileSystemEntries(directory.Path));
    }

    [Theory]
    [InlineData("postgresql", CurrentSchemaProviderKind.PostgreSql)]
    [InlineData("mysql", CurrentSchemaProviderKind.MySql)]
    [InlineData("sqlite", CurrentSchemaProviderKind.Sqlite)]
    public void Verify_ExplicitProviderIsPreservedWithoutNativeAdmission(string provider, CurrentSchemaProviderKind expected)
    {
        using var directory = new OwnedDirectory();
        string[] args = Arguments(directory.Path);
        args[Array.IndexOf(args, "--provider") + 1] = provider;
        OfflineMigrationVerifyCommandOptions parsed = OfflineMigrationCommandLine.ParseVerify(args);
        Assert.Equal(expected, parsed.Request.Database.Provider);
        Assert.Equal("instance", parsed.Request.Database.InstanceId);
        Assert.Equal("database", parsed.Request.Database.DatabaseId);
        Assert.Equal(2, parsed.Request.Checkpoints.Length);
        Assert.Equal(30, parsed.TimeoutSeconds);
        Assert.Empty(Directory.EnumerateFileSystemEntries(directory.Path));
    }

    [Fact]
    public void Verify_ExplicitOriginalArtifactsKeepOrderedCheckpointsAndDatabase()
    {
        using var directory = new OwnedDirectory();
        string[] args = Arguments(directory.Path);
        OfflineMigrationVerifyCommandOptions parsed = OfflineMigrationCommandLine.ParseVerify(args);
        Assert.Equal("instance", parsed.Request.Database.InstanceId);
        Assert.Equal("database", parsed.Request.Database.DatabaseId);
        Assert.Equal("invocation", parsed.Request.InvocationId);
        Assert.Equal(new[] { System.IO.Path.Combine(directory.Path, "checkpoint-1.json"),
            System.IO.Path.Combine(directory.Path, "checkpoint-2.json") }, parsed.Request.Checkpoints.Select(value => value.Reference));
        Assert.All(parsed.Request.Checkpoints, value => Assert.Equal(Digest, value.Sha256));
        Assert.Equal(30, parsed.TimeoutSeconds);
        Assert.False(File.Exists(parsed.OutputPath));
    }

    [Theory]
    [InlineData("--timeout-seconds", "0")]
    [InlineData("--timeout-seconds", "01")]
    [InlineData("--timeout-seconds", "+1")]
    [InlineData("--timeout-seconds", "-1")]
    [InlineData("--timeout-seconds", "1e2")]
    [InlineData("--timeout-seconds", "2147484")]
    [InlineData("--timeout-seconds", " 30")]
    [InlineData("--provider", "mysql-latest")]
    [InlineData("--plan", "relative.json")]
    [InlineData("--plan-sha256", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")]
    [InlineData("--invocation-id", "invocation\n")]
    public void Verify_NoncanonicalOrUnsupportedArgumentsRefuseBeforeIo(string flag, string value)
    {
        using var directory = new OwnedDirectory();
        string[] args = Arguments(directory.Path);
        args[Array.IndexOf(args, flag) + 1] = value;
        Assert.Throws<InvalidOperationException>(() => OfflineMigrationCommandLine.ParseVerify(args));
        Assert.Empty(Directory.EnumerateFileSystemEntries(directory.Path));
    }

    [Fact]
    public void Verify_MissingDuplicateUnknownLatestAndConflictingInputsRefuse()
    {
        using var directory = new OwnedDirectory();
        string[] args = Arguments(directory.Path);
        int environmentIndex = Array.IndexOf(args, "--env-file");
        Assert.Throws<InvalidOperationException>(() => OfflineMigrationCommandLine.ParseVerify(
            args.Take(environmentIndex).Concat(args.Skip(environmentIndex + 2)).ToArray()));
        Assert.Throws<InvalidOperationException>(() => OfflineMigrationCommandLine.ParseVerify(
            args.Concat(new[] { "--provider", "postgresql" }).ToArray()));
        Assert.Throws<InvalidOperationException>(() => OfflineMigrationCommandLine.ParseVerify(
            args.Concat(new[] { "--accept-recorded", "true" }).ToArray()));
        Assert.Throws<InvalidOperationException>(() => OfflineMigrationCommandLine.ParseVerify(args[..^1]));
        string[] latest = (string[])args.Clone();
        latest[Array.IndexOf(latest, "--plan") + 1] = System.IO.Path.Combine(directory.Path, "latest", "plan.json");
        Assert.Throws<InvalidOperationException>(() => OfflineMigrationCommandLine.ParseVerify(latest));
        string[] conflict = (string[])args.Clone();
        conflict[Array.IndexOf(conflict, "--output") + 1] = conflict[Array.IndexOf(conflict, "--plan") + 1];
        Assert.Throws<InvalidOperationException>(() => OfflineMigrationCommandLine.ParseVerify(conflict));
        string[] duplicateCheckpoint = (string[])args.Clone();
        int first = Array.IndexOf(args, "--checkpoint");
        duplicateCheckpoint[first + 4] = duplicateCheckpoint[first + 1];
        Assert.Throws<InvalidOperationException>(() => OfflineMigrationCommandLine.ParseVerify(duplicateCheckpoint));
        Assert.Throws<InvalidOperationException>(() => OfflineMigrationCommandLine.ParseVerify(args[..first]));
    }

    [Theory]
    [InlineData("1", 1)]
    [InlineData("2147483", 2147483)]
    public void Verify_RepresentableExplicitBudgetBoundariesRemainValid(string value, int expected)
    {
        using var directory = new OwnedDirectory();
        string[] args = Arguments(directory.Path);
        args[Array.IndexOf(args, "--timeout-seconds") + 1] = value;
        Assert.Equal(expected, OfflineMigrationCommandLine.ParseVerify(args).TimeoutSeconds);
    }

    [Fact]
    public async Task Publication_WholeByteShaPrivateModeAndNoOverwrite()
    {
        using var directory = new OwnedDirectory();
        string path = System.IO.Path.Combine(directory.Path, "artifact.json");
        byte[] bytes = Encoding.UTF8.GetBytes("{\"source\":\"\u6e90\"}\n");
        CurrentSchemaArtifactReference reference = await OfflineMigrationArtifactPublisher.PublishAsync(path, bytes, CancellationToken.None);
        Assert.Equal(path, reference.Reference);
        Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(bytes)), reference.Sha256);
        Assert.Equal(bytes, await File.ReadAllBytesAsync(path));
        if (!OperatingSystem.IsWindows()) Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(path));
        await Assert.ThrowsAsync<IOException>(() => OfflineMigrationArtifactPublisher.PublishAsync(path, new byte[] { 1 }, CancellationToken.None));
        Assert.Equal(bytes, await File.ReadAllBytesAsync(path));
        Assert.Single(Directory.EnumerateFileSystemEntries(directory.Path));
    }

    [Fact]
    public async Task Publication_CancelledOrInvalidInputCreatesNoArtifact()
    {
        using var directory = new OwnedDirectory();
        string path = System.IO.Path.Combine(directory.Path, "artifact.json");
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => OfflineMigrationArtifactPublisher.PublishAsync(path,
            new byte[] { 1 }, cancellation.Token));
        await Assert.ThrowsAsync<InvalidOperationException>(() => OfflineMigrationArtifactPublisher.PublishAsync("relative.json",
            new byte[] { 1 }, CancellationToken.None));
        await Assert.ThrowsAsync<InvalidOperationException>(() => OfflineMigrationArtifactPublisher.PublishAsync(path,
            ReadOnlyMemory<byte>.Empty, CancellationToken.None));
        Assert.Empty(Directory.EnumerateFileSystemEntries(directory.Path));
    }

    [Fact]
    public async Task Verify_PublicationNamesActualPathAndWholeReceiptBytes()
    {
        using var directory = new OwnedDirectory();
        OfflineMigrationVerifyCommandOptions options = OfflineMigrationCommandLine.ParseVerify(Arguments(directory.Path));
        OfflineMigrationCurrentSchemaIssuedArtifact artifact = CodecFixture(options);
        using var output = new StringWriter();
        await OfflineMigrationHost.VerifyWithinBudgetAsync(options, () => new FixtureProducer((_, _) => Task.FromResult(artifact)),
            output, CancellationToken.None);
        Assert.Equal(artifact.Bytes.ToArray(), await File.ReadAllBytesAsync(options.OutputPath));
        using JsonDocument response = JsonDocument.Parse(output.ToString());
        Assert.Equal(options.OutputPath, response.RootElement.GetProperty("receipt").GetProperty("Reference").GetString());
        Assert.Equal(artifact.Reference.Sha256, response.RootElement.GetProperty("receipt").GetProperty("Sha256").GetString());
        Assert.NotEqual(artifact.Receipt.ContentDigest, artifact.Reference.Sha256);
    }

    [Theory]
    [InlineData("bytes")]
    [InlineData("sha")]
    [InlineData("database")]
    [InlineData("plan")]
    [InlineData("checkpoints")]
    [InlineData("rejected")]
    public async Task Verify_ChangedProducerCarrierNeverPublishes(string change)
    {
        using var directory = new OwnedDirectory();
        OfflineMigrationVerifyCommandOptions options = OfflineMigrationCommandLine.ParseVerify(Arguments(directory.Path));
        OfflineMigrationCurrentSchemaIssuedArtifact artifact = CodecFixture(options);
        if (change == "bytes") artifact = artifact with { Bytes = artifact.Bytes.ToArray().Concat(new byte[] { 10 }).ToArray() };
        else if (change == "sha") artifact = artifact with { Reference = artifact.Reference with { Sha256 = Digest } };
        else
        {
            CurrentSchemaReceipt receipt = artifact.Receipt;
            receipt = change switch
            {
                "database" => receipt with { Database = receipt.Database with { DatabaseId = "another" } },
                "plan" => receipt with { Plan = receipt.Plan with { Reference = "another-plan" } },
                "checkpoints" => receipt with { Checkpoints = receipt.Checkpoints.Reverse().ToImmutableArray() },
                "rejected" => receipt with { Status = CurrentSchemaReceiptStatus.Rejected, Reasons = ["rejected"] },
                _ => throw new InvalidOperationException()
            };
            receipt = receipt with { ContentDigest = CurrentSchemaReceiptCodec.ComputeContentDigest(receipt) };
            byte[] bytes = CurrentSchemaReceiptCodec.Serialize(receipt);
            artifact = new(new("logical", Convert.ToHexStringLower(SHA256.HashData(bytes))), receipt, bytes);
        }
        OfflineMigrationCurrentSchemaIssuedArtifact changed = artifact;
        await Assert.ThrowsAsync<InvalidOperationException>(() => OfflineMigrationHost.VerifyWithinBudgetAsync(options,
            () => new FixtureProducer((_, _) => Task.FromResult(changed)), TextWriter.Null, CancellationToken.None));
        Assert.Empty(Directory.EnumerateFileSystemEntries(directory.Path));
    }

    [Fact]
    public async Task Verify_InvalidBudgetRefusesBeforeProducerConstruction()
    {
        using var directory = new OwnedDirectory();
        OfflineMigrationVerifyCommandOptions options = OfflineMigrationCommandLine.ParseVerify(Arguments(directory.Path)) with { TimeoutSeconds = 0 };
        bool constructed = false;
        await Assert.ThrowsAsync<InvalidOperationException>(() => OfflineMigrationHost.VerifyWithinBudgetAsync(options,
            () => { constructed = true; throw new InvalidOperationException(); }, TextWriter.Null, CancellationToken.None));
        Assert.False(constructed);
    }

    [Fact]
    public async Task Verify_CancellationAwaitsProducerTerminalAndPreservesCleanupFailure()
    {
        using var directory = new OwnedDirectory();
        OfflineMigrationVerifyCommandOptions options = OfflineMigrationCommandLine.ParseVerify(Arguments(directory.Path));
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var cancellation = new CancellationTokenSource();
        Task operation = OfflineMigrationHost.VerifyWithinBudgetAsync(options, () => new FixtureProducer(async (_, token) =>
        {
            entered.SetResult();
            await release.Task;
            Assert.True(token.IsCancellationRequested);
            throw new InvalidOperationException("current_verify_connection_cleanup_unverified_primary_cancelled");
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
            // Observe the real terminal even when a preceding assertion fails.
            try { await operation; } catch { }
        }
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() => operation);
        Assert.Equal("current_verify_connection_cleanup_unverified_primary_cancelled", error.Message);
        Assert.False(File.Exists(options.OutputPath));
    }

    [Fact]
    public async Task Verify_ResponseFailureRetainsPublishedArtifactWithoutClaimingUnissued()
    {
        using var directory = new OwnedDirectory();
        OfflineMigrationVerifyCommandOptions options = OfflineMigrationCommandLine.ParseVerify(Arguments(directory.Path));
        OfflineMigrationCurrentSchemaIssuedArtifact artifact = CodecFixture(options);
        using var output = new FailingWriter();
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() => OfflineMigrationHost.VerifyWithinBudgetAsync(
            options, () => new FixtureProducer((_, _) => Task.FromResult(artifact)), output, CancellationToken.None));
        Assert.Equal("current_verify_receipt_published_response_failed", error.Message);
        Assert.True(output.ReceivedCancelableToken);
        Assert.Equal(artifact.Bytes.ToArray(), await File.ReadAllBytesAsync(options.OutputPath));
    }

    [Theory]
    [InlineData(true, "cancelled")]
    [InlineData(false, "failed")]
    public void Verify_OriginalIssuerSecondaryCleanupCannotBecomeOrdinaryPrimaryFailure(bool cancelled, string category)
    {
        Exception primary = cancelled ? new OperationCanceledException() : new IOException("private driver detail");
        primary.Data["current_verify_read_only_cleanup_failed"] = true;
        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() =>
            OfflineMigrationOwnedVerifyEvidence.ThrowObservedFailure(primary));
        Assert.Equal("current_verify_transaction_cleanup_unverified_primary_" + category, error.Message);
        Assert.Null(error.InnerException);
    }

    [Fact]
    public void Verify_UnmarkedOriginalCancellationKeepsExactPrimaryIdentity()
    {
        var primary = new OperationCanceledException();
        Assert.Same(primary, Assert.Throws<OperationCanceledException>(() => OfflineMigrationOwnedVerifyEvidence.ThrowObservedFailure(primary)));
        OfflineMigrationOwnedVerifyEvidence.ThrowObservedFailure(null);
    }

    private static string[] ExistingArguments(string root)
    {
        var args = Arguments(root).ToList();
        args[args.IndexOf("--output")] = "--receipt";
        args.AddRange(["--receipt-sha256", Digest]);
        return args.ToArray();
    }

    private static string[] Arguments(string root) => ["verify", "--provider", "postgresql", "--instance-id", "instance",
        "--database-id", "database", "--env-file", System.IO.Path.Combine(root, "connection.env"),
        "--plan", System.IO.Path.Combine(root, "plan.json"), "--plan-sha256", Digest,
        "--apply", System.IO.Path.Combine(root, "apply.json"), "--apply-sha256", Digest,
        "--invocation-id", "invocation", "--output", System.IO.Path.Combine(root, "current-receipt.json"),
        "--timeout-seconds", "30", "--checkpoint", System.IO.Path.Combine(root, "checkpoint-1.json"), Digest,
        "--checkpoint", System.IO.Path.Combine(root, "checkpoint-2.json"), Digest];

    private static OfflineMigrationCurrentSchemaIssuedArtifact CodecFixture(OfflineMigrationVerifyCommandOptions options)
    {
        // Structural carrier only, explicitly not native issuance, backup or schema proof.
        var receipt = new CurrentSchemaReceipt(CurrentSchemaReceiptCodec.Format, CurrentSchemaReceiptStatus.VerifiedCurrent,
            new("model", "extractor", "generator", Digest, Digest), "source", "v1", Digest, Digest,
            options.Request.Plan, options.Request.Apply, options.Request.Checkpoints, options.Request.Database, Digest,
            [new("step", "predicate", Digest, Digest, Digest)], new("backup", Digest), new("manifest", Digest), new("drill", Digest),
            [], new(new string('a', 40), Digest, Digest, Digest), [], string.Empty);
        receipt = receipt with { ContentDigest = CurrentSchemaReceiptCodec.ComputeContentDigest(receipt) };
        byte[] bytes = CurrentSchemaReceiptCodec.Serialize(receipt);
        return new(new("logical", Convert.ToHexStringLower(SHA256.HashData(bytes))), receipt, bytes);
    }

    private sealed class FixtureProducer(Func<OfflineMigrationVerifyCommandOptions, CancellationToken,
        Task<OfflineMigrationCurrentSchemaIssuedArtifact>> issue) : IOfflineMigrationVerifiedReceiptProducer
    {
        public Task<OfflineMigrationCurrentSchemaIssuedArtifact> IssueAsync(OfflineMigrationVerifyCommandOptions options, CancellationToken token)
            => issue(options, token);
    }

    private sealed class FailingWriter : StringWriter
    {
        internal bool ReceivedCancelableToken { get; private set; }
        public override Task WriteLineAsync(ReadOnlyMemory<char> buffer, CancellationToken cancellationToken = default)
        {
            ReceivedCancelableToken = cancellationToken.CanBeCanceled;
            return Task.FromException(new IOException("fixture response failure"));
        }
    }

    private sealed class OwnedDirectory : IDisposable
    {
        internal string Path { get; } = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "fsusblog-verify-" + Guid.NewGuid().ToString("N"));
        internal OwnedDirectory() => Directory.CreateDirectory(Path);
        public void Dispose() => Directory.Delete(Path, recursive: true);
    }
}
