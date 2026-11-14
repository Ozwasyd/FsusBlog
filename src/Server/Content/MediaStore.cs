using System.Security.Cryptography;
using FsusBlog.V2.Core;
using Npgsql;

namespace FsusBlog.V2.Server.Content;

internal sealed record MediaRecord(Guid Id, string Name, MediaFormat Format, int Length, int Width, int Height, DateTimeOffset CreatedAt);
internal readonly record struct MediaPosition(DateTimeOffset CreatedAt, Guid Id);

internal sealed class MediaStore(MediaFiles files)
{
    private const string Fields = "id,name,format,length,width,height,created_at";

    internal async Task<List<MediaRecord>> List(NpgsqlConnection db, NpgsqlTransaction transaction, Guid owner, MediaPosition? before,
        CancellationToken token)
    {
        await using var query = Store.Sql(db, transaction, $"""
            SELECT {Fields} FROM public.private_media WHERE owner_id=$1 AND phase=1
            AND ($2 OR (created_at,id) < ($3,$4))
            ORDER BY created_at DESC,id DESC LIMIT 51
            """, owner, before is null, before?.CreatedAt ?? DateTimeOffset.UnixEpoch, before?.Id ?? Guid.Empty);
        await using var rows = await query.ExecuteReaderAsync(token);
        List<MediaRecord> available = [];
        while (await rows.ReadAsync(token)) available.Add(ReadRecord(rows));
        return available;
    }

    internal async Task<Guid> Reserve(NpgsqlConnection db, NpgsqlTransaction transaction, Guid owner, Guid commandId,
        MediaImage image, CancellationToken token)
    {
        var id = Guid.NewGuid();
        await using (var insert = Store.Sql(db, transaction, """
            INSERT INTO public.private_media (id,owner_id,command_id,request_hash,content_hash,name,format,length,width,height,phase)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0)
            ON CONFLICT (owner_id,command_id) DO NOTHING
            """, id, owner, commandId, image.RequestHash, image.Hash, image.Name, (short)image.Format, image.Bytes.Length, image.Width,
            image.Height))
            if (await insert.ExecuteNonQueryAsync(token) == 1) return id;

        await using var existing = Store.Sql(db, transaction, """
            SELECT id,request_hash,phase FROM public.private_media WHERE owner_id=$1 AND command_id=$2 FOR UPDATE
            """, owner, commandId);
        await using var row = await existing.ExecuteReaderAsync(token);
        if (!await row.ReadAsync(token) || !CryptographicOperations.FixedTimeEquals(row.GetFieldValue<byte[]>(1), image.RequestHash))
            throw new BusinessException(Rejection.Conflict, "This upload key is already in use.");
        if ((MediaPhase)row.GetInt16(2) is MediaPhase.Removing or MediaPhase.Removed)
            throw new BusinessException(Rejection.Conflict, "This upload has been removed. Use a new key for a new upload.");
        return row.GetGuid(0);
    }

    internal async Task<MediaRecord> Activate(NpgsqlConnection db, NpgsqlTransaction transaction, Guid owner, Guid id,
        MediaImage image, CancellationToken token)
    {
        var row = await Find(db, transaction, owner, id, locking: true, token);
        if (row is null || row.Phase is MediaPhase.Removing or MediaPhase.Removed)
            throw new BusinessException(Rejection.Conflict, "This upload is no longer available.");

        if (row.Phase == MediaPhase.Pending)
        {
            if (!CryptographicOperations.FixedTimeEquals(row.Digest, image.Hash) || row.Record.Length != image.Bytes.Length)
                throw new BusinessException(Rejection.Conflict, "Pending image does not match the saved upload.");
            await files.Materialize(id, image, token);
            await SetPhase(db, transaction, owner, id, MediaPhase.Ready, token);
        }
        else if (await files.Read(id, row.Record.Length, row.Digest, token) is null)
        {
            throw new IOException("Committed private media is unavailable from storage.");
        }
        return row.Record;
    }

    internal async Task<(MediaRecord Record, byte[] Bytes)?> Read(NpgsqlConnection db, NpgsqlTransaction transaction, Guid owner,
        Guid id, CancellationToken token)
    {
        var row = await Find(db, transaction, owner, id, locking: false, token);
        if (row?.Phase != MediaPhase.Ready) return null;
        var bytes = await files.Read(id, row.Record.Length, row.Digest, token);
        return bytes is null ? null : (row.Record, bytes);
    }

    internal async Task<bool> Tombstone(NpgsqlConnection db, NpgsqlTransaction transaction, Guid owner, Guid id,
        CancellationToken token)
    {
        var row = await Find(db, transaction, owner, id, locking: true, token);
        if (row is null) return false;
        if (row.Phase is MediaPhase.Pending or MediaPhase.Ready)
            await SetPhase(db, transaction, owner, id, MediaPhase.Removing, token);
        return true;
    }

    internal async Task FinishRemoval(NpgsqlConnection db, NpgsqlTransaction transaction, Guid owner, Guid id, CancellationToken token)
    {
        var row = await Find(db, transaction, owner, id, locking: true, token);
        if (row?.Phase != MediaPhase.Removing) return;
        await files.Delete(id, row.Record.Length, row.Digest, token);
        await SetPhase(db, transaction, owner, id, MediaPhase.Removed, token);
    }

    private static async Task<SavedMedia?> Find(NpgsqlConnection db, NpgsqlTransaction tx, Guid owner, Guid id, bool locking,
        CancellationToken token)
    {
        await using var query = Store.Sql(db, tx, $"""
            SELECT {Fields},content_hash,phase FROM public.private_media WHERE owner_id=$1 AND id=$2
            """ + (locking ? " FOR UPDATE" : " FOR SHARE"), owner, id);
        await using var row = await query.ExecuteReaderAsync(token);
        return await row.ReadAsync(token) ? new(ReadRecord(row), row.GetFieldValue<byte[]>(7), (MediaPhase)row.GetInt16(8)) : null;
    }

    private static async Task SetPhase(NpgsqlConnection db, NpgsqlTransaction transaction, Guid owner, Guid id, MediaPhase phase,
        CancellationToken token)
    {
        await using var command = Store.Sql(db, transaction, "UPDATE public.private_media SET phase=$3 WHERE owner_id=$1 AND id=$2",
            owner, id, (short)phase);
        await command.ExecuteNonQueryAsync(token);
    }

    private static MediaRecord ReadRecord(NpgsqlDataReader row) => new(row.GetGuid(0), row.GetString(1), (MediaFormat)row.GetInt16(2),
        row.GetInt32(3), row.GetInt32(4), row.GetInt32(5), row.GetFieldValue<DateTimeOffset>(6));

    private sealed record SavedMedia(MediaRecord Record, byte[] Digest, MediaPhase Phase);
}
