using FsusBlog.Contracts.Schema;
using FsusBlog.Server.Infrastructure.SchemaMigration;

using Xunit;

namespace FsusBlog.Server.Tests.Unit;

public sealed class SchemaModelComparerExtraLinksTests
{
    private static SchemaModelSnapshot Snapshot(
        SchemaTableModel table,
        SchemaProviderKind provider = SchemaProviderKind.PostgreSql)
        => new(
            new Dictionary<string, SchemaTableModel>(StringComparer.Ordinal)
            {
                [table.Name] = table
            },
            provider: provider);

    private static SchemaTableModel Table(
        string tableName,
        IReadOnlyList<string> indexes,
        IReadOnlyList<SchemaConstraintModel> constraints)
        => new(
            name: tableName,
            columns: [],
            indexes: indexes,
            indexDefinitions: new Dictionary<string, SchemaIndexModel>(StringComparer.Ordinal),
            constraints: constraints.ToDictionary(
                static constraint => constraint.Name,
                StringComparer.Ordinal),
            owner: new SchemaOwnerModel("postgresql@public", "test"));

    [Fact]
    public void ExtraIndex_InAllowedLinks_IsAccepted()
    {
        SchemaModelSnapshot expected = Snapshot(Table("article", [], []));
        SchemaModelSnapshot actual = Snapshot(Table("article", ["idx_article_status"], []));

        IReadOnlyList<string> errors = SchemaModelComparer.Compare(
            expected,
            actual,
            allowedExtraTables: null,
            allowedExtraLinks: new HashSet<string>(StringComparer.Ordinal) { "idx_article_status" });

        Assert.Empty(errors);
    }

    [Fact]
    public void ExtraIndex_NotInAllowedLinks_IsRejected()
    {
        SchemaModelSnapshot expected = Snapshot(Table("article", [], []));
        SchemaModelSnapshot actual = Snapshot(Table("article", ["idx_article_status"], []));

        IReadOnlyList<string> errors = SchemaModelComparer.Compare(
            expected,
            actual,
            allowedExtraTables: null,
            allowedExtraLinks: new HashSet<string>(StringComparer.Ordinal) { "idx_other" });

        Assert.Contains(errors, static error => error.Contains("extra index article.idx_article_status", StringComparison.Ordinal));
    }

    [Fact]
    public void ExtraConstraint_InAllowedLinks_IsAccepted()
    {
        SchemaModelSnapshot expected = Snapshot(Table("comment", [], []));
        SchemaModelSnapshot actual = Snapshot(
            Table(
                "comment",
                [],
                [new SchemaConstraintModel("fk_comment_thread", "foreign_key", ["thread_id"])]));

        IReadOnlyList<string> errors = SchemaModelComparer.Compare(
            expected,
            actual,
            allowedExtraTables: null,
            allowedExtraLinks: new HashSet<string>(StringComparer.Ordinal) { "fk_comment_thread" });

        Assert.Empty(errors);
    }

    [Fact]
    public void ExtraConstraint_NotInAllowedLinks_IsRejected()
    {
        SchemaModelSnapshot expected = Snapshot(Table("comment", [], []));
        SchemaModelSnapshot actual = Snapshot(
            Table(
                "comment",
                [],
                [new SchemaConstraintModel("fk_comment_thread", "foreign_key", ["thread_id"])]));

        IReadOnlyList<string> errors = SchemaModelComparer.Compare(
            expected,
            actual,
            allowedExtraTables: null,
            allowedExtraLinks: null);

        Assert.Contains(errors, static error => error.Contains("extra constraint comment.fk_comment_thread", StringComparison.Ordinal));
    }

    [Fact]
    public void MissingEntityConstraint_StillRejected_WhenAllowedOnlyAppliesToExtras()
    {
        SchemaModelSnapshot expected = Snapshot(
            Table(
                "comment",
                [],
                [new SchemaConstraintModel("ck_comment_state", "check", ["state"])]));
        SchemaModelSnapshot actual = Snapshot(Table("comment", [], []));

        IReadOnlyList<string> errors = SchemaModelComparer.Compare(
            expected,
            actual,
            allowedExtraTables: null,
            allowedExtraLinks: new HashSet<string>(StringComparer.Ordinal) { "ck_comment_other" });

        Assert.Contains(errors, static error => error.Contains("missing constraint comment.ck_comment_state", StringComparison.Ordinal));
    }
}
