using System.Collections.Immutable;
using System.Text;

namespace FsusBlog.Server.Services.Authoring;

public static partial class AuthorFullTextSearchContract
{
    public const string QueryGrammarVersion = "conjunctive-author-clauses.v1";

    /// <summary>
    /// Parses the sole author content grammar; it never executes queries. Whitespace is
    /// conjunction, quoted text is a phrase, field.NAME selects a closed content field,
    /// and status/category/tag/updated-at.before/updated-at.after select system facts.
    /// Only quote/backslash escapes exist inside quotes. Regex, boolean operators and
    /// wildcards are unavailable. Typed property operands require their value authority.
    /// </summary>
    public static ImmutableArray<AuthorSearchClause> ParseClauses(string text)
    {
        ArgumentNullException.ThrowIfNull(text);
        Require(text.Length is > 0 and <= MaxQueryCharacters, "author_search_query_budget_invalid");
        var clauses = ImmutableArray.CreateBuilder<AuthorSearchClause>();
        var filters = new HashSet<string>(StringComparer.Ordinal);
        int offset = 0;
        while (offset < text.Length)
        {
            while (offset < text.Length && char.IsWhiteSpace(text[offset]))
            {
                offset++;
            }
            if (offset == text.Length)
            {
                break;
            }
            Require(clauses.Count < MaxQueryClauses, "author_search_query_budget_invalid");
            int start = offset;
            while (offset < text.Length && !char.IsWhiteSpace(text[offset])
                && text[offset] is not ':' and not '"')
            {
                offset++;
            }
            string? prefix = null;
            if (offset < text.Length && text[offset] == ':')
            {
                prefix = text[start..offset++];
                start = offset;
            }
            bool quoted = offset < text.Length && text[offset] == '"';
            string value;
            if (quoted)
            {
                Require(offset == start, "author_search_query_quote_invalid");
                offset++;
                var phrase = new StringBuilder();
                bool closed = false;
                while (offset < text.Length)
                {
                    char character = text[offset++];
                    if (character == '"')
                    {
                        closed = true;
                        break;
                    }
                    if (character == '\\')
                    {
                        Require(offset < text.Length && text[offset] is '"' or '\\',
                            "author_search_query_escape_invalid");
                        character = text[offset++];
                    }
                    phrase.Append(character);
                }
                Require(closed && (offset == text.Length || char.IsWhiteSpace(text[offset])),
                    "author_search_query_quote_invalid");
                value = phrase.ToString();
            }
            else
            {
                while (offset < text.Length && !char.IsWhiteSpace(text[offset]))
                {
                    offset++;
                }
                value = text[start..offset];
                string unsupported = prefix is "updated-at.before" or "updated-at.after"
                    ? "*?[](){}|^$\\\""
                    : "*+?[](){}|^$\\\"";
                Require(value.IndexOfAny(unsupported.ToCharArray()) < 0
                    && !value.StartsWith('/')
                    && value is not ("AND" or "OR" or "NOT"), "author_search_query_operator_unavailable");
            }
            Require(ValidText(value, MaxQueryCharacters), "author_search_query_value_invalid");
            AuthorSearchClause clause = Clause(prefix, value, quoted);
            if (prefix is not null)
            {
                Require(filters.Add(prefix), "author_search_duplicate_filter");
            }
            clauses.Add(clause);
        }
        Require(clauses.Count > 0, "author_search_query_budget_invalid");
        return clauses.ToImmutable();
    }

    private static AuthorSearchClause Clause(string? prefix, string value, bool quoted)
    {
        if (prefix is null)
        {
            return new(quoted ? AuthorSearchClauseKind.QuotedPhrase : AuthorSearchClauseKind.PlainText,
                null, null, null, [value]);
        }
        if (prefix.StartsWith("field.", StringComparison.Ordinal))
        {
            AuthorSearchFieldKind[] fields = Fields.Where(pair => pair.Value == prefix[6..])
                .Select(static pair => pair.Key).ToArray();
            Require(fields.Length == 1 && fields[0] != AuthorSearchFieldKind.Property,
                "author_search_field_unknown");
            return new(quoted ? AuthorSearchClauseKind.FieldPhrase : AuthorSearchClauseKind.FieldText,
                fields[0], null, null, [value]);
        }
        return prefix switch
        {
            "status" => new(AuthorSearchClauseKind.Status, null, null, null, [value]),
            "category" => new(AuthorSearchClauseKind.Category, null, null, null, [value]),
            "tag" => new(AuthorSearchClauseKind.Tag, null, null, null, [value]),
            "updated-at.before" or "updated-at.after" => new(AuthorSearchClauseKind.Date, null, null, prefix, [value]),
            "property" => throw new AuthorSearchContractException("author_search_typed_property_operand_unavailable"),
            _ => throw new AuthorSearchContractException("author_search_filter_unknown")
        };
    }
}
