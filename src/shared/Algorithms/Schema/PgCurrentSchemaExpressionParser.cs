using System.Globalization;
using System.Numerics;
using System.Text;
using System.Text.RegularExpressions;

using FsusBlog.Contracts.Schema;
using FsusBlog.Shared.Algorithms;

namespace FsusBlog.Shared.Algorithms.Schema;

/// <summary>Single current PostgreSQL expression algorithm; no business mapping, DDL or admission authority.</summary>
public sealed class PgCurrentSchemaExpressionParser
{
    private readonly IReadOnlyDictionary<string, SchemaColumnModel> _columns;
    private readonly List<Token> _tokens;
    private int _position;

    private PgCurrentSchemaExpressionParser(string source, IReadOnlyDictionary<string, SchemaColumnModel> columns)
    {
        _columns = columns;
        _tokens = Lex(source);
    }

    /// <summary>Decodes the supported PostgreSQL expression grammar with exact typed literals and bound columns.</summary>
    public static SchemaExpressionNode Parse(string source, IReadOnlyDictionary<string, SchemaColumnModel> columns)
    {
        var parser = new PgCurrentSchemaExpressionParser(source, columns);
        SchemaExpressionNode value = parser.Expression(0);
        parser.Require("end");
        return value;
    }

    /// <summary>Interprets the original current owner's default facts without altering their storage semantics.</summary>
    public static SchemaExpressionNode ParseExpectedDefault(SchemaColumnModel column, IReadOnlyDictionary<string, SchemaColumnModel> columns)
    {
        string source = column.DefaultValue ?? throw Refused();
        // The original entity owner/compiler treats bare string defaults as literal
        // values. Recipe defaults already carry their original quoted expression.
        if (column.DataType == "string" && Regex.IsMatch(source, "^[A-Za-z_][A-Za-z0-9_ .-]*$", RegexOptions.CultureInvariant)
            && !source.Equals("NULL", StringComparison.OrdinalIgnoreCase))
            return Node("string", source);
        return NormalizeDefaultLiteral(Parse(source, columns), column);
    }

    /// <summary>Decodes the full native default and compares its literal in the already verified physical storage domain.</summary>
    public static SchemaExpressionNode ParseObservedDefault(string source, SchemaColumnModel column,
        IReadOnlyDictionary<string, SchemaColumnModel> columns)
        => NormalizeDefaultLiteral(Parse(source, columns), column);

    private static SchemaExpressionNode NormalizeDefaultLiteral(SchemaExpressionNode value, SchemaColumnModel column)
    {
        if (IntegralRange(column.DataType) is not null && IntegralLiteral(value) is not null)
            return NormalizeIntegralStorageLiteral(value, column);
        if (column.DataType is not ("single" or "double"))
            return value;
        string type = column.DataType == "single" ? "real" : "double precision";
        if (value.Kind == "cast" && value.Value == type && value.Arguments.Count == 1)
            value = value.Arguments[0];
        if (value.Kind == "operator" && value.Value == "negate" && value.Arguments.Count == 1 && value.Arguments[0].Kind == "number")
        {
            SchemaExpressionNode literal = value.Arguments[0];
            value = literal with
            {
                Value = literal.Value == "0" ? "0" : literal.Value.StartsWith("-", StringComparison.Ordinal) ? literal.Value[1..] : "-" + literal.Value
            };
        }
        if (value.Kind is not ("number" or "string"))
            return value;
        // This is the independently observed physical floating-point domain, not
        // decimal-literal normalization. The expected assignment and native cast
        // both target the column's already compared exact physical type.
        if (column.DataType == "single")
        {
            if (!float.TryParse(value.Value, NumberStyles.Float, CultureInfo.InvariantCulture, out float number) || !float.IsFinite(number))
                throw Refused();
            return Node("physical-float32", BitConverter.SingleToUInt32Bits(number).ToString("x8", CultureInfo.InvariantCulture));
        }
        if (!double.TryParse(value.Value, NumberStyles.Float, CultureInfo.InvariantCulture, out double wide) || !double.IsFinite(wide))
            throw Refused();
        return Node("physical-float64", BitConverter.DoubleToUInt64Bits(wide).ToString("x16", CultureInfo.InvariantCulture));
    }

    private SchemaExpressionNode Expression(int minimum)
    {
        SchemaExpressionNode left;
        if (Take("not"))
        {
            left = Operation("not", Expression(30));
        }
        else if (Take("-") || Take("+"))
        {
            string sign = _tokens[_position - 1].Value;
            SchemaExpressionNode value = Expression(70);
            // Do not fold nonzero negation: nested integer negation can overflow,
            // even when its mathematical value equals another valid literal.
            left = sign == "+" || value.Kind == "number" && value.Value == "0" ? value : Operation("negate", value);
        }
        else
        {
            left = Primary();
        }
        while (true)
        {
            if (Peek.Kind is "string" or "number" or "quoted-identifier")
                return left;
            string token = Peek.Value;
            if (token == "::" && minimum <= 90)
            {
                _position++;
                left = Cast(left, Type());
                continue;
            }
            if (token == "at" && minimum <= 55)
            {
                _position++;
                Require("time");
                Require("zone");
                left = Node("call", "timezone", Expression(56), left);
                continue;
            }
            bool negatedComparison = token == "not" && Next.Value is "in" or "between" or "like" or "ilike";
            string comparison = negatedComparison ? Next.Value : token;
            if (minimum <= 40 && comparison is "in" or "between" or "is" or "like" or "ilike")
            {
                _position += negatedComparison ? 2 : 1;
                SchemaExpressionNode result;
                if (comparison == "in")
                {
                    Require("(");
                    result = Node("operator", negatedComparison ? "not-in" : "in", new[] { left }.Concat(Arguments(")")).ToArray());
                }
                else if (comparison == "between")
                {
                    SchemaExpressionNode low = Expression(41);
                    Require("and");
                    SchemaExpressionNode high = Expression(41);
                    result = Operation("and", Operation(">=", left, low), Operation("<=", left, high));
                    if (negatedComparison)
                        result = Operation("not", result);
                }
                else if (comparison == "is")
                {
                    bool not = Take("not");
                    if (Take("distinct"))
                    {
                        Require("from");
                        result = Operation(not ? "is-not-distinct-from" : "is-distinct-from", left, Expression(41));
                    }
                    else
                    {
                        string test = Peek.Value;
                        if (Peek.Kind != "identifier" || test is not ("null" or "true" or "false" or "unknown"))
                            throw Refused();
                        _position++;
                        result = Operation("is-" + (not ? "not-" : "") + test, left);
                    }
                }
                else
                {
                    result = Operation((negatedComparison ? "not-" : "") + comparison, left, Expression(41));
                }
                left = result;
                continue;
            }
            int precedence = token switch
            {
                "or" => 10,
                "and" => 20,
                "=" or "<>" or "!=" or ">" or "<" or ">=" or "<=" or "~" or "!~" or "~*" or "!~*" or "~~" or "!~~" or "~~*" or "!~~*" => 40,
                "+" or "-" or "||" or "->" or "->>" or "#>" or "#>>" or "?" or "?|" or "?&" => 50,
                "*" or "/" or "%" => 60,
                _ => -1
            };
            if (precedence < minimum || precedence < 0)
                return left;
            _position++;
            if ((token is "=" or "<>") && (Peek.Value is "any" or "all"))
            {
                string quantifier = Peek.Value;
                _position++;
                Require("(");
                SchemaExpressionNode array = Expression(0);
                Require(")");
                if (array.Kind != "array")
                    throw Refused();
                string operation = (token, quantifier) switch
                {
                    ("=", "any") => "in",
                    ("<>", "all") => "not-in",
                    _ => throw Refused()
                };
                left = Node("operator", operation, new[] { left }.Concat(array.Arguments).ToArray());
            }
            else
            {
                string operation = token switch
                {
                    "!=" => "<>",
                    "~~" => "like",
                    "!~~" => "not-like",
                    "~~*" => "ilike",
                    "!~~*" => "not-ilike",
                    _ => token
                };
                left = Operation(operation, left, Expression(precedence + 1));
            }
        }
    }

    private SchemaExpressionNode Primary()
    {
        Token token = Peek;
        _position++;
        if (token.Kind == "string")
            return Node("string", token.Value);
        if (token.Kind == "number")
            return Number(token.Value, InferredNumericType(token.Value));
        if (token.Value == "(")
        {
            SchemaExpressionNode value = Expression(0);
            Require(")");
            return value;
        }
        if (token.Kind == "quoted-identifier")
        {
            if (!_columns.ContainsKey(token.Value))
                throw Refused();
            return Node("column", token.Value);
        }
        if (token.Kind != "identifier")
            throw Refused();
        if (token.Value is "true" or "false")
            return Node("boolean", token.Value);
        if (token.Value == "null")
            return Node("null", "");
        if (token.Value == "current_timestamp")
            return Node("call", "now");
        if (token.Value == "array")
        {
            Require("[");
            return Node("array", "", Arguments("]"));
        }
        if (Take("("))
        {
            if (token.Value == "cast")
            {
                SchemaExpressionNode value = Expression(0);
                Require("as");
                string type = Type();
                Require(")");
                return Cast(value, type);
            }
            return Node("call", token.Value, Arguments(")"));
        }
        if (!_columns.ContainsKey(token.Value))
            throw Refused();
        return Node("column", token.Value);
    }

    private SchemaExpressionNode[] Arguments(string close)
    {
        var values = new List<SchemaExpressionNode>();
        if (Take(close))
            return [];
        do
        {
            values.Add(Expression(0));
        } while (Take(","));
        Require(close);
        return values.ToArray();
    }

    private string Type()
    {
        if (Peek.Kind != "identifier")
            throw Refused();
        string value = Peek.Value;
        _position++;
        if (value == "character" && Take("varying"))
            value = "varchar";
        if (value == "double")
        {
            Require("precision");
            value = "double precision";
        }
        if (Take("("))
        {
            if (Peek.Kind != "number")
                throw Refused();
            value += "(" + Peek.Value;
            _position++;
            if (Take(","))
            {
                if (Peek.Kind != "number")
                    throw Refused();
                value += "," + Peek.Value;
                _position++;
            }
            Require(")");
            value += ")";
        }
        if (value.StartsWith("timestamp", StringComparison.Ordinal) && Peek.Value is "with" or "without")
        {
            value += " " + Peek.Value;
            _position++;
            Require("time");
            Require("zone");
            value += " time zone";
        }
        if (Take("["))
        {
            Require("]");
            value += "[]";
        }
        return value;
    }

    private SchemaExpressionNode Cast(SchemaExpressionNode expression, string type)
    {
        if (expression.Kind == "null" && type is "text" or "varchar" or "integer" or "int4" or "bigint" or "int8" or "smallint" or "int2"
            or "boolean" or "uuid" or "jsonb" or "bytea" or "numeric" or "decimal" or "timestamp" or "timestamp without time zone")
            return expression;
        bool text = type is "text" or "varchar" or "character varying";
        if (type.StartsWith("varchar(", StringComparison.Ordinal))
        {
            if (!int.TryParse(type[8..^1], out int length) || length <= 0)
                throw Refused();
            // A bounded cast can truncate. Keep it unless the exact literal fits.
            if (expression.Kind == "string" && expression.Value.EnumerateRunes().Count() <= length)
                return expression;
        }
        if (text && (expression.Kind == "string"
            || expression.Kind == "column" && _columns[expression.Value].DataType == "string"))
            return expression;
        if (type is "integer" or "int4" or "bigint" or "int8" or "smallint" or "int2")
        {
            if ((expression.Kind == "number" || expression.Kind == "string" && IsIntegerInputLiteral(expression.Value))
                && TryIntegralLiteral(expression.Value, out BigInteger number))
            {
                (BigInteger minimum, BigInteger maximum) = type switch
                {
                    "smallint" or "int2" => (short.MinValue, short.MaxValue),
                    "integer" or "int4" => (int.MinValue, int.MaxValue),
                    _ => (long.MinValue, long.MaxValue)
                };
                if (number >= minimum && number <= maximum)
                    return Node("cast", type switch
                    {
                        "smallint" or "int2" => "smallint",
                        "integer" or "int4" => "integer",
                        _ => "bigint"
                    }, Number(number.ToString(CultureInfo.InvariantCulture), type switch
                    {
                        "smallint" or "int2" => "smallint",
                        "integer" or "int4" => "integer",
                        _ => "bigint"
                    }));
            }
        }
        if (type == "boolean" && expression.Kind == "boolean")
            return expression;
        if ((type is "numeric" or "decimal") && (expression.Kind is "number" or "string"))
            return Node("cast", "numeric", Number(expression.Value, "numeric"));
        if (type == "text[]" && expression.Kind == "array" && expression.Arguments.All(static item => item.Kind == "string"))
            return expression;
        return Node("cast", type, expression);
    }

    private SchemaExpressionNode Operation(string operation, params SchemaExpressionNode[] arguments)
    {
        if (operation is "and" or "or")
            return Node("operator", operation, arguments.SelectMany(item => item.Kind == "operator" && item.Value == operation ? item.Arguments : new[] { item }).ToArray());
        if (operation == "=" && arguments[1].Kind == "boolean" && IsBoolean(arguments[0]))
        {
            return arguments[1].Value == "true" ? arguments[0] : Node("operator", "not", arguments[0]);
        }
        // A direct integral-column comparison is mathematical for an exact,
        // in-range integral constant. This does not normalize arithmetic operands:
        // integer division, overflow and overload resolution retain native types.
        if (operation is "=" or "<>" or ">" or "<" or ">=" or "<=")
        {
            NormalizeColumnComparison(arguments, 0, 1);
            NormalizeColumnComparison(arguments, 1, 0);
        }
        return Node("operator", operation, arguments);
    }

    private void NormalizeColumnComparison(SchemaExpressionNode[] arguments, int columnIndex, int literalIndex)
    {
        SchemaExpressionNode column = arguments[columnIndex];
        SchemaExpressionNode literal = arguments[literalIndex];
        if (column.Kind == "column" && IntegralLiteral(literal) is { } number
            && IntegralRange(_columns[column.Value].DataType) is { } range
            && number >= range.Minimum && number <= range.Maximum)
            arguments[literalIndex] = NormalizeIntegralStorageLiteral(literal, _columns[column.Value]);
    }

    /// <summary>Normalizes only supported literal assignment to the verified integral storage domain; arithmetic is not erased.</summary>
    public static SchemaExpressionNode NormalizeIntegralStorageLiteral(SchemaExpressionNode value, SchemaColumnModel column)
    {
        if (IntegralLiteral(value) is not { } number || IntegralRange(column.DataType) is not { } range
            || number < range.Minimum || number > range.Maximum)
            throw Refused();
        return Node("physical-integer", NormalizeNumber(number.ToString(CultureInfo.InvariantCulture)), Node("numeric-type", range.Type));
    }

    private static BigInteger? IntegralLiteral(SchemaExpressionNode value)
    {
        if (value.Kind == "number" && TryIntegralLiteral(value.Value, out BigInteger number))
            return number;
        if (value.Kind == "operator" && value.Value == "negate" && value.Arguments.Count == 1
            && value.Arguments[0].Kind == "number" && TryIntegralLiteral(value.Arguments[0].Value, out number))
            return -number;
        if (value.Kind == "cast" && value.Arguments.Count == 1 && value.Arguments[0].Kind == "number"
            && value.Value is "smallint" or "integer" or "bigint" or "numeric"
            && TryIntegralLiteral(value.Arguments[0].Value, out number))
        {
            // A literal cast is admitted only when its exact value fits its own
            // destination too. Overflow/rounding casts remain distinct syntax.
            var range = value.Value switch
            {
                "smallint" => IntegralRange("int16"),
                "integer" => IntegralRange("int32"),
                "bigint" => IntegralRange("int64"),
                _ => null
            };
            if (range is null || number >= range.Value.Minimum && number <= range.Value.Maximum)
                return number;
        }
        return null;
    }

    private static (BigInteger Minimum, BigInteger Maximum, string Type)? IntegralRange(string type)
        => type switch
        {
            "short" or "int16" => (short.MinValue, short.MaxValue, "smallint"),
            "int" or "int32" => (int.MinValue, int.MaxValue, "integer"),
            "long" or "int64" => (long.MinValue, long.MaxValue, "bigint"),
            _ => null
        };

    private static SchemaExpressionNode Number(string value, string type)
        => Node("number", NormalizeNumber(value), Node("numeric-type", type));

    private static bool IsIntegerInputLiteral(string value)
        => Regex.IsMatch(value, "\\A[+-]?[0-9]+\\z", RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1));

    private static string InferredNumericType(string source)
    {
        // PostgreSQL infers a decimal-point/exponent token as numeric even when
        // its mathematical value is integral. Preserve that before canonicalizing.
        if (source.Contains('.') || source.Contains('e') || source.Contains('E'))
            return "numeric";
        if (!BigInteger.TryParse(source, CultureInfo.InvariantCulture, out BigInteger value))
            throw Refused();
        if (value >= int.MinValue && value <= int.MaxValue)
            return "integer";
        return value >= long.MinValue && value <= long.MaxValue ? "bigint" : "numeric";
    }

    private bool IsBoolean(SchemaExpressionNode expression)
        => expression.Kind == "boolean" || expression.Kind == "column" && _columns[expression.Value].DataType == "boolean"
            || expression.Kind == "operator" && expression.Value is "and" or "or" or "not" or "=" or "<>" or ">" or "<" or ">=" or "<="
                or "in" or "not-in" or "like" or "not-like" or "ilike" or "not-ilike" or "~" or "!~" or "~*" or "!~*"
            || expression.Kind == "operator" && expression.Value.StartsWith("is-", StringComparison.Ordinal);

    private static SchemaExpressionNode Node(string kind, string value, params SchemaExpressionNode[] arguments) => new(kind, value, arguments);

    private static string NormalizeNumber(string value)
        => ExactDecimalLiteral.Normalize(value);

    private static bool TryIntegralLiteral(string value, out BigInteger integer)
    {
        string canonical = NormalizeNumber(value);
        int separator = canonical.IndexOf('e');
        if (separator < 0)
            return BigInteger.TryParse(canonical, CultureInfo.InvariantCulture, out integer);
        BigInteger scale = BigInteger.Parse(canonical[(separator + 1)..], CultureInfo.InvariantCulture);
        // The admitted integral destination is at most Int64. Large exponents
        // remain explicit casts, without allocating their expanded value.
        if (scale < 0 || scale > 19)
        {
            integer = default;
            return false;
        }
        integer = BigInteger.Parse(canonical[..separator], CultureInfo.InvariantCulture) * BigInteger.Pow(10, (int)scale);
        return true;
    }

    private Token Peek => _tokens[_position];
    private Token Next => _tokens[Math.Min(_position + 1, _tokens.Count - 1)];
    private bool Take(string value)
    {
        if (Peek.Kind is "string" or "number" or "quoted-identifier" || Peek.Value != value)
            return false;
        _position++;
        return true;
    }
    private void Require(string value)
    {
        if (!Take(value))
            throw Refused();
    }

    private sealed record Token(string Kind, string Value);
    private static List<Token> Lex(string source)
    {
        var result = new List<Token>();
        for (int position = 0; position < source.Length;)
        {
            char value = source[position];
            if (char.IsWhiteSpace(value))
            {
                position++;
                continue;
            }
            if (value == '"')
            {
                var identifier = new StringBuilder();
                position++;
                bool closed = false;
                while (position < source.Length)
                {
                    char character = source[position++];
                    if (character != '"')
                    {
                        identifier.Append(character);
                        continue;
                    }
                    if (position < source.Length && source[position] == '"')
                    {
                        identifier.Append('"');
                        position++;
                        continue;
                    }
                    closed = true;
                    break;
                }
                if (!closed)
                    throw Refused();
                result.Add(new("quoted-identifier", identifier.ToString()));
                continue;
            }
            if (value == '\'')
            {
                var literal = new StringBuilder();
                position++;
                bool closed = false;
                while (position < source.Length)
                {
                    char character = source[position++];
                    if (character != '\'')
                    {
                        literal.Append(character);
                        continue;
                    }
                    if (position < source.Length && source[position] == '\'')
                    {
                        literal.Append('\'');
                        position++;
                        continue;
                    }
                    closed = true;
                    break;
                }
                if (!closed)
                    throw Refused();
                result.Add(new("string", literal.ToString()));
                continue;
            }
            if (char.IsAsciiLetter(value) || value == '_')
            {
                int start = position++;
                while (position < source.Length && (char.IsAsciiLetterOrDigit(source[position]) || source[position] == '_'))
                    position++;
                result.Add(new("identifier", source[start..position].ToLowerInvariant()));
                continue;
            }
            if (char.IsAsciiDigit(value))
            {
                int start = position++;
                while (position < source.Length && char.IsAsciiDigit(source[position]))
                    position++;
                if (position < source.Length && source[position] == '.')
                {
                    position++;
                    while (position < source.Length && char.IsAsciiDigit(source[position]))
                        position++;
                }
                if (position < source.Length && source[position] is 'e' or 'E')
                {
                    position++;
                    if (position < source.Length && source[position] is '+' or '-')
                        position++;
                    int exponentStart = position;
                    while (position < source.Length && char.IsAsciiDigit(source[position]))
                        position++;
                    if (position == exponentStart)
                        throw Refused();
                }
                result.Add(new("number", source[start..position]));
                continue;
            }
            if (value is '(' or ')' or ',' or '[' or ']')
            {
                result.Add(new("punctuation", value.ToString()));
                position++;
                continue;
            }
            string? op = new[] { "!~~*", "!~~", "~~*", "#>>", "->>", "::", "<=", ">=", "<>", "!=", "!~*", "!~", "~*", "~~", "||", "->", "#>", "?|", "?&", "=", "<", ">", "+", "-", "*", "/", "%", "~", "?" }
                .FirstOrDefault(candidate => source.AsSpan(position).StartsWith(candidate, StringComparison.Ordinal));
            if (op is null || op == "-" && position + 1 < source.Length && source[position + 1] == '-' || op == "/" && position + 1 < source.Length && source[position + 1] == '*')
                throw Refused();
            result.Add(new("operator", op));
            position += op.Length;
        }
        result.Add(new("end", "end"));
        return result;
    }

    private static InvalidOperationException Refused() => new("current_schema_pg_expression_capability_unavailable");
}
