using System.Security.Cryptography;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Content;
using FsusBlogV2.Storage;
using Npgsql;
using static FsusBlog.V2.Server.SqlCommands;

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
        await Execute(db, tx, ct, "select pg_advisory_xact_lock(hashtextextended('fsus-author-document-export',0))");
        var prior = await Owned(db, tx, actor, request.Id, ct);
        if (prior is not null)
        {
            if (prior.Request != request || !Enumerable.SequenceEqual(assets, await DocumentExportInput.ReadAttachmentIds(db, tx, actor.Id, request.Id, prior.Provider, ct)))
                throw new BusinessException(Rejection.Conflict, "The request ID belongs to a different document export.");
            await RevisionHistoryStore.LockOwned(db, tx, actor.Id, request.Article, ct);
            return prior;
        }

        if (request.Format == DocumentExportFormat.Pdf && pdfToolDigest is null)
            throw new BusinessException(Rejection.Invalid, "The PDF provider is unavailable.");
        await RevisionHistoryStore.LockCurrent(db, tx, actor, request.Article, request.Revision, ct);
        if (assets.Length > 0)
        {
            var scope = request.Format switch
            {
                DocumentExportFormat.Pdf => ExportImageScope.All,
                DocumentExportFormat.Docx or DocumentExportFormat.Epub when assets.Length > 1 => ExportImageScope.Portable,
                _ => ExportImageScope.Html
            };
            if (!await CurrentSchema.HasDocumentExportAttachmentsAsync(db, tx, ct, list: assets.Length > 1) ||
                scope > ExportImageScope.Html && await CurrentSchema.ReadExportImageScopeAsync(db, tx, ct) < scope)
                throw new BusinessException(Rejection.Invalid, "The document export attachment schema is unavailable.");
        }
        var input = await DocumentExportInput.Read(db, tx, request.Article, request.SourceRevision, media, actor.Id, assets, ct);

        await Execute(db, tx, ct, """
            delete from public.author_document_export
            where expires_at<=statement_timestamp() or (owner_id=$1 and author_generation<>$2)
            """, actor.Id, actor.Generation);
        if (await Scalar(db, tx, ct, """
            select count(*)<$2 and count(*) filter (where owner_id=$1)<$3 from public.author_document_export
            """, actor.Id, SiteCapacity, Wire.DocumentExportTasksPerOwner) is not true)
            throw new BusinessException(Rejection.Conflict, "The export quota is full. Wait for an export to expire.");

        var provider = DocumentExportInput.ProviderFor(assets);
        var assetColumn = assets.Length == 1 ? ",attachment_id" : assets.Length > 1 ? ",attachment_ids" : "";
        object[] parameters = [actor.Id, request.Id, request.Article, request.Revision, request.SourceRevision, actor.Generation,
            (short)request.Format, (short)provider, input.Digest(request, provider, pdfToolDigest)];
        if (assets.Length > 0) parameters = [.. parameters, assets.Length == 1 ? (object)assets[0] : assets];
        return await QueryRequired(db, tx, ct, $"""
            insert into public.author_document_export
                (owner_id,id,article_id,expected_revision,source_revision,author_generation,format,state,provider,created_at,expires_at,source_digest{assetColumn})
            values ($1,$2,$3,$4,$5,$6,$7,1,$8,statement_timestamp(),statement_timestamp()+interval '30 minutes',$9{(assets.Length > 0 ? ",$10" : "")})
            returning {Columns}
            """, Read, null, parameters);
    }

    internal static async Task<IReadOnlyList<DocumentExportTask>> List(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor,
        int article, CancellationToken ct) =>
        await QueryList(db, tx, ct, $"""
            select {Columns} from public.author_document_export
            where owner_id=$1 and article_id=$2 and author_generation=$3 and expires_at>statement_timestamp()
            order by created_at desc,id desc limit $4
            """, Read, actor.Id, article, actor.Generation, Wire.DocumentExportTasksPerOwner);

    internal static async Task<DocumentExportTask> Cancel(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor, Guid id,
        CancellationToken ct)
    {
        var task = await Owned(db, tx, actor, id, ct) ?? throw DocumentExportContract.Missing();
        await RevisionHistoryStore.LockOwned(db, tx, actor.Id, task.Request.Article, ct);
        return await QueryOne(db, tx, ct, $"""
            update public.author_document_export
            set state=case when state=1 then 5 else 7 end,
                finished_at=case when state=1 then statement_timestamp() else null end
            where {OwnedTask} and state in (1,2)
            returning {Columns}
            """, Read, actor.Id, id, actor.Generation)
            ?? await Owned(db, tx, actor, id, ct) ?? throw DocumentExportContract.Missing();
    }

    internal static async Task<(DocumentExportFormat Format, byte[] Bytes, bool HasAttachment)> Download(NpgsqlConnection db, NpgsqlTransaction tx,
        Identity actor, Guid id, MediaFiles? media, bool privateTransport, int receiptVersion, byte[]? pdfToolDigest, CancellationToken ct)
    {
        var task = await Owned(db, tx, actor, id, ct) ?? throw DocumentExportContract.Missing();
        await RevisionHistoryStore.LockOwned(db, tx, actor.Id, task.Request.Article, ct);
        if (task.State != DocumentExportState.Succeeded || (receiptVersion == 2 && task.Request.Format is not (DocumentExportFormat.Docx or DocumentExportFormat.Epub)))
            throw DocumentExportContract.Missing();
        var receipt = receiptVersion != 0;
        var hasAttachment = task.Provider is DocumentExportInput.AttachmentProvider or DocumentExportInput.ImageListProvider;
        if (hasAttachment && !privateTransport) throw DocumentExportContract.Missing();
        var toolDigest = task.Request.Format == DocumentExportFormat.Pdf ? pdfToolDigest : null;
        if (receipt && task.Request.Format == DocumentExportFormat.Pdf && toolDigest is null)
            throw new PublicUnavailableException();
        var verified = hasAttachment || receipt
            ? await DocumentExportInput.ReadVerified(db, tx, task.Request, media, actor.Id, task.Provider, task.SourceDigest, toolDigest, ct)
            : null;
        var (output, digest) = await QueryRequired(db, tx, ct, $"""
            select output,output_digest from public.author_document_export where {OwnedTask} and state=3
            """, r => (r.GetFieldValue<byte[]>(0), r.GetFieldValue<byte[]>(1)), DocumentExportContract.Missing,
            actor.Id, id, actor.Generation);
        if (output.Length != task.OutputBytes ||
            !CryptographicOperations.FixedTimeEquals(SHA256.HashData(output), digest) ||
            !CryptographicOperations.FixedTimeEquals(task.OutputDigest!, digest))
            throw new PublicUnavailableException();
        return (task.Request.Format, receipt ? DocumentExportReceipt.Encode(task, verified!, toolDigest, receiptVersion, ct) : output, hasAttachment);
    }

    private static Task<DocumentExportTask?> Owned(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor, Guid id,
        CancellationToken ct) =>
        QueryOne(db, tx, ct, $"select {Columns} from public.author_document_export where {OwnedTask}",
            Read, actor.Id, id, actor.Generation);

    private static DocumentExportTask Read(NpgsqlDataReader row) => new(new(row.GetGuid(0), row.GetInt32(1), row.GetInt64(2),
        row.GetInt64(3), (DocumentExportFormat)row.GetInt16(4)), (DocumentExportState)row.GetInt16(5),
        (DocumentExportFailure)row.GetInt16(6), (byte)row.GetInt16(7), row.Timestamp(8), row.Timestamp(9), row.Timestamp(10),
        row.Timestamp(11), row.GetFieldValue<byte[]>(12), row.IsDBNull(13) ? null : row.GetFieldValue<byte[]>(13), row.GetInt32(14));

    private static long Timestamp(this NpgsqlDataReader row, int column) =>
        row.IsDBNull(column) ? 0 : row.GetUnixMilliseconds(column);
}
