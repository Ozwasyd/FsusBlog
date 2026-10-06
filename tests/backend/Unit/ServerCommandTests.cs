using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Services.Security;

using Microsoft.Extensions.Logging.Abstractions;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ServerCommandTests
{
    [Theory]
    [InlineData("migrate")]
    [InlineData("MIGRATE")]
    [InlineData("plan")]
    [InlineData("apply")]
    [InlineData("verify")]
    public void Parse_RejectsMigrationCommands(string name)
    {
        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() =>
            ServerCommandLine.Parse([name, "--phase", "expand"]));

        Assert.Equal("server_command_unknown", error.Message);
    }

    [Theory]
    [InlineData("--phase")]
    [InlineData("--PHASE=expand")]
    [InlineData("--id")]
    [InlineData("--release")]
    [InlineData("--release-manifest")]
    [InlineData("--evidence")]
    [InlineData("--confirm-destructive")]
    [InlineData("--dry-run")]
    [InlineData("--check")]
    public void Parse_RejectsMigrationArgumentsInBothServeForms(string argument)
    {
        foreach (string[] args in new[] { new[] { argument }, new[] { "serve", argument } })
        {
            InvalidOperationException error = Assert.Throws<InvalidOperationException>(() =>
                ServerCommandLine.Parse(args));

            Assert.Equal("server_migration_arguments_not_supported", error.Message);
        }
    }

    [Fact]
    public void Parse_PreservesServeHostArguments()
    {
        string[] hostArguments = ["--urls", "http://127.0.0.1:5000", "--environment=Production"];
        ServerCommand implicitServe = ServerCommandLine.Parse(hostArguments);
        ServerCommand explicitServe = ServerCommandLine.Parse(["serve", .. hostArguments]);
        ServerCommand emptyServe = ServerCommandLine.Parse([]);

        Assert.Equal(ServerCommandKind.Serve, implicitServe.Kind);
        Assert.Equal(hostArguments, implicitServe.HostArguments);
        Assert.Equal(hostArguments, explicitServe.HostArguments);
        Assert.Null(implicitServe.EnvironmentFilePath);
        Assert.False(implicitServe.ConfirmRepair);
        Assert.Empty(emptyServe.HostArguments);
    }

    [Fact]
    public void Parse_PasskeyRejectsMigrationArguments()
    {
        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() =>
            ServerCommandLine.Parse(["passkey-projection", "--check", "--phase", "expand"]));

        Assert.Equal("passkey_projection_argument_unknown:--phase", error.Message);
    }

    [Theory]
    [InlineData("--env-file")]
    [InlineData("--confirm-repair")]
    public void Parse_PasskeyRejectsMissingEnvironmentFileValue(string nextArgument)
    {
        string[] args = nextArgument == "--env-file"
            ? ["passkey-projection", "--check", "--env-file"]
            : ["passkey-projection", "--check", "--env-file", nextArgument];
        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() =>
            ServerCommandLine.Parse(args));

        Assert.Equal("server_command_value_missing:--env-file", error.Message);
    }

    [Theory]
    [InlineData(ServerCommandKind.Serve, false)]
    [InlineData((ServerCommandKind)999, false)]
    [InlineData(ServerCommandKind.PasskeyProjectionRepair, false)]
    public async Task Host_RejectsUnexecutableOrUnconfirmedCommandsBeforeService(
        ServerCommandKind kind,
        bool confirmRepair)
    {
        var service = new RecordingPasskeyProjectionService();
        var host = new ServerCommandHost(service, NullLogger<ServerCommandHost>.Instance);

        int exitCode = await host.RunAsync(new ServerCommand(kind, null, confirmRepair, []), CancellationToken.None);

        Assert.Equal(1, exitCode);
        Assert.Equal(0, service.CheckCalls);
        Assert.Equal(0, service.RepairCalls);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Host_ExecutesOnlySelectedPasskeyOperation(bool repair)
    {
        var service = new RecordingPasskeyProjectionService();
        var host = new ServerCommandHost(service, NullLogger<ServerCommandHost>.Instance);
        ServerCommand command = ServerCommandLine.Parse(repair
            ? ["passkey-projection", "--repair", "--confirm-repair"]
            : ["passkey-projection", "--check"]);

        int exitCode = await host.RunAsync(command, CancellationToken.None);

        Assert.Equal(0, exitCode);
        Assert.Equal(repair ? 0 : 1, service.CheckCalls);
        Assert.Equal(repair ? 1 : 0, service.RepairCalls);
    }

    [Fact]
    public void EnvironmentFile_ReadsLiteralValuesWithoutShellExpansion()
    {
        WithEnvironmentFile("# comment\n\nexport ConnectionStrings__DefaultConnection='$(not-a-command)'\nName=\"$UNEXPANDED\"\n", path =>
        {
            IReadOnlyDictionary<string, string?> values = ServerCommandEnvironmentFile.Read(path);

            Assert.Equal("$(not-a-command)", values["ConnectionStrings:DefaultConnection"]);
            Assert.Equal("$UNEXPANDED", values["Name"]);
            Assert.Equal(2, values.Count);
        });
    }

    [Theory]
    [InlineData("missing-separator", "server_env_file_line_invalid")]
    [InlineData("bad key=value", "server_env_file_key_invalid")]
    [InlineData("Name=first\nNAME=second", "server_env_file_key_duplicate")]
    [InlineData("Section__Name=first\nSection:Name=second", "server_env_file_key_duplicate")]
    public void EnvironmentFile_RejectsMalformedOrDuplicateKeys(string contents, string expectedCode)
    {
        WithEnvironmentFile(contents, path =>
        {
            InvalidOperationException error = Assert.Throws<InvalidOperationException>(() =>
                ServerCommandEnvironmentFile.Read(path));

            Assert.Equal(expectedCode, error.Message);
        });
    }

    [Fact]
    public void Parse_CurrentSchemaCheckPreservesExactExplicitInputsWithoutHostFallback()
    {
        string receiptPath = Path.Combine(Path.GetTempPath(), "current-receipt.json");
        string environmentPath = Path.Combine(Path.GetTempPath(), "current.env");
        string artifactDigest = new('a', 64);
        string sourceRevision = new('b', 40);
        ServerCommand command = ServerCommandLine.Parse([
            "current-schema-check", "--receipt", receiptPath, "--receipt-sha256", artifactDigest,
            "--candidate-source-revision", sourceRevision, "--env-file", environmentPath
        ]);

        Assert.Equal(ServerCommandKind.CurrentSchemaCheck, command.Kind);
        Assert.Equal(environmentPath, command.EnvironmentFilePath);
        Assert.False(command.ConfirmRepair);
        Assert.Empty(command.HostArguments);
        Assert.Equal(new CurrentSchemaCheckArguments(receiptPath, artifactDigest, sourceRevision), command.SchemaCheck);
    }

    [Theory]
    [InlineData("--receipt")]
    [InlineData("--receipt-sha256")]
    [InlineData("--candidate-source-revision")]
    [InlineData("--env-file")]
    public void Parse_CurrentSchemaCheckRejectsMissingAndDuplicateInputs(string option)
    {
        string[] complete = CurrentSchemaCheckArgumentsForTest();
        int index = Array.IndexOf(complete, option);
        string[] missing = [.. complete[..index], .. complete[(index + 2)..]];
        Assert.Throws<InvalidOperationException>(() => ServerCommandLine.Parse(missing));
        string[] duplicate = [.. complete, option, complete[index + 1]];
        Assert.Throws<InvalidOperationException>(() => ServerCommandLine.Parse(duplicate));
        string[] missingValue = [.. complete[..(index + 1)]];
        Assert.Throws<InvalidOperationException>(() => ServerCommandLine.Parse(missingValue));
    }

    [Theory]
    [InlineData("--phase")]
    [InlineData("--confirm-destructive")]
    [InlineData("--release-manifest")]
    [InlineData("--receipt=other.json")]
    [InlineData("--unknown")]
    public void Parse_CurrentSchemaCheckRejectsMutationAndUnknownOptions(string option)
    {
        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() =>
            ServerCommandLine.Parse([.. CurrentSchemaCheckArgumentsForTest(), option, "other"]));
        Assert.Equal("server_command_current_schema_argument_unknown", error.Message);
    }

    [Theory]
    [InlineData("--receipt", "relative.json")]
    [InlineData("--env-file", "relative.env")]
    [InlineData("--receipt", " /tmp/receipt.json")]
    [InlineData("--receipt", "/tmp/receipt.json\n")]
    [InlineData("--receipt-sha256", "missing")]
    [InlineData("--receipt-sha256", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")]
    [InlineData("--candidate-source-revision", "latest")]
    [InlineData("--candidate-source-revision", "0000000000000000000000000000000000000000")]
    public void Parse_CurrentSchemaCheckRejectsNonExactPathsOrIdentities(string option, string value)
    {
        string[] args = CurrentSchemaCheckArgumentsForTest();
        args[Array.IndexOf(args, option) + 1] = value;
        Assert.Throws<InvalidOperationException>(() => ServerCommandLine.Parse(args));
    }

    [Theory]
    [InlineData(ServerCommandKind.Serve)]
    [InlineData(ServerCommandKind.PasskeyProjectionRepair)]
    [InlineData((ServerCommandKind)999)]
    [InlineData(ServerCommandKind.CurrentSchemaCheck)]
    public async Task CurrentSchemaHost_RejectsMissingOrForeignIntentBeforeDatabase(ServerCommandKind kind)
    {
        var host = new CurrentSchemaReceiptCommandHost(
            null!, null!, NullLogger<CurrentSchemaReceiptCommandHost>.Instance);
        int exitCode = await host.RunAsync(new ServerCommand(kind, null, false, []), CancellationToken.None);
        Assert.Equal(1, exitCode);
    }

    [Fact]
    public async Task CurrentSchemaHost_UsesOriginalReadOnlyVerifierAndPropagatesCancellationBeforeDatabase()
    {
        var host = new CurrentSchemaReceiptCommandHost(
            null!, null!, NullLogger<CurrentSchemaReceiptCommandHost>.Instance);
        ServerCommand command = ServerCommandLine.Parse(CurrentSchemaCheckArgumentsForTest());
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => host.RunAsync(command, cancellation.Token));
    }

    private static string[] CurrentSchemaCheckArgumentsForTest() => [
        "current-schema-check", "--receipt", Path.Combine(Path.GetTempPath(), "current-receipt.json"),
        "--receipt-sha256", new string('a', 64), "--candidate-source-revision", new string('b', 40),
        "--env-file", Path.Combine(Path.GetTempPath(), "current.env")
    ];

    private static void WithEnvironmentFile(string contents, Action<string> action)
    {
        string path = Path.Combine(Path.GetTempPath(), $"fsusblog-server-command-{Guid.NewGuid():N}.env");
        try
        {
            File.WriteAllText(path, contents);
            action(path);
        }
        finally
        {
            File.Delete(path);
        }
    }

    private sealed class RecordingPasskeyProjectionService : IPasskeyProjectionConsistencyService
    {
        public int CheckCalls { get; private set; }
        public int RepairCalls { get; private set; }

        public Task<PasskeyProjectionConsistencyReport> CheckAsync(CancellationToken cancellationToken = default)
        {
            CheckCalls++;
            return Task.FromResult(new PasskeyProjectionConsistencyReport(0, 0, 0));
        }

        public Task<PasskeyProjectionConsistencyReport> RepairAsync(CancellationToken cancellationToken = default)
        {
            RepairCalls++;
            return Task.FromResult(new PasskeyProjectionConsistencyReport(1, 1, 0));
        }

        public Task EnsureAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
    }
}
