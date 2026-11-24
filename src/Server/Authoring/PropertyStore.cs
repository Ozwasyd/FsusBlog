using System.Collections.Immutable;
using static FsusBlog.V2.Server.SqlCommands;

namespace FsusBlog.V2.Server.Authoring;

internal sealed partial class PropertyStore(NpgsqlConnection db, NpgsqlTransaction tx, Guid ownerId)
{
    internal PropertyStore(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor) : this(db, tx, actor.Id) { }

    private static readonly Guid PropertyScopeLock = new("c6143d07-094d-4a49-8ca8-6e3d4fa547ce");
    // The application uses one site per database. The owner and scope are never taken from a request.
    private PropertyScope Scope => new("primary", ownerId);
    private sealed record FieldType(PropertyKind Domain, PropertyFieldKind Field, Type Value, string Tag);

    private static readonly FieldType[] Types =
    [
        new(PropertyKind.Text, PropertyFieldKind.Text, typeof(PropertyValue.Text), "text"),
        new(PropertyKind.Number, PropertyFieldKind.Number, typeof(PropertyValue.Number), "number"),
        new(PropertyKind.Boolean, PropertyFieldKind.Boolean, typeof(PropertyValue.Boolean), "boolean"),
        new(PropertyKind.Date, PropertyFieldKind.Date, typeof(PropertyValue.Date), "date"),
        new(PropertyKind.SingleSelect, PropertyFieldKind.SingleSelect, typeof(PropertyValue.SingleSelect), "single-select"),
        new(PropertyKind.MultiSelect, PropertyFieldKind.MultiSelect, typeof(PropertyValue.MultiSelect), "multi-select"),
        new(PropertyKind.ArticleReference, PropertyFieldKind.ArticleReference, typeof(PropertyValue.ArticleReference), "article-reference"),
        new(PropertyKind.Url, PropertyFieldKind.Url, typeof(PropertyValue.Url), "url"),
    ];
    private static readonly FrozenDictionary<PropertyFieldKind, FieldType> ByField = Types.ToFrozenDictionary(type => type.Field);
    private static readonly FrozenDictionary<PropertyKind, FieldType> ByDomain = Types.ToFrozenDictionary(type => type.Domain);
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
            input.ArticleId, ownerId);
        if (input.AfterKey.Length > 0 && (schema.Revision != input.SchemaRevision || values != input.ValueRevision))
            throw Conflict();
        var definitions = schema.Page(input.AfterKey.Length == 0 ? null : input.AfterKey,
            WireLimits.PropertyPageSize + 1, kind);
        var page = definitions.Take(WireLimits.PropertyPageSize).ToArray();
        var rows = new Dictionary<Guid, PropertyValue>();
        if (page.Length > 0)
            await ReadAll(db, tx, ct, """
                select definition_id,data::text,references_ids from public.property_value
                where article_id=$1 and owner_id=$2 and definition_id=any($3)
                """, reader =>
            {
                var value = Parse<PropertyValue>(reader.GetString(1));
                if (!ReferenceIds(value).SequenceEqual(reader.GetFieldValue<int[]>(2)))
                    throw new InvalidOperationException("Stored property reference projection changed.");
                rows.Add(reader.GetGuid(0), value);
            }, input.ArticleId, ownerId, page.Select(definition => definition.Id).ToArray());
        var references = await ReadReferences(rows.Values.SelectMany(ReferenceIds).Distinct().Order().ToArray(), ct);
        var nextKey = definitions.Length > WireLimits.PropertyPageSize ? page[^1].MachineKey : "";
        return new(input.ArticleId, input.ArticleRevision, schema.Revision, values, nextKey,
            page.Select(definition => EditorField(definition, VisibleValue(rows.GetValueOrDefault(definition.Id), references))).ToArray());
    }

    internal async Task<PropertyEditorWorkspace> ReadTextHit(PropertyTextHitRequest input, CancellationToken ct)
    {
        if (!await CurrentSchema.HasAuthorTextPropertyIndexAsync(db, tx, ct))
            throw new BusinessException(Rejection.NotFound, "Install or upgrade the private article index with author-search.");
        var projection = await ResolveTextProjection(input.SchemaRevision, input.DefinitionId, input.DefinitionRevision, ct);
        var articleRevision = await AssertArticle(input.ArticleId, input.ArticleRevision, ct);
        await using var command = SqlCommands.Create(db, tx, $$"""
            select a.revision,case when octet_length(v.data::text)<={{AuthorTextPropertyIndex.MaxStoredTextBytes}} then v.data::text end
            from public.property_article a
            join public.property_value v on v.article_id=a.article_id and v.owner_id=a.owner_id and v.definition_id=$3
            join public.author_text_property_document d on d.owner_id=v.owner_id and d.article_id=v.article_id
                and d.definition_id=v.definition_id and d.definition_revision=$4 and d.value_revision=a.revision
            where a.owner_id=$1 and a.article_id=$2 and a.revision>0 and ($5=0 or a.revision=$5) and d.source_digest=$6
            """, ownerId, input.ArticleId, projection.Definition.Id, projection.Definition.Revision, input.ValueRevision, input.SourceDigest);
        command.CommandTimeout = 3;
        await using var row = await command.ExecuteReaderAsync(ct);
        if (!await row.ReadAsync(ct) || row.IsDBNull(1) ||
            ReadTextSource(projection, input.ArticleId, row.GetString(1)) is not { } text ||
            !CryptographicOperations.FixedTimeEquals(SHA256.HashData(PropertyTextUtf8.GetBytes(text)), input.SourceDigest))
            throw PropertyTextConflict();
        return new(input.ArticleId, articleRevision, projection.SchemaRevision, row.GetInt64(0), "",
            [EditorField(projection.Definition, new PropertyFieldValue.Text(text))]);
    }

    private static string EditorLabel(PropertyDefinition definition) =>
        definition.Names.FirstOrDefault(name => name.Locale == "zh")?.Label ?? definition.Names[0].Label;

    private static PropertyFieldOption[] EditorOptions(PropertyDefinition definition) =>
        definition.Settings.Options.Where(option => option.Status == PropertyStatus.Active)
            .Select(option => new PropertyFieldOption(option.Id, option.Label)).ToArray();

    private static PropertyEditorField EditorField(PropertyDefinition definition, PropertyFieldValue value) =>
        new(definition.Id, definition.Revision, definition.MachineKey,
            EditorLabel(definition),
            definition.Status == PropertyStatus.Deprecated, FieldKind(definition.Settings.Kind),
            EditorOptions(definition), value);

    internal Task<PropertyCommandReceipt> Change(PropertyDefinitionCommand input, CancellationToken ct) =>
        Change(new PropertySchemaInput(input, PropertyFieldKind.Text, []), textOnly: true, ct);

    internal async Task<PropertyDefinitionProjection> ReadProjection(Guid id, CancellationToken ct)
    {
        var schema = await ReadLockedSchema(ct);
        if (schema.Find(id) is not { Status: PropertyStatus.Active or PropertyStatus.Deprecated } definition)
            throw Missing();
        var flags = definition.Settings;
        return new(id, schema.Revision, definition.Revision, definition.Status == PropertyStatus.Deprecated,
            flags.SearchEligible, flags.Filterable, flags.Sortable, definition.Digest);
    }

    internal async Task<PropertyCommandReceipt> Change(PropertyDefinitionProjectionCommand input, CancellationToken ct)
    {
        var schema = await ReadLockedSchema(ct);
        if (schema.Find(input.DefinitionId) is null) throw Missing();
        return await ApplyChange(schema, new(ownerId, input.RequestId, input.SchemaRevision, input.DefinitionRevision,
            new PropertyChange.SetProjectionFlags(input.DefinitionId, input.SearchEligible, input.Sortable)), ct);
    }

    internal async Task<PropertyCommandReceipt> Change(PropertySchemaInput details, bool textOnly, CancellationToken ct)
    {
        var input = details.Command;
        var schema = await ReadLockedSchema(ct);
        var kind = DomainKind(details.Kind);
        var command = new PropertyCommand(ownerId, input.RequestId, input.SchemaRevision, input.DefinitionRevision, input.Operation switch
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
            """, ct, ownerId, command.Change.DefinitionId);
        var transition = schema.Apply(command, replay, (_, _) => impact);
        var receipt = transition.Receipt;
        if (!transition.Replayed)
        {
            await SqlCommands.Execute(db, tx, ct, "insert into public.property_schema(owner_id,revision) values($1,0) on conflict do nothing", ownerId);
            var definition = transition.Schema.Find(command.Change.DefinitionId)!;
            if (await SqlCommands.Execute(db, tx, ct, """
                insert into public.property_definition(owner_id,id,machine_key,revision,digest,shape)
                values($1,$2,$3,$4,$5,$6)
                on conflict(owner_id,id) do update set revision=excluded.revision,digest=excluded.digest,shape=excluded.shape
                where property_definition.revision=$7
                """, ownerId, definition.Id, definition.MachineKey, definition.Revision, definition.Digest,
                Json(definition), command.ExpectedDefinitionRevision) != 1) throw Conflict();
            if (!await VerifyStorageBudget(ct)) throw Invalid();

            if (await SqlCommands.Execute(db, tx, ct, "update public.property_schema set revision=$2 where owner_id=$1 and revision=$3",
                ownerId, receipt.SchemaRevision, command.ExpectedSchemaRevision) != 1) throw Conflict();

            await SqlCommands.Execute(db, tx, ct, "insert into public.property_schema_command(owner_id,request_id,receipt) values($1,$2,$3)",
                ownerId, receipt.RequestId, Json(receipt));
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
        var single = new PropertyValueBatchInput(input.ArticleId, input.ArticleRevision, input.SchemaRevision, input.ValueRevision,
            input.RequestId, [new(input.DefinitionId, input.DefinitionRevision, input.Value)]);
        var next = await WriteValues(single, textOnly, originalFrame, ct);
        return new(input.DefinitionId, input.SchemaRevision, next);
    }

    internal async Task<PropertyValueBatchReceipt> WriteBatch(PropertyValueBatchInput input, byte[] originalFrame,
        AuthorTextRebuildQueue rebuild, Identity actor, CancellationToken ct)
    {
        var next = await WriteValues(input, textOnly: false, originalFrame, ct, (rebuild, actor));
        return new(input.ArticleId, input.SchemaRevision, next, input.RequestId);
    }

    private async Task<long> WriteValues(PropertyValueBatchInput input, bool textOnly, byte[] originalFrame, CancellationToken ct,
        (AuthorTextRebuildQueue Queue, Identity Actor)? projection = null)
    {
        await ScopeLock(ct);
        long articleRevision = await AssertArticle(input.ArticleId, expectedRevision: null, ct);
        // The request fingerprint binds every field. Keep the first definition as the existing journal coordinate.
        var firstDefinition = input.Changes[0].DefinitionId;
        var fingerprint = SHA256.HashData(originalFrame);
        if (await QueryOneValue(db, tx, ct, """
            select fingerprint,definition_id,revision from public.property_value_command where article_id=$1 and request_id=$2
            """, r => CryptographicOperations.FixedTimeEquals(fingerprint, r.GetFieldValue<byte[]>(0)) && r.GetGuid(1) == firstDefinition
                ? r.GetInt64(2) : throw Conflict(), input.ArticleId, input.RequestId) is { } replayed)
            return replayed;

        if (input.ArticleRevision != articleRevision) throw Conflict();
        var schema = await ReadSchema(ct);
        if (schema.Revision != input.SchemaRevision) throw Conflict();
        var candidates = new List<(PropertyDefinition Definition, PropertyValue? Value)>(input.Changes.Count);
        foreach (var change in input.Changes)
        {
            var definition = schema.Find(change.DefinitionId) ?? throw Missing();
            if (textOnly && definition.Settings.Kind != PropertyKind.Text || definition.Status == PropertyStatus.Deleted) throw Missing();
            if (definition.Revision != change.DefinitionRevision) throw Conflict();
            var candidate = DomainValue(change.Value);
            if (candidate is null && definition.Settings.Presence.Required) throw Invalid();
            candidates.Add((definition, candidate));
        }
        var references = candidates.SelectMany(candidate => ReferenceIds(candidate.Value)).Distinct().ToArray();
        var referenceFacts = await ValidateReferences(input.ArticleId, references, ct);
        for (var index = 0; index < candidates.Count; index++)
        {
            var (definition, value) = candidates[index];
            if (value is not null)
                candidates[index] = (definition, PropertyValues.Validate(definition, value, input.ArticleId,
                    target => referenceFacts.GetValueOrDefault(checked((int)target))));
        }

        long next;
        next = await SqlCommands.Scalar(db, tx, ct, """
            insert into public.property_article(article_id,owner_id,revision)
            select $1,$2,1 where $3=0 or exists (
                select 1 from public.property_article where article_id=$1 and owner_id=$2 and revision=$3
            )
            on conflict(article_id) do update set revision=property_article.revision+1
            where property_article.owner_id=$2 and property_article.revision=$3 returning revision
            """, input.ArticleId, ownerId, input.ValueRevision) as long? ?? throw Conflict();

        foreach (var (definition, value) in candidates)
        {
            if (value is not null)
            {
                await SqlCommands.Execute(db, tx, ct, """
                    insert into public.property_value(article_id,owner_id,definition_id,data,references_ids) values($1,$2,$3,$4,$5)
                    on conflict(article_id,definition_id) do update set data=excluded.data,references_ids=excluded.references_ids
                    """, input.ArticleId, ownerId, definition.Id, Json(value), ReferenceIds(value));
            }
            else
            {
                await SqlCommands.Execute(db, tx, ct, """
                    delete from public.property_value where article_id=$1 and owner_id=$2 and definition_id=$3
                    """, input.ArticleId, ownerId, definition.Id);
            }
        }

        await SqlCommands.Execute(db, tx, ct, """
            insert into public.property_value_command(article_id,request_id,fingerprint,definition_id,revision)
            values($1,$2,$3,$4,$5)
            """, input.ArticleId, input.RequestId, fingerprint, firstDefinition, next);
        if (projection is { } queue && queue.Queue.Installed)
            await EnqueueChangedText(input, schema, queue.Queue, queue.Actor, ct);
        return next;
    }

    private async Task EnqueueChangedText(PropertyValueBatchInput input, PropertySchema schema,
        AuthorTextRebuildQueue rebuild, Identity actor, CancellationToken ct)
    {
        // All still-present Text values carry the article-wide revision. Also include fields removed by this command.
        var affected = input.Changes.Select(change => change.DefinitionId).ToHashSet();
        await ReadAll(db, tx, ct, "select definition_id from public.property_value where article_id=$1 and owner_id=$2",
            r => affected.Add(r.GetGuid(0)), input.ArticleId, ownerId);

        var definitions = affected.Select(schema.Find).Where(definition =>
                definition is { Status: PropertyStatus.Active, Settings: { Kind: PropertyKind.Text, SearchEligible: true } })
            .Select(definition => (definition!.Id, definition.Revision)).ToArray();
        await rebuild.EnqueueProperties(db, tx, actor, schema.Revision, definitions, ct);
    }

    private Task ScopeLock(CancellationToken ct) =>
        SqlCommands.LockCommand(db, tx, ownerId, PropertyScopeLock, ct);

    private async Task<long> AssertArticle(int article, long? expectedRevision, CancellationToken ct)
    {
        var revision = (await OwnedArticleRead.TryLock(db, tx, ownerId, article, ct))?.Revision ?? throw Missing();
        if (expectedRevision.HasValue && revision != expectedRevision.Value) throw Conflict();
        return revision;
    }

    private async Task<PropertySchema> ReadLockedSchema(CancellationToken ct)
    {
        await ScopeLock(ct);
        return await ReadSchema(ct);
    }

    private async Task<PropertySchema> ReadSchema(CancellationToken ct)
    {
        var revision = await Revision("select revision from public.property_schema where owner_id=$1", ct, ownerId);
        if (!await VerifyStorageBudget(ct)) throw new InvalidOperationException("Stored property schema exceeds its byte budget.");
        var definitions = ImmutableArray.CreateBuilder<PropertyDefinition>();
        await ReadAll(db, tx, ct, "select id,machine_key,revision,digest,shape::text from public.property_definition where owner_id=$1 limit 4001",
            reader =>
            {
                var definition = Parse<PropertyDefinition>(reader.GetString(4));
                if (definition.Id != reader.GetGuid(0) || definition.MachineKey != reader.GetString(1) ||
                    definition.Revision != reader.GetInt64(2) || definition.Digest != reader.GetString(3))
                    throw new InvalidOperationException("Stored property definition does not match its digest or coordinates.");
                definitions.Add(definition);
            }, ownerId);
        return PropertySchema.Restore(Scope, revision, definitions);
    }

    private async Task<bool> VerifyStorageBudget(CancellationToken ct) =>
        await Revision("select coalesce(sum(octet_length(shape::text)),0) from public.property_definition where owner_id=$1",
            ct, ownerId) <= PropertyStorageJson.SchemaByteBudget;

    private async Task<HashSet<int>> ReadReferences(int[] ids, CancellationToken ct, bool lockTargets = true)
    {
        var visible = new HashSet<int>();
        if (ids.Length == 0) return visible;
        await ReadAll(db, tx, ct, $"""
            select r.id from public.article r
            {ReferenceAuthorityJoins("join")}
            where r.id=any($1) and r.owner_id=$2 and not r.deleted order by r.id {(lockTargets ? "for share of r" : "")}
            """, r => visible.Add(r.GetInt32(0)), ids, ownerId);
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
            var cycles = await SqlCommands.Scalar(db, tx, ct, """
                with recursive reachable(id) as (
                    select $2::integer
                    union
                    select unnest(p.references_ids) from reachable r
                    join public.property_value p on p.article_id=r.id and p.owner_id=$1
                    where cardinality(p.references_ids)>0
                ), bounded as (select id from reachable limit 4001)
                select exists(select from bounded where id=$3) or (select count(*) from bounded)>4000
                """, ownerId, target, article) is not false;
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

    private static PropertyFieldKind FieldKind(PropertyKind kind) => ByDomain.TryGetValue(kind, out var type)
        ? type.Field : throw new InvalidOperationException("Stored property kind is unknown.");

    private static FieldType RequireType(PropertyFieldKind kind) =>
        ByField.TryGetValue(kind, out var type) ? type : throw Invalid();

    private static PropertyKind DomainKind(PropertyFieldKind kind) => RequireType(kind).Domain;

    private async Task<PropertyReceipt?> ReadReceipt(Guid requestId, CancellationToken ct)
    {
        return await SqlCommands.Scalar(db, tx, ct, """
            select receipt::text from public.property_schema_command where owner_id=$1 and request_id=$2
            """, ownerId, requestId) is string json ? Parse<PropertyReceipt>(json) : null;
    }

    private async Task<long> Revision(string sql, CancellationToken ct, params object[] parameters)
    {
        return (await SqlCommands.Scalar(db, tx, ct, sql, parameters) as long?) ?? 0;
    }

    private static NpgsqlParameter Json<T>(T value) => new() { NpgsqlDbType = NpgsqlDbType.Jsonb, Value = JsonSerializer.Serialize(value, StoredJson) };
    private static T Parse<T>(string value) => JsonSerializer.Deserialize<T>(value, StoredJson)
        ?? throw new InvalidOperationException("Stored property data is missing.");
    private static BusinessException Missing() => new(Rejection.NotFound, "Article property is unavailable.");
    private static BusinessException Conflict() => new(Rejection.Conflict, "The article properties changed. Reload before editing.");
    private static BusinessException Invalid() => new(Rejection.Invalid, "Invalid article property.");

    private static string PropertyTypeTag(PropertyFieldKind kind) => RequireType(kind).Tag;

    private static JsonSerializerOptions CreateSerializer()
    {
        var resolver = new System.Text.Json.Serialization.Metadata.DefaultJsonTypeInfoResolver();
        resolver.Modifiers.Add(info =>
        {
            if (info.Type != typeof(PropertyValue)) return;
            var options = new System.Text.Json.Serialization.Metadata.JsonPolymorphismOptions();
            options.DerivedTypes.Add(new(typeof(PropertyValue.Null), "null"));
            foreach (var type in Types) options.DerivedTypes.Add(new(type.Value, type.Tag));
            info.PolymorphismOptions = options;
        });
        return new(PropertyStorageJson.Options) { TypeInfoResolver = resolver };
    }
}
