using Microsoft.Extensions.Logging.Abstractions;

using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Services.Security;

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
