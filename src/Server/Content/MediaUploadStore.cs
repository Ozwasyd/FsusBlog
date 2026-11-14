using System.Security.Cryptography;
using FsusBlog.V2.Core;
using Npgsql;

namespace FsusBlog.V2.Server.Content;

internal sealed record MediaUploadInput(Guid Key, string Name, MediaFormat Format, int Length, int PartSize, byte[] Digest);
internal sealed record MediaUpload(Guid Id, MediaUploadInput Input, DateTimeOffset ExpiresAt, Guid? AssetId, bool Complete)
{
    internal int Parts => (Input.Length + Input.PartSize - 1) / Input.PartSize;

    internal int PartLength(int part, int offset)
    {
        if (part < 0 || part >= Parts || offset != part * Input.PartSize)
            throw new BusinessException(Rejection.Invalid, "Invalid media part coordinate.");
        return Math.Min(Input.PartSize, Input.Length - offset);
    }
}

internal sealed class MediaUploadStore(NpgsqlConnection db, NpgsqlTransaction tx, Guid owner)
{
    private const string Fields = "id,command_id,name,format,length,part_size,digest,expires_at,asset_id,complete";

    internal async Task<MediaUpload> Begin(MediaUploadInput input, CancellationToken ct)
    {
        // A short transaction serializes admission and keeps reserved staging at 16 * 20 MiB maximum.
        await using (var admission = Store.Sql(db, tx, "SELECT pg_catalog.pg_advisory_xact_lock(4815262471654073043)"))
            await admission.ExecuteNonQueryAsync(ct);
        await Sweep(ct);

        await using (var existing = Store.Sql(db, tx, $"""
            SELECT {Fields} FROM public.private_media_upload WHERE owner_id=$1 AND command_id=$2
            AND (expires_at>clock_timestamp() OR (asset_id IS NOT NULL AND NOT complete)) FOR UPDATE
            """, owner, input.Key))
        await using (var row = await existing.ExecuteReaderAsync(ct))
            if (await row.ReadAsync(ct))
            {
                var upload = Read(row);
                if (upload.Input.Name != input.Name || upload.Input.Format != input.Format || upload.Input.Length != input.Length ||
                    upload.Input.PartSize != input.PartSize || !Same(upload.Input.Digest, input.Digest))
                    throw new BusinessException(Rejection.Conflict, "The upload key was already used by a different manifest.");
                return upload;
            }

        await using var create = Store.Sql(db, tx, $"""
            INSERT INTO public.private_media_upload (id,owner_id,command_id,name,format,length,part_size,digest,expires_at)
            SELECT $1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()+interval '6 hours'
            WHERE (SELECT count(*) FROM public.private_media_upload WHERE NOT complete) < 16
            AND (SELECT count(*) FROM public.private_media_upload WHERE owner_id=$2 AND NOT complete) < 4
            AND (SELECT count(*) FROM public.private_media_upload) < 1024
            ON CONFLICT (owner_id,command_id) DO NOTHING RETURNING {Fields}
            """, Guid.NewGuid(), owner, input.Key, input.Name, (short)input.Format, input.Length, input.PartSize, input.Digest);
        await using var inserted = await create.ExecuteReaderAsync(ct);
        if (!await inserted.ReadAsync(ct))
            throw new BusinessException(Rejection.Conflict, "Upload staging is full. Cancel another upload or retry later.");
        return Read(inserted);
    }

    private async Task Sweep(CancellationToken ct)
    {
        await using var expired = Store.Sql(db, tx, """
            SELECT id FROM public.private_media_upload WHERE expires_at<=clock_timestamp()
            AND (asset_id IS NULL OR complete)
            ORDER BY expires_at,id LIMIT 32 FOR UPDATE SKIP LOCKED
            """);
        List<Guid> ids = [];
        await using (var rows = await expired.ExecuteReaderAsync(ct))
            while (await rows.ReadAsync(ct)) ids.Add(rows.GetGuid(0));
        if (ids.Count == 0) return;
        var batch = ids.ToArray();
        await using (var parts = Store.Sql(db, tx, "DELETE FROM public.private_media_upload_part WHERE upload_id=ANY($1)", batch))
            await parts.ExecuteNonQueryAsync(ct);
        await using var uploads = Store.Sql(db, tx, "DELETE FROM public.private_media_upload WHERE id=ANY($1)", batch);
        await uploads.ExecuteNonQueryAsync(ct);
    }

    internal async Task<MediaUpload> Find(Guid id, bool locking, CancellationToken ct)
    {
        await using var command = Store.Sql(db, tx, $"""
            SELECT {Fields} FROM public.private_media_upload WHERE owner_id=$1 AND id=$2
            AND (expires_at>clock_timestamp() OR (asset_id IS NOT NULL AND NOT complete))
            """ + (locking ? " FOR UPDATE" : " FOR SHARE"), owner, id);
        await using var row = await command.ExecuteReaderAsync(ct);
        return await row.ReadAsync(ct) ? Read(row) : throw new BusinessException(Rejection.NotFound, "Private upload not found.");
    }

    internal async Task<List<int>> Received(MediaUpload upload, CancellationToken ct)
    {
        await using var query = Store.Sql(db, tx, "SELECT part FROM public.private_media_upload_part WHERE upload_id=$1 ORDER BY part LIMIT 321", upload.Id);
        await using var rows = await query.ExecuteReaderAsync(ct);
        List<int> parts = [];
        while (await rows.ReadAsync(ct))
        {
            var part = rows.GetInt32(0);
            if (part < 0 || part >= upload.Parts) throw new InvalidOperationException("Private upload parts are inconsistent.");
            parts.Add(part);
        }
        return parts;
    }

    internal async Task AddPart(MediaUpload upload, int part, int offset, byte[] digest, byte[] data, CancellationToken ct)
    {
        if (upload.AssetId.HasValue) throw new BusinessException(Rejection.Conflict, "The private image is already reserved.");
        if (upload.PartLength(part, offset) != data.Length) throw new BusinessException(Rejection.Invalid, "Invalid media part length.");
        await using var command = Store.Sql(db, tx, """
            INSERT INTO public.private_media_upload_part (upload_id,part,digest,bytes)
            VALUES ($1,$2,$3,$4) ON CONFLICT (upload_id,part) DO NOTHING
            """, upload.Id, part, digest, data);
        if (await command.ExecuteNonQueryAsync(ct) == 1) return;
        await using var exact = Store.Sql(db, tx, """
            SELECT 1 FROM public.private_media_upload_part WHERE upload_id=$1 AND part=$2 AND digest=$3 AND bytes=$4
            """, upload.Id, part, digest, data);
        if (await exact.ExecuteScalarAsync(ct) is null)
            throw new BusinessException(Rejection.Conflict, "This media part already has different contents.");
    }

    internal async Task<byte[]> Assemble(MediaUpload upload, CancellationToken ct)
    {
        var parts = await Received(upload, ct);
        if (parts.Count != upload.Parts) throw new BusinessException(Rejection.Conflict, "Private upload is missing parts.");
        var data = new byte[upload.Input.Length];
        await using var query = Store.Sql(db, tx, """
            SELECT part,digest,bytes FROM public.private_media_upload_part WHERE upload_id=$1 ORDER BY part
            """, upload.Id);
        await using var rows = await query.ExecuteReaderAsync(ct);
        var index = 0;
        while (await rows.ReadAsync(ct))
        {
            var offset = index * upload.Input.PartSize;
            var part = rows.GetFieldValue<byte[]>(2);
            if (index != rows.GetInt32(0) || part.Length != upload.PartLength(index, offset) ||
                !Same(SHA256.HashData(part), rows.GetFieldValue<byte[]>(1)))
                throw new InvalidOperationException("A private upload part changed after it was recorded.");
            part.CopyTo(data, offset);
            index++;
        }
        if (index != parts.Count || !Same(SHA256.HashData(data), upload.Input.Digest))
            throw new BusinessException(Rejection.Conflict, "The assembled image does not match its declared digest.");
        return data;
    }

    internal async Task Reserve(MediaUpload upload, Guid asset, CancellationToken ct)
    {
        await using var command = Store.Sql(db, tx, "UPDATE public.private_media_upload SET asset_id=$3 WHERE owner_id=$1 AND id=$2 AND asset_id IS NULL",
            owner, upload.Id, asset);
        await command.ExecuteNonQueryAsync(ct);
    }

    internal async Task Finish(MediaUpload upload, CancellationToken ct)
    {
        await using var command = Store.Sql(db, tx, """
            UPDATE public.private_media_upload SET complete=true,expires_at=greatest(expires_at,clock_timestamp()+interval '1 hour')
            WHERE owner_id=$1 AND id=$2;
            """, owner, upload.Id);
        await command.ExecuteNonQueryAsync(ct);
        await RemoveParts(upload.Id, ct);
    }

    internal async Task Cancel(MediaUpload upload, CancellationToken ct)
    {
        await RemoveParts(upload.Id, ct);
        await using var command = Store.Sql(db, tx, "DELETE FROM public.private_media_upload WHERE owner_id=$1 AND id=$2", owner, upload.Id);
        await command.ExecuteNonQueryAsync(ct);
    }

    private async Task RemoveParts(Guid id, CancellationToken ct)
    {
        await using var command = Store.Sql(db, tx, "DELETE FROM public.private_media_upload_part WHERE upload_id=$1", id);
        await command.ExecuteNonQueryAsync(ct);
    }

    private static MediaUpload Read(NpgsqlDataReader row) => new(row.GetGuid(0),
        new MediaUploadInput(row.GetGuid(1), row.GetString(2), (MediaFormat)row.GetInt16(3), row.GetInt32(4),
            row.GetInt32(5), row.GetFieldValue<byte[]>(6)), row.GetFieldValue<DateTimeOffset>(7), row.IsDBNull(8) ? null : row.GetGuid(8), row.GetBoolean(9));

    internal static bool Same(byte[] left, byte[] right) => CryptographicOperations.FixedTimeEquals(left, right);
}
