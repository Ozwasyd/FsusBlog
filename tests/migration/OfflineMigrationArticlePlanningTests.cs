using System.Collections.Immutable;

using FsusBlog.Contracts.Migration;

using Xunit;

namespace FsusBlog.Migration.Tests;

// Pure process-selector and early-refusal controls. No private target/tool/native
// capability is fabricated, and these cases do not prove article/backup publication.
public sealed class OfflineMigrationArticlePlanningTests
{
    [Fact]
    public void ExplicitArticleSelectorsRetainOriginalBackupRunScopeWithoutIo()
    {
        var fixture = Fixture();
        OfflineMigrationHostOwnedConfiguration.RequireArticlePlanningScope(
            fixture.Options, fixture.Inputs, fixture.Scope, default);
        Assert.Equal(new Uri("https://example.test/original/articles/"), fixture.Inputs.DocumentBase);
        Assert.Equal("explicit-current-owner-transition", fixture.Inputs.PublicationTransitionKind);
        Assert.Equal("explicit-current-owner-audit", fixture.Inputs.RevisionDiffSummary);
        Assert.Null(fixture.Options.OperationDeadline);
        Assert.False(Directory.Exists(fixture.Inputs.OutputDirectory));
        Assert.False(File.Exists(fixture.Options.PlanOutputPath));
    }

    [Theory]
    [InlineData("database")]
    [InlineData("environment")]
    [InlineData("restore-environment")]
    [InlineData("package")]
    [InlineData("plan-output")]
    [InlineData("provider")]
    public void ChangedPlanLocatorsCannotReuseOriginalBackupScope(string field)
    {
        var fixture = Fixture();
        var changed = field switch
        {
            "database" => fixture.Options with { ExpectedDatabase = fixture.Options.ExpectedDatabase with { DatabaseId = "other" } },
            "environment" => fixture.Options with { EnvironmentFilePath = "other.env" },
            "restore-environment" => fixture.Options with { RestoreEnvironmentFilePath = "other.env" },
            "package" => fixture.Options with { BackupPackagePath = "other.package" },
            "plan-output" => fixture.Options with { PlanOutputPath = "other.plan" },
            _ => fixture.Options with { ExpectedDatabase = fixture.Options.ExpectedDatabase with { Provider = CurrentSchemaProviderKind.Sqlite } }
        };
        Assert.Equal("offline_backup_tool_configuration_invocation_scope_changed", Assert.Throws<InvalidOperationException>(() =>
            OfflineMigrationHostOwnedConfiguration.RequireArticlePlanningScope(changed,
                fixture.Inputs, fixture.Scope, default)).Message);
        Assert.False(Directory.Exists(fixture.Inputs.OutputDirectory));
    }

    [Theory]
    [InlineData("parent")]
    [InlineData("outside")]
    [InlineData("prefix-sibling")]
    public void ArticleOutputMustBeInsideTheExplicitOriginalRunOutputScope(string field)
    {
        var fixture = Fixture();
        string output = field switch
        {
            "parent" => fixture.Scope.OutputParent,
            "outside" => Path.Combine(Path.GetDirectoryName(fixture.Scope.OutputParent)!, "other-run"),
            _ => fixture.Scope.OutputParent + "-alias/output"
        };
        Assert.Equal("offline_article_original_output_scope_changed", Assert.Throws<InvalidOperationException>(() =>
            OfflineMigrationHostOwnedConfiguration.RequireArticlePlanningScope(fixture.Options,
                fixture.Inputs with { OutputDirectory = output }, fixture.Scope, default)).Message);
    }

    [Fact]
    public async Task MissingActualOtherProvidersRefuseOriginalFactoryBeforeCredentialsOrAnyCapabilityUse()
    {
        var fixture = Fixture();
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            OfflineMigrationHostOwnedConfiguration.CreateOriginalArticlePreservationAsync(fixture.Options,
                fixture.Inputs, null!, null!, null!, null!, ImmutableArray<OfflineMigrationApplyOperation>.Empty,
                TimeSpan.FromHours(1), null!, default));
        Assert.False(Directory.Exists(fixture.Inputs.OutputDirectory));
        Assert.False(File.Exists(fixture.Options.PlanOutputPath));
    }

    [Fact]
    public async Task CancelledOriginalFactoryDoesNotReadCredentialsOrConstructCapabilities()
    {
        var fixture = Fixture();
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            OfflineMigrationHostOwnedConfiguration.CreateOriginalArticlePreservationAsync(fixture.Options,
                fixture.Inputs, null!, null!, null!, null!, [], TimeSpan.FromHours(1), null!, cancellation.Token));
        Assert.False(File.Exists(fixture.Options.PlanOutputPath));
    }

    private static (OfflineMigrationPlanCommandOptions Options, ArticlePreservationProducerInputs Inputs,
        OfflineMigrationShellBackupDrillInputScope Scope) Fixture()
    {
        string root = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "article-host-contract-" + Guid.NewGuid().ToString("N")));
        var database = new CurrentSchemaDatabaseIdentity(CurrentSchemaProviderKind.PostgreSql, "contract-instance", "contract-db");
        var options = new OfflineMigrationPlanCommandOptions(database, Path.Combine(root, "source.env"),
            Path.Combine(root, "backup.package"), Path.Combine(root, "package-manifest.json"),
            Path.Combine(root, "backup-restore-drill.json"), Path.Combine(root, "restore.env"), Path.Combine(root, "plan.json"), 30);
        var scope = new OfflineMigrationShellBackupDrillInputScope(database, options.EnvironmentFilePath,
            options.RestoreEnvironmentFilePath, options.BackupPackagePath, root, options.PlanOutputPath);
        var inputs = new ArticlePreservationProducerInputs(new(Path.Combine(root, "original-origin.artifact"), new string('a', 64)),
            new("https://example.test/original/articles/"), Path.Combine(root, "article-inputs"), 4096,
            "explicit-current-owner-transition", "explicit-current-owner-audit");
        return (options, inputs, scope);
    }
}
