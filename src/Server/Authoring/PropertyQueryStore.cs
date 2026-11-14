using System.Buffers.Binary;
using System.Security.Cryptography;
using FsusBlog.V2.Contracts;
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

    internal async Task<PropertyArticlePage> Filter(PropertyArticleQuery input, string session, CancellationToken ct)
    {
        await ScopeLock(ct);
        var schema = await ReadSchema(ct);
        if (schema.Revision != input.SchemaRevision) throw Conflict();
        var definition = schema.Find(input.DefinitionId) ?? throw Missing();
        if (definition.Revision != input.DefinitionRevision) throw Conflict();
        if (definition.Status != PropertyStatus.Active || !definition.Settings.Filterable) throw Missing();
        var normalized = DomainValue(input.Value) is { } value ? PropertyValues.NormalizeFilter(definition, value) : null;
        var referenceIds = ReferenceIds(normalized);
        if (referenceIds.Length != 0 && !(await ReadReferences(referenceIds, ct)).SetEquals(referenceIds)) throw Missing();

        var canonical = normalized is null ? "" : Json(normalized).Value!.ToString()!;
        var binding = SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(
            FormattableString.Invariant($"{session}:{input.DefinitionId:D}:{input.SchemaRevision}:{input.DefinitionRevision}:{canonical}")));
        var before = 0;
        if (input.Cursor.Length != 0)
        {
            var bytes = WebEncoders.Base64UrlDecode(input.Cursor);
            before = BinaryPrimitives.ReadInt32LittleEndian(bytes);
            if (before <= 0 || !CryptographicOperations.FixedTimeEquals(
                    System.Text.Encoding.ASCII.GetBytes(Cursor(binding, before)),
                    System.Text.Encoding.ASCII.GetBytes(input.Cursor))) throw Invalid();
        }
        var json = new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.Jsonb, Value = normalized is null ? DBNull.Value : canonical };
        await using var query = Store.Sql(db, tx, """
            select a.id,a.revision,a.title from public.article a
            left join public.property_value v on v.article_id=a.id and v.owner_id=$1 and v.definition_id=$2
            where a.owner_id=$1 and not a.deleted and ($3=0 or a.id<$3)
                and (case when $4::jsonb is null then v.article_id is null else v.data=$4 end)
                and not exists (
                    select from unnest(v.references_ids) target(id)
                    where not exists (select from public.article r join public.article_publication p
                        on p.article_id=r.id and p.revision=r.published_revision
                        join public.article_publication_rights w
                        on w.article_id=p.article_id and w.publication_id=p.publication_id and w.revision=p.revision
                        where r.id=target.id and r.owner_id=$1 and not r.deleted)
                )
            order by a.id desc limit $5
            """, actor.Id, definition.Id, before, json, WireLimits.PropertyPageSize + 1);
        var matches = new List<PropertyArticleRow>(WireLimits.PropertyPageSize + 1);
        await using var reader = await query.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
            matches.Add(new(reader.GetInt32(0), reader.GetInt64(1), reader.GetString(2)));
        var more = matches.Count > WireLimits.PropertyPageSize;
        if (more) matches.RemoveAt(matches.Count - 1);
        return new(more ? Cursor(binding, matches[^1].Id) : "", matches);
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
