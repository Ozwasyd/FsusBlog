using FsusBlog.Contracts.Schema;
using FsusBlog.Shared.Algorithms.Schema;

using Xunit;

namespace FsusBlog.Migration.Tests;

public sealed class PgCurrentSchemaBootstrapOperationTests
{
    [Theory]
    [InlineData("string", "'global'", "global")]
    [InlineData("string", "'a  b'", "a  b")]
    public void SeedKeyDigest_BindsOriginalLiteralAndActualScalarBytes(string type, string expression, string nativeValue)
    {
        var column = new SchemaColumnModel("key", false, true, false, null, type);
        SchemaExpressionNode literal = PgCurrentSchemaExpressionParser.Parse(expression, new Dictionary<string, SchemaColumnModel>());
        SchemaExpressionNode expected = PgCurrentSchemaBootstrapOperation.ExpectedKey(column, literal);
        SchemaExpressionNode actual = PgCurrentSchemaBootstrapOperation.ActualKey(column, nativeValue);
        Assert.True(SchemaExpressionIdentity.Equal(expected, actual));
        Assert.False(SchemaExpressionIdentity.Equal(expected, PgCurrentSchemaBootstrapOperation.ActualKey(column, nativeValue + "changed")));
    }

    [Fact]
    public void IntegralAndUuidKeys_KeepTypedNativeIdentity()
    {
        var integer = new SchemaColumnModel("key", false, true, false, null, "int64");
        SchemaExpressionNode numeric = PgCurrentSchemaExpressionParser.Parse("1000", new Dictionary<string, SchemaColumnModel>());
        Assert.True(SchemaExpressionIdentity.Equal(PgCurrentSchemaBootstrapOperation.ExpectedKey(integer, numeric),
            PgCurrentSchemaBootstrapOperation.ActualKey(integer, 1000L)));
        Assert.Throws<InvalidOperationException>(() => PgCurrentSchemaBootstrapOperation.ActualKey(integer, "1000"));
        var uuid = integer with
        {
            DataType = "uuid"
        };
        Guid identity = Guid.Parse("00112233-4455-6677-8899-aabbccddeeff");
        SchemaExpressionNode literal = PgCurrentSchemaExpressionParser.Parse("'00112233-4455-6677-8899-AABBCCDDEEFF'::uuid",
            new Dictionary<string, SchemaColumnModel>());
        Assert.True(SchemaExpressionIdentity.Equal(PgCurrentSchemaBootstrapOperation.ExpectedKey(uuid, literal),
            PgCurrentSchemaBootstrapOperation.ActualKey(uuid, identity)));
    }

    [Theory]
    [InlineData("1000")]
    [InlineData("'1000'::bigint")]
    [InlineData("1000.0")]
    public void SeedIntegralAssignment_UsesNativeStorageTypeWithoutErasingExpressionTypes(string expression)
    {
        var column = new SchemaColumnModel("key", false, true, false, null, "int64");
        SchemaExpressionNode literal = PgCurrentSchemaExpressionParser.Parse(expression, new Dictionary<string, SchemaColumnModel>());
        Assert.True(SchemaExpressionIdentity.Equal(PgCurrentSchemaBootstrapOperation.ExpectedKey(column, literal),
            PgCurrentSchemaBootstrapOperation.ActualKey(column, 1000L)));
        SchemaExpressionNode division = PgCurrentSchemaExpressionParser.Parse("1000 / 2", new Dictionary<string, SchemaColumnModel>());
        Assert.Throws<InvalidOperationException>(() => PgCurrentSchemaBootstrapOperation.ExpectedKey(column, division));
        SchemaExpressionNode overflow = PgCurrentSchemaExpressionParser.Parse("9223372036854775808", new Dictionary<string, SchemaColumnModel>());
        Assert.Throws<InvalidOperationException>(() => PgCurrentSchemaBootstrapOperation.ExpectedKey(column, overflow));
    }

    [Theory]
    [InlineData("now()")]
    [InlineData("current_setting('max_connections')")]
    public void DynamicSeedKeys_CannotMasqueradeAsStableReplayAnchors(string expression)
    {
        var column = new SchemaColumnModel("key", false, true, false, null, "string");
        SchemaExpressionNode value = PgCurrentSchemaExpressionParser.Parse(expression, new Dictionary<string, SchemaColumnModel>());
        Assert.Throws<InvalidOperationException>(() => PgCurrentSchemaBootstrapOperation.ExpectedKey(column, value));
    }
}
