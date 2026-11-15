using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
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
        DocumentExportCreate request, byte[]? pdfToolDigest, MediaFiles? media, Guid[] assets, CancellationToken ct)
    {
        await using (var guard = Store.Sql(db, tx, "select pg_advisory_xact_lock(hashtextextended('fsus-author-document-export',0))"))
            await guard.ExecuteNonQueryAsync(ct);
        var prior = await Owned(db, tx, actor, request.Id, ct);
        if (prior is not null)
        {
            if (prior.Request != request || !Enumerable.SequenceEqual(assets, await ReadAttachmentIds(db, tx, actor.Id, request.Id, prior.Provider, ct)))
                throw new BusinessException(Rejection.Conflict, "The request ID belongs to a different document export.");
            await RevisionHistoryStore.LockOwned(db, tx, actor.Id, request.Article, ct);
            return prior;
        }

        if (request.Format == DocumentExportFormat.Pdf && pdfToolDigest is null)
            throw new BusinessException(Rejection.Invalid, "The PDF provider is unavailable.");
        await RevisionHistoryStore.LockCurrent(db, tx, actor, request.Article, request.Revision, ct);
        if (assets.Length > 0 && !(assets.Length > 1 && request.Format != DocumentExportFormat.Html
            ? await CurrentSchema.FindExportImageListConstraintAsync(db, tx, ct, portable: true) is not null
            : await CurrentSchema.HasDocumentExportAttachmentsAsync(db, tx, ct, list: assets.Length > 1)))
            throw new BusinessException(Rejection.Invalid, "The document export attachment schema is unavailable.");
        var input = await DocumentExportInput.Read(db, tx, request, media, actor.Id, assets, ct);

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

        var provider = DocumentExportInput.ProviderFor(assets);
        var assetColumn = assets.Length == 1 ? ",attachment_id" : assets.Length > 1 ? ",attachment_ids" : "";
        object[] parameters = [actor.Id, request.Id, request.Article, request.Revision, request.SourceRevision, actor.Generation,
            (short)request.Format, (short)provider, input.Digest(request, provider, pdfToolDigest)];
        if (assets.Length > 0) parameters = [.. parameters, assets.Length == 1 ? (object)assets[0] : assets];
        await using var write = Store.Sql(db, tx, $"""
            insert into public.author_document_export
                (owner_id,id,article_id,expected_revision,source_revision,author_generation,format,state,provider,created_at,expires_at,source_digest{assetColumn})
            values ($1,$2,$3,$4,$5,$6,$7,1,$8,statement_timestamp(),statement_timestamp()+interval '30 minutes',$9{(assets.Length > 0 ? ",$10" : "")})
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
        Identity actor, Guid id, MediaFiles? media, bool privateTransport, bool receipt, byte[]? pdfToolDigest, CancellationToken ct)
    {
        var task = await Owned(db, tx, actor, id, ct) ?? throw DocumentExportEndpoints.Missing();
        await RevisionHistoryStore.LockOwned(db, tx, actor.Id, task.Request.Article, ct);
        if (task.State != DocumentExportState.Succeeded) throw DocumentExportEndpoints.Missing();
        var hasAttachment = task.Provider is DocumentExportInput.AttachmentProvider or DocumentExportInput.ImageListProvider;
        if (hasAttachment && !privateTransport) throw DocumentExportEndpoints.Missing();
        var toolDigest = task.Request.Format == DocumentExportFormat.Pdf ? pdfToolDigest : null;
        if (receipt && task.Request.Format == DocumentExportFormat.Pdf && toolDigest is null)
            throw new PublicUnavailableException();
        var verified = hasAttachment || receipt
            ? await DocumentExportInput.ReadVerified(db, tx, task.Request, media, actor.Id, task.Provider, task.SourceDigest, toolDigest, ct)
            : null;
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
        return (task.Request.Format, receipt ? SerializeReceipt(task, verified!, toolDigest) : output, hasAttachment);
    }

    private static byte[] SerializeReceipt(DocumentExportTask task, DocumentExportInput input, byte[]? toolDigest)
    {
        var (mime, format) = DocumentExportEndpoints.Presentation(task.Request.Format);
        return JsonSerializer.SerializeToUtf8Bytes(new
        {
            version = 1, taskId = task.Request.Id, article = task.Request.Article,
            expectedRevision = task.Request.Revision.ToString(CultureInfo.InvariantCulture),
            sourceRevision = task.Request.SourceRevision.ToString(CultureInfo.InvariantCulture),
            format, provider = task.Provider, layout = "basic-layout-1", state = "succeeded",
            toolchainSha256 = toolDigest is null ? null : Convert.ToHexStringLower(toolDigest),
            createdUnixMs = task.Created, startedUnixMs = task.Started, finishedUnixMs = task.Finished, expiresUnixMs = task.Expires,
            sourceSha256 = Convert.ToHexStringLower(task.SourceDigest),
            bodySha256 = TextDigest(input.Body),
            metadata = new
            {
                title = input.Title, savedUtcTicks = input.HappenedAt.UtcTicks.ToString(CultureInfo.InvariantCulture),
                titleSha256 = TextDigest(input.Title)
            },
            assets = input.Attachments.Select((image, index) => new
            {
                id = input.Assets[index], name = image.Name, mime = image.ContentType,
                width = image.Width, height = image.Height, bytes = image.Bytes.Length,
                sha256 = Convert.ToHexStringLower(image.VerifiedDigest!)
            }).ToArray(),
            output = new { mime = mime.Split(';', 2)[0], bytes = task.OutputBytes, sha256 = Convert.ToHexStringLower(task.OutputDigest!) }
        });

        static string TextDigest(string text) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(text)));
    }

    internal static async Task<Guid[]> ReadAttachmentIds(NpgsqlConnection db, NpgsqlTransaction tx, Guid owner, Guid id, short provider, CancellationToken ct)
    {
        if (provider is 1 or DocumentExportInput.CurrentProvider) return [];
        var list = provider == DocumentExportInput.ImageListProvider;
        await using var read = Store.Sql(db, tx, $"""
            select {(list ? "attachment_ids" : "array[attachment_id]")} from public.author_document_export
            where owner_id=$1 and id=$2 and provider=$3
            """, owner, id, provider);
        return await read.ExecuteScalarAsync(ct) is Guid[] assets && assets.All(asset => asset != Guid.Empty) &&
            assets.Distinct().Count() == assets.Length && DocumentExportInput.ProviderFor(assets) == provider
                ? assets : throw new PublicUnavailableException();
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
