using System.Security.Cryptography;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Content;
using FsusBlogV2.Storage;
using Npgsql;

namespace FsusBlog.V2.Server.Authoring;

internal static class DocumentExportStore
{
    private const int SiteCapacity = 16;
    private const string Columns = """
        id,article_id,expected_revision,source_revision,format,state,failure,provider,created_at,started_at,
        finished_at,expires_at,source_digest,output_digest,coalesce(octet_length(output),0)
        """;
    private const string OwnedTask = "owner_id=$1 and id=$2 and author_generation=$3 and expires_at>statement_timestamp()";

    internal static async Task<DocumentExportTask> Create(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor,
        DocumentExportCreate request, byte[]? pdfToolDigest, MediaFiles? media, Guid? asset, CancellationToken ct)
    {
        await using (var guard = Store.Sql(db, tx, "select pg_advisory_xact_lock(hashtextextended('fsus-author-document-export',0))"))
            await guard.ExecuteNonQueryAsync(ct);
        var prior = await Owned(db, tx, actor, request.Id, ct);
        if (prior is not null)
        {
            if (prior.Request != request || (prior.Provider == DocumentExportInput.AttachmentProvider) != asset.HasValue ||
                (asset.HasValue && await ReadAttachmentId(db, tx, actor.Id, request.Id, ct) != asset.Value))
                throw new BusinessException(Rejection.Conflict, "The request ID belongs to a different document export.");
            await RevisionHistoryStore.LockOwned(db, tx, actor.Id, request.Article, ct);
            return prior;
        }

        if (request.Format == DocumentExportFormat.Pdf && pdfToolDigest is null)
            throw new BusinessException(Rejection.Invalid, "The PDF provider is unavailable.");
        await RevisionHistoryStore.LockCurrent(db, tx, actor, request.Article, request.Revision, ct);
        if (asset.HasValue && !await CurrentSchema.HasDocumentExportAttachmentsAsync(db, tx, ct))
            throw new BusinessException(Rejection.Invalid, "The document export attachment schema is unavailable.");
        var input = await DocumentExportInput.Read(db, tx, request, media, actor.Id, asset, ct);

        await using (var remove = Store.Sql(db, tx, """
            delete from public.author_document_export
            where expires_at<=statement_timestamp() or (owner_id=$1 and author_generation<>$2)
            """, actor.Id, actor.Generation))
            await remove.ExecuteNonQueryAsync(ct);
        await using (var quota = Store.Sql(db, tx, """
            select count(*)<$2 and count(*) filter (where owner_id=$1)<$3 from public.author_document_export
            """, actor.Id, SiteCapacity, Wire.DocumentExportTasksPerOwner))
        {
            if (await quota.ExecuteScalarAsync(ct) is not true)
                throw new BusinessException(Rejection.Conflict, "The export quota is full. Wait for an export to expire.");
        }

        var provider = asset.HasValue ? DocumentExportInput.AttachmentProvider : DocumentExportInput.CurrentProvider;
        object[] parameters = [actor.Id, request.Id, request.Article, request.Revision, request.SourceRevision, actor.Generation,
            (short)request.Format, (short)provider, input.Digest(request, provider, pdfToolDigest)];
        if (asset is Guid selected) parameters = [.. parameters, selected];
        await using var write = Store.Sql(db, tx, $"""
            insert into public.author_document_export
                (owner_id,id,article_id,expected_revision,source_revision,author_generation,format,state,provider,created_at,expires_at,source_digest{(asset.HasValue ? ",attachment_id" : "")})
            values ($1,$2,$3,$4,$5,$6,$7,1,$8,statement_timestamp(),statement_timestamp()+interval '30 minutes',$9{(asset.HasValue ? ",$10" : "")})
            returning {Columns}
            """, parameters);
        await using var receipt = await write.ExecuteReaderAsync(ct);
        await receipt.ReadAsync(ct);
        return Read(receipt);
    }

    internal static async Task<IReadOnlyList<DocumentExportTask>> List(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor,
        int article, CancellationToken ct)
    {
        await using var list = Store.Sql(db, tx, $"""
            select {Columns} from public.author_document_export
            where owner_id=$1 and article_id=$2 and author_generation=$3 and expires_at>statement_timestamp()
            order by created_at desc,id desc limit $4
            """, actor.Id, article, actor.Generation, Wire.DocumentExportTasksPerOwner);
        await using var rows = await list.ExecuteReaderAsync(ct);
        var tasks = new List<DocumentExportTask>(Wire.DocumentExportTasksPerOwner);
        while (await rows.ReadAsync(ct)) tasks.Add(Read(rows));
        return tasks;
    }

    internal static async Task<DocumentExportTask> Cancel(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor, Guid id,
        CancellationToken ct)
    {
        var task = await Owned(db, tx, actor, id, ct) ?? throw DocumentExportEndpoints.Missing();
        await RevisionHistoryStore.LockOwned(db, tx, actor.Id, task.Request.Article, ct);
        await using var update = Store.Sql(db, tx, $"""
            update public.author_document_export
            set state=case when state=1 then 5 else 7 end,
                finished_at=case when state=1 then statement_timestamp() else null end
            where {OwnedTask} and state in (1,2)
            returning {Columns}
            """, actor.Id, id, actor.Generation);
        await using (var row = await update.ExecuteReaderAsync(ct))
            if (await row.ReadAsync(ct)) return Read(row);
        return await Owned(db, tx, actor, id, ct) ?? throw DocumentExportEndpoints.Missing();
    }

    internal static async Task<(DocumentExportFormat Format, byte[] Bytes, bool HasAttachment)> Download(NpgsqlConnection db, NpgsqlTransaction tx,
        Identity actor, Guid id, MediaFiles? media, bool privateTransport, CancellationToken ct)
    {
        var task = await Owned(db, tx, actor, id, ct) ?? throw DocumentExportEndpoints.Missing();
        await RevisionHistoryStore.LockOwned(db, tx, actor.Id, task.Request.Article, ct);
        if (task.State != DocumentExportState.Succeeded) throw DocumentExportEndpoints.Missing();
        var hasAttachment = task.Provider == DocumentExportInput.AttachmentProvider;
        if (hasAttachment)
        {
            if (!privateTransport) throw DocumentExportEndpoints.Missing();
            var asset = await ReadAttachmentId(db, tx, actor.Id, id, ct);
            var input = await DocumentExportInput.Read(db, tx, task.Request, media, actor.Id, asset, ct);
            if (!CryptographicOperations.FixedTimeEquals(task.SourceDigest, input.Digest(task.Request, task.Provider, null)))
                throw new PublicUnavailableException();
        }
        await using var read = Store.Sql(db, tx, $"""
            select output,output_digest from public.author_document_export where {OwnedTask} and state=3
            """, actor.Id, id, actor.Generation);
        await using var row = await read.ExecuteReaderAsync(ct);
        if (!await row.ReadAsync(ct)) throw DocumentExportEndpoints.Missing();
        var output = row.GetFieldValue<byte[]>(0);
        if (output.Length != task.OutputBytes ||
            !CryptographicOperations.FixedTimeEquals(SHA256.HashData(output), row.GetFieldValue<byte[]>(1)) ||
            !CryptographicOperations.FixedTimeEquals(task.OutputDigest!, row.GetFieldValue<byte[]>(1)))
            throw new PublicUnavailableException();
        return (task.Request.Format, output, hasAttachment);
    }

    internal static async Task<Guid> ReadAttachmentId(NpgsqlConnection db, NpgsqlTransaction tx, Guid owner, Guid id, CancellationToken ct)
    {
        await using var read = Store.Sql(db, tx, """
            select attachment_id from public.author_document_export where owner_id=$1 and id=$2 and provider=3
            """, owner, id);
        return await read.ExecuteScalarAsync(ct) is Guid asset ? asset : throw new PublicUnavailableException();
    }

    private static async Task<DocumentExportTask?> Owned(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor, Guid id,
        CancellationToken ct)
    {
        await using var read = Store.Sql(db, tx, $"""
            select {Columns} from public.author_document_export where {OwnedTask}
            """, actor.Id, id, actor.Generation);
        await using var row = await read.ExecuteReaderAsync(ct);
        return await row.ReadAsync(ct) ? Read(row) : null;
    }

    private static DocumentExportTask Read(NpgsqlDataReader row) => new(new(row.GetGuid(0), row.GetInt32(1), row.GetInt64(2),
        row.GetInt64(3), (DocumentExportFormat)row.GetInt16(4)), (DocumentExportState)row.GetInt16(5),
        (DocumentExportFailure)row.GetInt16(6), (byte)row.GetInt16(7), row.Timestamp(8), row.Timestamp(9), row.Timestamp(10),
        row.Timestamp(11), row.GetFieldValue<byte[]>(12), row.IsDBNull(13) ? null : row.GetFieldValue<byte[]>(13), row.GetInt32(14));

    private static long Timestamp(this NpgsqlDataReader row, int column) =>
        row.IsDBNull(column) ? 0 : row.GetFieldValue<DateTimeOffset>(column).ToUnixTimeMilliseconds();
}
