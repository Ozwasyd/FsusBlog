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

internal sealed partial class PropertyStore(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor)
{
    private const int SchemaStorageBudget = 8 * 1024 * 1024;
    private static readonly Guid PropertyScopeLock = new("c6143d07-094d-4a49-8ca8-6e3d4fa547ce");
    // The application uses one site per database. The owner and scope are never taken from a request.
    private PropertyScope Scope => new("primary", actor.Id);
    private static readonly JsonSerializerOptions StoredJson = CreateSerializer();

    internal async Task<PropertyWorkspace> Read(PropertyWorkspaceRequest input, CancellationToken ct)
    {
        var page = await ReadEditor(input, PropertyKind.Text, ct);
        return new(page.ArticleId, page.ArticleRevision, page.SchemaRevision, page.ValueRevision, page.NextKey,
            page.Fields.Select(field => new PropertyTextField(field.DefinitionId, field.DefinitionRevision, field.MachineKey,
                field.Label, field.Deprecated, (field.Value as PropertyFieldValue.Text)?.Value)).ToArray());
    }

    internal async Task<PropertyEditorWorkspace> ReadEditor(PropertyWorkspaceRequest input, PropertyKind? kind, CancellationToken ct)
    {
        await ScopeLock(ct);
        await AssertArticle(input.ArticleId, input.ArticleRevision, ct);
        var schema = await ReadSchema(ct);
        var values = await Revision("select revision from public.property_article where article_id=$1 and owner_id=$2", ct,
            input.ArticleId, actor.Id);
        if (input.AfterKey.Length > 0 && (schema.Revision != input.SchemaRevision || values != input.ValueRevision))
            throw Conflict();
        var definitions = schema.Page(input.AfterKey.Length == 0 ? null : input.AfterKey,
            WireLimits.PropertyPageSize + 1, kind);
        var page = definitions.Take(WireLimits.PropertyPageSize).ToArray();
        var rows = new Dictionary<Guid, PropertyValue>();
        if (page.Length > 0)
        {
            await using var read = Store.Sql(db, tx, """
                select definition_id,data::text,references_ids from public.property_value
                where article_id=$1 and owner_id=$2 and definition_id=any($3)
                """, input.ArticleId, actor.Id, page.Select(definition => definition.Id).ToArray());
            await using var reader = await read.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct))
            {
                var value = Parse<PropertyValue>(reader.GetString(1));
                if (!ReferenceIds(value).SequenceEqual(reader.GetFieldValue<int[]>(2)))
                    throw new InvalidOperationException("Stored property reference projection changed.");
                rows.Add(reader.GetGuid(0), value);
            }
        }
        var references = await ReadReferences(rows.Values.SelectMany(ReferenceIds).Distinct().Order().ToArray(), ct);
        var nextKey = definitions.Length > WireLimits.PropertyPageSize ? page[^1].MachineKey : "";
        return new(input.ArticleId, input.ArticleRevision, schema.Revision, values, nextKey,
            page.Select(definition => new PropertyEditorField(definition.Id, definition.Revision, definition.MachineKey,
                definition.Names.FirstOrDefault(name => name.Locale == "zh")?.Label ?? definition.Names[0].Label,
                definition.Status == PropertyStatus.Deprecated, FieldKind(definition.Settings.Kind),
                definition.Settings.Options.Where(option => option.Status == PropertyStatus.Active)
                    .Select(option => new PropertyFieldOption(option.Id, option.Label)).ToArray(),
                VisibleValue(rows.GetValueOrDefault(definition.Id), references))).ToArray());
    }

    internal Task<PropertyCommandReceipt> Change(PropertyDefinitionCommand input, CancellationToken ct) =>
        Change(new PropertySchemaInput(input, PropertyFieldKind.Text, []), textOnly: true, ct);

    internal async Task<PropertyCommandReceipt> Change(PropertySchemaInput details, bool textOnly, CancellationToken ct)
    {
        var input = details.Command;
        await ScopeLock(ct);
        var schema = await ReadSchema(ct);
        var kind = DomainKind(details.Kind);
        var command = new PropertyCommand(actor.Id, input.RequestId, input.SchemaRevision, input.DefinitionRevision, input.Operation switch
        {
            1 => new PropertyChange.Create(input.DefinitionId, input.MachineKey, [new("zh", input.Label)],
                new(kind, new(AllowNull: !textOnly), Options: details.Options.Select((option, order) =>
                    new PropertyOption(option.Id, option.Label, order)).ToImmutableArray(),
                    Reference: kind == PropertyKind.ArticleReference ? new() : null,
                    Url: kind == PropertyKind.Url ? new() : null, Placement: PropertyPlacement.Sidebar)),
            2 => new PropertyChange.Rename(input.DefinitionId, [new("zh", input.Label)]),
            3 => new PropertyChange.Deprecate(input.DefinitionId),
            4 => new PropertyChange.Delete(input.DefinitionId),
            _ => throw Invalid(),
        });
        if (textOnly && schema.Find(input.DefinitionId) is { Settings.Kind: not PropertyKind.Text }) throw Missing();
        return await ApplyChange(schema, command, ct);
    }

    private async Task<PropertyCommandReceipt> ApplyChange(PropertySchema schema, PropertyCommand command, CancellationToken ct)
    {
        var replay = await ReadReceipt(command.RequestId, ct);
        var impact = await Revision("""
            select count(*) from public.property_value where owner_id=$1 and definition_id=$2
            """, ct, actor.Id, command.Change.DefinitionId);
        var transition = schema.Apply(command, replay, (_, _) => impact);
        var receipt = transition.Receipt;
        if (!transition.Replayed)
        {
            await using (var initialize = Store.Sql(db, tx, "insert into public.property_schema(owner_id,revision) values($1,0) on conflict do nothing", actor.Id))
                await initialize.ExecuteNonQueryAsync(ct);
            var definition = transition.Schema.Find(command.Change.DefinitionId)!;
            await using var write = Store.Sql(db, tx, """
                insert into public.property_definition(owner_id,id,machine_key,revision,digest,shape)
                values($1,$2,$3,$4,$5,$6)
                on conflict(owner_id,id) do update set revision=excluded.revision,digest=excluded.digest,shape=excluded.shape
                where property_definition.revision=$7
                """, actor.Id, definition.Id, definition.MachineKey, definition.Revision, definition.Digest,
                Json(definition), command.ExpectedDefinitionRevision);
            if (await write.ExecuteNonQueryAsync(ct) != 1) throw Conflict();
            if (!await VerifyStorageBudget(ct)) throw Invalid();

            await using var advance = Store.Sql(db, tx, "update public.property_schema set revision=$2 where owner_id=$1 and revision=$3",
                actor.Id, receipt.SchemaRevision, command.ExpectedSchemaRevision);
            if (await advance.ExecuteNonQueryAsync(ct) != 1) throw Conflict();

            await using var journal = Store.Sql(db, tx, "insert into public.property_schema_command(owner_id,request_id,receipt) values($1,$2,$3)",
                actor.Id, receipt.RequestId, Json(receipt));
            await journal.ExecuteNonQueryAsync(ct);
        }
        return new(receipt.DefinitionId, receipt.SchemaRevision, receipt.DefinitionRevision);
    }

    internal Task<PropertyCommandReceipt> WriteText(PropertyTextCommand input, CancellationToken ct) =>
        Write(new(input.ArticleId, input.ArticleRevision, input.SchemaRevision, input.ValueRevision,
            input.DefinitionId, input.DefinitionRevision, input.RequestId,
            input.Remove ? new PropertyFieldValue.Missing() : new PropertyFieldValue.Text(input.Value)),
            textOnly: true, originalFrame: Wire.EncodePropertyTextCommand(input), ct);

    internal async Task<PropertyCommandReceipt> Write(PropertyValueInput input, bool textOnly, byte[] originalFrame, CancellationToken ct)
    {
        await ScopeLock(ct);
        long articleRevision = await AssertArticle(input.ArticleId, expectedRevision: null, ct);
        var fingerprint = SHA256.HashData(originalFrame);
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
        if (textOnly && definition.Settings.Kind != PropertyKind.Text || definition.Status == PropertyStatus.Deleted) throw Missing();
        if (definition.Revision != input.DefinitionRevision) throw Conflict();
        var candidate = DomainValue(input.Value);
        if (candidate is null && definition.Settings.Presence.Required) throw Invalid();
        var referenceFacts = await ValidateReferences(input.ArticleId, ReferenceIds(candidate), ct);
        var value = candidate is null ? null : PropertyValues.Validate(definition, candidate, input.ArticleId,
            target => referenceFacts.GetValueOrDefault(checked((int)target)));

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
            if (value is not null)
            {
                await using var upsert = Store.Sql(db, tx, """
                    insert into public.property_value(article_id,owner_id,definition_id,data,references_ids) values($1,$2,$3,$4,$5)
                    on conflict(article_id,definition_id) do update set data=excluded.data,references_ids=excluded.references_ids
                    """, input.ArticleId, actor.Id, input.DefinitionId, Json(value), ReferenceIds(value));
                await upsert.ExecuteNonQueryAsync(ct);
            }
            else
            {
                await using var remove = Store.Sql(db, tx, """
                    delete from public.property_value where article_id=$1 and owner_id=$2 and definition_id=$3
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
        if (await ArchivedArticleAuthority.IsLockedArchived(db, tx, article, ct)) throw Missing();
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

    private async Task<HashSet<int>> ReadReferences(int[] ids, CancellationToken ct)
    {
        var visible = new HashSet<int>();
        if (ids.Length == 0) return visible;
        await using var command = Store.Sql(db, tx, """
            select a.id from public.article a join public.article_publication p on p.article_id=a.id and p.revision=a.published_revision
            join public.article_publication_rights w
                on w.article_id=p.article_id and w.publication_id=p.publication_id and w.revision=p.revision
            where a.id=any($1) and a.owner_id=$2 and not a.deleted order by a.id for share of a
            """, ids, actor.Id);
        await using var reader = await command.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct)) visible.Add(reader.GetInt32(0));
        return visible;
    }

    private async Task<Dictionary<int, PropertyReferenceFacts>> ValidateReferences(int article, int[] ids, CancellationToken ct)
    {
        var visible = await ReadReferences(ids, ct);
        var facts = new Dictionary<int, PropertyReferenceFacts>(visible.Count);
        foreach (var target in visible)
        {
            // ScopeLock serializes all edits to this owner's values. The bound rejects a graph
            // too large to prove acyclic, even if the traversal hasn't reached the source yet.
            await using var command = Store.Sql(db, tx, """
                with recursive reachable(id) as (
                    select $2::integer
                    union
                    select unnest(p.references_ids) from reachable r
                    join public.property_value p on p.article_id=r.id and p.owner_id=$1
                    where cardinality(p.references_ids)>0
                ), bounded as (select id from reachable limit 4001)
                select exists(select from bounded where id=$3) or (select count(*) from bounded)>4000
                """, actor.Id, target, article);
            var cycles = await command.ExecuteScalarAsync(ct) is not false;
            facts.Add(target, new(Scope.Site, true, false, false, cycles));
        }
        return facts;
    }

    private static int[] ReferenceIds(PropertyValue? value) => value is PropertyValue.ArticleReference reference
        ? reference.ArticleIds.Select(id => checked((int)id)).ToArray() : [];

    private static PropertyFieldValue VisibleValue(PropertyValue? value, HashSet<int> references) => value switch
    {
        null => new PropertyFieldValue.Missing(),
        PropertyValue.Null => new PropertyFieldValue.Null(),
        PropertyValue.Text text => new PropertyFieldValue.Text(text.Value),
        PropertyValue.Number number => new PropertyFieldValue.Number(number.Value),
        PropertyValue.Boolean flag => new PropertyFieldValue.Boolean(flag.Value),
        PropertyValue.Date date => new PropertyFieldValue.Date(date.Value),
        PropertyValue.SingleSelect single => new PropertyFieldValue.SingleSelect(single.OptionId),
        PropertyValue.MultiSelect multi => new PropertyFieldValue.MultiSelect(multi.OptionIds),
        PropertyValue.ArticleReference reference => ReferenceIds(reference) is var ids && ids.All(references.Contains)
            ? new PropertyFieldValue.ArticleReference(ids) : new PropertyFieldValue.Unavailable(),
        PropertyValue.Url url => new PropertyFieldValue.Url(url.Value),
        _ => throw new InvalidOperationException("Stored property kind is unknown."),
    };

    private static PropertyValue? DomainValue(PropertyFieldValue value) => value switch
    {
        PropertyFieldValue.Missing => null,
        PropertyFieldValue.Null => new PropertyValue.Null(),
        PropertyFieldValue.Text text => new PropertyValue.Text(text.Value),
        PropertyFieldValue.Number number => new PropertyValue.Number(number.Value),
        PropertyFieldValue.Boolean flag => new PropertyValue.Boolean(flag.Value),
        PropertyFieldValue.Date date => new PropertyValue.Date(date.Value),
        PropertyFieldValue.SingleSelect single => new PropertyValue.SingleSelect(single.Value),
        PropertyFieldValue.MultiSelect multi => new PropertyValue.MultiSelect(multi.Value.ToImmutableArray()),
        PropertyFieldValue.ArticleReference reference => new PropertyValue.ArticleReference(reference.Value.Select(id => (long)id).ToImmutableArray()),
        PropertyFieldValue.Url url => new PropertyValue.Url(url.Value),
        _ => throw Invalid(),
    };

    private static PropertyFieldKind FieldKind(PropertyKind kind) => kind switch
    {
        PropertyKind.Text => PropertyFieldKind.Text, PropertyKind.Number => PropertyFieldKind.Number,
        PropertyKind.Boolean => PropertyFieldKind.Boolean, PropertyKind.Date => PropertyFieldKind.Date,
        PropertyKind.SingleSelect => PropertyFieldKind.SingleSelect, PropertyKind.MultiSelect => PropertyFieldKind.MultiSelect,
        PropertyKind.ArticleReference => PropertyFieldKind.ArticleReference, PropertyKind.Url => PropertyFieldKind.Url,
        _ => throw new InvalidOperationException("Stored property kind is unknown."),
    };

    private static PropertyKind DomainKind(PropertyFieldKind kind) => kind switch
    {
        PropertyFieldKind.Text => PropertyKind.Text, PropertyFieldKind.Number => PropertyKind.Number,
        PropertyFieldKind.Boolean => PropertyKind.Boolean, PropertyFieldKind.Date => PropertyKind.Date,
        PropertyFieldKind.SingleSelect => PropertyKind.SingleSelect, PropertyFieldKind.MultiSelect => PropertyKind.MultiSelect,
        PropertyFieldKind.ArticleReference => PropertyKind.ArticleReference, PropertyFieldKind.Url => PropertyKind.Url,
        _ => throw Invalid(),
    };

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

    private static string PropertyTypeTag(PropertyFieldKind kind) => kind switch
    {
        PropertyFieldKind.Text => "text",
        PropertyFieldKind.Number => "number",
        PropertyFieldKind.Boolean => "boolean",
        PropertyFieldKind.Date => "date",
        PropertyFieldKind.SingleSelect => "single-select",
        PropertyFieldKind.MultiSelect => "multi-select",
        PropertyFieldKind.ArticleReference => "article-reference",
        PropertyFieldKind.Url => "url",
        _ => throw Invalid(),
    };

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
                    new(typeof(PropertyValue.Null), "null"),
                    new(typeof(PropertyValue.Text), PropertyTypeTag(PropertyFieldKind.Text)),
                    new(typeof(PropertyValue.Number), PropertyTypeTag(PropertyFieldKind.Number)),
                    new(typeof(PropertyValue.Boolean), PropertyTypeTag(PropertyFieldKind.Boolean)),
                    new(typeof(PropertyValue.Date), PropertyTypeTag(PropertyFieldKind.Date)),
                    new(typeof(PropertyValue.SingleSelect), PropertyTypeTag(PropertyFieldKind.SingleSelect)),
                    new(typeof(PropertyValue.MultiSelect), PropertyTypeTag(PropertyFieldKind.MultiSelect)),
                    new(typeof(PropertyValue.ArticleReference), PropertyTypeTag(PropertyFieldKind.ArticleReference)),
                    new(typeof(PropertyValue.Url), PropertyTypeTag(PropertyFieldKind.Url)),
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
