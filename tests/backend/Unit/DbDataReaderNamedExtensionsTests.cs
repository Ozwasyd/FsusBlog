using System.Data;

using FsusBlog.Server.Infrastructure.Data;

namespace FsusBlog.Server.Tests.Unit;

public sealed class DbDataReaderNamedExtensionsTests
{
    [Fact]
    public void NamedProjectionReadsCorrectValuesWhenPhysicalColumnOrderChanges()
    {
        var table = new DataTable();
        table.Columns.Add("title", typeof(string));
        table.Columns.Add("unrelated_projection_column", typeof(string));
        table.Columns.Add("view_count", typeof(int));
        table.Columns.Add("id", typeof(int));
        table.Rows.Add("named projection", "ignored", 42, 7);
        using DataTableReader reader = table.CreateDataReader();
        Assert.True(reader.Read());

        Assert.Equal(7, reader.ReadInt32("id"));
        Assert.Equal("named projection", reader.ReadString("title"));
        Assert.Equal(42, reader.ReadInt32("view_count"));
    }

    [Fact]
    public void NamedProjectionFailsClosedWhenRequiredColumnIsMissing()
    {
        var table = new DataTable();
        table.Columns.Add("id", typeof(int));
        table.Rows.Add(7);
        using DataTableReader reader = table.CreateDataReader();
        Assert.True(reader.Read());

        InvalidOperationException exception = Assert.Throws<InvalidOperationException>(() => reader.ReadString("title"));
        Assert.Contains("title", exception.Message, StringComparison.Ordinal);
        Assert.NotNull(exception.InnerException);
    }

    [Fact]
    public void NamedProjectionRejectsBlankColumnNameBeforeProviderLookup()
    {
        var table = new DataTable();
        table.Columns.Add("id", typeof(int));
        table.Rows.Add(7);
        using DataTableReader reader = table.CreateDataReader();
        Assert.True(reader.Read());

        Assert.Throws<ArgumentException>(() => reader.ReadInt32(" "));
    }
}
