using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text.Encodings.Web;
using System.Text.Json;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core.Authoring;
using Npgsql;

namespace FsusBlog.V2.Server.Authoring;

// Called only while the matching authoring_canvas row is locked.
internal sealed class CanvasHistoryStore(NpgsqlConnection db, NpgsqlTransaction tx)
{
    private const int MaxDepth = 100;
    private const int MaxBytes = 32 * 1024 * 1024;
    private static readonly JsonSerializerOptions Json = new()
    {
        // UTF-8 retains the same size bound as the admitted graph for ordinary non-ASCII text.
        // This private payload is never embedded in HTML or returned to clients.
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        UnmappedMemberHandling = System.Text.Json.Serialization.JsonUnmappedMemberHandling.Disallow,
    };

    internal async Task<CanvasGraphHistory> Heads(Guid id, long revision, CancellationToken ct)
    {
        await using var query = Store.Sql(db, tx, """
            select (select edit_revision from public.canvas_history_patch where canvas_id=$1 and not undone order by edit_revision desc limit 1),
                   (select edit_revision from public.canvas_history_patch where canvas_id=$1 and undone order by moved_at_revision desc limit 1)
            """, id);
        await using var row = await query.ExecuteReaderAsync(ct);
        await row.ReadAsync(ct);
        return new(revision, row.IsDBNull(0) ? null : row.GetInt64(0), row.IsDBNull(1) ? null : row.GetInt64(1));
    }

    internal async Task<CanvasHistoryEntry?> Read(Guid id, long revision, bool undo, CancellationToken ct)
    {
        var order = undo ? "edit_revision" : "moved_at_revision";
        await using var query = Store.Sql(db, tx, $"""
            select edit_revision,payload,digest from public.canvas_history_patch
            where canvas_id=$1 and undone=$2 order by {order} desc limit 1
            """, id, !undo);
        await using var row = await query.ExecuteReaderAsync(ct);
        if (!await row.ReadAsync(ct)) return null;
        long target = row.GetInt64(0);
        var bytes = row.GetFieldValue<byte[]>(1);
        var seal = row.GetFieldValue<byte[]>(2);
        if (target > revision || !CryptographicOperations.FixedTimeEquals(Digest(id, target, bytes), seal))
            throw new InvalidOperationException("Canvas history patch seal is invalid.");
        var payload = JsonSerializer.Deserialize<CanvasHistoryPayload>(bytes, Json);
        if (payload is not { Version: 1, Before: not null, After: not null, Patch: not null })
            throw new InvalidOperationException("Canvas history patch is invalid.");
        return new(target, payload);
    }

    internal async Task Edit(Guid id, long revision, CanvasHistoryPayload payload, CancellationToken ct)
    {
        long[] discarded = await DeleteBranch(id, onlyRedo: true, ct);
        var bytes = JsonSerializer.SerializeToUtf8Bytes(payload, Json);
        if (bytes.Length > MaxBytes) throw new InvalidOperationException("Canvas history entry exceeds the retained document budget.");
        await SqlCommands.Execute(db, tx, ct, """
            insert into public.canvas_history_patch(canvas_id,edit_revision,undone,moved_at_revision,payload,digest)
            values($1,$2,false,$2,$3,$4)
            """, id, revision, bytes, Digest(id, revision, bytes));

        // Retain one contiguous suffix. Dropping only older undo entries never creates a jump.
        await SqlCommands.Execute(db, tx, ct, """
            with newest as (
                select edit_revision,
                    row_number() over latest as position,
                    sum(octet_length(payload)) over latest as bytes
                from public.canvas_history_patch
                where canvas_id=$1
                window latest as (order by edit_revision desc)
            )
            delete from public.canvas_history_patch p using newest n
            where p.canvas_id=$1 and p.edit_revision=n.edit_revision and (n.position>$2 or n.bytes>$3)
            """, id, MaxDepth, MaxBytes);

        await Record(id, revision, null, discarded, ct);
    }

    internal async Task Move(Guid id, long revision, long target, bool undone, CancellationToken ct)
    {
        await using (var update = Store.Sql(db, tx, """
            update public.canvas_history_patch set undone=$4,moved_at_revision=$2
            where canvas_id=$1 and edit_revision=$3 and undone<>$4
            """, id, revision, target, undone))
            if (await update.ExecuteNonQueryAsync(ct) != 1)
                throw new InvalidOperationException("Canvas history changed while its document lock was held.");
        await Record(id, revision, target, [], ct);
    }

    internal async Task Clear(Guid id, long revision, CancellationToken ct)
    {
        long[] discarded = await DeleteBranch(id, onlyRedo: false, ct);
        await Record(id, revision, null, discarded, ct);
    }

    private async Task<long[]> DeleteBranch(Guid id, bool onlyRedo, CancellationToken ct)
    {
        await using var clear = Store.Sql(db, tx, """
            delete from public.canvas_history_patch where canvas_id=$1 and (not $2 or undone)
            returning edit_revision,undone
            """, id, onlyRedo);
        await using var rows = await clear.ExecuteReaderAsync(ct);
        var discarded = new List<long>();
        while (await rows.ReadAsync(ct))
            if (rows.GetBoolean(1)) discarded.Add(rows.GetInt64(0));
        discarded.Sort();
        return discarded.ToArray();
    }

    private async Task Record(Guid id, long revision, long? target, long[] discarded, CancellationToken ct)
    {
        await SqlCommands.Execute(db, tx, ct, """
            insert into public.canvas_history_transition(canvas_id,revision,target_revision,discarded_redo)
            values($1,$2,$3,$4)
            """, id, revision, new NpgsqlParameter<long?> { TypedValue = target, NpgsqlDbType = NpgsqlTypes.NpgsqlDbType.Bigint }, discarded);
    }

    private static byte[] Digest(Guid id, long revision, byte[] data)
    {
        Span<byte> coordinates = stackalloc byte[24];
        id.TryWriteBytes(coordinates, bigEndian: true, out _);
        BinaryPrimitives.WriteInt64LittleEndian(coordinates[16..], revision);
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        hash.AppendData(coordinates);
        hash.AppendData(data);
        return hash.GetHashAndReset();
    }
}

internal sealed record CanvasHistoryMetadata(string Title, CanvasViewport Viewport);
internal sealed record CanvasHistoryPayload(int Version, CanvasHistoryMetadata Before, CanvasHistoryMetadata After, CanvasHistoryPatch Patch);
internal sealed record CanvasHistoryEntry(long Revision, CanvasHistoryPayload Payload);
