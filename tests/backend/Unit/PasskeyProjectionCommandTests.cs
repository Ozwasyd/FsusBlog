using FsusBlog.Server.Infrastructure.SchemaMigration;

namespace FsusBlog.Server.Tests.Unit;

public sealed class PasskeyProjectionCommandTests
{
    [Fact]
    public void CheckCommand_ParsesWithoutReleaseIdentity()
    {
        OnlineSchemaMigrationCommand command = OnlineSchemaMigrationCommandLine.Parse(
            ["passkey-projection", "--check", "--env-file", "/run/secrets/fsus.env"]);

        Assert.Equal(OnlineSchemaMigrationCommandKind.PasskeyProjectionCheck, command.Kind);
        Assert.Equal("/run/secrets/fsus.env", command.EnvironmentFilePath);
        Assert.False(command.ConfirmDestructive);
    }

    [Fact]
    public void RepairCommand_RequiresExplicitConfirmation()
    {
        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() =>
            OnlineSchemaMigrationCommandLine.Parse(["passkey-projection", "--repair"]));
        OnlineSchemaMigrationCommand command = OnlineSchemaMigrationCommandLine.Parse(
            ["passkey-projection", "--repair", "--confirm-repair"]);

        Assert.Equal("passkey_projection_repair_confirmation_required", error.Message);
        Assert.Equal(OnlineSchemaMigrationCommandKind.PasskeyProjectionRepair, command.Kind);
        Assert.True(command.ConfirmDestructive);
    }

    [Theory]
    [InlineData("--check", "--repair", "passkey_projection_mode_required")]
    [InlineData("--check", "--confirm-repair", "passkey_projection_check_confirmation_conflict")]
    public void Command_RejectsConflictingModes(
        string first,
        string second,
        string expectedCode)
    {
        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() =>
            OnlineSchemaMigrationCommandLine.Parse(["passkey-projection", first, second]));

        Assert.Equal(expectedCode, error.Message);
    }
}
