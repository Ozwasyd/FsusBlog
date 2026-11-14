using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Core.Authoring;
using Npgsql;
using NpgsqlTypes;

namespace FsusBlog.V2.Server.Authoring;

internal sealed class PropertyStore(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor)
{
    private const int SchemaStorageBudget = 8 * 1024 * 1024;
    private static readonly Guid PropertyScopeLock = new("c6143d07-094d-4a49-8ca8-6e3d4fa547ce");
    // The application uses one site per database. The owner and scope are never taken from a request.
    private PropertyScope Scope => new("primary", actor.Id);
    private static readonly JsonSerializerOptions StoredJson = CreateSerializer();

    internal async Task<PropertyWorkspace> Read(PropertyWorkspaceRequest input, CancellationToken ct)
    {
        await ScopeLock(ct);
        await AssertArticle(input.ArticleId, input.ArticleRevision, ct);
        var schema = await ReadSchema(ct);
        var values = await Revision("select revision from public.property_article where article_id=$1 and owner_id=$2", ct,
            input.ArticleId, actor.Id);
        if (input.AfterKey.Length > 0 && (schema.Revision != input.SchemaRevision || values != input.ValueRevision))
            throw Conflict();
        var definitions = schema.Page(input.AfterKey.Length == 0 ? null : input.AfterKey,
            WireLimits.PropertyPageSize + 1, PropertyKind.Text);
        var page = definitions.Take(WireLimits.PropertyPageSize).ToArray();
        var rows = new Dictionary<Guid, string>();
        if (page.Length > 0)
        {
            await using var read = Store.Sql(db, tx, """
                select definition_id,value from public.property_text_value
                where article_id=$1 and owner_id=$2 and definition_id=any($3)
                """, input.ArticleId, actor.Id, page.Select(definition => definition.Id).ToArray());
            await using var reader = await read.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct)) rows.Add(reader.GetGuid(0), reader.GetString(1));
        }
        var nextKey = definitions.Length > WireLimits.PropertyPageSize ? page[^1].MachineKey : "";
        return new(input.ArticleId, input.ArticleRevision, schema.Revision, values, nextKey,
            page.Select(definition => new PropertyTextField(definition.Id, definition.Revision, definition.MachineKey,
                definition.Names.FirstOrDefault(name => name.Locale == "zh")?.Label ?? definition.Names[0].Label,
                definition.Status == PropertyStatus.Deprecated, rows.GetValueOrDefault(definition.Id))).ToArray());
    }

    internal async Task<PropertyCommandReceipt> Change(PropertyDefinitionCommand input, CancellationToken ct)
    {
        await ScopeLock(ct);
        await using (var initialize = Store.Sql(db, tx, "insert into public.property_schema(owner_id,revision) values($1,0) on conflict do nothing", actor.Id))
            await initialize.ExecuteNonQueryAsync(ct);
        var schema = await ReadSchema(ct);
        var replay = await ReadReceipt(input.RequestId, ct);
        var impact = await Revision("""
            select count(*) from public.property_text_value where owner_id=$1 and definition_id=$2
            """, ct, actor.Id, input.DefinitionId);
        var command = new PropertyCommand(actor.Id, input.RequestId, input.SchemaRevision, input.DefinitionRevision, input.Operation switch
        {
            1 => new PropertyChange.Create(input.DefinitionId, input.MachineKey, [new("zh", input.Label)],
                new(PropertyKind.Text, new(AllowNull: false), Placement: PropertyPlacement.Sidebar)),
            2 => new PropertyChange.Rename(input.DefinitionId, [new("zh", input.Label)]),
            3 => new PropertyChange.Deprecate(input.DefinitionId),
            4 => new PropertyChange.Delete(input.DefinitionId),
            _ => throw Invalid(),
        });
        if (schema.Find(input.DefinitionId) is { Settings.Kind: not PropertyKind.Text }) throw Missing();
        var transition = schema.Apply(command, replay, (_, _) => impact);
        var receipt = transition.Receipt;
        if (!transition.Replayed)
        {
            var definition = transition.Schema.Find(input.DefinitionId)!;
            await using var write = Store.Sql(db, tx, """
                insert into public.property_definition(owner_id,id,machine_key,revision,digest,shape)
                values($1,$2,$3,$4,$5,$6)
                on conflict(owner_id,id) do update set revision=excluded.revision,digest=excluded.digest,shape=excluded.shape
                where property_definition.revision=$7
                """, actor.Id, definition.Id, definition.MachineKey, definition.Revision, definition.Digest,
                Json(definition), input.DefinitionRevision);
            if (await write.ExecuteNonQueryAsync(ct) != 1) throw Conflict();
            if (!await VerifyStorageBudget(ct)) throw Invalid();

            await using var advance = Store.Sql(db, tx, "update public.property_schema set revision=$2 where owner_id=$1 and revision=$3",
                actor.Id, receipt.SchemaRevision, input.SchemaRevision);
            if (await advance.ExecuteNonQueryAsync(ct) != 1) throw Conflict();

            await using var journal = Store.Sql(db, tx, "insert into public.property_schema_command(owner_id,request_id,receipt) values($1,$2,$3)",
                actor.Id, receipt.RequestId, Json(receipt));
            await journal.ExecuteNonQueryAsync(ct);
        }
        return new(receipt.DefinitionId, receipt.SchemaRevision, receipt.DefinitionRevision);
    }

    internal async Task<PropertyCommandReceipt> WriteText(PropertyTextCommand input, CancellationToken ct)
    {
        await ScopeLock(ct);
        long articleRevision = await AssertArticle(input.ArticleId, expectedRevision: null, ct);
        var fingerprint = SHA256.HashData(Wire.EncodePropertyTextCommand(input));
        await using (var replay = Store.Sql(db, tx, """
            select fingerprint,definition_id,revision from public.property_value_command where article_id=$1 and request_id=$2
            """, input.ArticleId, input.RequestId))
        await using (var reader = await replay.ExecuteReaderAsync(ct))
        {
            if (await reader.ReadAsync(ct))
            {
                if (!CryptographicOperations.FixedTimeEquals(fingerprint, reader.GetFieldValue<byte[]>(0))) throw Conflict();
                return new(reader.GetGuid(1), input.SchemaRevision, reader.GetInt64(2));
            }
        }

        if (input.ArticleRevision != articleRevision) throw Conflict();
        var schema = await ReadSchema(ct);
        if (schema.Revision != input.SchemaRevision) throw Conflict();
        var definition = schema.Find(input.DefinitionId) ?? throw Missing();
        if (definition.Settings.Kind != PropertyKind.Text || definition.Status == PropertyStatus.Deleted) throw Missing();
        if (definition.Revision != input.DefinitionRevision) throw Conflict();
        var value = input.Remove ? null : PropertyValues.Validate(definition, new PropertyValue.Text(input.Value), input.ArticleId);
        if (input.Remove && definition.Settings.Presence.Required) throw Invalid();

        await using (var advance = Store.Sql(db, tx, """
            insert into public.property_article(article_id,owner_id,revision)
            select $1,$2,1 where $3=0 or exists (
                select 1 from public.property_article where article_id=$1 and owner_id=$2 and revision=$3
            )
            on conflict(article_id) do update set revision=property_article.revision+1
            where property_article.owner_id=$2 and property_article.revision=$3 returning revision
            """, input.ArticleId, actor.Id, input.ValueRevision))
        {
            if (await advance.ExecuteScalarAsync(ct) is not long next) throw Conflict();
            if (value is PropertyValue.Text text)
            {
                await using var upsert = Store.Sql(db, tx, """
                    insert into public.property_text_value(article_id,owner_id,definition_id,value) values($1,$2,$3,$4)
                    on conflict(article_id,definition_id) do update set value=excluded.value
                    """, input.ArticleId, actor.Id, input.DefinitionId, text.Value);
                await upsert.ExecuteNonQueryAsync(ct);
            }
            else
            {
                await using var remove = Store.Sql(db, tx, """
                    delete from public.property_text_value where article_id=$1 and owner_id=$2 and definition_id=$3
                    """, input.ArticleId, actor.Id, input.DefinitionId);
                await remove.ExecuteNonQueryAsync(ct);
            }

            await using var record = Store.Sql(db, tx, """
                insert into public.property_value_command(article_id,request_id,fingerprint,definition_id,revision)
                values($1,$2,$3,$4,$5)
                """, input.ArticleId, input.RequestId, fingerprint, input.DefinitionId, next);
            await record.ExecuteNonQueryAsync(ct);
            return new(input.DefinitionId, input.SchemaRevision, next);
        }
    }

    private Task ScopeLock(CancellationToken ct) =>
        Store.LockCommand(db, tx, actor.Id, PropertyScopeLock, ct);

    private async Task<long> AssertArticle(int article, long? expectedRevision, CancellationToken ct)
    {
        await using var command = Store.Sql(db, tx,
            "select revision from public.article where id=$1 and owner_id=$2 and not deleted for share", article, actor.Id);
        if (await command.ExecuteScalarAsync(ct) is not long revision) throw Missing();
        if (expectedRevision.HasValue && revision != expectedRevision.Value) throw Conflict();
        return revision;
    }

    private async Task<PropertySchema> ReadSchema(CancellationToken ct)
    {
        var revision = await Revision("select revision from public.property_schema where owner_id=$1", ct, actor.Id);
        if (!await VerifyStorageBudget(ct)) throw new InvalidOperationException("Stored property schema exceeds its byte budget.");
        await using var command = Store.Sql(db, tx,
            "select id,machine_key,revision,digest,shape::text from public.property_definition where owner_id=$1 limit 4001", actor.Id);
        await using var reader = await command.ExecuteReaderAsync(ct);
        var definitions = ImmutableArray.CreateBuilder<PropertyDefinition>();
        while (await reader.ReadAsync(ct))
        {
            var definition = Parse<PropertyDefinition>(reader.GetString(4));
            if (definition.Id != reader.GetGuid(0) || definition.MachineKey != reader.GetString(1) ||
                definition.Revision != reader.GetInt64(2) || definition.Digest != reader.GetString(3))
                throw new InvalidOperationException("Stored property definition does not match its digest or coordinates.");
            definitions.Add(definition);
        }
        return PropertySchema.Restore(Scope, revision, definitions);
    }

    private async Task<bool> VerifyStorageBudget(CancellationToken ct) =>
        await Revision("select coalesce(sum(octet_length(shape::text)),0) from public.property_definition where owner_id=$1",
            ct, actor.Id) <= SchemaStorageBudget;

    private async Task<PropertyReceipt?> ReadReceipt(Guid requestId, CancellationToken ct)
    {
        await using var command = Store.Sql(db, tx, """
            select receipt::text from public.property_schema_command where owner_id=$1 and request_id=$2
            """, actor.Id, requestId);
        return await command.ExecuteScalarAsync(ct) is string json ? Parse<PropertyReceipt>(json) : null;
    }

    private async Task<long> Revision(string sql, CancellationToken ct, params object[] parameters)
    {
        await using var command = Store.Sql(db, tx, sql, parameters);
        return (await command.ExecuteScalarAsync(ct) as long?) ?? 0;
    }

    private static NpgsqlParameter Json<T>(T value) => new() { NpgsqlDbType = NpgsqlDbType.Jsonb, Value = JsonSerializer.Serialize(value, StoredJson) };
    private static T Parse<T>(string value) => JsonSerializer.Deserialize<T>(value, StoredJson)
        ?? throw new InvalidOperationException("Stored property data is missing.");
    private static BusinessException Missing() => new(Rejection.NotFound, "Article property is unavailable.");
    private static BusinessException Conflict() => new(Rejection.Conflict, "The article properties changed. Reload before editing.");
    private static BusinessException Invalid() => new(Rejection.Invalid, "Invalid article property.");

    private static JsonSerializerOptions CreateSerializer()
    {
        var resolver = new System.Text.Json.Serialization.Metadata.DefaultJsonTypeInfoResolver();
        resolver.Modifiers.Add(info =>
        {
            if (info.Type != typeof(PropertyValue)) return;
            info.PolymorphismOptions = new()
            {
                DerivedTypes =
                {
                    new(typeof(PropertyValue.Null), "null"), new(typeof(PropertyValue.Text), "text"),
                    new(typeof(PropertyValue.Number), "number"), new(typeof(PropertyValue.Boolean), "boolean"),
                    new(typeof(PropertyValue.Date), "date"), new(typeof(PropertyValue.SingleSelect), "single-select"),
                    new(typeof(PropertyValue.MultiSelect), "multi-select"),
                    new(typeof(PropertyValue.ArticleReference), "article-reference"), new(typeof(PropertyValue.Url), "url"),
                },
            };
        });
        return new()
        {
            TypeInfoResolver = resolver,
            UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
            AllowOutOfOrderMetadataProperties = true,
            IgnoreReadOnlyProperties = true,
        };
    }
}
