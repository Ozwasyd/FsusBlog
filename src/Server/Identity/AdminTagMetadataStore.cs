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

internal sealed partial class AdminPasskeyStore
{
    private static readonly Guid TagMetadataLock = new("cd3aef2b-973a-4dbb-a5fe-ef6457dbd3de");
    private const PowScope TagMetadataScope = PowScope.AdminTagMetadata;

    internal Task<bool> TagMetadataAvailable(string? session, CancellationToken ct) =>
        WithLiveAdmin(session, CurrentSchema.ArticleWritePermission, (_, _, _) => Task.FromResult(true), ct);

    internal Task<AdminTagMetadata> ReadTagMetadata(string? session, int id, CancellationToken ct) =>
        WithLiveAdmin(session, CurrentSchema.ArticleWritePermission, (db, tx, _) => ReadTag(db, tx, id, ct), ct);

    internal Task<byte[]> ChangeTagMetadata(string? session, AdminTagMetadataCommand input, byte[] frame, HttpContext http,
        ScopedPow pow, Action? invalidate, CancellationToken ct) =>
        WithLiveAdmin(session, CurrentSchema.ArticleWritePermission, async (db, tx, admin) =>
        {
            var name = input.Name.Trim().Normalize(NormalizationForm.FormC);
            var key = TagKey(name);
            var description = input.Description.Trim();
            if (key is null || Encoding.UTF8.GetByteCount(name) > WireLimits.AdminTagNameBytes ||
                description.Contains('\0') || description.EnumerateRunes().Count() > 500)
                throw new BusinessException(Rejection.Invalid, "Invalid tag name or description.");
            var context = input.Id.ToString(CultureInfo.InvariantCulture);
            var source = ScopedPow.Source(http);
            if (invalidate is null)
            {
                await ReadTag(db, tx, input.Id, ct);
                return PowWire.EncodeChallenge(pow.Issue(TagMetadataScope, context, session!, source, ScopedPow.ReadClientNonce(http), frame));
            }

            await Store.LockCommand(db, tx, Guid.Empty, TagMetadataLock, ct);
            var digest = SHA256.HashData(Wire.EncodeAdminTagMetadataCommand(input with { Name = name, Description = description }));
            var replay = await ReadTagReceipt(db, tx, admin.Id, input.RequestId, digest, ct);
            if (replay is not null) return Wire.EncodeAdminTagMetadata(replay);
            await pow.Consume(db, tx, TagMetadataScope, context, session!, source, frame, ScopedPow.ReadProof(http), ct);
            var current = await ReadTag(db, tx, input.Id, ct);
            if (current.Revision != input.ExpectedRevision) throw TagChanged();
            var changed = current.Name != name || current.Description != description;
            var revision = current.Revision;
            if (changed)
            {
                if (current.Name != name)
                {
                    var old = TaxonomyNames.TagLookupKey(current.Name) ?? throw TagChanged();
                    await ReserveTagKeys(db, tx, input.Id, old, key, ct);
                }
                await using (var update = Store.Sql(db, tx, """
                    update public.tag set name=$2,description=nullif($3,'') where id=$1
                    """, input.Id, name, description))
                    if (await update.ExecuteNonQueryAsync(ct) != 1) throw TagChanged();
                await using var epoch = Store.Sql(db, tx, "update public.taxonomy_epoch set revision=revision+1 where singleton returning revision");
                revision = await epoch.ExecuteScalarAsync(ct) is long value ? value : throw new PublicUnavailableException();
            }

            var receipt = new AdminTagMetadata(input.Id, revision, name, description, changed);
            await using var append = Store.Sql(db, tx, """
                insert into public.admin_tag_metadata_command
                    (principal_id,request_id,tag_id,revision,old_name,old_description,name,description,changed,fingerprint,session_reference,happened_at)
                values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,clock_timestamp())
                """, admin.Id, input.RequestId, current.Id, revision, current.Name, current.Description,
                name, description, changed, digest, SHA256.HashData(admin.Digest));
            await append.ExecuteNonQueryAsync(ct);
            if (changed) invalidate();
            return Wire.EncodeAdminTagMetadata(receipt);
        }, ct);

    private static async Task<AdminTagMetadata> ReadTag(NpgsqlConnection db, NpgsqlTransaction tx, int id, CancellationToken ct)
    {
        await using var cmd = Store.Sql(db, tx, """
            select t.name,coalesce(t.description,''),coalesce((select max(h.revision) from public.admin_tag_metadata_command h
                where h.tag_id=t.id and h.changed),0) from public.tag t where t.id=$1
            """, id);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        if (!await reader.ReadAsync(ct)) throw new BusinessException(Rejection.NotFound, "Tag not found.");
        return new(id, reader.GetInt64(2), reader.GetString(0), reader.GetString(1), false);
    }

    private static async Task<AdminTagMetadata?> ReadTagReceipt(NpgsqlConnection db, NpgsqlTransaction tx, Guid principal,
        Guid request, byte[] digest, CancellationToken ct)
    {
        await using var cmd = Store.Sql(db, tx, """
            select tag_id,revision,name,description,changed,fingerprint from public.admin_tag_metadata_command
            where principal_id=$1 and request_id=$2
            """, principal, request);
        await using var row = await cmd.ExecuteReaderAsync(ct);
        if (!await row.ReadAsync(ct)) return null;
        if (!CryptographicOperations.FixedTimeEquals(digest, row.GetFieldValue<byte[]>(5))) throw TagChanged();
        return new(row.GetInt32(0), row.GetInt64(1), row.GetString(2), row.GetString(3), row.GetBoolean(4));
    }

    private static async Task ReserveTagKeys(NpgsqlConnection db, NpgsqlTransaction tx, int id, string old, string next, CancellationToken ct)
    {
        // Older registries reserved only aliases. Compare active names with the same invariant CLR key as public lookup.
        await using (var names = Store.Sql(db, tx, "select name from public.tag where id<>$1", id))
        await using (var row = await names.ExecuteReaderAsync(ct))
            while (await row.ReadAsync(ct))
            {
                var key = TaxonomyNames.TagLookupKey(row.GetString(0));
                if (key == old || key == next) throw TagChanged();
            }
        await using var claim = Store.Sql(db, tx, """
            insert into public.tag_url_name(name_key,tag_id)
            select distinct entry,$3 from unnest(array[$1,$2]::text[]) keys(entry)
            on conflict(name_key) do update set tag_id=excluded.tag_id where tag_url_name.tag_id=excluded.tag_id
            """, old, next, id);
        if (await claim.ExecuteNonQueryAsync(ct) != (old == next ? 1 : 2)) throw TagChanged();
    }

    private static string? TagKey(string name) => name.Any(character => character is '/' or '\\') ||
        name.Contains("%2f", StringComparison.OrdinalIgnoreCase) || name.Contains("%5c", StringComparison.OrdinalIgnoreCase) ||
        name.All(char.IsAsciiDigit) ? null : TaxonomyNames.TagLookupKey(name);

    private static BusinessException TagChanged() => new(Rejection.Conflict, "The tag changed or the name is already reserved. Reload before saving.");
}
