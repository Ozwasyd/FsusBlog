using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Core.Content;
using FsusBlog.V2.Server.Security;
using FsusBlogV2.Storage;
using Npgsql;

namespace FsusBlog.V2.Server.Administration;

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
            var replay = await ReadMetadataReceipt(db, tx, admin.Id, input.RequestId, digest, category, ct);
            if (replay is not null) return Encode(replay);
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
                throw new BusinessException(Rejection.NotFound, category ? "Category not found." : "Tag not found.");

            if (await SqlCommands.Scalar(db, tx, ct, $"select 1 from public.{links} where {key}=$1 limit 1", id) is not null)
                throw new BusinessException(Rejection.Conflict,
                    category ? "This category is still referenced by saved article revisions." : "This tag is still referenced by saved article revisions.");

            if (!category)
            {
                await SqlCommands.Execute(db, tx, ct, "delete from public.tag_url_name where tag_id=$1", id);
            }

            await SqlCommands.Execute(db, tx, ct, $"delete from public.admin_{entity}_metadata_command where {entity}_id=$1", id);

            if (await SqlCommands.Execute(db, tx, ct, $"delete from public.{entity} where id=$1", id) != 1)
                throw new BusinessException(Rejection.NotFound, category ? "Category not found." : "Tag not found.");

            if (await SqlCommands.Scalar(db, tx, ct,
                "update public.taxonomy_epoch set revision=revision+1 where singleton returning revision") is not long)
                throw new PublicUnavailableException();

            invalidate();
            return Wire.EncodeEmptySuccess();
        }, ct);

    private static async Task<int> CreateTaxonomy(NpgsqlConnection db, NpgsqlTransaction tx, string name, string description, bool category, CancellationToken ct)
    {
        var entity = Entity(category);
        // The kind lock also serializes allocation. Imported catalogs can contain explicit IDs ahead of the identity sequence.
        return await SqlCommands.Scalar(db, tx, ct, $"""
            with next as (select greatest(coalesce(max(id),0),0)::bigint+1 as id from public.{entity})
            insert into public.{entity}(id,name,description)
            select id::integer,$1,nullif($2,'') from next where id<=2147483647
            on conflict do nothing returning id
            """, name, description) is int id ? id : throw MetadataChanged(category);
    }

    private static async Task<AdminTagMetadata> ReadTaxonomyMetadata(NpgsqlConnection db, NpgsqlTransaction tx, int id, bool category, CancellationToken ct)
    {
        var entity = Entity(category);
        await using var cmd = Store.Sql(db, tx, $"""
            select t.name,coalesce(t.description,''),coalesce((select max(h.revision) from public.admin_{entity}_metadata_command h
                where h.{entity}_id=t.id and h.changed),0) from public.{entity} t where t.id=$1
            """, id);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        if (!await reader.ReadAsync(ct)) throw new BusinessException(Rejection.NotFound, category ? "Category not found." : "Tag not found.");
        return new(id, reader.GetInt64(2), reader.GetString(0), reader.GetString(1), false);
    }

    private static async Task<AdminTagMetadata?> ReadMetadataReceipt(NpgsqlConnection db, NpgsqlTransaction tx, Guid principal,
        Guid request, byte[] digest, bool category, CancellationToken ct)
    {
        var entity = Entity(category);
        await using var cmd = Store.Sql(db, tx, $"""
            select {entity}_id,revision,name,description,changed,fingerprint from public.admin_{entity}_metadata_command
            where principal_id=$1 and request_id=$2
            """, principal, request);
        await using var row = await cmd.ExecuteReaderAsync(ct);
        if (!await row.ReadAsync(ct)) return null;
        if (!CryptographicOperations.FixedTimeEquals(digest, row.GetFieldValue<byte[]>(5))) throw MetadataChanged(category);
        return new(row.GetInt32(0), row.GetInt64(1), row.GetString(2), row.GetString(3), row.GetBoolean(4));
    }

    private static string Entity(bool category) => category ? "category" : "tag";

    private static async Task ReserveTagKeys(NpgsqlConnection db, NpgsqlTransaction tx, int id, string old, string next, CancellationToken ct)
    {
        // Older registries reserved only aliases. Compare active names with the same invariant CLR key as public lookup.
        await using (var names = Store.Sql(db, tx, "select name from public.tag where id<>$1", id))
        await using (var row = await names.ExecuteReaderAsync(ct))
            while (await row.ReadAsync(ct))
            {
                var key = TaxonomyNames.TagLookupKey(row.GetString(0));
                if (key == old || key == next) throw MetadataChanged(false);
            }
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
