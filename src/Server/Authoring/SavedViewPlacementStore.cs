using System.Security.Cryptography;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using Npgsql;
using NpgsqlTypes;

namespace FsusBlog.V2.Server.Authoring;

internal sealed partial class SavedViewStore
{
    internal async Task<SavedViewPlacement> Placement(Guid requested, int offset, long expected, CancellationToken ct)
    {
        await Store.LockCommand(db, tx, actor.Id, CollectionLock, ct);
        var revision = await CollectionRevision(ct);
        if (offset != 0 && revision != expected) throw Changed();
        (SavedViewSummary View, bool Pinned)? requestedView = null;
        if (requested != Guid.Empty) requestedView = await ReadSummary(requested, ct) ?? throw Missing();
        await using var query = Store.Sql(db, tx, """
            select d.view_id,v.revision,v.name from public.author_saved_view_default d
            left join public.author_saved_view v on (v.site_id,v.owner_id,v.id)=(d.site_id,d.owner_id,d.view_id) and not v.retired
            where d.site_id=$1 and d.owner_id=$2
            """, site, actor.Id);
        SavedViewSummary? fallback = null;
        await using (var row = await query.ExecuteReaderAsync(ct))
            if (await row.ReadAsync(ct))
            {
                if (row.IsDBNull(1)) throw Changed();
                fallback = new(row.GetGuid(0), row.GetInt64(1), row.GetString(2));
            }

        await using var pins = Store.Sql(db, tx, """
            select v.id,v.revision,v.name from public.author_saved_view_pin p
            join public.author_saved_view v on (v.site_id,v.owner_id,v.id)=(p.site_id,p.owner_id,p.view_id) and not v.retired
            where p.site_id=$1 and p.owner_id=$2 order by p.pin_order offset $3 limit $4
            """, site, actor.Id, offset, WireLimits.SavedViewPageSize + 1);
        var page = new List<SavedViewSummary>();
        await using (var row = await pins.ExecuteReaderAsync(ct))
            while (await row.ReadAsync(ct)) page.Add(new(row.GetGuid(0), row.GetInt64(1), row.GetString(2)));
        if (page.Count <= WireLimits.SavedViewPageSize)
            return new(revision, fallback, requestedView?.View, requestedView?.Pinned ?? false, 0, page);
        page.RemoveAt(page.Count - 1);
        return new(revision, fallback, requestedView?.View, requestedView?.Pinned ?? false, offset + page.Count, page);
    }

    internal async Task<SavedViewReceipt> ChangePlacement(SavedViewPlacementCommand input, CancellationToken ct)
    {
        await Store.LockCommand(db, tx, actor.Id, CollectionLock, ct);
        var fingerprint = SHA256.HashData(Wire.EncodeSavedViewPlacementCommand(input));
        await using (var replay = Store.Sql(db, tx, """
            select fingerprint,view_id,revision,collection_revision from public.author_saved_view_placement_command
            where site_id=$1 and owner_id=$2 and request_id=$3
            """, site, actor.Id, input.RequestId))
        await using (var row = await replay.ExecuteReaderAsync(ct))
            if (await row.ReadAsync(ct))
            {
                if (!CryptographicOperations.FixedTimeEquals(fingerprint, row.GetFieldValue<byte[]>(0))) throw Changed();
                return new(row.GetGuid(1), row.GetInt64(2), row.GetInt64(3), false);
            }
        if (await Replay(input.RequestId, fingerprint, ct) is not null) throw Changed();
        var revision = await CollectionRevision(ct);
        if (revision != input.CollectionRevision) throw Changed();
        var (view, _) = await ReadSummary(input.Id, ct) ?? throw Missing();
        if (view.Revision != input.Revision) throw Changed();
        switch (input.Action)
        {
            case SavedViewPlacementAction.Default:
                await using (var set = Store.Sql(db, tx, """
                    insert into public.author_saved_view_default values($1,$2,$3)
                    on conflict (site_id,owner_id) do update set view_id=excluded.view_id
                    """, site, actor.Id, input.Id)) await set.ExecuteNonQueryAsync(ct);
                break;
            case SavedViewPlacementAction.ClearDefault:
                await using (var clear = Store.Sql(db, tx, """
                    delete from public.author_saved_view_default where site_id=$1 and owner_id=$2 and view_id=$3
                    """, site, actor.Id, input.Id))
                    if (await clear.ExecuteNonQueryAsync(ct) != 1) throw Changed();
                break;
            default:
                await MovePin(input, ct);
                break;
        }

        await using var advance = Store.Sql(db, tx, """
            update public.author_saved_view_collection set revision=revision+1 where site_id=$1 and owner_id=$2 and revision=$3
            """, site, actor.Id, revision);
        if (await advance.ExecuteNonQueryAsync(ct) != 1) throw Changed();

        var before = SqlCommands.Optional(NpgsqlDbType.Uuid, input.BeforeId == Guid.Empty ? null : input.BeforeId);
        await using var journal = Store.Sql(db, tx, """
            insert into public.author_saved_view_placement_command values($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp())
            """, site, actor.Id, input.RequestId, input.Id, view.Revision, revision + 1, (int)input.Action, before, fingerprint);
        await journal.ExecuteNonQueryAsync(ct);
        return new(input.Id, view.Revision, revision + 1, false);
    }

    private async Task MovePin(SavedViewPlacementCommand input, CancellationToken ct)
    {
        var pinned = new List<Guid>();
        await using (var query = Store.Sql(db, tx, """
            select p.view_id from public.author_saved_view_pin p
            join public.author_saved_view v on (v.site_id,v.owner_id,v.id)=(p.site_id,p.owner_id,p.view_id) and not v.retired
            where p.site_id=$1 and p.owner_id=$2 order by p.pin_order limit $3
            """, site, actor.Id, WireLimits.SavedViewMaxCount + 1))
        await using (var row = await query.ExecuteReaderAsync(ct))
            while (await row.ReadAsync(ct)) pinned.Add(row.GetGuid(0));
        if (pinned.Count > WireLimits.SavedViewMaxCount) throw Changed();
        var previous = pinned.IndexOf(input.Id);
        if (previous >= 0) pinned.RemoveAt(previous);
        if (previous < 0 && input.Action is (SavedViewPlacementAction.Unpin or SavedViewPlacementAction.MoveBefore))
            throw Changed();
        if (input.Action != SavedViewPlacementAction.Unpin)
        {
            var position = input.BeforeId == Guid.Empty ? pinned.Count : pinned.IndexOf(input.BeforeId);
            if (position < 0 || input.Action == SavedViewPlacementAction.MoveBefore && position == previous) throw Changed();
            pinned.Insert(position, input.Id);
        }

        await RemovePin(input.Id, ct);
        if (input.Action != SavedViewPlacementAction.Unpin)
        {
            await SqlCommands.Execute(db, tx, ct, "insert into public.author_saved_view_pin values($1,$2,$3,$4)",
                site, actor.Id, input.Id, pinned.IndexOf(input.Id) + 1);
        }
        await SqlCommands.Execute(db, tx, ct, """
            update public.author_saved_view_pin p set pin_order=desired.position::integer
            from unnest($3::uuid[]) with ordinality desired(id,position)
            where p.site_id=$1 and p.owner_id=$2 and p.view_id=desired.id and p.pin_order<>desired.position
            """, site, actor.Id, pinned.ToArray());
    }

    private async Task RemovePlacement(Guid id, CancellationToken ct)
    {
        await using var read = Store.Sql(db, tx, """
            select exists(select from public.author_saved_view_default where site_id=$1 and owner_id=$2 and view_id=$3)
            """, site, actor.Id, id);
        if (await read.ExecuteScalarAsync(ct) is true)
            throw new BusinessException(Rejection.Conflict, "Clear or replace the default view before removing it.");
        await RemovePin(id, ct);
    }

    private async Task RejectPlacementKeyReuse(Guid requestId, CancellationToken ct)
    {
        await using var query = Store.Sql(db, tx, """
            select exists(select from public.author_saved_view_placement_command where site_id=$1 and owner_id=$2 and request_id=$3)
            """, site, actor.Id, requestId);
        if (await query.ExecuteScalarAsync(ct) is true) throw Changed();
    }

    private async Task RemovePin(Guid id, CancellationToken ct)
    {
        await SqlCommands.Execute(db, tx, ct, "delete from public.author_saved_view_pin where site_id=$1 and owner_id=$2 and view_id=$3", site, actor.Id, id);
    }

    private async Task<(SavedViewSummary View, bool Pinned)?> ReadSummary(Guid id, CancellationToken ct)
    {
        await using var query = Store.Sql(db, tx, """
            select v.revision,v.name,p.view_id is not null from public.author_saved_view v
            left join public.author_saved_view_pin p on (p.site_id,p.owner_id,p.view_id)=(v.site_id,v.owner_id,v.id)
            where v.site_id=$1 and v.owner_id=$2 and v.id=$3 and not v.retired
            """, site, actor.Id, id);
        await using var row = await query.ExecuteReaderAsync(ct);
        return await row.ReadAsync(ct) ? (new(id, row.GetInt64(0), row.GetString(1)), row.GetBoolean(2)) : null;
    }
}
