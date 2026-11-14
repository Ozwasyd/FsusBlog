using System.Security.Cryptography;
using System.Text;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Core.Authoring;
using FsusBlogV2.Storage;
using Npgsql;

namespace FsusBlog.V2.Server.Authoring;

internal sealed partial class SavedViewStore(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor, Guid site)
{
    private static readonly Guid CollectionLock = new("62cdc231-0ad9-4d32-a5d4-5a450125321c");
    private const int RetainedLimit = 4000;

    internal async Task<SavedViewCatalog> List(Guid after, long expected, CancellationToken ct)
    {
        await Store.LockCommand(db, tx, actor.Id, CollectionLock, ct);
        var revision = await CollectionRevision(ct);
        if (after != Guid.Empty && revision != expected) throw Changed();
        await using var cmd = Store.Sql(db, tx, """
            select id,revision,name from public.author_saved_view
            where site_id=$1 and owner_id=$2 and not retired and id>$3 order by id limit $4
            """, site, actor.Id, after, WireLimits.SavedViewPageSize + 1);
        await using var row = await cmd.ExecuteReaderAsync(ct);
        var views = new List<SavedViewSummary>();
        while (await row.ReadAsync(ct)) views.Add(new(row.GetGuid(0), row.GetInt64(1), row.GetString(2)));
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
            await using var limits = Store.Sql(db, tx, """
                select count(*) filter(where not retired),count(*) from public.author_saved_view where site_id=$1 and owner_id=$2
                """, site, actor.Id);
            await using var row = await limits.ExecuteReaderAsync(ct);
            await row.ReadAsync(ct);
            if (row.GetInt64(0) >= WireLimits.SavedViewMaxCount || row.GetInt64(1) >= RetainedLimit)
                throw new BusinessException(Rejection.Conflict, "The saved view collection reached its capacity.");
        }
        else if (await Read(input.Id, ct) is not { } current) throw Missing();
        else if (input.Revision != current.Revision) throw Changed();

        var key = Encoding.UTF8.GetBytes(name.ToUpperInvariant());
        if (input.Action != SavedViewAction.Retire)
        {
            await using var duplicate = Store.Sql(db, tx, """
                select exists(select from public.author_saved_view where site_id=$1 and owner_id=$2 and name_key=$3 and id<>$4 and not retired)
                """, site, actor.Id, key, input.Id);
            if (await duplicate.ExecuteScalarAsync(ct) is true)
                throw new BusinessException(Rejection.Conflict, "A saved view already has this name.");
        }

        byte[]? definition = null;
        if (input.Query is { } query)
        {
            try { definition = await new PropertyStore(db, tx, actor).CaptureSavedView(query, ct); }
            catch (PropertyValidationException) { throw PropertyStore.SavedViewDependency(); }
        }
        if (placement && input.Action == SavedViewAction.Retire) await RemovePlacement(input.Id, ct);

        await using var advance = revision == 0
            ? Store.Sql(db, tx, "insert into public.author_saved_view_collection values($1,$2,1) on conflict do nothing", site, actor.Id)
            : Store.Sql(db, tx, "update public.author_saved_view_collection set revision=revision+1 where site_id=$1 and owner_id=$2 and revision=$3",
                site, actor.Id, revision);
        if (await advance.ExecuteNonQueryAsync(ct) != 1) throw Changed();

        await using var change = input.Action switch
        {
            SavedViewAction.Save when input.Revision == 0 => Store.Sql(db, tx, """
                insert into public.author_saved_view values($1,$2,$3,1,$4,$5,$6,$7,false) on conflict do nothing
                """, site, actor.Id, input.Id, name, key, definition!, SHA256.HashData(definition!)),
            SavedViewAction.Save => Store.Sql(db, tx, """
                update public.author_saved_view set revision=revision+1,name=$5,name_key=$6,definition=$7,digest=$8
                where site_id=$1 and owner_id=$2 and id=$3 and revision=$4 and not retired
                """, site, actor.Id, input.Id, input.Revision, name, key, definition!, SHA256.HashData(definition!)),
            SavedViewAction.Rename => Store.Sql(db, tx, """
                update public.author_saved_view set revision=revision+1,name=$5,name_key=$6
                where site_id=$1 and owner_id=$2 and id=$3 and revision=$4 and not retired
                """, site, actor.Id, input.Id, input.Revision, name, key),
            SavedViewAction.Retire => Store.Sql(db, tx, """
                update public.author_saved_view set revision=revision+1,retired=true
                where site_id=$1 and owner_id=$2 and id=$3 and revision=$4 and not retired
                """, site, actor.Id, input.Id, input.Revision),
            _ => throw Changed(),
        };
        if (await change.ExecuteNonQueryAsync(ct) != 1) throw Changed();

        var receipt = new SavedViewReceipt(input.Id, input.Revision + 1, revision + 1, input.Action == SavedViewAction.Retire);
        await using var journal = Store.Sql(db, tx, """
            insert into public.author_saved_view_command values($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp())
            """, site, actor.Id, input.RequestId, receipt.Id, receipt.Revision, receipt.CollectionRevision, (int)input.Action, fingerprint);
        await journal.ExecuteNonQueryAsync(ct);
        return receipt;
    }

    internal async Task<PropertyArticlePage> Open(SavedViewExecute input, string session, CancellationToken ct)
    {
        await Store.LockCommand(db, tx, actor.Id, CollectionLock, ct);
        var view = await Read(input.Id, ct) ?? throw Missing();
        if (input.Revision != view.Revision) throw Changed();
        try
        {
            var conditions = Wire.DecodeSavedViewDefinition(view.Definition, view.Digest);
            return await new PropertyStore(db, tx, actor).OpenSavedView(conditions, session, input, ct);
        }
        catch (BusinessException failure) when (failure.Rejection == Rejection.NotFound) { throw PropertyStore.SavedViewDependency(); }
        catch (PropertyValidationException) { throw PropertyStore.SavedViewDependency(); }
        catch (ProtocolException) { throw PropertyStore.SavedViewDependency(); }
    }

    private async Task<long> CollectionRevision(CancellationToken ct)
    {
        await using var cmd = Store.Sql(db, tx, "select revision from public.author_saved_view_collection where site_id=$1 and owner_id=$2", site, actor.Id);
        return await cmd.ExecuteScalarAsync(ct) is long revision ? revision : 0;
    }

    private async Task<(long Revision, byte[] Definition, byte[] Digest)?> Read(Guid id, CancellationToken ct)
    {
        await using var cmd = Store.Sql(db, tx, """
            select revision,definition,digest from public.author_saved_view where site_id=$1 and owner_id=$2 and id=$3 and not retired
            """, site, actor.Id, id);
        await using var row = await cmd.ExecuteReaderAsync(ct);
        return await row.ReadAsync(ct) ? (row.GetInt64(0), row.GetFieldValue<byte[]>(1), row.GetFieldValue<byte[]>(2)) : null;
    }

    private async Task<SavedViewReceipt?> Replay(Guid request, byte[] fingerprint, CancellationToken ct)
    {
        await using var command = Store.Sql(db, tx, """
            select fingerprint,view_id,revision,collection_revision,action from public.author_saved_view_command
            where site_id=$1 and owner_id=$2 and request_id=$3
            """, site, actor.Id, request);
        await using var row = await command.ExecuteReaderAsync(ct);
        if (!await row.ReadAsync(ct)) return null;
        if (!CryptographicOperations.FixedTimeEquals(fingerprint, row.GetFieldValue<byte[]>(0))) throw Changed();
        return new(row.GetGuid(1), row.GetInt64(2), row.GetInt64(3), row.GetInt32(4) == (int)SavedViewAction.Retire);
    }

    private static BusinessException Changed() => new(Rejection.Conflict, "The saved view collection changed. Reload it before continuing.");
    private static BusinessException Missing() => new(Rejection.NotFound, "Saved view is unavailable.");
}
