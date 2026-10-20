using FsusBlog.Contracts.Schema;

using Xunit;

namespace FsusBlog.Migration.Tests;

public sealed class ArticlePreservationStorageTests
{
    private const string Owner = "FsusBlog.Server.Entities.Article";

    [Fact]
    public void Owner_Binding_Uses_The_Exported_Names_And_Keeps_Raw_Field_Values()
    {
        ArticlePreservationLogicalRow row = new(Owner, [new("Id", 7), new("Title", " raw title\n")]);
        ArticlePreservationStorageRow bound = ArticlePreservationStorageProgram.BindRow(Table(), row);
        Assert.Equal("actual_owned_table", bound.Table);
        Assert.Equal("actual_owned_title", bound.Columns.Single(static column => column.PropertyOwner.EndsWith(".Title", StringComparison.Ordinal)).Name);
        Assert.Equal(" raw title\n", bound.Columns.Single(static column => column.PropertyOwner.EndsWith(".Title", StringComparison.Ordinal)).Value);
        Assert.Equal(7, bound.Columns.Single(static column => column.IsPrimaryKey).Value);
        // Synthetic metadata tests binding only, not a production export or executable program.
    }

    [Theory]
    [InlineData("missing-column")]
    [InlineData("extra-column")]
    [InlineData("unknown-owner")]
    [InlineData("duplicate-owner")]
    [InlineData("changed-type")]
    [InlineData("computed")]
    [InlineData("conversion")]
    [InlineData("column-name-drift")]
    [InlineData("table-owner-drift")]
    public void Owner_Binding_Refuses_Closed_Shape_Drift_Instead_Of_Guessing_Current_Fields(string changed)
    {
        SchemaTableModel original = Table();
        Dictionary<string, SchemaColumnModel> columns = new(original.Columns, StringComparer.Ordinal);
        SchemaOwnerModel owner = original.Owner!;
        SchemaColumnModel title = columns["actual_owned_title"];
        switch (changed)
        {
            case "missing-column":
                columns.Remove("actual_owned_title");
                break;
            case "extra-column":
                columns.Add("future_field", title with
                {
                    Name = "future_field"
                });
                break;
            case "unknown-owner":
                columns[title.Name] = title with
                {
                    Owner = new(Owner + ".FutureTitle", "unit")
                };
                break;
            case "duplicate-owner":
                columns[title.Name] = title with
                {
                    Owner = columns["actual_owned_id"].Owner
                };
                break;
            case "changed-type":
                columns[title.Name] = title with
                {
                    DataType = "int64"
                };
                break;
            case "computed":
                columns[title.Name] = title with
                {
                    ComputedExpression = "actual-new-owner-expression"
                };
                break;
            case "conversion":
                columns[title.Name] = title with
                {
                    Conversion = "json"
                };
                break;
            case "column-name-drift":
                columns[title.Name] = title with
                {
                    Name = "another-name"
                };
                break;
            case "table-owner-drift":
                owner = new("FsusBlog.Server.Entities.OtherArticle", "unit");
                break;
            default:
                throw new ArgumentOutOfRangeException(nameof(changed));
        }
        SchemaTableModel modified = new(original.Name, columns, [], owner: owner);
        ArticlePreservationLogicalRow row = new(Owner, [new("Id", 7), new("Title", "raw title")]);
        Assert.Throws<InvalidOperationException>(() => ArticlePreservationStorageProgram.BindRow(modified, row));
    }

    [Fact]
    public void Owner_Binding_Rejects_Duplicate_Input_Properties_And_Required_Null_Values()
    {
        Assert.Throws<InvalidOperationException>(() => ArticlePreservationStorageProgram.BindRow(Table(),
            new(Owner, [new("Id", 7), new("Id", 8)])));
        Assert.Throws<InvalidOperationException>(() => ArticlePreservationStorageProgram.BindRow(Table(),
            new(Owner, [new("Id", 7), new("Title", null)])));
    }

    private static SchemaTableModel Table()
        => new("actual_owned_table", new(StringComparer.Ordinal)
        {
            ["actual_owned_id"] = new("actual_owned_id", false, true, true, null, "int32", Conversion: "none", Owner: new(Owner + ".Id", "unit")),
            ["actual_owned_title"] = new("actual_owned_title", false, false, false, 256, "string", Conversion: "none", Owner: new(Owner + ".Title", "unit"))
        }, [], owner: new(Owner, "unit"));
}
