using FsusBlog.Server.Infrastructure.Operations;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>Pure closed CLI intent controls; parsed data never proves an inherited FD or native parent admission.</summary>
public sealed class CurrentSchemaOwnedInputsCommandTests
{
    private static string[] Arguments() => [
        "current-schema-check-owned-inputs",
        "--receipt", "/unopened/current-schema.receipt",
        "--receipt-sha256", new string('a', 64),
        "--candidate-source-revision", new string('b', 40),
        "--env-file", "/unopened/primary.env",
        "--env-sha256", new string('c', 64),
        "--env-epoch-sha256", new string('d', 64),
        "--receipt-epoch-sha256", new string('e', 64)
    ];

    [Fact]
    public void Parse_DelegatesOriginalCurrentSchemaInputsWithoutGrantingHostArgumentsOrFDSelection()
    {
        CurrentSchemaOwnedInputsArguments parsed = CurrentSchemaOwnedInputsCommand.Parse(Arguments());
        ServerCommand original = ServerCommandLine.Parse([
            "current-schema-check", .. Arguments()[1..9]
        ]);

        Assert.Equal(original.Kind, parsed.Intent.Kind);
        Assert.Equal(original.SchemaCheck, parsed.Intent.SchemaCheck);
        Assert.Equal(original.EnvironmentFilePath, parsed.Intent.EnvironmentFilePath);
        Assert.False(parsed.Intent.ConfirmRepair);
        Assert.Empty(parsed.Intent.HostArguments);
        Assert.Equal(new string('c', 64), parsed.EnvironmentArtifactSha256);
        Assert.Equal(new string('d', 64), parsed.EnvironmentObservationSha256);
        Assert.Equal(new string('e', 64), parsed.ReceiptObservationSha256);
        Assert.Equal(4, CurrentSchemaOwnedInputsCommand.EnvironmentDescriptor);
    }

    [Theory]
    [InlineData(1)]
    [InlineData(3)]
    [InlineData(5)]
    [InlineData(7)]
    [InlineData(9)]
    [InlineData(11)]
    [InlineData(13)]
    public void Parse_RejectsEachMissingAndDuplicatedOriginalOrComparisonInput(int offset)
    {
        string[] args = Arguments();
        string[] missing = [.. args.Take(offset), .. args.Skip(offset + 2)];
        string[] duplicate = [.. args, args[offset], args[offset + 1]];

        Assert.Throws<InvalidOperationException>(() => CurrentSchemaOwnedInputsCommand.Parse(missing));
        Assert.Throws<InvalidOperationException>(() => CurrentSchemaOwnedInputsCommand.Parse(duplicate));
    }

    [Theory]
    [InlineData("--env-fd")]
    [InlineData("--receipt-fd")]
    [InlineData("--mode")]
    [InlineData("--environment")]
    [InlineData("--urls")]
    [InlineData("--confirm-repair")]
    [InlineData("--phase")]
    [InlineData("--receipt-sha256=abc")]
    public void Parse_RejectsAnyDescriptorModeHostOrMigrationOverride(string option)
    {
        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() =>
            CurrentSchemaOwnedInputsCommand.Parse([.. Arguments(), option, "5"]));

        Assert.Equal("server_command_owned_current_schema_argument_unknown", error.Message);
    }

    [Theory]
    [InlineData(1)]
    [InlineData(3)]
    [InlineData(5)]
    [InlineData(7)]
    [InlineData(9)]
    [InlineData(11)]
    [InlineData(13)]
    public void Parse_RejectsMissingWhitespaceAndControlValuesForEveryInput(int offset)
    {
        string[] args = Arguments();
        foreach (string invalid in new[] { string.Empty, " value", "value ", "value\n", "--not-a-value" })
        {
            string[] changed = [.. args];
            changed[offset + 1] = invalid;
            Assert.Throws<InvalidOperationException>(() => CurrentSchemaOwnedInputsCommand.Parse(changed));
        }
        Assert.Throws<InvalidOperationException>(() =>
            CurrentSchemaOwnedInputsCommand.Parse([.. args.Take(offset + 1)]));
    }

    [Theory]
    [InlineData(3, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")]
    [InlineData(5, "0000000000000000000000000000000000000000")]
    [InlineData(1, "relative/current.receipt")]
    [InlineData(7, "relative/primary.env")]
    [InlineData(9, "not-a-digest")]
    [InlineData(11, "not-a-digest")]
    [InlineData(13, "not-a-digest")]
    public void Parse_RejectsOriginalSourcePathAndArtifactConstraintsPlusNewEpochData(int offset, string value)
    {
        string[] args = Arguments();
        args[offset + 1] = value;

        Assert.Throws<InvalidOperationException>(() => CurrentSchemaOwnedInputsCommand.Parse(args));
    }

    [Theory]
    [InlineData("serve")]
    [InlineData("current-schema-check")]
    [InlineData("passkey-projection")]
    [InlineData("CURRENT-SCHEMA-CHECK-OWNED-INPUTS")]
    public void OwnedEntry_RequiresItsExactExplicitCommandWithoutOrdinaryParserFallback(string name)
    {
        string[] args = Arguments();
        args[0] = name;
        Assert.False(CurrentSchemaOwnedInputsCommand.IsRequested(args));
        Assert.Throws<InvalidOperationException>(() => CurrentSchemaOwnedInputsCommand.Parse(args));
        Assert.Throws<InvalidOperationException>(() => ServerCommandLine.Parse(Arguments()));
    }
}
