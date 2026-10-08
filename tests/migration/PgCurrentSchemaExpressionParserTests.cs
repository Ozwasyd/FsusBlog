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
        ["active"] = new("active", false, false, false, null, "boolean"),
        ["wide"] = new("wide", false, false, false, null, "double", PhysicalType: "double precision"),
        ["narrow"] = new("narrow", false, false, false, null, "single", PhysicalType: "real")
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
    [InlineData("wide >= 0.1", "wide >= (0.1)::double precision")]
    [InlineData("0.1 <= wide", "(0.1)::double precision <= wide")]
    [InlineData("wide <= 4", "wide <= (4)::double precision")]
    [InlineData("wide >= -10000000", "wide >= ('-10000000'::integer)::double precision")]
    [InlineData("wide BETWEEN -10000000 AND 10000000", "wide >= ('-10000000'::integer)::double precision AND wide <= 10000000::double precision")]
    [InlineData("wide >= -0.1234567890123456789", "wide >= '-0.12345678901234568'::double precision")]
    [InlineData("wide >= 1::numeric", "wide >= 1::double precision")]
    [InlineData("wide >= 9007199254740993", "wide >= 9007199254740992::double precision")]
    public void DirectDoubleColumnComparison_UsesTheNativeFloatingOperandDomain(string original, string observed)
    {
        Assert.True(SchemaExpressionIdentity.Equal(Parse(original), Parse(observed)));
    }

    [Theory]
    [InlineData("wide >= 0.1", "wide >= 0.10000000000000002")]
    [InlineData("wide >= 0.1", "wide >= ('0.1'::real)::double precision")]
    [InlineData("wide >= 9007199254740992", "wide >= 9007199254740994")]
    [InlineData("wide >= 1", "wide >= (1 / 2)")]
    [InlineData("wide >= 1", "wide >= (1::numeric / 2)")]
    [InlineData("wide / 2 > 0", "wide / 2::double precision > 0")]
    [InlineData("wide >= 1", "CAST(wide AS real) >= 1")]
    [InlineData("narrow >= 0.1", "narrow >= '0.1'::real")]
    [InlineData("wide >= 1", "wide >= '1e0'::bigint::double precision")]
    [InlineData("wide >= -(-2147483648)", "wide >= 2147483648")]
    [InlineData("wide >= 0.14", "wide >= CAST(0.14 AS numeric(2,1))")]
    public void FloatingComparison_DoesNotErasePrecisionOverflowArithmeticOrOtherDomains(string original, string observed)
    {
        Assert.False(SchemaExpressionIdentity.Equal(Parse(original), Parse(observed)));
    }

    [Theory]
    [InlineData("wide >= 1e1000")]
    [InlineData("wide >= 1e-1000")]
    public void FloatingComparison_UnrepresentableLiteralCannotAcquireZeroOrFiniteIdentity(string expression)
    {
        Assert.Throws<InvalidOperationException>(() => Parse(expression));
    }

    [Theory]
    [InlineData("'{}'", "'{}'::jsonb")]
    [InlineData("'[]'", "'[]'::jsonb")]
    [InlineData("'null'", "'null'::jsonb")]
    [InlineData("NULL", "NULL::jsonb")]
    public void JsonbDefaultAssignment_BindsOnlyTheDeclaredPhysicalStorageDomain(string original, string observed)
    {
        var column = new SchemaColumnModel("payload", false, false, false, null, "json", original, PhysicalType: "jsonb");
        Assert.True(SchemaExpressionIdentity.Equal(PgCurrentSchemaExpressionParser.ParseExpectedDefault(column, s_columns),
            PgCurrentSchemaExpressionParser.ParseObservedDefault(observed, column, s_columns)));
    }

    [Theory]
    [InlineData("'{}'", "'[]'::jsonb")]
    [InlineData("'{}'", "'null'::jsonb")]
    [InlineData("'null'", "NULL::jsonb")]
    [InlineData("'{}'", "'{}'::json")]
    [InlineData("'{}'", "'{}'::text[]")]
    [InlineData("""'{"a":1}'""", """'{"a":2}'::jsonb""")]
    public void JsonbDefaultAssignment_PreservesLiteralNullAndExplicitOtherCastDifferences(string original, string observed)
    {
        var column = new SchemaColumnModel("payload", false, false, false, null, "json", original, PhysicalType: "jsonb");
        Assert.False(SchemaExpressionIdentity.Equal(PgCurrentSchemaExpressionParser.ParseExpectedDefault(column, s_columns),
            PgCurrentSchemaExpressionParser.ParseObservedDefault(observed, column, s_columns)));
    }

    private static SchemaExpressionNode Parse(string expression) => PgCurrentSchemaExpressionParser.Parse(expression, s_columns);
}
