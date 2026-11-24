using FsusBlog.V2.Core.Content;

namespace FsusBlog.V2.Server.Administration;

internal sealed class AdminTaxonomyStore(AdminSessionGate gate)
{
    internal Task<AdminTaxonomyPage> Taxonomy(string? token, bool tags, IQueryCollection query, Publications publications,
        CancellationToken ct) => gate.WithSession(token, async (db, tx, _) =>
        {
            var after = TaxonomyCursor(query);
            var snapshot = publications.Snapshot ?? throw new PublicUnavailableException();
            var (registry, _, _) = TaxonomyRelations(tags);
            var items = new List<AdminTaxonomyItem>(WireLimits.AdminTaxonomyPageSize);
            var nextAfter = 0;
            await SqlCommands.ReadAll(db, tx, ct, $"""
                with page as materialized (
                    select id,name from public.{registry} where id>$1 order by id limit $2
                ), watermark as (
                    select coalesce(max(id),0) as value from public.blog_outbox where kind in ('publish','retract','delete')
                )
                select w.value,p.id,p.name,counts.drafts,counts.scheduled,counts.retracted,counts.deleted,counts.retained
                from watermark w
                left join page p on true
                left join lateral (
                    select (count(*) filter (where current and not deleted and not scheduled and published_revision is null and publication_count=0))::int as drafts,
                           (count(*) filter (where current and not deleted and scheduled))::int as scheduled,
                           (count(*) filter (where current and not deleted and not scheduled and published_revision is null and publication_count>0))::int as retracted,
                           (count(*) filter (where current and deleted))::int as deleted,
                           count(*)::int as retained
                    from ({TaxonomyMembers(tags, "p.id")}) members
                ) counts on p.id is not null
                order by p.id
                """, rows =>
            {
                if (nextAfter != 0) return;
                if (rows.GetInt64(0) != snapshot.Watermark) throw new PublicUnavailableException();
                if (rows.IsDBNull(1)) return;
                if (items.Count == WireLimits.AdminTaxonomyPageSize) { nextAfter = items[^1].Id; return; }
                var id = rows.GetInt32(1);
                items.Add(new(id, rows.GetString(2), snapshot.Taxonomy.ById(tags, id)?.ArticleCount ?? 0,
                    rows.GetInt32(3), rows.GetInt32(4), rows.GetInt32(5), rows.GetInt32(6), rows.GetInt32(7)));
            }, after, WireLimits.AdminTaxonomyPageSize + 1);
            return new AdminTaxonomyPage(nextAfter, items);
        }, ct);

    internal Task<AdminTaxonomyDependencies> TaxonomyDependencies(string? token, bool tags, IQueryCollection query, CancellationToken ct) =>
        gate.WithSession(token, (db, tx, _) =>
        {
            var id = TaxonomyCoordinate(query, "dependency", "Invalid administrator taxonomy dependency ID.");
            var (registry, _, _) = TaxonomyRelations(tags);
            var aliasCount = tags ? "(select count(*)::int from public.tag_url_name where tag_id=t.id)" : "0";
            return SqlCommands.QueryRequired(db, tx, ct, $"""
                select (count(*) filter (where not m.deleted and (m.current or m.published)))::int,
                       (count(*) filter (where m.deleted or not (m.current or m.published)))::int,
                       {aliasCount}
                from public.{registry} t
                left join lateral ({TaxonomyMembers(tags, "t.id")}) m on true
                where t.id=$1
                group by t.id
                """, row => new AdminTaxonomyDependencies(id, row.GetInt32(0), row.GetInt32(1), row.GetInt32(2)),
                () => new BusinessException(Rejection.NotFound, "The taxonomy entry was not found."), id);
        }, ct);

    private static (string Registry, string Links, string Key) TaxonomyRelations(bool tags) => tags
        ? ("tag", "article_revision_tag", "tag_id")
        : ("category", "article_revision_category", "category_id");

    private static string TaxonomyMembers(bool tags, string coordinate)
    {
        var (_, links, key) = TaxonomyRelations(tags);
        return $"""
            select a.deleted,a.published_revision,a.publication_count,
                   bool_or(l.revision=a.revision) as current,
                   bool_or(l.revision=coalesce(a.published_revision,0)) as published,
                   exists(select from public.article_schedule s join public.admin_principal p on p.id=s.actor_id
                          where s.article_id=a.id and s.revision=a.revision and s.actor_id=a.owner_id
                            and s.generation=p.generation and p.enabled) as scheduled
            from public.{links} l join public.article a on a.id=l.article_id
            where l.{key}={coordinate} group by a.id
            """;
    }

    private static int TaxonomyCursor(IQueryCollection query) =>
        query.Count == 0 ? 0 : TaxonomyCoordinate(query, "after", "Invalid administrator taxonomy cursor.");

    private static int TaxonomyCoordinate(IQueryCollection query, string key, string failure) =>
        query.Count == 1 && query[key] is { Count: 1 } values && values[0] is { Length: > 0 and <= 10 } raw &&
        int.TryParse(raw, NumberStyles.None, CultureInfo.InvariantCulture, out var value) && value > 0
            ? value : throw new BusinessException(Rejection.Invalid, failure);
}

// Shared store for both tag and category metadata management.
internal sealed class AdminTagMetadataStore(AdminSessionGate gate)
{
    private static readonly Guid TagMetadataLock = new("cd3aef2b-973a-4dbb-a5fe-ef6457dbd3de");
    private static readonly Guid CategoryMetadataLock = new("ef338fb8-fb03-4025-86bc-324c35f26ca9");

    internal Task<bool> TagMetadataAvailable(string? session, CancellationToken ct) =>
        gate.WithLiveAdmin(session, (_, _, _) => Task.FromResult(true), ct);

    internal Task<AdminTagMetadata> ReadTagMetadata(string? session, int id, CancellationToken ct) =>
        ReadMetadata(session, id, false, ct);

    internal Task<AdminTagMetadata> ReadCategoryMetadata(string? session, int id, CancellationToken ct) =>
        ReadMetadata(session, id, true, ct);

    private Task<AdminTagMetadata> ReadMetadata(string? session, int id, bool category, CancellationToken ct) =>
        gate.WithLiveAdmin(session, (db, tx, _) => ReadTaxonomyMetadata(db, tx, id, category, ct), ct);

    internal Task<byte[]> ChangeTagMetadata(string? session, AdminTagMetadataCommand input, byte[] frame, HttpContext http,
        ScopedPow pow, Action? invalidate, CancellationToken ct) => ChangeMetadata(session, input, frame, http, pow, invalidate, false, ct);

    internal Task<byte[]> ChangeCategoryMetadata(string? session, AdminTagMetadataCommand input, byte[] frame, HttpContext http,
        ScopedPow pow, Action? invalidate, CancellationToken ct) => ChangeMetadata(session, input, frame, http, pow, invalidate, true, ct);

    private Task<byte[]> ChangeMetadata(string? session, AdminTagMetadataCommand input, byte[] frame, HttpContext http,
        ScopedPow pow, Action? invalidate, bool category, CancellationToken ct) =>
        gate.WithLiveAdmin(session, async (db, tx, admin) =>
        {
            var entity = Entity(category);
            var scope = category ? PowScope.AdminCategoryMetadata : PowScope.AdminTagMetadata;
            var name = input.Name.Trim();
            if (!category) name = name.Normalize(NormalizationForm.FormC);
            var key = category ? null : TagKey(name);
            var description = input.Description.Trim();
            if (name.Length == 0 || name.Any(char.IsControl) || (!category && key is null) ||
                Encoding.UTF8.GetByteCount(name) > (category ? WireLimits.AdminCategoryNameBytes : WireLimits.AdminTagNameBytes) ||
                description.Contains('\0') || description.EnumerateRunes().Count() > 500)
                throw new BusinessException(Rejection.Invalid, $"Invalid {entity} name or description.");
            var context = input.Id.ToString(CultureInfo.InvariantCulture);
            var source = ScopedPow.Source(http);
            var command = input with { Name = name, Description = description };
            var canonical = category ? Wire.EncodeAdminCategoryMetadataCommand(command)
                : input.Id == 0 ? Wire.EncodeAdminTagCreateCommand(command) : Wire.EncodeAdminTagMetadataCommand(command);
            byte[] Encode(AdminTagMetadata receipt) => category ? Wire.EncodeAdminCategoryMetadata(receipt) : Wire.EncodeAdminTagMetadata(receipt);
            if (invalidate is null)
            {
                if (input.Id != 0) await ReadTaxonomyMetadata(db, tx, input.Id, category, ct);
                return PowWire.EncodeChallenge(pow.Issue(scope, context, session!, source, ScopedPow.ReadClientNonce(http), frame));
            }

            await Store.LockCommand(db, tx, Guid.Empty, category ? CategoryMetadataLock : TagMetadataLock, ct);
            var digest = SHA256.HashData(canonical);
            if (await ReadMetadataReceipt(db, tx, admin.Id, input.RequestId, digest, category, ct) is { } replay)
                return Encode(replay);
            await pow.Consume(db, tx, scope, context, session!, source, frame, ScopedPow.ReadProof(http), ct);
            var current = input.Id == 0 ? null : await ReadTaxonomyMetadata(db, tx, input.Id, category, ct);
            var revision = current?.Revision ?? 0;
            if (revision != input.ExpectedRevision) throw MetadataChanged(category);
            var id = input.Id;
            var changed = current is null || current.Name != name || current.Description != description;
            if (changed)
            {
                if (current is null)
                {
                    id = await CreateTaxonomy(db, tx, name, description, category, ct);
                    if (!category) await ReserveTagKeys(db, tx, id, key!, key!, ct);
                }
                else
                {
                    if (!category && current.Name != name)
                    {
                        var old = TaxonomyNames.TagLookupKey(current.Name) ?? throw MetadataChanged(false);
                        await ReserveTagKeys(db, tx, id, old, key!, ct);
                    }
                    if (await SqlCommands.Execute(db, tx, ct, $"""
                        update public.{entity} set name=$2,description=nullif($3,'') where id=$1
                        and not exists(select from public.{entity} where id<>$1 and name=$2)
                        """, id, name, description) != 1) throw MetadataChanged(category);
                }
                revision = await SqlCommands.Scalar(db, tx, ct,
                    "update public.taxonomy_epoch set revision=revision+1 where singleton returning revision") is long value ? value : throw new PublicUnavailableException();
            }

            var receipt = new AdminTagMetadata(id, revision, name, description, changed);
            await SqlCommands.Execute(db, tx, ct, $"""
                insert into public.admin_{entity}_metadata_command
                    (principal_id,request_id,{entity}_id,revision,old_name,old_description,name,description,changed,fingerprint,session_reference,happened_at)
                values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,clock_timestamp())
                """, admin.Id, input.RequestId, id, revision, current?.Name ?? "", current?.Description ?? "",
                name, description, changed, digest, SHA256.HashData(admin.Digest));
            if (changed) invalidate();
            return Encode(receipt);
        }, ct);

    internal Task<byte[]> DeleteTaxonomy(string? session, int id, bool category, Action invalidate, CancellationToken ct) =>
        gate.WithLiveAdmin(session, async (db, tx, _) =>
        {
            var entity = Entity(category);
            var links = category ? "article_revision_category" : "article_revision_tag";
            var key = category ? "category_id" : "tag_id";
            await Store.LockCommand(db, tx, Guid.Empty, category ? CategoryMetadataLock : TagMetadataLock, ct);
            if (await SqlCommands.Scalar(db, tx, ct, $"select 1 from public.{entity} where id=$1", id) is null)
                throw NotFound(category);
            if (await SqlCommands.Scalar(db, tx, ct, $"select 1 from public.{links} where {key}=$1 limit 1", id) is not null)
                throw new BusinessException(Rejection.Conflict,
                    category ? "This category is still referenced by saved article revisions." : "This tag is still referenced by saved article revisions.");
            if (!category)
                await SqlCommands.Execute(db, tx, ct, "delete from public.tag_url_name where tag_id=$1", id);
            await SqlCommands.Execute(db, tx, ct, $"delete from public.admin_{entity}_metadata_command where {entity}_id=$1", id);
            if (await SqlCommands.Execute(db, tx, ct, $"delete from public.{entity} where id=$1", id) != 1)
                throw NotFound(category);
            if (await SqlCommands.Scalar(db, tx, ct,
                "update public.taxonomy_epoch set revision=revision+1 where singleton returning revision") is not long)
                throw new PublicUnavailableException();
            invalidate();
            return Wire.EncodeEmptySuccess();
        }, ct);

    private static async Task<int> CreateTaxonomy(NpgsqlConnection db, NpgsqlTransaction tx, string name, string description, bool category, CancellationToken ct) =>
        await SqlCommands.Scalar(db, tx, ct, $"""
            with next as (select greatest(coalesce(max(id),0),0)::bigint+1 as id from public.{Entity(category)})
            insert into public.{Entity(category)}(id,name,description)
            select id::integer,$1,nullif($2,'') from next where id<=2147483647
            on conflict do nothing returning id
            """, name, description) is int id ? id : throw MetadataChanged(category);

    private static Task<AdminTagMetadata> ReadTaxonomyMetadata(NpgsqlConnection db, NpgsqlTransaction tx, int id, bool category, CancellationToken ct) =>
        SqlCommands.QueryRequired(db, tx, ct, $"""
            select t.name,coalesce(t.description,''),coalesce((select max(h.revision) from public.admin_{Entity(category)}_metadata_command h
                where h.{Entity(category)}_id=t.id and h.changed),0) from public.{Entity(category)} t where t.id=$1
            """, reader => new AdminTagMetadata(id, reader.GetInt64(2), reader.GetString(0), reader.GetString(1), false),
            () => NotFound(category), id);

    private static Task<AdminTagMetadata?> ReadMetadataReceipt(NpgsqlConnection db, NpgsqlTransaction tx, Guid principal,
        Guid request, byte[] digest, bool category, CancellationToken ct) =>
        SqlCommands.QueryOne(db, tx, ct, $"""
            select {Entity(category)}_id,revision,name,description,changed,fingerprint from public.admin_{Entity(category)}_metadata_command
            where principal_id=$1 and request_id=$2
            """, row => CryptographicOperations.FixedTimeEquals(digest, row.GetFieldValue<byte[]>(5))
                ? new AdminTagMetadata(row.GetInt32(0), row.GetInt64(1), row.GetString(2), row.GetString(3), row.GetBoolean(4))
                : throw MetadataChanged(category),
            principal, request);

    private static string Entity(bool category) => category ? "category" : "tag";
    private static BusinessException NotFound(bool category) => new(Rejection.NotFound, category ? "Category not found." : "Tag not found.");

    private static async Task ReserveTagKeys(NpgsqlConnection db, NpgsqlTransaction tx, int id, string old, string next, CancellationToken ct)
    {
        await SqlCommands.ReadAll(db, tx, ct, "select name from public.tag where id<>$1", row =>
        {
            var key = TaxonomyNames.TagLookupKey(row.GetString(0));
            if (key == old || key == next) throw MetadataChanged(false);
        }, id);
        if (await SqlCommands.Execute(db, tx, ct, """
            insert into public.tag_url_name(name_key,tag_id)
            select distinct entry,$3 from unnest(array[$1,$2]::text[]) keys(entry)
            on conflict(name_key) do update set tag_id=excluded.tag_id where tag_url_name.tag_id=excluded.tag_id
            """, old, next, id) != (old == next ? 1 : 2)) throw MetadataChanged(false);
    }

    private static string? TagKey(string name) => name.Any(character => character is '/' or '\\') ||
        name.Contains("%2f", StringComparison.OrdinalIgnoreCase) || name.Contains("%5c", StringComparison.OrdinalIgnoreCase) ||
        name.All(char.IsAsciiDigit) ? null : TaxonomyNames.TagLookupKey(name);

    private static BusinessException MetadataChanged(bool category) =>
        new(Rejection.Conflict, $"The {Entity(category)} changed or the name is already reserved. Reload before saving.");
}
