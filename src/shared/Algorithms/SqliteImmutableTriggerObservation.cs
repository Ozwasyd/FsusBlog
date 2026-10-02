using System.Text.RegularExpressions;

namespace FsusBlog.Algorithms;

/// <summary>The native mutation event of an observed unconditional BEFORE trigger.</summary>
public enum SqliteImmutableTriggerEvent
{
    Update,
    Delete
}

/// <summary>
/// The actual SQLite RAISE action, not an inferred PostgreSQL exception or a
/// provider-neutral guarantee. Consumers must retain its different failure semantics.
/// </summary>
public enum SqliteTriggerRaiseAction
{
    Abort,
    Rollback,
    Fail,
    Ignore
}

/// <summary>
/// Decoded native trigger facts. No canonical current identity, producer ownership,
/// receipt status or expected action is manufactured from this declaration.
/// </summary>
/// <param name="Name">The decoded native trigger identifier.</param>
/// <param name="Table">The decoded native table identifier.</param>
/// <param name="Event">The single SQLite event; a PostgreSQL UPDATE OR DELETE is not substituted.</param>
/// <param name="Action">The actual RAISE action in the stored body.</param>
/// <param name="Message">The exact decoded string literal, or null for RAISE(IGNORE).</param>
public sealed record SqliteImmutableTriggerObservation(
    string Name,
    string Table,
    SqliteImmutableTriggerEvent Event,
    SqliteTriggerRaiseAction Action,
    string? Message);

/// <summary>
/// Decodes the closed unconditional immutable-guard grammar from actual SQLite
/// catalog SQL. Unknown, conditional or additional effects are refused, never
/// treated as proof merely because a trigger with the expected name exists.
/// </summary>
public static class SqliteImmutableTriggerObserver
{
    private const string White = @"[ \t\r\n\f]";
    private const string Identifier = "(?:\"(?:[^\"]|\"\")*\"|`(?:[^`]|``)*`|\\[[^\\]]*\\]|[A-Za-z_][A-Za-z0-9_]*)";
    private const string Literal = "'(?:[^']|'')*'";
    private const string Header = @"\A" + White + "*CREATE" + White + "+TRIGGER" + White
        + "+(?:IF" + White + "+NOT" + White + "+EXISTS" + White + "+)?(?<name>" + Identifier + ")"
        + White + "+BEFORE" + White + "+(?<event>UPDATE|DELETE)" + White + "+ON" + White
        + "+(?<table>" + Identifier + ")" + White + "+(?:FOR" + White + "+EACH" + White
        + "+ROW" + White + "+)?BEGIN" + White + "+SELECT" + White + "+RAISE" + White + @"*\(";
    private const string Footer = White + @"*\)" + White + "*;" + White + "*END" + White + "*;?" + White + @"*\z";
    private static readonly Regex s_error = new(Header + White + "*(?<action>ABORT|ROLLBACK|FAIL)" + White
        + "*," + White + "*(?<message>" + Literal + ")" + Footer,
        RegexOptions.CultureInvariant | RegexOptions.IgnoreCase | RegexOptions.NonBacktracking);
    private static readonly Regex s_ignore = new(Header + White + "*IGNORE" + Footer,
        RegexOptions.CultureInvariant | RegexOptions.IgnoreCase | RegexOptions.NonBacktracking);

    /// <summary>
    /// Decode only a single native unconditional BEFORE UPDATE/DELETE RAISE body.
    /// The caller bounds original metadata before invoking this non-backtracking parser.
    /// </summary>
    /// <param name="actualSql">SQL measured from the original native catalog, not a producer assertion.</param>
    /// <returns>Actual names, event, failure action and message without choosing an expected provider policy.</returns>
    public static SqliteImmutableTriggerObservation Decode(string actualSql)
    {
        ArgumentNullException.ThrowIfNull(actualSql);
        if (actualSql.Contains('\0'))
        {
            throw new InvalidOperationException("sqlite_current_trigger_effect_not_supported");
        }
        Match match = s_error.Match(actualSql);
        SqliteTriggerRaiseAction action;
        string? message;
        if (match.Success)
        {
            action = match.Groups["action"].Value.ToUpperInvariant() switch
            {
                "ABORT" => SqliteTriggerRaiseAction.Abort,
                "ROLLBACK" => SqliteTriggerRaiseAction.Rollback,
                "FAIL" => SqliteTriggerRaiseAction.Fail,
                _ => throw new InvalidOperationException("sqlite_current_trigger_effect_not_supported")
            };
            string literal = match.Groups["message"].Value;
            message = literal[1..^1].Replace("''", "'", StringComparison.Ordinal);
        }
        else
        {
            match = s_ignore.Match(actualSql);
            if (!match.Success)
            {
                throw new InvalidOperationException("sqlite_current_trigger_effect_not_supported");
            }
            action = SqliteTriggerRaiseAction.Ignore;
            message = null;
        }
        // SQLite folds ASCII keywords only. Regex's Unicode ignore-case rules
        // must not turn a keyword lookalike into native executable semantics;
        // Unicode remains valid inside actual identifiers and literal messages.
        for (int index = 0; index < actualSql.Length; index++)
        {
            if (actualSql[index] > 0x7f && !Inside(match.Groups["name"], index)
                && !Inside(match.Groups["table"], index) && !Inside(match.Groups["message"], index))
            {
                throw new InvalidOperationException("sqlite_current_trigger_effect_not_supported");
            }
        }
        return new(DecodeIdentifier(match.Groups["name"].Value), DecodeIdentifier(match.Groups["table"].Value),
            match.Groups["event"].Value.Equals("UPDATE", StringComparison.OrdinalIgnoreCase)
                ? SqliteImmutableTriggerEvent.Update : SqliteImmutableTriggerEvent.Delete, action, message);
    }

    private static bool Inside(Group group, int index) => group.Success && index >= group.Index && index < group.Index + group.Length;

    private static string DecodeIdentifier(string value) => value[0] switch
    {
        '"' => value[1..^1].Replace("\"\"", "\"", StringComparison.Ordinal),
        '`' => value[1..^1].Replace("``", "`", StringComparison.Ordinal),
        '[' => value[1..^1],
        _ => value
    };
}
