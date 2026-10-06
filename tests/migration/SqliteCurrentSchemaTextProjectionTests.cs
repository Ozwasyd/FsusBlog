using System.Reflection;
using System.Text;

using Microsoft.Data.Sqlite;

using Xunit;

namespace FsusBlog.Migration.Tests;

public sealed class SqliteCurrentSchemaTextProjectionTests
{
    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("metadata")]
    [InlineData("😀ä")]
    public async Task NativeEmptyTextRemainsDistinctFromNull(string? value)
    {
        await using var connection = new SqliteConnection("Data Source=:memory:;Pooling=False");
        await connection.OpenAsync();
        await using SqliteCommand command = connection.CreateCommand();
        command.CommandText = "SELECT " + Project("$value");
        command.Parameters.AddWithValue("$value", (object?)value ?? DBNull.Value);
        await using SqliteDataReader reader = await command.ExecuteReaderAsync();
        Assert.True(await reader.ReadAsync());
        object budget = NewBudget();
        Assert.Equal(value, ReadText(budget, reader, required: false));
        if (value is null)
        {
            TargetInvocationException failure = Assert.Throws<TargetInvocationException>(() => ReadText(budget, reader, required: true));
            Assert.Equal("sqlite_current_catalog_text_missing", Assert.IsType<InvalidOperationException>(failure.InnerException).Message);
        }
        else
        {
            Assert.False(reader.IsDBNull(0));
            Assert.Equal(value, ReadText(budget, reader, required: true));
        }
    }

    [Theory]
    [InlineData("ascii")]
    [InlineData("unicode")]
    [InlineData("nul")]
    public async Task NativeProjectionKeepsOriginalByteAndMetadataRefusalBounds(string kind)
    {
        int limit = OfflineMigrationSourceObserver.MaximumCellCharacters;
        string value = kind switch
        {
            "ascii" => new string('x', (limit + 1) * 8),
            "unicode" => string.Concat(Enumerable.Repeat("😀", limit + 1)),
            _ => "before\0after"
        };
        await using var connection = new SqliteConnection("Data Source=:memory:;Pooling=False");
        await connection.OpenAsync();
        await using SqliteCommand command = connection.CreateCommand();
        command.CommandText = "SELECT " + Project("$value");
        command.Parameters.AddWithValue("$value", value);
        await using SqliteDataReader reader = await command.ExecuteReaderAsync();
        Assert.True(await reader.ReadAsync());
        string actual = reader.GetString(0);
        Assert.True(Encoding.UTF8.GetByteCount(actual) <= (limit + 1) * 4);
        if (kind == "nul")
        {
            Assert.Equal(value, actual);
        }
        else
        {
            Assert.True(actual.Length > limit);
        }
        TargetInvocationException failure = Assert.Throws<TargetInvocationException>(() => ReadText(NewBudget(), reader, required: true));
        Assert.Equal("sqlite_current_catalog_metadata_budget_exceeded", Assert.IsType<InvalidOperationException>(failure.InnerException).Message);
    }

    private static string Project(string column)
    {
        MethodInfo method = typeof(SqliteCurrentSchemaCatalogObserver).GetMethod("Text", BindingFlags.Static | BindingFlags.NonPublic)!;
        return (string)method.Invoke(null, [column])!;
    }

    private static object NewBudget() => Activator.CreateInstance(
        typeof(SqliteCurrentSchemaCatalogObserver).GetNestedType("MetadataBudget", BindingFlags.NonPublic)!, nonPublic: true)!;

    private static string? ReadText(object budget, SqliteDataReader reader, bool required)
    {
        MethodInfo method = budget.GetType().GetMethod(required ? "RequiredText" : "NullableText", BindingFlags.Instance | BindingFlags.NonPublic)!;
        return (string?)method.Invoke(budget, [reader, 0]);
    }
}
