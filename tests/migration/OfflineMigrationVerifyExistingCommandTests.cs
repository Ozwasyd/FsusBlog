using System.Security.Cryptography;

using NSubstitute;
using Xunit;

using FsusBlog.Contracts.Migration;
using FsusBlog.Contracts.SchemaMigration;

namespace FsusBlog.Migration.Tests;

public sealed class OfflineMigrationVerifyExistingCommandTests
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
    [InlineData("--invocation-id", "--receipt")]
    [InlineData("--invocation-id", "--receipt-sha256")]
    [InlineData("--instance-id", "--receipt")]
    [InlineData("--instance-id", "--receipt-sha256")]
    [InlineData("--database-id", "--receipt")]
    [InlineData("--database-id", "--receipt-sha256")]
    public void Verify_ReceiptOptionNamesRemainLiteralOrdinaryIdentityValues(string name, string value)
    {
        using var directory = new OwnedDirectory();
        string[] args = Arguments(directory.Path);
        args[Array.IndexOf(args, name) + 1] = value;
        OfflineMigrationVerifyCommandOptions options = OfflineMigrationCommandLine.ParseVerify(args);
        string actual = name switch
        {
            "--invocation-id" => options.Request.InvocationId,
            "--instance-id" => options.Request.Database.InstanceId,
            "--database-id" => options.Request.Database.DatabaseId,
            _ => throw new InvalidOperationException()
        };
        Assert.Equal(value, actual);
        Assert.False(OfflineMigrationCommandLine.HasExistingVerifyReceiptOptions(args));
        Assert.True(OfflineMigrationCommandLine.HasExistingVerifyReceiptOptions(ExistingArguments(directory.Path)));
        Assert.Throws<InvalidOperationException>(() => OfflineMigrationCommandLine.ParseVerifyExisting(args));
        Assert.Empty(Directory.EnumerateFileSystemEntries(directory.Path));
    }

    [Fact]
    public async Task VerifyExisting_ConfiguredSqliteStillRefusesBeforeArtifactOrCredentialRead()
    {
        using var directory = new OwnedDirectory();
        string[] args = ExistingArguments(directory.Path);
        args[Array.IndexOf(args, "--provider") + 1] = "sqlite";
        OfflineMigrationVerifyExistingCommandOptions options = OfflineMigrationCommandLine.ParseVerifyExisting(args);
        var artifacts = Substitute.For<IOfflineMigrationVerificationArtifactReader>();
        var current = Substitute.For<IOfflineMigrationCurrentSchemaObserver>();
        var authority = Substitute.For<IOfflineMigrationCurrentSchemaVerificationAuthority>();
        var operations = Substitute.For<IOfflineMigrationApplyOperationRegistry>();
        OfflineMigrationOwnedVerifyEvidence verifier = OfflineMigrationVerifyEvidence.ComposeOwnedExisting(
            new(artifacts, current, authority, operations));
        InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            OfflineMigrationHost.VerifyExistingWithinBudgetAsync(options, () => verifier, TextWriter.Null, CancellationToken.None));
        Assert.Equal("current_verify_sqlite_owned_current_schema_not_configured", failure.Message);
        Assert.Empty(artifacts.ReceivedCalls());
        Assert.Empty(current.ReceivedCalls());
        Assert.Empty(authority.ReceivedCalls());
        Assert.Empty(operations.ReceivedCalls());
        Assert.Empty(Directory.EnumerateFileSystemEntries(directory.Path));
    }

    [Fact]
    public async Task ExistingArtifactCaptureOwnsItsBytesWithoutNativeAdmission()
    {
        using var directory = new OwnedDirectory();
        OfflineMigrationVerifyCommandOptions options = OfflineMigrationCommandLine.ParseVerify(Arguments(directory.Path));
        OfflineMigrationCurrentSchemaIssuedArtifact artifact = CodecFixture(options);
        CurrentSchemaArtifactReference reference = new(options.OutputPath, artifact.Reference.Sha256);
        byte[] returned = artifact.Bytes.ToArray();
        var reader = Substitute.For<IOfflineMigrationVerificationArtifactReader>();
        reader.ReadAsync(reference, Arg.Any<CancellationToken>()).Returns(Task.FromResult<ReadOnlyMemory<byte>>(returned));
        var owners = new OfflineMigrationCurrentSchemaVerificationCapabilities(reader,
            Substitute.For<IOfflineMigrationCurrentSchemaObserver>(),
            Substitute.For<IOfflineMigrationCurrentSchemaVerificationAuthority>(),
            Substitute.For<IOfflineMigrationApplyOperationRegistry>());
        OfflineMigrationCurrentSchemaIssuedArtifact captured = await OfflineMigrationCurrentSchemaIssuer.ReadExistingArtifactAsync(
            reference, owners, CancellationToken.None);
        returned[^1] ^= 1;
        Assert.Equal(artifact.Bytes.ToArray(), captured.Bytes.ToArray());
        await Assert.ThrowsAsync<InvalidOperationException>(() => OfflineMigrationCurrentSchemaIssuer.RecheckExistingArtifactAsync(
            reference, captured.Receipt, captured.Bytes, owners, CancellationToken.None));
        Assert.Empty(owners.CurrentSchema.ReceivedCalls());
        Assert.Empty(owners.Authority.ReceivedCalls());
        Assert.Empty(owners.Operations.ReceivedCalls());
        Assert.Empty(Directory.EnumerateFileSystemEntries(directory.Path));
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(2147484)]
    public async Task VerifyExisting_UnrepresentableBudgetRefusesBeforeConstruction(int seconds)
    {
        using var directory = new OwnedDirectory();
        OfflineMigrationVerifyExistingCommandOptions options = OfflineMigrationCommandLine.ParseVerifyExisting(ExistingArguments(directory.Path))
            with { TimeoutSeconds = seconds };
        bool constructed = false;
        await Assert.ThrowsAsync<InvalidOperationException>(() => OfflineMigrationHost.VerifyExistingWithinBudgetAsync(options, () =>
        {
            constructed = true;
            throw new InvalidOperationException("fixture must not construct");
        }, TextWriter.Null, CancellationToken.None));
        Assert.False(constructed);
        Assert.Empty(Directory.EnumerateFileSystemEntries(directory.Path));
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

    private sealed class OwnedDirectory : IDisposable
    {
        internal string Path { get; } = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "fsusblog-verify-" + Guid.NewGuid().ToString("N"));
        internal OwnedDirectory() => Directory.CreateDirectory(Path);
        public void Dispose() => Directory.Delete(Path, recursive: true);
    }
}
