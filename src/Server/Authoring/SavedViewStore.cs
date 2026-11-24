using System.Security.Cryptography;
using System.Text;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Core.Authoring;
using FsusBlogV2.Storage;
using Npgsql;
using NpgsqlTypes;
using static FsusBlog.V2.Server.SqlCommands;

namespace FsusBlog.V2.Server.Authoring;

internal sealed class SavedViewStore(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor, Guid site)
{
    private static readonly Guid CollectionLock = new("62cdc231-0ad9-4d32-a5d4-5a450125321c");
    private const int RetainedLimit = 4000;

    internal async Task<SavedViewCatalog> List(Guid after, long expected, CancellationToken ct)
    {
        await Store.LockCommand(db, tx, actor.Id, CollectionLock, ct);
        var revision = await CollectionRevision(ct);
        if (after != Guid.Empty && revision != expected) throw Changed();
        var views = await QueryList(db, tx, ct, """
            select id,revision,name from public.author_saved_view
            where site_id=$1 and owner_id=$2 and not retired and id>$3 order by id limit $4
            """, r => new SavedViewSummary(r.GetGuid(0), r.GetInt64(1), r.GetString(2)),
            site, actor.Id, after, WireLimits.SavedViewPageSize + 1);
        if (views.Count <= WireLimits.SavedViewPageSize) return new(revision, Guid.Empty, views);
        views.RemoveAt(views.Count - 1);
        return new(revision, views[^1].Id, views);
    }

    internal async Task<SavedViewReceipt> Change(SavedViewCommand input, CancellationToken ct)
    {
        await Store.LockCommand(db, tx, actor.Id, CollectionLock, ct);
        var name = input.Action == SavedViewAction.Retire ? "" : Wire.NormalizeSavedViewName(input.Name);
        var fingerprint = SHA256.HashData(Wire.EncodeSavedViewCommand(input with { Name = name }));
        if (await Replay(input.RequestId, fingerprint, ct) is { } replay) return replay;
        var placement = await CurrentSchema.HasSavedViewPlacementAsync(db, tx, ct);
        if (placement) await RejectPlacementKeyReuse(input.RequestId, ct);
        var revision = await CollectionRevision(ct);
        if (revision != input.CollectionRevision) throw Changed();
        if (input.Revision == 0)
        {
            var (active, total) = await QueryRequired(db, tx, ct, """
                select count(*) filter(where not retired),count(*) from public.author_saved_view where site_id=$1 and owner_id=$2
                """, r => (r.GetInt64(0), r.GetInt64(1)), null, site, actor.Id);
            if (active >= WireLimits.SavedViewMaxCount || total >= RetainedLimit)
                throw new BusinessException(Rejection.Conflict, "The saved view collection reached its capacity.");
        }
        else if (await Read(input.Id, ct) is not { } current) throw Missing();
        else if (input.Revision != current.Revision) throw Changed();

        var key = Encoding.UTF8.GetBytes(name.ToUpperInvariant());
        if (input.Action != SavedViewAction.Retire && await Scalar(db, tx, ct, """
            select exists(select from public.author_saved_view where site_id=$1 and owner_id=$2 and name_key=$3 and id<>$4 and not retired)
            """, site, actor.Id, key, input.Id) is true)
            throw new BusinessException(Rejection.Conflict, "A saved view already has this name.");

        byte[]? definition = null;
        if (input.Query is { } query)
        {
            try { definition = await new PropertyStore(db, tx, actor).CaptureSavedView(query, ct); }
            catch (PropertyValidationException) { throw PropertyStore.SavedViewDependency(); }
        }
        if (placement && input.Action == SavedViewAction.Retire) await RemovePlacement(input.Id, ct);

        if (await (revision == 0
            ? Execute(db, tx, ct, "insert into public.author_saved_view_collection values($1,$2,1) on conflict do nothing", site, actor.Id)
            : Execute(db, tx, ct, "update public.author_saved_view_collection set revision=revision+1 where site_id=$1 and owner_id=$2 and revision=$3",
                site, actor.Id, revision)) != 1) throw Changed();

        var changed = input.Action switch
        {
            SavedViewAction.Save when input.Revision == 0 => await Execute(db, tx, ct, """
                insert into public.author_saved_view values($1,$2,$3,1,$4,$5,$6,$7,false) on conflict do nothing
                """, site, actor.Id, input.Id, name, key, definition!, SHA256.HashData(definition!)),
            SavedViewAction.Save => await Execute(db, tx, ct, """
                update public.author_saved_view set revision=revision+1,name=$5,name_key=$6,definition=$7,digest=$8
                where site_id=$1 and owner_id=$2 and id=$3 and revision=$4 and not retired
                """, site, actor.Id, input.Id, input.Revision, name, key, definition!, SHA256.HashData(definition!)),
            SavedViewAction.Rename => await Execute(db, tx, ct, """
                update public.author_saved_view set revision=revision+1,name=$5,name_key=$6
                where site_id=$1 and owner_id=$2 and id=$3 and revision=$4 and not retired
                """, site, actor.Id, input.Id, input.Revision, name, key),
            SavedViewAction.Retire => await Execute(db, tx, ct, """
                update public.author_saved_view set revision=revision+1,retired=true
                where site_id=$1 and owner_id=$2 and id=$3 and revision=$4 and not retired
                """, site, actor.Id, input.Id, input.Revision),
            _ => throw Changed(),
        };
        if (changed != 1) throw Changed();

        var receipt = new SavedViewReceipt(input.Id, input.Revision + 1, revision + 1, input.Action == SavedViewAction.Retire);
        await Execute(db, tx, ct, """
            insert into public.author_saved_view_command values($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp())
            """, site, actor.Id, input.RequestId, receipt.Id, receipt.Revision, receipt.CollectionRevision, (int)input.Action, fingerprint);
        return receipt;
    }

    internal async Task<PropertyArticlePage> Open(SavedViewExecute input, string session, CancellationToken ct)
    {
        await Store.LockCommand(db, tx, actor.Id, CollectionLock, ct);
        var view = await Read(input.Id, ct) ?? throw Missing();
        if (input.Revision != view.Revision) throw Changed();
        try
        {
            var definition = Wire.DecodeSavedViewDefinition(view.Definition, view.Digest);
            return await new PropertyStore(db, tx, actor).OpenSavedView(definition, session, input, ct);
        }
        catch (BusinessException failure) when (failure.Rejection == Rejection.NotFound) { throw PropertyStore.SavedViewDependency(); }
        catch (PropertyValidationException) { throw PropertyStore.SavedViewDependency(); }
        catch (ProtocolException) { throw PropertyStore.SavedViewDependency(); }
    }

    internal async Task<SavedViewPlacement> Placement(Guid requested, int offset, long expected, CancellationToken ct)
    {
        await Store.LockCommand(db, tx, actor.Id, CollectionLock, ct);
        var revision = await CollectionRevision(ct);
        if (offset != 0 && revision != expected) throw Changed();
        (SavedViewSummary View, bool Pinned)? requestedView = requested == Guid.Empty ? null : await ReadSummary(requested, ct) ?? throw Missing();
        var fallback = await QueryOne(db, tx, ct, """
            select d.view_id,v.revision,v.name from public.author_saved_view_default d
            left join public.author_saved_view v on (v.site_id,v.owner_id,v.id)=(d.site_id,d.owner_id,d.view_id) and not v.retired
            where d.site_id=$1 and d.owner_id=$2
            """, row => row.IsDBNull(1) ? throw Changed() : new SavedViewSummary(row.GetGuid(0), row.GetInt64(1), row.GetString(2)),
            site, actor.Id);

        var page = await QueryList(db, tx, ct, """
            select v.id,v.revision,v.name from public.author_saved_view_pin p
            join public.author_saved_view v on (v.site_id,v.owner_id,v.id)=(p.site_id,p.owner_id,p.view_id) and not v.retired
            where p.site_id=$1 and p.owner_id=$2 order by p.pin_order offset $3 limit $4
            """, r => new SavedViewSummary(r.GetGuid(0), r.GetInt64(1), r.GetString(2)),
            site, actor.Id, offset, WireLimits.SavedViewPageSize + 1);
        if (page.Count <= WireLimits.SavedViewPageSize)
            return new(revision, fallback, requestedView?.View, requestedView?.Pinned ?? false, 0, page);
        page.RemoveAt(page.Count - 1);
        return new(revision, fallback, requestedView?.View, requestedView?.Pinned ?? false, offset + page.Count, page);
    }

    internal async Task<SavedViewReceipt> ChangePlacement(SavedViewPlacementCommand input, CancellationToken ct)
    {
        await Store.LockCommand(db, tx, actor.Id, CollectionLock, ct);
        var fingerprint = SHA256.HashData(Wire.EncodeSavedViewPlacementCommand(input));
        if (await QueryOne(db, tx, ct, """
            select fingerprint,view_id,revision,collection_revision from public.author_saved_view_placement_command
            where site_id=$1 and owner_id=$2 and request_id=$3
            """, r => CryptographicOperations.FixedTimeEquals(fingerprint, r.GetFieldValue<byte[]>(0))
                ? new SavedViewReceipt(r.GetGuid(1), r.GetInt64(2), r.GetInt64(3), false) : throw Changed(),
            site, actor.Id, input.RequestId) is { } replay) return replay;
        if (await Replay(input.RequestId, fingerprint, ct) is not null) throw Changed();
        var revision = await CollectionRevision(ct);
        if (revision != input.CollectionRevision) throw Changed();
        var (view, _) = await ReadSummary(input.Id, ct) ?? throw Missing();
        if (view.Revision != input.Revision) throw Changed();
        switch (input.Action)
        {
            case SavedViewPlacementAction.Default:
                await Execute(db, tx, ct, """
                    insert into public.author_saved_view_default values($1,$2,$3)
                    on conflict (site_id,owner_id) do update set view_id=excluded.view_id
                    """, site, actor.Id, input.Id);
                break;
            case SavedViewPlacementAction.ClearDefault:
                if (await Execute(db, tx, ct, """
                    delete from public.author_saved_view_default where site_id=$1 and owner_id=$2 and view_id=$3
                    """, site, actor.Id, input.Id) != 1) throw Changed();
                break;
            default:
                await MovePin(input, ct);
                break;
        }

        if (await Execute(db, tx, ct, """
            update public.author_saved_view_collection set revision=revision+1 where site_id=$1 and owner_id=$2 and revision=$3
            """, site, actor.Id, revision) != 1) throw Changed();

        var before = Optional(NpgsqlDbType.Uuid, input.BeforeId == Guid.Empty ? null : input.BeforeId);
        await Execute(db, tx, ct, """
            insert into public.author_saved_view_placement_command values($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp())
            """, site, actor.Id, input.RequestId, input.Id, view.Revision, revision + 1, (int)input.Action, before, fingerprint);
        return new(input.Id, view.Revision, revision + 1, false);
    }

    private async Task MovePin(SavedViewPlacementCommand input, CancellationToken ct)
    {
        var pinned = await QueryList(db, tx, ct, """
            select p.view_id from public.author_saved_view_pin p
            join public.author_saved_view v on (v.site_id,v.owner_id,v.id)=(p.site_id,p.owner_id,p.view_id) and not v.retired
            where p.site_id=$1 and p.owner_id=$2 order by p.pin_order limit $3
            """, r => r.GetGuid(0), site, actor.Id, WireLimits.SavedViewMaxCount + 1);
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
            await Execute(db, tx, ct, "insert into public.author_saved_view_pin values($1,$2,$3,$4)",
                site, actor.Id, input.Id, pinned.IndexOf(input.Id) + 1);
        await Execute(db, tx, ct, """
            update public.author_saved_view_pin p set pin_order=desired.position::integer
            from unnest($3::uuid[]) with ordinality desired(id,position)
            where p.site_id=$1 and p.owner_id=$2 and p.view_id=desired.id and p.pin_order<>desired.position
            """, site, actor.Id, pinned.ToArray());
    }

    private async Task RemovePlacement(Guid id, CancellationToken ct)
    {
        if (await Scalar(db, tx, ct, """
            select exists(select from public.author_saved_view_default where site_id=$1 and owner_id=$2 and view_id=$3)
            """, site, actor.Id, id) is true)
            throw new BusinessException(Rejection.Conflict, "Clear or replace the default view before removing it.");
        await RemovePin(id, ct);
    }

    private async Task RejectPlacementKeyReuse(Guid requestId, CancellationToken ct)
    {
        if (await Scalar(db, tx, ct, """
            select exists(select from public.author_saved_view_placement_command where site_id=$1 and owner_id=$2 and request_id=$3)
            """, site, actor.Id, requestId) is true) throw Changed();
    }

    private Task RemovePin(Guid id, CancellationToken ct) =>
        Execute(db, tx, ct, "delete from public.author_saved_view_pin where site_id=$1 and owner_id=$2 and view_id=$3", site, actor.Id, id);

    private Task<(SavedViewSummary View, bool Pinned)?> ReadSummary(Guid id, CancellationToken ct) =>
        QueryOneValue(db, tx, ct, """
            select v.revision,v.name,p.view_id is not null from public.author_saved_view v
            left join public.author_saved_view_pin p on (p.site_id,p.owner_id,p.view_id)=(v.site_id,v.owner_id,v.id)
            where v.site_id=$1 and v.owner_id=$2 and v.id=$3 and not v.retired
            """, r => (new SavedViewSummary(id, r.GetInt64(0), r.GetString(1)), r.GetBoolean(2)), site, actor.Id, id);

    private async Task<long> CollectionRevision(CancellationToken ct) =>
        await Scalar(db, tx, ct,
            "select revision from public.author_saved_view_collection where site_id=$1 and owner_id=$2", site, actor.Id) is long revision ? revision : 0;

    private Task<(long Revision, byte[] Definition, byte[] Digest)?> Read(Guid id, CancellationToken ct) =>
        QueryOneValue(db, tx, ct, """
            select revision,definition,digest from public.author_saved_view where site_id=$1 and owner_id=$2 and id=$3 and not retired
            """, r => (r.GetInt64(0), r.GetFieldValue<byte[]>(1), r.GetFieldValue<byte[]>(2)), site, actor.Id, id);

    private Task<SavedViewReceipt?> Replay(Guid request, byte[] fingerprint, CancellationToken ct) =>
        QueryOne(db, tx, ct, """
            select fingerprint,view_id,revision,collection_revision,action from public.author_saved_view_command
            where site_id=$1 and owner_id=$2 and request_id=$3
            """, r => CryptographicOperations.FixedTimeEquals(fingerprint, r.GetFieldValue<byte[]>(0))
                ? new SavedViewReceipt(r.GetGuid(1), r.GetInt64(2), r.GetInt64(3), r.GetInt32(4) == (int)SavedViewAction.Retire)
                : throw Changed(), site, actor.Id, request);

    private static BusinessException Changed() => new(Rejection.Conflict, "The saved view collection changed. Reload it before continuing.");
    private static BusinessException Missing() => new(Rejection.NotFound, "Saved view is unavailable.");
}
