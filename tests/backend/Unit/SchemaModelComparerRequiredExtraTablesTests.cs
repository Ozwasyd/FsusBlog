using FsusBlog.Server.Infrastructure.SchemaMigration;

using FsusBlog.Contracts.Schema;

using Xunit;

namespace FsusBlog.Server.Tests.Unit;

public sealed class SchemaModelComparerRequiredExtraTablesTests
{
    private static SchemaModelSnapshot Snapshot(
        params string[] tableNames)
        => new(
            tableNames.ToDictionary(
                static name => name,
                static name => new SchemaTableModel(
                    name,
                    [],
                    [],
                    owner: new SchemaOwnerModel("postgresql", $"public.{name}")),
                StringComparer.Ordinal),
            provider: SchemaProviderKind.PostgreSql);

    [Fact]
    public void MissingRequiredExtraTable_IsRejected()
    {
        SchemaModelSnapshot expected = Snapshot("article");
        SchemaModelSnapshot actual = Snapshot("article");

        IReadOnlyList<string> errors = SchemaModelComparer.Compare(
            expected,
            actual,
            allowedExtraTables: ["plugin_registry"],
            requiredExtraTables: ["daily_read_stats", "region_read_stats"]);

        Assert.Contains(errors, static error => error == "missing required extra table daily_read_stats");
        Assert.Contains(errors, static error => error == "missing required extra table region_read_stats");
    }

    [Fact]
    public void PresentRequiredExtraTable_IsAcceptedWithoutAllowlist()
    {
        SchemaModelSnapshot expected = Snapshot("article");
        SchemaModelSnapshot actual = Snapshot("article", "daily_read_stats");

        IReadOnlyList<string> errors = SchemaModelComparer.Compare(
            expected,
            actual,
            allowedExtraTables: null,
            requiredExtraTables: ["daily_read_stats"]);

        Assert.Empty(errors);
    }

    [Fact]
    public void RequiredExtraTable_DoesNotHideUnrelatedExtras()
    {
        SchemaModelSnapshot expected = Snapshot("article");
        SchemaModelSnapshot actual = Snapshot("article", "daily_read_stats", "unexpected_table");

        IReadOnlyList<string> errors = SchemaModelComparer.Compare(
            expected,
            actual,
            allowedExtraTables: null,
            requiredExtraTables: ["daily_read_stats"]);

        Assert.Contains(
            errors,
            static error => error.StartsWith("extra table unexpected_table", StringComparison.Ordinal));
        Assert.DoesNotContain(
            errors,
            static error => error.Contains("daily_read_stats", StringComparison.Ordinal));
    }
}
