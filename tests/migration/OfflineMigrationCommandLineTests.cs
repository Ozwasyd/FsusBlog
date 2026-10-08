using Xunit;

namespace FsusBlog.Migration.Tests;

public sealed class OfflineMigrationCommandLineTests
{
    [Fact]
    public void ParsePlan_RequiresExplicitDatabaseProviderAndOriginalBackupReferences()
    {
        OfflineMigrationPlanCommandOptions options = OfflineMigrationCommandLine.ParsePlan(PlanArguments());
        Assert.Equal("instance", options.ExpectedDatabase.InstanceId);
        Assert.Equal("database", options.ExpectedDatabase.DatabaseId);
        Assert.Equal("backup.fsbenc", options.BackupPackagePath);
        Assert.Equal("manifest.json", options.BackupManifestPath);
        Assert.Equal("drill.json", options.RestoreDrillPath);
        Assert.Equal("restore.env", options.RestoreEnvironmentFilePath);
        Assert.Equal("plan.json", options.PlanOutputPath);
        Assert.Equal(60, options.TimeoutSeconds);
    }

    [Theory]
    [InlineData("--release-manifest")]
    [InlineData("--slot")]
    [InlineData("--latest-backup")]
    [InlineData("--phase")]
    [InlineData("--steps")]
    public void ParsePlan_RejectsReleaseSlotLegacyPhaseAndManualSelection(string argument)
    {
        Assert.StartsWith("schema_plan_argument_unknown:", Assert.Throws<InvalidOperationException>(() =>
            OfflineMigrationCommandLine.ParsePlan([.. PlanArguments(), argument, "value"])).Message);
    }

    [Fact]
    public void ParsePlan_RejectsDuplicateMissingAndUnknownProvider()
    {
        Assert.StartsWith("schema_plan_argument_invalid_or_duplicate:", Assert.Throws<InvalidOperationException>(() =>
            OfflineMigrationCommandLine.ParsePlan([.. PlanArguments(), "--database-id", "other"])).Message);
        Assert.StartsWith("schema_plan_argument_required:", Assert.Throws<InvalidOperationException>(() =>
            OfflineMigrationCommandLine.ParsePlan(["plan", "--provider", "postgresql"])).Message);
        string[] unknown = PlanArguments();
        unknown[2] = "guess";
        Assert.Equal("schema_plan_provider_unknown", Assert.Throws<InvalidOperationException>(() =>
            OfflineMigrationCommandLine.ParsePlan(unknown)).Message);
    }

    private static string[] PlanArguments()
        => ["plan", "--provider", "postgresql", "--instance-id", "instance", "--database-id", "database",
            "--env-file", "source.env", "--backup-package", "backup.fsbenc", "--backup-manifest", "manifest.json",
            "--restore-drill", "drill.json", "--restore-env-file", "restore.env", "--output", "plan.json",
            "--timeout-seconds", "60"];

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
