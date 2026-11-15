using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Core.Authoring;
using Microsoft.AspNetCore.WebUtilities;
using Npgsql;
using NpgsqlTypes;

namespace FsusBlog.V2.Server.Authoring;

internal sealed partial class PropertyStore
{
    private static readonly byte[] QueryKey = RandomNumberGenerator.GetBytes(32);

    internal async Task<PropertyFilterCatalog> Catalog(string? after, long schemaRevision, CancellationToken ct)
    {
        var (revision, next, definitions) = await ReadCatalog(after, schemaRevision, ct);
        return new(revision, next, definitions.Select(FilterField).ToArray());
    }

    internal async Task<PropertyProjectionCatalog> ProjectionCatalog(string? after, long schemaRevision, CancellationToken ct)
    {
        var (revision, next, definitions) = await ReadCatalog(after, schemaRevision, ct);
        return new(revision, next, definitions.Select(definition =>
        {
            var field = FilterField(definition);
            var settings = definition.Settings;
            return new PropertyProjectionCatalogField(field,
                !field.Deprecated && settings.SearchEligible && field.Kind == PropertyFieldKind.Text,
                !field.Deprecated && settings.Sortable && SupportsSort(field.Kind));
        }).ToArray());
    }

    private async Task<(long Revision, string Next, PropertyDefinition[] Definitions)> ReadCatalog(string? after, long schemaRevision,
        CancellationToken ct)
    {
        await ScopeLock(ct);
        var schema = await ReadSchema(ct);
        if (after is not null && schemaRevision != schema.Revision) throw Conflict();
        var fields = schema.Page(after, WireLimits.PropertyPageSize + 1);
        var page = fields.Take(WireLimits.PropertyPageSize).ToArray();
        var next = fields.Length > page.Length ? page[^1].MachineKey : "";
        return (schema.Revision, next, page);
    }

    private static PropertyFilterField FilterField(PropertyDefinition definition) => new(definition.Id, definition.Revision, definition.MachineKey,
        definition.Names.FirstOrDefault(name => name.Locale == "zh")?.Label ?? definition.Names[0].Label, FieldKind(definition.Settings.Kind),
        definition.Status == PropertyStatus.Active && definition.Settings.Filterable, definition.Status != PropertyStatus.Active,
        definition.Settings.Options.Where(option => option.Status == PropertyStatus.Active).Select(option => new PropertyFieldOption(option.Id, option.Label)).ToArray());

    internal async Task<PropertyCommandReceipt> SetFilterable(PropertyFilterabilityCommand input, CancellationToken ct)
    {
        await ScopeLock(ct);
        var schema = await ReadSchema(ct);
        if (schema.Find(input.DefinitionId) is null) throw Missing();
        return await ApplyChange(schema, new(ownerId, input.RequestId, input.SchemaRevision, input.DefinitionRevision,
            new PropertyChange.SetFilterable(input.DefinitionId, input.Enabled)), ct);
    }

    internal async Task<PropertyArticlePage> Filter(PropertyArticleQueryGroup input, string session, CancellationToken ct)
    {
        var conditions = await ResolveQuery(input.SchemaRevision, input.Conditions, ct);
        await ValidateQueryReferences(conditions, ct);
        return await Filter(conditions, input.SchemaRevision, session, input.Cursor, input.Keyword, ct);
    }

    internal async Task<byte[]> CaptureSavedView(PropertyArticleQueryGroup input, CancellationToken ct)
    {
        var conditions = await ResolveQuery(input.SchemaRevision, input.Conditions, ct);
        await ValidateQueryReferences(conditions, ct);
        var references = conditions.SelectMany(item => ReferenceIds(item.Value)).ToHashSet();
        return Wire.EncodeSavedViewDefinition(conditions.Select(item => new SavedViewCondition(item.DefinitionId, item.Kind,
            item.Comparison, item.Value is null ? new PropertyFieldValue.Missing() : VisibleValue(item.Value, references), item.AnyOf)).ToArray(), input.Keyword);
    }

    internal async Task<PropertyArticlePage> OpenSavedView(SavedViewDefinition saved, string session, SavedViewExecute request, CancellationToken ct)
    {
        await ScopeLock(ct);
        var schema = await ReadSchema(ct);
        var conditions = saved.Conditions.Select(item =>
        {
            var definition = schema.Find(item.DefinitionId) ?? throw SavedViewDependency();
            if (FieldKind(definition.Settings.Kind) != item.Kind) throw SavedViewDependency();
            return Normalize(definition, new(item.DefinitionId, definition.Revision, item.Comparison, item.Value, item.AnyOf));
        }).ToArray();
        await ValidateQueryReferences(conditions, ct);
        return await Filter(conditions, schema.Revision, $"saved:{request.Id:D}:{request.Revision}:{session}", request.Cursor, saved.Keyword, ct);
    }

    internal static BusinessException SavedViewDependency() => new(Rejection.Conflict, "A saved view dependency is unavailable. Update its conditions.");

    internal async Task ValidateQueryReferences(Condition[] conditions, CancellationToken ct)
    {
        var referenceIds = QueryReferenceIds(conditions);
        if (referenceIds.Length != 0 && !(await ReadReferences(referenceIds, ct)).SetEquals(referenceIds)) throw Missing();
    }

    internal async Task<Condition[]> ResolveQuery(long schemaRevision, IReadOnlyList<PropertyCondition> conditions, CancellationToken ct) =>
        (await ResolveSearchQuery(schemaRevision, conditions, null, null, ct)).Conditions;

    internal async Task<(Condition[] Conditions, FacetDefinition? Facet, SortDefinition? Sort)> ResolveSearchQuery(long schemaRevision,
        IReadOnlyList<PropertyCondition> conditions, FacetSelection? facet, SortSelection? sort, CancellationToken ct)
    {
        await ScopeLock(ct);
        var schema = await ReadSchema(ct);
        if (schema.Revision != schemaRevision) throw Conflict();
        var resolved = conditions.OrderBy(item => item.DefinitionId).ThenBy(item => item.Comparison)
            .Select(item => Normalize(schema.Find(item.DefinitionId) ?? throw Missing(), item)).ToArray();
        if (resolved.Any(item => item.AnyOf))
        {
            if (resolved.Where(item => item.AnyOf).GroupBy(item => (item.DefinitionId, item.Comparison, QueryValueKey(item.Value)))
                .Any(group => group.Count() > 1)) throw Invalid();
            resolved = resolved.OrderBy(item => item.DefinitionId).ThenBy(item => item.Comparison)
                .ThenBy(item => item.AnyOf ? QueryValueKey(item.Value) : "", StringComparer.Ordinal).ToArray();
        }
        return (resolved, facet is { } selection ? ResolveFacet(schema, selection) : null,
            sort is { } ordering ? ResolveSort(schema, ordering) : null);
    }

    private static FacetDefinition ResolveFacet(PropertySchema schema, FacetSelection selection)
    {
        var definition = ActiveDefinition(schema, selection.DefinitionId, selection.DefinitionRevision);
        if (!definition.Settings.Filterable) throw Missing();
        var kind = FieldKind(definition.Settings.Kind);
        if (kind is not (PropertyFieldKind.Boolean or PropertyFieldKind.SingleSelect or PropertyFieldKind.MultiSelect)) throw Invalid();
        return new(definition.Id, definition.Revision, kind, ActiveOptionIds(definition));
    }

    private static SortDefinition ResolveSort(PropertySchema schema, SortSelection selection)
    {
        var definition = ActiveDefinition(schema, selection.DefinitionId, selection.DefinitionRevision);
        if (!definition.Settings.Sortable) throw Missing();
        var kind = FieldKind(definition.Settings.Kind);
        if (!SupportsSort(kind) || !Enum.IsDefined(selection.Direction)) throw Invalid();
        return new(definition.Id, kind, selection.Direction, ActiveOptionIds(definition));
    }

    private static PropertyDefinition ActiveDefinition(PropertySchema schema, Guid id, long revision)
    {
        var definition = schema.Find(id) ?? throw Missing();
        if (definition.Revision != revision) throw Conflict();
        return definition.Status == PropertyStatus.Active ? definition : throw Missing();
    }

    private static bool SupportsSort(PropertyFieldKind kind) => kind is PropertyFieldKind.Text or PropertyFieldKind.Number or
        PropertyFieldKind.Boolean or PropertyFieldKind.Date or PropertyFieldKind.SingleSelect or PropertyFieldKind.MultiSelect;

    private static Guid[] ActiveOptionIds(PropertyDefinition definition)
    {
        var optionIds = definition.Settings.Options.Where(option => option.Status == PropertyStatus.Active)
            .Select(option => option.Id).Order().ToArray();
        if (optionIds.Length > WireLimits.PropertyOptionCount) throw Invalid();
        return optionIds;
    }

    private static int[] QueryReferenceIds(Condition[] conditions) =>
        conditions.SelectMany(item => ReferenceIds(item.Value)).Distinct().ToArray();

    private async Task<PropertyArticlePage> Filter(Condition[] conditions, long schema, string session, string cursor, string keyword,
        CancellationToken ct)
    {
        var binding = CursorBinding(session, schema, conditions, keyword);
        var before = 0;
        if (cursor.Length != 0)
        {
            var bytes = WebEncoders.Base64UrlDecode(cursor);
            before = BinaryPrimitives.ReadInt32LittleEndian(bytes);
            if (before <= 0 || !CryptographicOperations.FixedTimeEquals(
                    Encoding.ASCII.GetBytes(Cursor(binding, before)), Encoding.ASCII.GetBytes(cursor))) throw Invalid();
        }
        var sql = new StringBuilder($"""
            select a.id,a.revision,a.title from public.article a
            where a.owner_id=$1 and not a.deleted and {ArchivedArticleAuthority.Available}
            """);
        var parameters = new List<object> { ownerId, before, WireLimits.PropertyPageSize + 1 };
        sql.Append(before != 0 ? " and a.id<$2" : " and a.id>$2");
        if (keyword.Length != 0)
        {
            parameters.Add(keyword);
            sql.Append(" and ").Append(ArticleInventoryEndpoints.KeywordPredicate(parameters.Count));
        }
        AppendConditions(sql, parameters, conditions);
        sql.Append(" order by a.id desc limit $3");
        await using var query = Store.Sql(db, tx, sql.ToString(), parameters.ToArray());
        var matches = new List<PropertyArticleRow>(WireLimits.PropertyPageSize + 1);
        await using var reader = await query.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
            matches.Add(new(reader.GetInt32(0), reader.GetInt64(1), reader.GetString(2)));
        var more = matches.Count > WireLimits.PropertyPageSize;
        if (more) matches.RemoveAt(matches.Count - 1);
        return new(more ? Cursor(binding, matches[^1].Id) : "", matches);
    }

    internal sealed record Condition(Guid DefinitionId, long DefinitionRevision, PropertyFieldKind Kind, PropertyComparison Comparison, PropertyValue? Value,
        bool AnyOf);
    internal readonly record struct FacetSelection(Guid DefinitionId, long DefinitionRevision);
    internal sealed record FacetDefinition(Guid Id, long Revision, PropertyFieldKind Kind, Guid[] OptionIds);
    internal readonly record struct SortSelection(Guid DefinitionId, long DefinitionRevision, AuthorTextPropertySortDirection Direction);
    internal sealed record SortDefinition(Guid Id, PropertyFieldKind Kind, AuthorTextPropertySortDirection Direction, Guid[] OptionIds);

    internal static string SortCtes(SortDefinition sort, List<object> parameters, string rankOrder)
    {
        parameters.Add(sort.Id);
        var definition = parameters.Count;
        parameters.Add(PropertyTypeTag(sort.Kind));
        var kind = parameters.Count;
        var key = SortKey(sort, parameters);
        var direction = sort.Direction == AuthorTextPropertySortDirection.Ascending ? "asc" : "desc";
        return $"""
            property_sort_values as materialized (
                select s.*, v.data is null as missing_sort_value, v.data->>'$type'='null' as explicit_sort_null,
                    case when v.data->>'$type'=${kind} then {key} end as sort_value
                from selected s left join public.property_value v
                    on v.owner_id=$1 and v.article_id=s.article_id and v.definition_id=${definition}
            ),
            property_sort_order as materialized (
                select p.*, row_number() over (order by
                    case when p.sort_value is not null then 0 when p.explicit_sort_null then 1
                         when p.missing_sort_value then 2 else 3 end,
                    p.sort_value {direction} nulls last, {rankOrder}) as sort_position
                from property_sort_values p
            ),
            property_sort_fence as materialized (
                select sort_position from property_sort_order where article_id=$13
            ),
            """;
    }

    private static string SortKey(SortDefinition sort, List<object> parameters)
    {
        const string Text = "v.data->>'Value'";
        const string Value = "v.data->'Value'";
        if (sort.Kind is PropertyFieldKind.SingleSelect or PropertyFieldKind.MultiSelect)
        {
            parameters.Add(sort.OptionIds.Select(id => id.ToString("D")).ToArray());
            var active = parameters.Count;
            if (sort.Kind == PropertyFieldKind.SingleSelect)
                return $"case when v.data->>'OptionId'=any(${active}::text[]) then (v.data->>'OptionId')::uuid end";

            return $$"""
                case when jsonb_typeof(v.data->'OptionIds')='array' then (
                    select case when count(*)=count(distinct option_id)
                        then coalesce(array_agg(option_id order by option_id), '{}'::uuid[]) end
                    from (select case when item.value=any(${{active}}::text[]) then item.value::uuid end as option_id
                          from jsonb_array_elements_text(v.data->'OptionIds') item(value)) options
                ) end
                """;
        }

        return sort.Kind switch
        {
            PropertyFieldKind.Text => $"case when jsonb_typeof({Value})='string' then ({Text}) collate \"C\" end",
            PropertyFieldKind.Number => $"case when jsonb_typeof({Value})='number' then ({Text})::numeric end",
            PropertyFieldKind.Boolean => $"case when jsonb_typeof({Value})='boolean' then ({Text})::boolean end",
            PropertyFieldKind.Date => $"case when pg_catalog.pg_input_is_valid({Text},'timestamp with time zone') then ({Text})::timestamptz end",
            _ => throw Invalid(),
        };
    }

    internal static string FacetCtes(FacetDefinition facet, List<object> parameters)
    {
        parameters.Add(facet.Id);
        var definition = parameters.Count;
        parameters.Add(PropertyTypeTag(facet.Kind));
        var kind = parameters.Count;
        string[] keys = facet.Kind == PropertyFieldKind.Boolean ? ["false", "true"] : facet.OptionIds.Select(id => id.ToString("D")).ToArray();
        parameters.Add(keys);
        var values = parameters.Count;
        var (member, jsonType) = facet.Kind switch
        {
            PropertyFieldKind.Boolean => ("Value", "boolean"),
            PropertyFieldKind.SingleSelect => ("OptionId", "string"),
            PropertyFieldKind.MultiSelect => ("OptionIds", "array"),
            _ => throw Invalid(),
        };
        var value = $"v.data->'{member}'";
        var multi = facet.Kind == PropertyFieldKind.MultiSelect;
        var array = multi ? value : $"jsonb_build_array({value})";
        var empty = multi ? $"count(*) filter (where v.data->>'$type'=${kind} and {value}='[]'::jsonb)::integer" : "0";
        return $"""
            property_facet_values as materialized (
                select s.article_id,v.data from selected s
                left join public.property_value v on v.owner_id=$1 and v.article_id=s.article_id and v.definition_id=${definition}
            ),
            property_facet_counts as (
                select item.key,count(distinct v.article_id)::integer as hits from property_facet_values v
                cross join lateral jsonb_array_elements_text(case when v.data->>'$type'=${kind}
                    and jsonb_typeof({value})='{jsonType}' then {array} else '[]'::jsonb end) item(key)
                where item.key=any(${values}::text[]) group by item.key
            ),
            property_facet_buckets as (
                select count(*) filter (where v.data is null)::integer as missing,
                    count(*) filter (where v.data->>'$type'='null')::integer as explicit_null,
                    {empty} as empty,
                    array(select coalesce(c.hits,0) from unnest(${values}::text[]) with ordinality keys(key,ordinal)
                        left join property_facet_counts c on c.key=keys.key order by keys.ordinal) as hits
                from property_facet_values v
            ),
            """;
    }

    internal static AuthorTextPropertyFacet ReadFacet(FacetDefinition facet, NpgsqlDataReader row, int column)
    {
        PropertyFieldValue[] values = facet.Kind == PropertyFieldKind.Boolean
            ? [new PropertyFieldValue.Boolean(false), new PropertyFieldValue.Boolean(true)]
            : facet.OptionIds.Select(id => (PropertyFieldValue)new PropertyFieldValue.SingleSelect(id)).ToArray();
        var hits = row.GetFieldValue<int[]>(column + 3);
        if (hits.Length != values.Length) throw Conflict();
        var buckets = values.Select((value, index) => new AuthorTextPropertyFacetBucket(value, hits[index])).ToArray();
        return new(facet.Id, facet.Revision, facet.Kind, row.GetInt32(column), row.GetInt32(column + 1), row.GetInt32(column + 2), buckets);
    }

    private static byte[] CursorBinding(string session, long revision, Condition[] conditions, string keyword)
    {
        using var data = new MemoryStream();
        using var writer = new BinaryWriter(data, Encoding.UTF8, leaveOpen: true);
        writer.Write(session);
        writer.Write(revision);
        writer.Write(conditions.Length);
        foreach (var condition in conditions)
        {
            writer.Write(condition.DefinitionId.ToByteArray());
            writer.Write(condition.DefinitionRevision);
            writer.Write(Wire.PropertyComparisonCode(condition.Comparison, condition.AnyOf));
            writer.Write(QueryValueKey(condition.Value));
        }
        if (keyword.Length != 0)
        {
            writer.Write("title-summary");
            writer.Write(keyword);
        }
        writer.Flush();
        return SHA256.HashData(data.GetBuffer().AsSpan(0, (int)data.Length));
    }

    private static string QueryValueKey(PropertyValue? value) => value is null ? "" : (string)Json(value).Value!;

    private static Condition Normalize(PropertyDefinition definition, PropertyCondition condition)
    {
        if (definition.Revision != condition.DefinitionRevision) throw Conflict();
        if (definition.Status != PropertyStatus.Active || !definition.Settings.Filterable) throw Missing();
        var value = DomainValue(condition.Value);
        var normalized = (condition.Comparison, definition.Settings.Kind, value) switch
        {
            (PropertyComparison.Equal or PropertyComparison.IsPresent, _, null) => null,
            (PropertyComparison.IsPresent, _, _) => throw Invalid(),
            (PropertyComparison.Equal, _, { } present) => PropertyValues.NormalizeFilter(definition, present),
            (PropertyComparison.MultiSelectAnyOf, PropertyKind.MultiSelect, PropertyValue.MultiSelect choices) =>
                PropertyValues.NormalizeSelectionAlternatives(definition, choices),
            (PropertyComparison.SingleSelectAnyOf, PropertyKind.SingleSelect, PropertyValue.MultiSelect choices) =>
                PropertyValues.NormalizeSelectionAlternatives(definition, choices),
            (PropertyComparison.ReferenceAnyOf, PropertyKind.ArticleReference, PropertyValue.ArticleReference references) =>
                PropertyValues.NormalizeReferenceAlternatives(definition, references),
            (PropertyComparison.MultiSelectAnyOf or PropertyComparison.SingleSelectAnyOf or PropertyComparison.ReferenceAnyOf, _, _) => throw Invalid(),
            (_, PropertyKind.Number, PropertyValue.Number number) => number,
            (_, PropertyKind.Date, PropertyValue.Date date) => new PropertyValue.Date(date.Value.ToUniversalTime()),
            _ => throw Invalid(),
        };
        return new(condition.DefinitionId, condition.DefinitionRevision, FieldKind(definition.Settings.Kind), condition.Comparison, normalized, condition.AnyOf);
    }

    internal static void AppendConditions(StringBuilder sql, List<object> parameters, Condition[] conditions)
    {
        foreach (var condition in conditions.Where(item => !item.AnyOf))
        {
            sql.Append(" and ");
            AppendCondition(sql, parameters, condition);
        }
        foreach (var group in conditions.Where(item => item.AnyOf).GroupBy(item => item.DefinitionId))
        {
            var separator = " and (";
            foreach (var condition in group)
            {
                sql.Append(separator);
                AppendCondition(sql, parameters, condition);
                separator = " or ";
            }
            sql.Append(')');
        }
    }

    private static void AppendCondition(StringBuilder sql, List<object> parameters, Condition condition)
    {
        var isPresent = condition.Comparison == PropertyComparison.IsPresent;
        parameters.Add(condition.DefinitionId);
        sql.Append(condition.Value is null && !isPresent ? "not exists (" : "exists (");
        sql.Append("select from public.property_value v where v.article_id=a.id and v.owner_id=$1 and v.definition_id=$")
            .Append(parameters.Count);
        if (isPresent)
        {
            parameters.Add(PropertyTypeTag(condition.Kind));
            sql.Append(" and v.data->>'$type'=$").Append(parameters.Count);
        }
        else if (condition.Comparison == PropertyComparison.ReferenceAnyOf && condition.Value is PropertyValue.ArticleReference references)
        {
            parameters.Add(PropertyTypeTag(condition.Kind));
            sql.Append(" and v.data->>'$type'=$").Append(parameters.Count);
            parameters.Add(ReferenceIds(references));
            sql.Append(" and v.data->'ArticleIds'=to_jsonb(v.references_ids) and v.references_ids && $").Append(parameters.Count);
        }
        else if (condition.Comparison is PropertyComparison.MultiSelectAnyOf or PropertyComparison.SingleSelectAnyOf &&
                 condition.Value is PropertyValue.MultiSelect alternatives)
        {
            parameters.Add(PropertyTypeTag(condition.Kind));
            sql.Append(" and v.data->>'$type'=$").Append(parameters.Count);
            parameters.Add(alternatives.OptionIds.Select(id => id.ToString("D")).ToArray());
            if (condition.Comparison == PropertyComparison.SingleSelectAnyOf)
                sql.Append(" and v.data->>'OptionId'=any($").Append(parameters.Count).Append(')');
            else
                sql.Append(" and jsonb_typeof(v.data->'OptionIds')='array' and (v.data->'OptionIds') ?| $").Append(parameters.Count);
        }
        else if (condition.Value is not null)
        {
            if (condition.Comparison == PropertyComparison.Equal)
            {
                parameters.Add(Json(condition.Value));
                sql.Append(" and v.data=$").Append(parameters.Count);
            }
            else
            {
                var (expression, operand) = condition.Value switch
                {
                    PropertyValue.Number number => ("case when v.data->>'$type'='number' then (v.data->>'Value')::numeric end", (object)number.Value),
                    PropertyValue.Date date => ("case when v.data->>'$type'='date' then (v.data->>'Value')::timestamptz end", (object)date.Value),
                    _ => throw Invalid(),
                };
                parameters.Add(operand);
                var comparison = condition.Comparison switch
                {
                    PropertyComparison.LessThan => "<",
                    PropertyComparison.AtMost => "<=",
                    PropertyComparison.GreaterThan => ">",
                    PropertyComparison.AtLeast => ">=",
                    _ => throw Invalid(),
                };
                sql.Append(" and (").Append(expression).Append(')').Append(comparison).Append('$').Append(parameters.Count);
            }
        }
        if (ChecksReferenceVisibility(condition))
            sql.Append($"""
                 and not exists (select from unnest(v.references_ids) target(id)
                    where not exists (select from public.article r
                        {ReferenceAuthorityJoins("join")}
                        where r.id=target.id and r.owner_id=$1 and not r.deleted))
                """);
        sql.Append(')');
    }

    private static bool ChecksReferenceVisibility(Condition condition) =>
        condition.Value is PropertyValue.ArticleReference ||
        condition.Comparison == PropertyComparison.IsPresent && condition.Kind == PropertyFieldKind.ArticleReference;

    private static string ReferenceAuthorityJoins(string join) => $"""
        {join} public.article_publication p on p.article_id=r.id and p.revision=r.published_revision
        {join} public.article_publication_rights w
            on w.article_id=p.article_id and w.publication_id=p.publication_id and w.revision=p.revision
        """;

    internal static string ReferenceDependencyWitness(Condition[] conditions, List<object> parameters)
    {
        var definitions = conditions.Where(ChecksReferenceVisibility).Select(condition => condition.DefinitionId).Distinct().ToArray();
        if (definitions.Length == 0) return "''::bytea";
        parameters.Add(definitions);
        var definitionParameter = parameters.Count;
        parameters.Add(QueryReferenceIds(conditions));
        var operandParameter = parameters.Count;
        return $"""
            (select pg_catalog.sha256(coalesce(string_agg(
                pg_catalog.int4send(target.id) || pg_catalog.int8send(coalesce(r.published_revision,0)) ||
                pg_catalog.int8send(coalesce(p.publication_id,0)) || pg_catalog.int8send(coalesce(w.id,0)),
                ''::bytea order by target.id), ''::bytea))
            from (
                select unnest(v.references_ids) as id
                from public.property_value v join owner_scope e on e.id=v.article_id
                where v.owner_id=$1 and v.definition_id=any(${definitionParameter})
                union select unnest(${operandParameter}::integer[])
            ) target
            left join public.article r on r.id=target.id and r.owner_id=$1 and not r.deleted
            {ReferenceAuthorityJoins("left join")})
            """;
    }

    private static string Cursor(byte[] binding, int before)
    {
        Span<byte> token = stackalloc byte[sizeof(int) + SHA256.HashSizeInBytes];
        Span<byte> signed = stackalloc byte[sizeof(int) + SHA256.HashSizeInBytes];
        BinaryPrimitives.WriteInt32LittleEndian(token, before);
        token[..sizeof(int)].CopyTo(signed);
        binding.CopyTo(signed[sizeof(int)..]);
        HMACSHA256.HashData(QueryKey, signed, token[sizeof(int)..]);
        return WebEncoders.Base64UrlEncode(token.ToArray());
    }
}
