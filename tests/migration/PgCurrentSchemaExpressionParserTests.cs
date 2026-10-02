using FsusBlog.Contracts.Schema;

using Xunit;

namespace FsusBlog.Migration.Tests;

public sealed class PgCurrentSchemaExpressionParserTests
{
    private static readonly IReadOnlyDictionary<string, SchemaColumnModel> s_columns = new Dictionary<string, SchemaColumnModel>(StringComparer.Ordinal)
    {
        ["name"] = new("name", false, false, false, 96, "string"),
        ["state"] = new("state", false, false, false, null, "string"),
        ["not"] = new("not", false, false, false, null, "string"),
        ["revision"] = new("revision", false, false, false, null, "long"),
        ["active"] = new("active", false, false, false, null, "boolean")
    };

    [Theory]
    [InlineData("((revision >= 1) AND (revision <= 10))", "revision BETWEEN '1'::bigint AND 10")]
    [InlineData("state IN ('draft', 'published')", "state = ANY (ARRAY['draft'::text, 'published'::text])")]
    [InlineData("state NOT IN ('draft', 'published')", "state <> ALL (ARRAY['draft'::text, 'published'::text])")]
    [InlineData("name LIKE 'prefix%'", "(name)::text ~~ 'prefix%'::text")]
    [InlineData("active = true", "active")]
    [InlineData("active = false", "NOT active")]
    [InlineData("100.0000", "1e2")]
    [InlineData("-0.000", "0")]
    [InlineData("'abc'", "'abc'::varchar(3)")]
    [InlineData("'10'::bigint", "10.00")]
    [InlineData("'a  b'::text", "'a  b'")]
    [InlineData("\"not\" = 'not'", "(\"not\")::text = ('not')::text")]
    public void BoundOriginalAndCatalogExpressions_HaveTheSameNeutralIdentity(string original, string observed)
    {
        Assert.True(SchemaExpressionIdentity.Equal(Parse(original), Parse(observed)));
    }

    [Theory]
    [InlineData("name = 'a b'", "name = 'a  b'")]
    [InlineData("state IN ('draft', 'published')", "state IN ('draft', 'deleted')")]
    [InlineData("revision >= 1", "revision >= 2")]
    [InlineData("'abcd'", "'abcd'::varchar(3)")]
    [InlineData("123456789012345678901234567890.1", "123456789012345678901234567890.2")]
    [InlineData("1.00000000000000000000000000000000001", "1.00000000000000000000000000000000002")]
    [InlineData("'9223372036854775808'::bigint", "9223372036854775808")]
    [InlineData("revision >= 1 AND revision <= 10", "revision >= 1 OR revision <= 10")]
    public void SameShapeChangedMeaning_DoesNotAcquireTheOriginalIdentity(string original, string observed)
    {
        Assert.False(SchemaExpressionIdentity.Equal(Parse(original), Parse(observed)));
    }

    [Theory]
    [InlineData("unknown_column = 1")]
    [InlineData("revision >= 1; SELECT 1")]
    [InlineData("revision >= 1 -- ignored")]
    [InlineData("revision >= /* ignored */ 1")]
    [InlineData("revision IS 'null'")]
    [InlineData("1e+")]
    [InlineData("1.2.3")]
    [InlineData("'unterminated")]
    public void UnboundOrUnsupportedSyntax_IsRefused(string expression)
    {
        Assert.Throws<InvalidOperationException>(() => Parse(expression));
    }

    [Theory]
    [InlineData("not")]
    [InlineData("-")]
    [InlineData("and")]
    public void LiteralBytes_AreNeverConsumedAsGrammar(string literal)
    {
        SchemaExpressionNode expression = Parse("'" + literal + "'");
        Assert.Equal("string", expression.Kind);
        Assert.Equal(literal, expression.Value);
    }

    [Theory]
    [InlineData("single", "real", "0.1")]
    [InlineData("double", "double precision", "0")]
    [InlineData("double", "double precision", "0.1234567890123456789")]
    public void LiteralDefault_UsesTheAlreadyComparedPhysicalFloatingDomain(string semanticType, string physicalType, string literal)
    {
        var column = new SchemaColumnModel("rate", false, false, false, null, semanticType, literal, PhysicalType: physicalType);
        SchemaExpressionNode expected = PgCurrentSchemaExpressionParser.ParseExpectedDefault(column, s_columns);
        SchemaExpressionNode actual = PgCurrentSchemaExpressionParser.ParseObservedDefault("'" + literal + "'::" + physicalType, column, s_columns);
        Assert.True(SchemaExpressionIdentity.Equal(expected, actual));
        Assert.False(SchemaExpressionIdentity.Equal(expected,
            PgCurrentSchemaExpressionParser.ParseObservedDefault("'2'::" + physicalType, column, s_columns)));
    }

    private static SchemaExpressionNode Parse(string expression) => PgCurrentSchemaExpressionParser.Parse(expression, s_columns);
}
