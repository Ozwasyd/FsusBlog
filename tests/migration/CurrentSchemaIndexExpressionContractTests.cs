using System.Text.Json;

using FsusBlog.Contracts.Schema;
using FsusBlog.Shared.Algorithms.Schema;

using Xunit;

namespace FsusBlog.Migration.Tests;

public sealed class CurrentSchemaIndexExpressionContractTests
{
    [Fact]
    public void LegacyColumnKey_PreservesActualFrozen46Serialization()
    {
        const string Frozen = """{"Column":"opened","Direction":"desc","NullPlacement":"first","OperatorClass":"default","Collation":"default","MySqlPhysical":null}""";
        Assert.Equal(Frozen, JsonSerializer.Serialize(new SchemaIndexKeyModel("opened", "desc", "first", "default", "default")));
    }

    [Fact]
    public void TypedKeys_RoundTripAndCopyOrderedBoundTimestampFacts()
    {
        SchemaIndexKeyModel key = Key();
        SchemaIndexKeyModel copied = JsonSerializer.Deserialize<SchemaIndexKeyModel>(JsonSerializer.Serialize(key))!;
        Assert.True(SchemaIndexExpressions.Equal(key.Expression, copied.Expression));
        Assert.Empty(SchemaModelComparer.Compare(Snapshot(key), Snapshot(copied)));
        Assert.Equal(CurrentSchemaCanonicalAuthority.ComputeContentDigest(Snapshot(key).Tables),
            CurrentSchemaCanonicalAuthority.ComputeContentDigest(Snapshot(copied).Tables));
        Assert.Equal(new[] { "opened", "edited", "activated" }, SchemaIndexExpressions.Columns(key.Expression!));
        CurrentSchemaCanonicalModel sealedModel = CurrentSchemaCanonicalAuthority.Create(Snapshot(key).Tables, new string('a', 64));
        ((SchemaIndexExpression[])key.Expression!.Arguments)[0] = new(SchemaIndexExpressionKind.Column, "activated", []);
        Assert.Equal("opened", sealedModel.SemanticSchema.Tables["probe"].IndexDefinitions["probe_index"].Keys[0].Expression!.Arguments[0].Column);
        Assert.Throws<InvalidOperationException>(() => CurrentSchemaCanonicalAuthority.ProjectProvider(sealedModel, SchemaProviderKind.Sqlite));
    }

    [Theory]
    [InlineData("GREATEST(edited,opened,activated)")]
    [InlineData("GREATEST(opened,edited,edited)")]
    [InlineData("GREATEST(opened::timestamp(0),edited,activated)")]
    [InlineData("CAST(GREATEST(opened,edited,activated) AS timestamp(0))")]
    public void ChangedOrderedExpressionOrCast_ChangesIdentityAndCompilesWithoutDiscardingFacts(string sql)
    {
        SchemaIndexKeyModel original = Key();
        SchemaIndexExpression changed = PgCurrentSchemaIndexExpression.Parse(sql, Columns());
        Assert.False(SchemaIndexExpressions.Equal(original.Expression, changed));
        SchemaIndexExpression roundTrip = PgCurrentSchemaIndexExpression.Parse(
            PgCurrentSchemaIndexExpression.Compile(changed, Columns()), Columns());
        Assert.True(SchemaIndexExpressions.Equal(changed, roundTrip));
        Assert.NotEmpty(SchemaModelComparer.Compare(Snapshot(original), Snapshot(original with
        {
            Expression = changed
        })));
    }

    [Theory]
    [InlineData("GREATEST(opened,edited)")]
    [InlineData("GREATEST(opened,edited,absent)")]
    [InlineData("LEAST(opened,edited,activated)")]
    [InlineData("GREATEST(opened::date,edited::date,activated::date)")]
    [InlineData("GREATEST(opened,edited,activated); SELECT 1")]
    public void UnsupportedSyntaxOrBinding_RefusesWholeKey(string sql)
        => Assert.Throws<InvalidOperationException>(() => PgCurrentSchemaIndexExpression.Parse(sql, Columns()));

    [Fact]
    public void DisjointKeyAndCompleteNativeObservation_AreRequired()
    {
        SchemaIndexKeyModel key = Key();
        Assert.Throws<InvalidOperationException>(() => SchemaIndexExpressions.Require(key with { Column = "opened" }, Columns()));
        Assert.Throws<InvalidOperationException>(() => SchemaIndexExpressions.Bind(key.Expression!,
            Columns().ToDictionary(static entry => entry.Key, entry => entry.Value with { DataType = "string" })));
        const string Native = """[{"column":null,"direction":"desc","nullPlacement":"first","operatorClass":"default","collation":"default","expression":"GREATEST(opened,edited,activated)","expressionType":"timestamp without time zone"}]""";
        SchemaIndexKeyModel actual = Assert.Single(PgCurrentSchemaCatalogObserver.ParsePostgresIndexKeys(Native, true, Columns()));
        Assert.True(SchemaIndexExpressions.Equal(key.Expression, actual.Expression));
        Assert.Throws<InvalidOperationException>(() => PgCurrentSchemaCatalogObserver.ParsePostgresIndexKeys(Native, true));
        Assert.Throws<InvalidOperationException>(() => PgCurrentSchemaCatalogObserver.ParsePostgresIndexKeys(Native, false, Columns()));
        Assert.Throws<InvalidOperationException>(() => PgCurrentSchemaCatalogObserver.ParsePostgresIndexKeys(
            Native.Replace("timestamp without time zone", "date", StringComparison.Ordinal), true, Columns()));
    }

    private static Dictionary<string, SchemaColumnModel> Columns()
        => new[] { "opened", "edited", "activated" }.ToDictionary(static name => name,
            static name => new SchemaColumnModel(name, true, false, false, null, "timestamp"), StringComparer.Ordinal);

    private static SchemaIndexKeyModel Key()
        => new(string.Empty, "desc", "first", "default", "default")
        {
            Expression = PgCurrentSchemaIndexExpression.Parse("GREATEST(opened,edited,activated)", Columns())
        };

    private static SchemaModelSnapshot Snapshot(SchemaIndexKeyModel key)
    {
        var index = new SchemaIndexModel("probe_index", false, [key], [], "btree", null, false);
        var table = new SchemaTableModel("probe", Columns(), [index.Name], new Dictionary<string, SchemaIndexModel> { [index.Name] = index });
        return new(new Dictionary<string, SchemaTableModel> { [table.Name] = table });
    }
}
