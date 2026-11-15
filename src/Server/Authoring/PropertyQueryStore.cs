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
        await ScopeLock(ct);
        var schema = await ReadSchema(ct);
        if (after is not null && schemaRevision != schema.Revision) throw Conflict();
        var fields = schema.Page(after, WireLimits.PropertyPageSize + 1);
        var page = fields.Take(WireLimits.PropertyPageSize).ToArray();
        var next = fields.Length > page.Length ? page[^1].MachineKey : "";
        return new(schema.Revision, next, page.Select(d => new PropertyFilterField(d.Id, d.Revision, d.MachineKey,
            d.Names.FirstOrDefault(n => n.Locale == "zh")?.Label ?? d.Names[0].Label, FieldKind(d.Settings.Kind),
            d.Status == PropertyStatus.Active && d.Settings.Filterable, d.Status != PropertyStatus.Active,
            d.Settings.Options.Where(o => o.Status == PropertyStatus.Active).Select(o => new PropertyFieldOption(o.Id, o.Label)).ToArray())).ToArray());
    }

    internal async Task<PropertyCommandReceipt> SetFilterable(PropertyFilterabilityCommand input, CancellationToken ct)
    {
        await ScopeLock(ct);
        var schema = await ReadSchema(ct);
        if (schema.Find(input.DefinitionId) is null) throw Missing();
        return await ApplyChange(schema, new(actor.Id, input.RequestId, input.SchemaRevision, input.DefinitionRevision,
            new PropertyChange.SetFilterable(input.DefinitionId, input.Enabled)), ct);
    }

    internal async Task<PropertyArticlePage> Filter(PropertyArticleQueryGroup input, string session, CancellationToken ct)
    {
        await ScopeLock(ct);
        var schema = await ReadSchema(ct);
        var conditions = Resolve(schema, input);
        await ValidateQueryReferences(conditions, ct);
        return await Filter(conditions, schema.Revision, session, input.Cursor, ct);
    }

    internal async Task<byte[]> CaptureSavedView(PropertyArticleQueryGroup input, CancellationToken ct)
    {
        await ScopeLock(ct);
        var schema = await ReadSchema(ct);
        var conditions = Resolve(schema, input);
        await ValidateQueryReferences(conditions, ct);
        var references = conditions.SelectMany(item => ReferenceIds(item.Value)).ToHashSet();
        return Wire.EncodeSavedViewDefinition(conditions.Select(item => new SavedViewCondition(item.DefinitionId, item.Kind,
            item.Comparison, item.Value is null ? new PropertyFieldValue.Missing() : VisibleValue(item.Value, references))).ToArray());
    }

    internal async Task<PropertyArticlePage> OpenSavedView(SavedViewCondition[] saved, string session, SavedViewExecute request, CancellationToken ct)
    {
        await ScopeLock(ct);
        var schema = await ReadSchema(ct);
        var conditions = saved.Select(item =>
        {
            var definition = schema.Find(item.DefinitionId) ?? throw SavedViewDependency();
            if (FieldKind(definition.Settings.Kind) != item.Kind) throw SavedViewDependency();
            return Normalize(definition, new(item.DefinitionId, definition.Revision, item.Comparison, item.Value));
        }).ToArray();
        await ValidateQueryReferences(conditions, ct);
        return await Filter(conditions, schema.Revision, $"saved:{request.Id:D}:{request.Revision}:{session}", request.Cursor, ct);
    }

    internal static BusinessException SavedViewDependency() => new(Rejection.Conflict, "A saved view dependency is unavailable. Update its conditions.");

    private async Task ValidateQueryReferences(Condition[] conditions, CancellationToken ct)
    {
        var referenceIds = conditions.SelectMany(item => ReferenceIds(item.Value)).Distinct().ToArray();
        if (referenceIds.Length != 0 && !(await ReadReferences(referenceIds, ct)).SetEquals(referenceIds)) throw Missing();
    }

    private static Condition[] Resolve(PropertySchema schema, PropertyArticleQueryGroup input)
    {
        if (schema.Revision != input.SchemaRevision) throw Conflict();
        return input.Conditions.OrderBy(item => item.DefinitionId).ThenBy(item => item.Comparison)
            .Select(item => Normalize(schema.Find(item.DefinitionId) ?? throw Missing(), item)).ToArray();
    }

    private async Task<PropertyArticlePage> Filter(Condition[] conditions, long schema, string session, string cursor, CancellationToken ct)
    {
        var binding = CursorBinding(session, schema, conditions);
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
        var parameters = new List<object> { actor.Id, before, WireLimits.PropertyPageSize + 1 };
        sql.Append(before != 0 ? " and a.id<$2" : " and a.id>$2");
        foreach (var condition in conditions) AppendCondition(sql, parameters, condition);
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

    private sealed record Condition(Guid DefinitionId, long DefinitionRevision, PropertyFieldKind Kind, PropertyComparison Comparison, PropertyValue? Value);

    private static byte[] CursorBinding(string session, long revision, Condition[] conditions)
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
            writer.Write((int)condition.Comparison);
            writer.Write(condition.Value is null ? "" : (string)Json(condition.Value).Value!);
        }
        writer.Flush();
        return SHA256.HashData(data.GetBuffer().AsSpan(0, (int)data.Length));
    }

    private static Condition Normalize(PropertyDefinition definition, PropertyCondition condition)
    {
        if (definition.Revision != condition.DefinitionRevision) throw Conflict();
        if (definition.Status != PropertyStatus.Active || !definition.Settings.Filterable) throw Missing();
        var value = DomainValue(condition.Value);
        var normalized = (condition.Comparison, definition.Settings.Kind, value) switch
        {
            (PropertyComparison.Equal, _, null) => null,
            (PropertyComparison.Equal, _, { } present) => PropertyValues.NormalizeFilter(definition, present),
            (_, PropertyKind.Number, PropertyValue.Number number) => number,
            (_, PropertyKind.Date, PropertyValue.Date date) => new PropertyValue.Date(date.Value.ToUniversalTime()),
            _ => throw Invalid(),
        };
        return new(condition.DefinitionId, condition.DefinitionRevision, FieldKind(definition.Settings.Kind), condition.Comparison, normalized);
    }

    private static void AppendCondition(StringBuilder sql, List<object> parameters, Condition condition)
    {
        parameters.Add(condition.DefinitionId);
        sql.Append(condition.Value is null ? " and not exists (" : " and exists (");
        sql.Append("select from public.property_value v where v.article_id=a.id and v.owner_id=$1 and v.definition_id=$")
            .Append(parameters.Count);
        if (condition.Value is not null)
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
            if (condition.Value is PropertyValue.ArticleReference) sql.Append("""
                 and not exists (select from unnest(v.references_ids) target(id)
                    where not exists (select from public.article r join public.article_publication p
                        on p.article_id=r.id and p.revision=r.published_revision
                        join public.article_publication_rights w
                        on w.article_id=p.article_id and w.publication_id=p.publication_id and w.revision=p.revision
                        where r.id=target.id and r.owner_id=$1 and not r.deleted))
                """);
        }
        sql.Append(')');
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
