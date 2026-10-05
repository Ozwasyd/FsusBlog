using System.Security.Cryptography;
using System.Text.Json;

namespace FsusBlog.Contracts.Schema;

/// <summary>Provider-neutral expression facts, not SQL, executable code or a current mapping source.</summary>
/// <param name="Kind">The semantic node kind (literal, column, call, operator, cast or array).</param>
/// <param name="Value">The exact literal, bound column, operation or semantic type identity.</param>
/// <param name="Arguments">Ordered child facts; literal contents and operand order are preserved.</param>
public sealed record SchemaExpressionNode(string Kind, string Value, IReadOnlyList<SchemaExpressionNode> Arguments);

/// <summary>Pure identity/comparison for already parsed neutral facts; it owns no provider syntax.</summary>
public static class SchemaExpressionIdentity
{
    /// <summary>Hashes the complete versioned expression tree, not original producer or execution provenance.</summary>
    /// <param name="expression">The complete ordered neutral tree supplied by its expression owner.</param>
    /// <returns>The lowercase SHA-256 identity of every serialized node and child.</returns>
    public static string Digest(SchemaExpressionNode expression)
        => Convert.ToHexStringLower(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(new
        {
            version = "fsusblog.schema-expression.v1",
            expression
        })));

    /// <summary>Compares complete ordered facts without dropping casts, literals or unknown children.</summary>
    /// <param name="expected">The original owned expression facts.</param>
    /// <param name="actual">The independently parsed native expression facts.</param>
    /// <returns>True only when the complete versioned neutral identities match.</returns>
    public static bool Equal(SchemaExpressionNode expected, SchemaExpressionNode actual)
        => Digest(expected) == Digest(actual);
}
