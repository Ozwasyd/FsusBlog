using System.Collections.Immutable;

using Xunit;

namespace FsusBlog.Migration.Tests;

// Source protocol controls, not executed MySQL metadata or expected target authority.
public sealed class MySqlCurrentSchemaPhysicalObserverTests
{
    [Fact]
    public async Task OriginalOwnedNativeEntryHonorsCancellationBeforeAnyConnection()
    {
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => OfflineMigrationMySqlNativeSession.ObserveCurrentPhysicalAsync(
            "not-a-native-connection", cancellation.Token));
    }

    [Fact]
    public async Task OriginalOwnedNativeEntryRequiresTheOriginalFiniteCancellationScope()
        => await Assert.ThrowsAsync<InvalidOperationException>(() => OfflineMigrationMySqlNativeSession.ObserveCurrentPhysicalAsync(
            "not-a-native-connection", default));

    [Fact]
    public void ActualNativeAttributesRemainTypedWithoutSelectingSemanticDefaults()
    {
        MySqlCurrentSchemaCatalog raw = Catalog();
        MySqlCurrentSchemaPhysicalObservation actual = MySqlCurrentSchemaPhysicalObserver.Observe(raw);
        Assert.Same(raw, actual.Raw);
        MySqlObservedTablePhysicalFacts table = actual.Tables["CaseTable"];
        Assert.Equal("BASE TABLE", table.Physical.TableType);
        Assert.Equal("InnoDB", table.Physical.Engine);
        Assert.Equal("Dynamic", table.Physical.RowFormat);
        Assert.Equal("utf8mb4_bin", table.Physical.Collation);
        Assert.Null(Assert.Single(table.Physical.Partitions).Name);
        Assert.Null(Assert.Single(table.Physical.Partitions).Ordinal);
        MySqlObservedColumnPhysicalFacts column = table.Columns["value"];
        Assert.Equal("varchar(32)", column.PhysicalType);
        Assert.True(column.IsNullable);
        Assert.Null(column.DefaultValue);
        Assert.Equal("utf8mb4", column.Physical.CharacterSet);
        Assert.Equal("utf8mb4_bin", column.Physical.Collation);
        Assert.Equal("VIRTUAL GENERATED INVISIBLE", column.Physical.Extra);
        Assert.Equal("lower(`value`)", column.Physical.GenerationExpression);
        Assert.Null(column.Physical.SpatialReferenceSystemId);
        MySqlObservedIndexPhysicalFacts index = table.Indexes["actual_index"];
        Assert.False(index.Physical.IsVisible);
        Assert.True(index.IsUnique);
        Assert.Equal("BTREE", index.AccessMethod);
        MySqlObservedIndexKeyPhysicalFacts key = Assert.Single(index.Keys);
        Assert.Equal("value", key.Column);
        Assert.Equal("D", key.Direction);
        Assert.Equal((long)3, key.Physical.PrefixLength);
        Assert.Null(key.Physical.Expression);
        MySqlCurrentSchemaPhysicalObservation benign = MySqlCurrentSchemaPhysicalObserver.Observe(Catalog());
        Assert.Equal(column, benign.Tables["CaseTable"].Columns["value"]);
    }

    [Fact]
    public void FunctionalExpressionAndNullDirectionAreNotForgedAsOrdinaryColumnDefaults()
    {
        MySqlCurrentSchemaCatalog raw = Change(Catalog(), MySqlCatalogPart.IndexParts, "COLUMN_NAME", null);
        raw = Change(raw, MySqlCatalogPart.IndexParts, "EXPRESSION", "lower(`value`)");
        raw = Change(raw, MySqlCatalogPart.IndexParts, "SUB_PART", null);
        raw = Change(raw, MySqlCatalogPart.IndexParts, "COLLATION", null);
        MySqlObservedIndexKeyPhysicalFacts actual = Assert.Single(MySqlCurrentSchemaPhysicalObserver.Observe(raw)
            .Tables["CaseTable"].Indexes["actual_index"].Keys);
        Assert.Null(actual.Column);
        Assert.Null(actual.Direction);
        Assert.Null(actual.Physical.PrefixLength);
        Assert.Equal("lower(`value`)", actual.Physical.Expression);
    }

    [Fact]
    public void RawNullDefaultEmptyDefaultAndSpatialZeroRemainDifferentNativeFacts()
    {
        MySqlCurrentSchemaCatalog raw = Change(Catalog(), MySqlCatalogPart.Columns, "COLUMN_DEFAULT", "");
        raw = Change(raw, MySqlCatalogPart.Columns, "SRS_ID", "0");
        MySqlObservedColumnPhysicalFacts actual = MySqlCurrentSchemaPhysicalObserver.Observe(raw).Tables["CaseTable"].Columns["value"];
        Assert.Equal("", actual.DefaultValue);
        Assert.Equal((uint)0, actual.Physical.SpatialReferenceSystemId);
        Assert.NotEqual(MySqlCurrentSchemaPhysicalObserver.Observe(Catalog()).Tables["CaseTable"].Columns["value"], actual);
    }

    [Theory]
    [InlineData(0, "TABLE_TYPE", "unknown")]
    [InlineData(0, "ENGINE", null)]
    [InlineData(0, "ROW_FORMAT", null)]
    [InlineData(0, "TABLE_COLLATION", null)]
    [InlineData(0, "CREATE_OPTIONS", null)]
    [InlineData(1, "ORDINAL_POSITION", "2")]
    [InlineData(1, "IS_NULLABLE", "unknown")]
    [InlineData(1, "EXTRA", null)]
    [InlineData(1, "GENERATION_EXPRESSION", null)]
    [InlineData(1, "SRS_ID", "4294967296")]
    [InlineData(2, "SEQ_IN_INDEX", "2")]
    [InlineData(2, "IS_VISIBLE", "unknown")]
    [InlineData(2, "COLUMN_NAME", "missing")]
    [InlineData(2, "EXPRESSION", "value+1")]
    [InlineData(2, "SUB_PART", "0")]
    [InlineData(2, "COLLATION", "unknown")]
    [InlineData(2, "NON_UNIQUE", "2")]
    public void MissingOrUnqualifiedPhysicalFieldsDoNotReceiveDefaults(int part, string field, string? value)
        => Assert.Throws<InvalidOperationException>(() => MySqlCurrentSchemaPhysicalObserver.Observe(
            Change(Catalog(), (MySqlCatalogPart)part, field, value)));

    [Fact]
    public void MissingPartitionRowIsNotTheNativeUnpartitionedNullRow()
    {
        MySqlCurrentSchemaCatalog raw = Catalog();
        Assert.Single(MySqlCurrentSchemaPhysicalObserver.Observe(raw).Tables["CaseTable"].Physical.Partitions);
        Assert.Throws<InvalidOperationException>(() => MySqlCurrentSchemaPhysicalObserver.Observe(
            raw with { Rows = raw.Rows.Where(row => row.Part != MySqlCatalogPart.Partitions).ToImmutableArray() }));
    }

    [Fact]
    public void OrderedNativePartitionsPreserveExpressionsAndRejectGapsOrDuplicateOwners()
    {
        MySqlCurrentSchemaCatalog raw = Catalog();
        MySqlCatalogRow Partition(string name, string ordinal, string description) => Row(MySqlCatalogPart.Partitions,
            ("TABLE_NAME", "CaseTable"), ("PARTITION_NAME", name), ("PARTITION_ORDINAL_POSITION", ordinal),
            ("PARTITION_METHOD", "RANGE"), ("PARTITION_EXPRESSION", "id"), ("PARTITION_DESCRIPTION", description));
        raw = raw with { Rows = raw.Rows.Where(row => row.Part != MySqlCatalogPart.Partitions)
            .Concat([Partition("p0", "1", "10"), Partition("p1", "2", "MAXVALUE")]).ToImmutableArray() };
        var parts = MySqlCurrentSchemaPhysicalObserver.Observe(raw).Tables["CaseTable"].Physical.Partitions;
        Assert.Equal(new[] { "p0", "p1" }, parts.Select(part => part.Name));
        Assert.Equal("MAXVALUE", parts[1].Description);
        Assert.Throws<InvalidOperationException>(() => MySqlCurrentSchemaPhysicalObserver.Observe(
            raw with { Rows = raw.Rows.SetItem(raw.Rows.Length - 1, Partition("p1", "3", "MAXVALUE")) }));
        Assert.Throws<InvalidOperationException>(() => MySqlCurrentSchemaPhysicalObserver.Observe(
            raw with { Rows = raw.Rows.Add(raw.Rows[^1]) }));
    }

    [Fact]
    public void ExactFieldOrderDuplicatesAndOrphanTablesCannotProduceTypedCompleteness()
    {
        MySqlCurrentSchemaCatalog raw = Catalog();
        Assert.Throws<InvalidOperationException>(() => MySqlCurrentSchemaPhysicalObserver.Observe(
            raw with { Rows = raw.Rows.SetItem(1, raw.Rows[1] with { Cells = raw.Rows[1].Cells.Reverse().ToImmutableArray() }) }));
        Assert.Throws<InvalidOperationException>(() => MySqlCurrentSchemaPhysicalObserver.Observe(raw with { Rows = raw.Rows.Add(raw.Rows[0]) }));
        Assert.Throws<InvalidOperationException>(() => MySqlCurrentSchemaPhysicalObserver.Observe(
            Change(raw, MySqlCatalogPart.Columns, "TABLE_NAME", "unknown_table")));
    }

    [Fact]
    public void HiddenGeneratedKeysAndChangedDatabaseIdentityRemainRefusals()
    {
        MySqlCurrentSchemaCatalog raw = Catalog();
        Assert.Throws<InvalidOperationException>(() => MySqlCurrentSchemaPhysicalObserver.Observe(
            raw with { Session = raw.Session.SetItem(9, raw.Session[9] with { Value = "0" }) }));
        Assert.Throws<InvalidOperationException>(() => MySqlCurrentSchemaPhysicalObserver.Observe(
            raw with { Database = raw.Database with { DatabaseId = "other" } }));
    }

    [Fact]
    public void CompleteRawConstraintsEffectsAndMutableCounterAreNotDiscardedOrApproved()
    {
        MySqlCurrentSchemaCatalog raw = Catalog();
        raw = raw with { Rows = raw.Rows.AddRange([
            Row(MySqlCatalogPart.Constraints, ("TABLE_NAME", "CaseTable"), ("CONSTRAINT_NAME", "native_check"), ("CONSTRAINT_TYPE", "CHECK"), ("ENFORCED", "YES")),
            Row(MySqlCatalogPart.Checks, ("CONSTRAINT_NAME", "native_check"), ("CHECK_CLAUSE", "`value` is not null")),
            Row(MySqlCatalogPart.Triggers, ("TRIGGER_NAME", "native_trigger"), ("EVENT_OBJECT_SCHEMA", "ActualDb"), ("EVENT_OBJECT_TABLE", "CaseTable"), ("ACTION_STATEMENT", "SIGNAL SQLSTATE '45000'")),
            Row(MySqlCatalogPart.Routines, ("ROUTINE_NAME", "f"), ("ROUTINE_TYPE", "FUNCTION"), ("ROUTINE_DEFINITION", "RETURN 1")),
            Row(MySqlCatalogPart.RoutineParameters, ("SPECIFIC_NAME", "f"), ("ROUTINE_TYPE", "FUNCTION"), ("ORDINAL_POSITION", "0")),
            Row(MySqlCatalogPart.Events, ("EVENT_NAME", "native_event"), ("EVENT_DEFINITION", "SELECT 1"))]) };
        MySqlCurrentSchemaPhysicalObservation actual = MySqlCurrentSchemaPhysicalObserver.Observe(raw);
        Assert.Same(raw, actual.Raw);
        Assert.Equal(raw.Rows, actual.Raw.Rows);
        Assert.Equal("42", actual.Raw.Rows[0].Cells.Single(cell => cell.Name == "AUTO_INCREMENT").Value);
        Assert.Throws<InvalidOperationException>(() => MySqlCurrentSchemaPhysicalObserver.Observe(
            Change(raw, MySqlCatalogPart.Triggers, "ACTION_STATEMENT", null)));
        Assert.Throws<InvalidOperationException>(() => MySqlCurrentSchemaPhysicalObserver.Observe(
            Change(raw, MySqlCatalogPart.Triggers, "EVENT_OBJECT_SCHEMA", "other")));
        Assert.Throws<InvalidOperationException>(() => MySqlCurrentSchemaPhysicalObserver.Observe(
            Change(raw, MySqlCatalogPart.RoutineParameters, "ROUTINE_TYPE", "PROCEDURE")));
    }

    [Fact]
    public void ViewTableMustHaveItsActualDefinitionRatherThanAMissingEffectRow()
    {
        MySqlCurrentSchemaCatalog raw = Change(Catalog(), MySqlCatalogPart.Tables, "TABLE_TYPE", "VIEW");
        Assert.Throws<InvalidOperationException>(() => MySqlCurrentSchemaPhysicalObserver.Observe(raw));
        raw = raw with { Rows = raw.Rows.Add(Row(MySqlCatalogPart.Views, ("TABLE_NAME", "CaseTable"), ("VIEW_DEFINITION", "select 1 as value"))) };
        Assert.Equal("VIEW", MySqlCurrentSchemaPhysicalObserver.Observe(raw).Tables["CaseTable"].Physical.TableType);
    }

    private static MySqlCurrentSchemaCatalog Catalog()
    {
        ImmutableArray<MySqlCatalogCell> session = [new("server_uuid", "bb18f914-82ef-4e3d-85e5-e65e4c805b60"),
            new("database", "ActualDb"), new("isolation", "REPEATABLE-READ"), new("read_only", "1"), new("sql_mode", "STRICT_ALL_TABLES"),
            new("connection_charset", "utf8mb4"), new("connection_collation", "utf8mb4_bin"),
            new("auto_increment_increment", "1"), new("auto_increment_offset", "1"), new("gipk_visible", "1")];
        return new(MySqlCurrentSchemaCatalogObserver.RequireObservedSession(session), session,
        [
            Row(MySqlCatalogPart.Tables, ("TABLE_NAME", "CaseTable"), ("TABLE_TYPE", "BASE TABLE"), ("ENGINE", "InnoDB"),
                ("ROW_FORMAT", "Dynamic"), ("TABLE_COLLATION", "utf8mb4_bin"), ("CREATE_OPTIONS", ""), ("TABLE_COMMENT", "actual comment"), ("AUTO_INCREMENT", "42")),
            Row(MySqlCatalogPart.Columns, ("TABLE_NAME", "CaseTable"), ("COLUMN_NAME", "value"), ("ORDINAL_POSITION", "1"),
                ("COLUMN_TYPE", "varchar(32)"), ("IS_NULLABLE", "YES"), ("EXTRA", "VIRTUAL GENERATED INVISIBLE"),
                ("CHARACTER_SET_NAME", "utf8mb4"), ("COLLATION_NAME", "utf8mb4_bin"), ("GENERATION_EXPRESSION", "lower(`value`)"), ("COLUMN_COMMENT", "column comment")),
            Row(MySqlCatalogPart.IndexParts, ("TABLE_NAME", "CaseTable"), ("INDEX_NAME", "actual_index"), ("NON_UNIQUE", "0"),
                ("SEQ_IN_INDEX", "1"), ("COLUMN_NAME", "value"), ("COLLATION", "D"), ("SUB_PART", "3"), ("NULLABLE", "YES"),
                ("INDEX_TYPE", "BTREE"), ("COMMENT", ""), ("INDEX_COMMENT", "index comment"), ("IS_VISIBLE", "NO")),
            Row(MySqlCatalogPart.Partitions, ("TABLE_NAME", "CaseTable"))
        ]);
    }

    private static MySqlCatalogRow Row(MySqlCatalogPart part, params (string Name, string? Value)[] values)
    {
        Dictionary<string, string?> provided = values.ToDictionary(pair => pair.Name, pair => pair.Value, StringComparer.Ordinal);
        return new(part, MySqlCurrentSchemaCatalogObserver.ObservedFieldNames(part)
            .Select(name => new MySqlCatalogCell(name, provided.GetValueOrDefault(name))).ToImmutableArray());
    }

    private static MySqlCurrentSchemaCatalog Change(MySqlCurrentSchemaCatalog raw, MySqlCatalogPart part, string name, string? value)
        => raw with { Rows = raw.Rows.Select(row => row.Part == part
            ? row with { Cells = row.Cells.Select(cell => cell.Name == name ? cell with { Value = value } : cell).ToImmutableArray() }
            : row).ToImmutableArray() };
}
