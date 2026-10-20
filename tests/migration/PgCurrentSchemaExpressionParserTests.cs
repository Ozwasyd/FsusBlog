using FsusBlog.Contracts.Schema;
using FsusBlog.Shared.Algorithms.Schema;

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
    [InlineData("-0.000", "0.0")]
    [InlineData("'abc'", "'abc'::varchar(3)")]
    [InlineData("'10'::bigint", "10::bigint")]
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
    [InlineData("(1 / 2) > 0", "(1::numeric / 2) > 0")]
    [InlineData("(1 / 2) > 0", "(1.0 / 2) > 0")]
    [InlineData("(1 / 2) > 0", "(1e0 / 2) > 0")]
    [InlineData("(1 / 2) > 0", "(CAST(1 AS numeric) / 2) > 0")]
    [InlineData("(2147483647 + 1) > 0", "(2147483647::bigint + 1) > 0")]
    [InlineData("(1 % 2) > 0", "(1::numeric % 2) > 0")]
    [InlineData("(1::smallint + 1::smallint) > 0", "(1 + 1) > 0")]
    [InlineData("-(-2147483648)", "2147483648")]
    [InlineData("'10'::bigint", "10.00")]
    [InlineData("-0.000", "0")]
    [InlineData("'1.0'::bigint", "'1'::bigint")]
    [InlineData("'1e0'::bigint", "'1'::bigint")]
    [InlineData("revision >= '1.0'::bigint", "revision >= 1")]
    [InlineData("revision >= '1e0'::bigint", "revision >= 1")]
    public void NumericOperatorTypes_AreNotErasedByValueNormalization(string original, string observed)
    {
        Assert.False(SchemaExpressionIdentity.Equal(Parse(original), Parse(observed)));
    }

    [Theory]
    [InlineData("revision >= 1", "revision >= '1'::bigint")]
    [InlineData("revision >= 1", "revision >= 1.0")]
    [InlineData("revision >= 1", "revision >= CAST(1 AS numeric)")]
    [InlineData("revision >= -1", "revision >= '-1'::bigint")]
    [InlineData("(1::numeric / 2) > 0", "(CAST(1 AS decimal) / 2) > 0")]
    public void ProvenLiteralContexts_KeepTheirOriginalBenignIdentity(string original, string observed)
    {
        Assert.True(SchemaExpressionIdentity.Equal(Parse(original), Parse(observed)));
    }

    [Theory]
    [InlineData("int16", "smallint")]
    [InlineData("int32", "integer")]
    [InlineData("int64", "bigint")]
    public void IntegralLiteralAssignment_UsesTheAlreadyComparedStorageDomain(string semanticType, string physicalType)
    {
        var column = new SchemaColumnModel("key", false, false, false, null, semanticType, "1", PhysicalType: physicalType);
        Assert.True(SchemaExpressionIdentity.Equal(
            PgCurrentSchemaExpressionParser.ParseExpectedDefault(column, s_columns),
            PgCurrentSchemaExpressionParser.ParseObservedDefault("'1'::" + physicalType, column, s_columns)));
        Assert.False(SchemaExpressionIdentity.Equal(
            PgCurrentSchemaExpressionParser.ParseExpectedDefault(column, s_columns),
            PgCurrentSchemaExpressionParser.ParseObservedDefault("(1 / 2)", column, s_columns)));
    }

    [Theory]
    [InlineData("single", "real")]
    [InlineData("double", "double precision")]
    public void FloatingLiteralAssignment_PreservesNativeNegativeZeroBits(string semanticType, string physicalType)
    {
        var column = new SchemaColumnModel("rate", false, false, false, null, semanticType, "0", PhysicalType: physicalType);
        SchemaExpressionNode positive = PgCurrentSchemaExpressionParser.ParseExpectedDefault(column, s_columns);
        SchemaExpressionNode negative = PgCurrentSchemaExpressionParser.ParseObservedDefault("'-0'::" + physicalType, column, s_columns);
        Assert.False(SchemaExpressionIdentity.Equal(positive, negative));
        Assert.True(SchemaExpressionIdentity.Equal(negative,
            PgCurrentSchemaExpressionParser.ParseObservedDefault("'-0.0'::" + physicalType, column, s_columns)));
    }

    [Theory]
    [InlineData("'1.0'::bigint")]
    [InlineData("'1e0'::bigint")]
    public void InvalidIntegerTextCast_DefaultCannotAcquireValidLiteralIdentity(string expression)
    {
        var column = new SchemaColumnModel("key", false, false, false, null, "int64", "1", PhysicalType: "bigint");
        Assert.False(SchemaExpressionIdentity.Equal(PgCurrentSchemaExpressionParser.ParseExpectedDefault(column, s_columns),
            PgCurrentSchemaExpressionParser.ParseObservedDefault(expression, column, s_columns)));
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
    [InlineData("single", "real", "-0.1")]
    [InlineData("double", "double precision", "-0.1234567890123456789")]
    public void LiteralDefault_UsesTheAlreadyComparedPhysicalFloatingDomain(string semanticType, string physicalType, string literal)
    {
        var column = new SchemaColumnModel("rate", false, false, false, null, semanticType, literal, PhysicalType: physicalType);
        SchemaExpressionNode expected = PgCurrentSchemaExpressionParser.ParseExpectedDefault(column, s_columns);
        SchemaExpressionNode actual = PgCurrentSchemaExpressionParser.ParseObservedDefault("'" + literal + "'::" + physicalType, column, s_columns);
        Assert.True(SchemaExpressionIdentity.Equal(expected, actual));
        Assert.False(SchemaExpressionIdentity.Equal(expected,
            PgCurrentSchemaExpressionParser.ParseObservedDefault("'2'::" + physicalType, column, s_columns)));
    }

    [Theory]
    [InlineData("rate BETWEEN 0.1 AND 4", "rate >= (0.1)::double precision AND rate <= (4)::double precision")]
    [InlineData("rate >= -10000000", "rate >= ('-10000000'::integer)::double precision")]
    [InlineData("0.1 <= rate", "(0.1)::double precision <= rate")]
    public void DirectDoubleComparison_RetainsTheVerifiedNativeLiteralDomain(string original, string observed)
    {
        var columns = new Dictionary<string, SchemaColumnModel>
        {
            ["rate"] = new("rate", false, false, false, null, "double", PhysicalType: "double precision")
        };
        Assert.True(SchemaExpressionIdentity.Equal(PgCurrentSchemaExpressionParser.Parse(original, columns),
            PgCurrentSchemaExpressionParser.Parse(observed, columns)));
    }

    [Theory]
    [InlineData("rate >= 0.1", "rate >= (0.1)::real")]
    [InlineData("rate >= 0.1", "rate >= 0.1000000001")]
    [InlineData("rate >= 0.5", "rate >= ((1::numeric / 2)::double precision)")]
    [InlineData("rate / 2 > 0", "rate / 2.0 > 0")]
    public void DirectDoubleComparison_DoesNotEraseOtherCastsArithmeticOrChangedValues(string original, string observed)
    {
        var columns = new Dictionary<string, SchemaColumnModel>
        {
            ["rate"] = new("rate", false, false, false, null, "double", PhysicalType: "double precision")
        };
        Assert.False(SchemaExpressionIdentity.Equal(PgCurrentSchemaExpressionParser.Parse(original, columns),
            PgCurrentSchemaExpressionParser.Parse(observed, columns)));
    }

    [Fact]
    public void JsonbLiteralAssignment_RetainsItsStorageCastAndExactContent()
    {
        var column = new SchemaColumnModel("payload", false, false, false, null, "json", "'{}'", PhysicalType: "jsonb");
        SchemaExpressionNode expected = PgCurrentSchemaExpressionParser.ParseExpectedDefault(column, s_columns);
        Assert.True(SchemaExpressionIdentity.Equal(expected,
            PgCurrentSchemaExpressionParser.ParseObservedDefault("'{}'::jsonb", column, s_columns)));
        foreach (string drift in new[] { "'{}'::json", "'{\"x\":1}'::jsonb", "' {}'::jsonb" })
            Assert.False(SchemaExpressionIdentity.Equal(expected,
                PgCurrentSchemaExpressionParser.ParseObservedDefault(drift, column, s_columns)));
    }

    private static SchemaExpressionNode Parse(string expression) => PgCurrentSchemaExpressionParser.Parse(expression, s_columns);
}
