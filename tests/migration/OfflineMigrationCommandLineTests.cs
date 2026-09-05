using Xunit;

namespace FsusBlog.Migration.Tests;

public sealed class OfflineMigrationCommandLineTests
{
    [Fact]
    public void Parse_Expand()
    {
        OfflineMigrationCommandOptions options = OfflineMigrationCommandLine.Parse(
            ["migrate", "--phase", "expand", "--release-manifest", "/tmp/manifest.json"]);

        Assert.Equal(OfflineMigrationPhase.Expand, options.Phase);
        Assert.Null(options.MigrationId);
        Assert.Equal("/tmp/manifest.json", options.ReleaseManifestPath);
        Assert.False(options.ConfirmDestructive);
        Assert.False(options.DryRun);
    }

    [Fact]
    public void Parse_BackfillRequiresId()
    {
        Assert.Throws<InvalidOperationException>(() =>
            OfflineMigrationCommandLine.Parse(["migrate", "--phase", "backfill-resume"]));
    }

    [Fact]
    public void Parse_BackfillWithIdAndDryRun()
    {
        OfflineMigrationCommandOptions options = OfflineMigrationCommandLine.Parse(
            ["migrate", "--phase", "backfill-resume", "--id", "20260711-post-account-subject-hash-backfill", "--dry-run"]);

        Assert.Equal(OfflineMigrationPhase.Backfill, options.Phase);
        Assert.Equal("20260711-post-account-subject-hash-backfill", options.MigrationId);
        Assert.True(options.DryRun);
    }

    [Fact]
    public void Parse_ContractRequiresEvidence()
    {
        Assert.Throws<InvalidOperationException>(() =>
            OfflineMigrationCommandLine.Parse(["migrate", "--phase", "contract", "--confirm-destructive"]));
    }

    [Fact]
    public void Parse_ContractRequiresConfirmation()
    {
        Assert.Throws<InvalidOperationException>(() =>
            OfflineMigrationCommandLine.Parse(
                ["migrate", "--phase", "contract", "--evidence", "/tmp/evidence.json"]));
    }

    [Fact]
    public void Parse_ContractWithEvidenceAndConfirmation()
    {
        OfflineMigrationCommandOptions options = OfflineMigrationCommandLine.Parse(
            ["migrate", "--phase", "contract", "--evidence", "/tmp/evidence.json", "--confirm-destructive"]);

        Assert.Equal(OfflineMigrationPhase.Contract, options.Phase);
        Assert.True(options.ConfirmDestructive);
    }

    [Fact]
    public void Parse_IdOnlyForBackfill()
    {
        Assert.Throws<InvalidOperationException>(() =>
            OfflineMigrationCommandLine.Parse(
                ["migrate", "--phase", "expand", "--id", "20260724-post-plugin-registry"]));
    }

    [Fact]
    public void Parse_UnknownCommandRejected()
    {
        Assert.Throws<InvalidOperationException>(() => OfflineMigrationCommandLine.Parse(["serve"]));
    }

    [Fact]
    public void Parse_UnknownArgumentRejected()
    {
        Assert.Throws<InvalidOperationException>(() =>
            OfflineMigrationCommandLine.Parse(["migrate", "--phase", "expand", "--bogus"]));
    }
}
