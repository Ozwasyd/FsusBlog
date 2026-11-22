using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Core.Authoring;
using NpgsqlTypes;

namespace FsusBlog.V2.Server.Authoring;

internal sealed record AuthorTextPropertyScope(long SchemaRevision, PropertyDefinition Definition);

internal static class AuthorTextPropertyIndex
{
    // The saved text is bounded at 16,384 UTF-16 units; allow JSON escape expansion.
    internal const int MaxStoredTextBytes = 128 * 1024;

    internal static string Changes(string eligibleArticles, int definitionParameter, int definitionRevisionParameter) => $$"""
        property_text_source as materialized (
            select v.article_id,v.definition_id,${{definitionRevisionParameter}}::bigint as definition_revision,
                a.revision as value_revision
            from public.property_value v
            join public.property_article a on a.article_id=v.article_id and a.owner_id=v.owner_id
            join {{eligibleArticles}} e on e.id=v.article_id
            where v.owner_id=$1 and v.definition_id=${{definitionParameter}}
        ),
        property_text_changed as (
            select coalesce(s.article_id,d.article_id) as article_id,s.definition_revision,s.value_revision
            from property_text_source s
            full join (
                select article_id,definition_revision,value_revision from public.author_text_property_document
                where owner_id=$1 and definition_id=${{definitionParameter}}
            ) d on d.article_id=s.article_id
            where s.value_revision is distinct from d.value_revision or s.definition_revision is distinct from d.definition_revision
        )
        """;

    internal static string Witness(int definitionParameter, int definitionRevisionParameter) => $$"""
        select pg_catalog.sha256(pg_catalog.convert_to('fsusblog-author-text-property.v1','UTF8') ||
            pg_catalog.uuid_send($1::uuid) || pg_catalog.uuid_send(${{definitionParameter}}::uuid) ||
            pg_catalog.int8send(${{definitionRevisionParameter}}::bigint) ||
            pg_catalog.int8send(coalesce((select revision from public.property_schema where owner_id=$1),0)) ||
            coalesce(string_agg(pg_catalog.int4send(s.article_id) || pg_catalog.int8send(s.value_revision) ||
                d.source_digest, ''::bytea order by s.article_id), ''::bytea))
        from property_text_source s
        join public.author_text_property_document d on d.owner_id=$1 and d.definition_id=s.definition_id
            and d.article_id=s.article_id and d.definition_revision=s.definition_revision and d.value_revision=s.value_revision
        """;
}

internal sealed partial class PropertyStore
{
    private const int TextProjectionBatch = 8;
    private static readonly UTF8Encoding PropertyTextUtf8 = new(false, true);

    internal async Task<AuthorTextPropertyScope> ResolveTextProjection(long schemaRevision, Guid definitionId, long definitionRevision,
        CancellationToken ct)
    {
        await ScopeLock(ct);
        var schema = await ReadSchema(ct);
        return ResolveTextProjection(schema, schemaRevision, definitionId, definitionRevision);
    }

    private static AuthorTextPropertyScope ResolveTextProjection(PropertySchema schema, long schemaRevision,
        Guid definitionId, long definitionRevision)
    {
        if (schema.Find(definitionId) is not { Status: PropertyStatus.Active, Settings: { Kind: PropertyKind.Text, SearchEligible: true } } definition)
            throw Missing();
        if (schema.Revision != schemaRevision || definition.Revision != definitionRevision) throw Conflict();
        return new(schema.Revision, definition);
    }

    internal async Task ReconcileTextProjection(AuthorTextPropertyScope scope, CancellationToken ct)
    {
        if (scope.Definition.Scope != Scope) throw Missing();
        var pending = new List<PropertyTextChange>(TextProjectionBatch);
        await using (var command = SqlCommands.Create(db, tx, $$"""
            with eligible as (
                select a.id from public.article a where a.owner_id=$1 and not a.deleted and {{ArchivedArticleAuthority.Available}}
            ),
            {{AuthorTextPropertyIndex.Changes("eligible", 2, 3)}},
            picked as (select * from property_text_changed order by article_id limit $4)
            select p.article_id,p.value_revision,
                case when octet_length(v.data::text)<={{AuthorTextPropertyIndex.MaxStoredTextBytes}} then v.data::text end
            from picked p left join public.property_value v
                on p.value_revision is not null and v.owner_id=$1 and v.definition_id=$2 and v.article_id=p.article_id
            order by p.article_id
            """, ownerId, scope.Definition.Id, scope.Definition.Revision, TextProjectionBatch))
        {
            command.CommandTimeout = 3;
            await using var rows = await command.ExecuteReaderAsync(ct);
            while (await rows.ReadAsync(ct))
            {
                var article = rows.GetInt32(0);
                if (rows.IsDBNull(1)) pending.Add(new(article, null, null));
                else
                {
                    if (rows.IsDBNull(2)) throw PropertyTextConflict();
                    pending.Add(new(article, rows.GetInt64(1), ReadTextSource(scope, article, rows.GetString(2))));
                }
            }
        }

        foreach (var entry in pending)
        {
            ct.ThrowIfCancellationRequested();
            await SqlCommands.Execute(db, tx, ct, """
                delete from public.author_text_property_posting where owner_id=$1 and definition_id=$2 and article_id=$3
                """, ownerId, scope.Definition.Id, entry.ArticleId);
            if (entry.ValueRevision is not long valueRevision)
            {
                await SqlCommands.Execute(db, tx, ct, """
                    delete from public.author_text_property_document where owner_id=$1 and definition_id=$2 and article_id=$3
                    """, ownerId, scope.Definition.Id, entry.ArticleId);
                continue;
            }

            var text = entry.Text ?? "";
            await SqlCommands.Execute(db, tx, ct, """
                insert into public.author_text_property_document(owner_id,definition_id,article_id,definition_revision,value_revision,source_digest)
                values ($1,$2,$3,$4,$5,$6)
                on conflict (owner_id,definition_id,article_id) do update
                    set definition_revision=excluded.definition_revision,value_revision=excluded.value_revision,source_digest=excluded.source_digest
                """, ownerId, scope.Definition.Id, entry.ArticleId, scope.Definition.Revision, valueRevision,
                SHA256.HashData(PropertyTextUtf8.GetBytes(text)));
            if (text.Length == 0) continue;

            await using var copy = await db.BeginBinaryImportAsync("""
                copy public.author_text_property_posting(owner_id,definition_id,article_id,ordinal,term,start_u16,end_u16,start_u8,end_u8)
                from stdin (format binary)
                """, ct);
            foreach (var token in AuthorTextProfile.Tokenize(text, ct))
            {
                if (PropertyTextUtf8.GetByteCount(token.Value) > AuthorTextProfile.MaxTermBytes) continue;
                await copy.StartRowAsync(ct);
                await copy.WriteAsync(ownerId, NpgsqlDbType.Uuid, ct);
                await copy.WriteAsync(scope.Definition.Id, NpgsqlDbType.Uuid, ct);
                await copy.WriteAsync(entry.ArticleId, NpgsqlDbType.Integer, ct);
                await copy.WriteAsync(token.Ordinal, NpgsqlDbType.Integer, ct);
                await copy.WriteAsync(PropertyTextUtf8.GetBytes(token.Value), NpgsqlDbType.Bytea, ct);
                await copy.WriteAsync(token.Start, NpgsqlDbType.Integer, ct);
                await copy.WriteAsync(token.End, NpgsqlDbType.Integer, ct);
                await copy.WriteAsync(token.ByteStart, NpgsqlDbType.Integer, ct);
                await copy.WriteAsync(token.ByteEnd, NpgsqlDbType.Integer, ct);
            }
            await copy.CompleteAsync(ct);
        }
    }

    internal static string? ReadTextSource(AuthorTextPropertyScope scope, int article, string json)
    {
        try
        {
            if (PropertyTextUtf8.GetByteCount(json) > AuthorTextPropertyIndex.MaxStoredTextBytes) throw PropertyTextConflict();
            var stored = Parse<PropertyValue>(json);
            if (stored is not (PropertyValue.Text or PropertyValue.Null) ||
                !Equals(stored, PropertyValues.Validate(scope.Definition, stored, article)))
                throw PropertyTextConflict();
            return (stored as PropertyValue.Text)?.Value;
        }
        catch (Exception error) when (error is PropertyValidationException or EncoderFallbackException or JsonException)
        {
            throw PropertyTextConflict();
        }
    }

    private static BusinessException PropertyTextConflict() => new(Rejection.Conflict, "The private article property index could not verify the saved text.");
    private sealed record PropertyTextChange(int ArticleId, long? ValueRevision, string? Text);
}
