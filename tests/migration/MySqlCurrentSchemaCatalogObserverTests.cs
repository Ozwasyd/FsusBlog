using System.Collections.Immutable;
using System.Data.Common;

using Npgsql;
using Xunit;

using FsusBlog.Contracts.Migration;

namespace FsusBlog.Migration.Tests;

// Pure native-protocol/closure controls only. These do not fake a MySQL driver,
// catalog visibility, allocator, current target, actual DB or three-provider PASS.
public sealed class MySqlCurrentSchemaCatalogObserverTests
{
    [Fact]
    public async Task MissingActualNativeTransactionRefusesBeforeAnyCatalogCommand()
    {
        await using var unrelated = new NpgsqlConnection();
        using var cancellation = new CancellationTokenSource();
        await Assert.ThrowsAsync<ArgumentNullException>(() =>
            MySqlCurrentSchemaCatalogObserver.ReadAsync(unrelated, null!, cancellation.Token));
        Assert.Equal(System.Data.ConnectionState.Closed, unrelated.State);
    }

    [Fact]
    public void SessionObservationBindsNativeServerAndDatabaseWithoutLowercasing()
    {
        CurrentSchemaDatabaseIdentity actual = MySqlCurrentSchemaCatalogObserver.RequireObservedSession(Session());
        Assert.Equal(CurrentSchemaProviderKind.MySql, actual.Provider);
        Assert.Equal("mysql:bb18f914-82ef-4e3d-85e5-e65e4c805b60", actual.InstanceId);
        Assert.Equal("CaseSensitiveOriginalDb", actual.DatabaseId);
    }

    [Theory]
    [InlineData(0, "not-a-native-server-uuid")]
    [InlineData(0, "00000000-0000-0000-0000-000000000000")]
    [InlineData(1, "")]
    [InlineData(2, "READ-COMMITTED")]
    [InlineData(3, "unknown")]
    [InlineData(7, "0")]
    [InlineData(8, "-1")]
    [InlineData(9, "0")]
    public void UnknownNativeSessionOrHiddenGeneratedKeysCannotProduceAnObservation(int index, string value)
    {
        ImmutableArray<MySqlCatalogCell> session = Session();
        session = session.SetItem(index, session[index] with { Value = value });
        Assert.Throws<InvalidOperationException>(() => MySqlCurrentSchemaCatalogObserver.RequireObservedSession(session));
    }

    [Theory]
    [InlineData(7, "ACTION_STATEMENT")]
    [InlineData(8, "ROUTINE_DEFINITION")]
    [InlineData(10, "EVENT_DEFINITION")]
    [InlineData(11, "VIEW_DEFINITION")]
    [InlineData(5, "CHECK_CLAUSE")]
    public void ObjectNameWithoutActualDefinitionIsNotACompleteEffect(int partValue, string field)
    {
        var part = (MySqlCatalogPart)partValue;
        Assert.Throws<InvalidOperationException>(() =>
            MySqlCurrentSchemaCatalogObserver.RequireCompleteDefinition(new(part, [new(field, null)])));
        Assert.Throws<InvalidOperationException>(() =>
            MySqlCurrentSchemaCatalogObserver.RequireCompleteDefinition(new(part, [new(field, " ")])));
        MySqlCurrentSchemaCatalogObserver.RequireCompleteDefinition(new(part, [new(field, "actual raw native definition")]));
    }

    [Fact]
    public void FunctionalIndexAndColumnIndexRemainDistinctNativeObservations()
    {
        MySqlCurrentSchemaCatalogObserver.RequireCompleteDefinition(new(MySqlCatalogPart.IndexParts,
            [new("COLUMN_NAME", "content"), new("EXPRESSION", null)]));
        MySqlCurrentSchemaCatalogObserver.RequireCompleteDefinition(new(MySqlCatalogPart.IndexParts,
            [new("COLUMN_NAME", null), new("EXPRESSION", "lower(`content`) ")]));
        Assert.Throws<InvalidOperationException>(() => MySqlCurrentSchemaCatalogObserver.RequireCompleteDefinition(
            new(MySqlCatalogPart.IndexParts, [new("COLUMN_NAME", null), new("EXPRESSION", null)])));
        Assert.Throws<InvalidOperationException>(() => MySqlCurrentSchemaCatalogObserver.RequireCompleteDefinition(
            new(MySqlCatalogPart.IndexParts, [new("COLUMN_NAME", "content"), new("EXPRESSION", "lower(`content`)")])));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    [InlineData(4)]
    [InlineData(5)]
    [InlineData(6)]
    [InlineData(7)]
    [InlineData(8)]
    [InlineData(9)]
    [InlineData(10)]
    [InlineData(11)]
    [InlineData(12)]
    public void EveryMeasuredCatalogCategoryParticipatesInTerminalClosure(int partValue)
    {
        var part = (MySqlCatalogPart)partValue;
        Assert.True(Enum.IsDefined(part));
        var row = new MySqlCatalogRow(part, [new("native-field", "before")]);
        var before = new MySqlCurrentSchemaCatalog(MySqlCurrentSchemaCatalogObserver.RequireObservedSession(Session()), Session(), [row]);
        var equalCopy = before with { Rows = [new(part, [new("native-field", "before")])] };
        MySqlCurrentSchemaCatalogObserver.RequireUnchanged(before, equalCopy);
        Assert.Throws<InvalidOperationException>(() => MySqlCurrentSchemaCatalogObserver.RequireUnchanged(before,
            before with { Rows = [new(part, [new("native-field", "after")])] }));
        Assert.Throws<InvalidOperationException>(() => MySqlCurrentSchemaCatalogObserver.RequireUnchanged(before,
            before with { Rows = [] }));
    }

    [Fact]
    public void NullDefaultIsNotCollapsedIntoEmptyLiteralAndExtraCellsAreNotIgnored()
    {
        var before = new MySqlCurrentSchemaCatalog(MySqlCurrentSchemaCatalogObserver.RequireObservedSession(Session()), Session(),
            [new(MySqlCatalogPart.Columns, [new("COLUMN_DEFAULT", null)])]);
        Assert.Throws<InvalidOperationException>(() => MySqlCurrentSchemaCatalogObserver.RequireUnchanged(before,
            before with { Rows = [new(MySqlCatalogPart.Columns, [new("COLUMN_DEFAULT", "")])] }));
        Assert.Throws<InvalidOperationException>(() => MySqlCurrentSchemaCatalogObserver.RequireUnchanged(before,
            before with { Rows = [new(MySqlCatalogPart.Columns, [new("COLUMN_DEFAULT", null), new("COLLATION_NAME", "unexpected")])] }));
    }

    [Fact]
    public void OriginalMetadataBudgetRefusesTruncationAndPreservesNull()
    {
        var budget = new MySqlCurrentSchemaCatalogObserver.MetadataBudget();
        Assert.Null(budget.ReadCell(null));
        Assert.Equal("", budget.ReadCell(""));
        string admitted = new('x', OfflineMigrationSourceObserver.MaximumCellCharacters);
        Assert.Same(admitted, budget.ReadCell(admitted));
        Assert.Throws<InvalidOperationException>(() => budget.ReadCell(admitted + "x"));
        for (int index = 0; index < OfflineMigrationSourceObserver.MaximumMetadataRows; index++) budget.AddRow();
        Assert.Throws<InvalidOperationException>(budget.AddRow);
    }

    private static ImmutableArray<MySqlCatalogCell> Session() =>
    [
        new("server_uuid", "bb18f914-82ef-4e3d-85e5-e65e4c805b60"), new("database", "CaseSensitiveOriginalDb"),
        new("isolation", "REPEATABLE-READ"), new("read_only", "1"), new("sql_mode", "STRICT_TRANS_TABLES"),
        new("connection_charset", "utf8mb4"), new("connection_collation", "utf8mb4_bin"),
        new("auto_increment_increment", "1"), new("auto_increment_offset", "1"), new("gipk_visible", "1")
    ];
}
