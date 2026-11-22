namespace FsusBlog.V2.Contracts;

public enum DocumentExportFormat : byte { Html = 1, Pdf, Docx, Epub }
public enum DocumentExportState : byte { Queued = 1, Running, Succeeded, Failed, Cancelled, Blocked, Cancelling }
public enum DocumentExportFailure : byte { None, Unsupported, Unavailable, Permission, Interrupted }

public sealed record DocumentExportCreate(Guid Id, int Article, long Revision, long SourceRevision, DocumentExportFormat Format);
public sealed record DocumentExportTask(DocumentExportCreate Request, DocumentExportState State, DocumentExportFailure Failure,
    byte Provider, long Created, long Started, long Finished, long Expires, byte[] SourceDigest, byte[]? OutputDigest, int OutputBytes);

public static partial class Wire
{
    public const int DocumentExportTasksPerOwner = 4;
    private const int DocumentExportTaskSize = 140;
    private static readonly byte[] AbsentDocumentExportDigest = new byte[32];

    public static byte[] EncodeDocumentExportCreate(DocumentExportCreate request) =>
        EncodeRecord(FrameType.DocumentExportCreate, request, ValidateDocumentExport, WriteDocumentExportRequest);

    public static DocumentExportCreate DecodeDocumentExportCreate(ReadOnlySpan<byte> frame)
    {
        var reader = new Reader(Aeds.Decode(frame, FrameType.DocumentExportCreate));
        var value = ReadDocumentExportRequest(ref reader);
        reader.Finish();
        return value;
    }

    public static byte[] EncodeDocumentExportTaskRef(Guid id)
    {
        if (id == Guid.Empty) throw InvalidDocumentExport();
        var writer = new Writer();
        writer.Uuid(id);
        return Aeds.Encode(FrameType.DocumentExportTaskRef, writer.Written);
    }

    public static Guid DecodeDocumentExportTaskRef(ReadOnlySpan<byte> frame)
    {
        var reader = new Reader(Aeds.Decode(frame, FrameType.DocumentExportTaskRef));
        var id = reader.Uuid();
        reader.Finish();
        return id == Guid.Empty ? throw InvalidDocumentExport() : id;
    }

    public static byte[] EncodeDocumentExportTask(DocumentExportTask value)
    {
        var writer = new Writer();
        WriteDocumentExportTask(writer, value);
        return Aeds.Encode(FrameType.DocumentExportTask, writer.Written);
    }

    public static DocumentExportTask DecodeDocumentExportTask(ReadOnlySpan<byte> frame)
    {
        var reader = new Reader(Aeds.Decode(frame, FrameType.DocumentExportTask));
        var result = ReadDocumentExportTask(ref reader);
        reader.Finish();
        return result;
    }

    public static byte[] EncodeDocumentExportTaskList(IReadOnlyList<DocumentExportTask> values)
    {
        if (values.Count > DocumentExportTasksPerOwner) throw InvalidDocumentExport();
        var writer = new Writer();
        writer.FixedBytes([(byte)values.Count]);
        foreach (var value in values) WriteDocumentExportTask(writer, value);
        return Aeds.Encode(FrameType.DocumentExportTaskList, writer.Written);
    }

    public static IReadOnlyList<DocumentExportTask> DecodeDocumentExportTaskList(ReadOnlySpan<byte> frame)
    {
        var payload = Aeds.Decode(frame, FrameType.DocumentExportTaskList);
        if (payload.IsEmpty || payload[0] > DocumentExportTasksPerOwner || payload.Length != 1 + payload[0] * DocumentExportTaskSize)
            throw InvalidDocumentExport();
        var result = new DocumentExportTask[payload[0]];
        var reader = new Reader(payload[1..]);
        for (var index = 0; index < result.Length; index++) result[index] = ReadDocumentExportTask(ref reader);
        return result;
    }

    private static void WriteDocumentExportRequest(Writer writer, DocumentExportCreate request)
    {
        writer.Uuid(request.Id);
        writer.I32(request.Article);
        writer.I64(request.Revision);
        writer.I64(request.SourceRevision);
        writer.FixedBytes([(byte)request.Format]);
    }

    private static DocumentExportCreate ReadDocumentExportRequest(ref Reader reader)
    {
        var request = new DocumentExportCreate(reader.Uuid(), reader.I32(), reader.I64(), reader.I64(),
            (DocumentExportFormat)reader.FixedBytes(1)[0]);
        ValidateDocumentExport(request);
        return request;
    }

    private static void WriteDocumentExportTask(Writer writer, DocumentExportTask task)
    {
        ValidateDocumentExportTask(task);
        WriteDocumentExportRequest(writer, task.Request);
        writer.FixedBytes([(byte)task.State, (byte)task.Failure, task.Provider]);
        writer.I64(task.Created);
        writer.I64(task.Started);
        writer.I64(task.Finished);
        writer.I64(task.Expires);
        writer.FixedBytes(task.SourceDigest);
        writer.FixedBytes(task.OutputDigest ?? AbsentDocumentExportDigest);
        writer.I32(task.OutputBytes);
    }

    private static DocumentExportTask ReadDocumentExportTask(ref Reader reader)
    {
        var request = ReadDocumentExportRequest(ref reader);
        var flags = reader.FixedBytes(3);
        var result = new DocumentExportTask(request, (DocumentExportState)flags[0], (DocumentExportFailure)flags[1], flags[2],
            reader.I64(), reader.I64(), reader.I64(), reader.I64(), reader.FixedBytes(32).ToArray(), reader.FixedBytes(32).ToArray(), reader.I32());
        if (result.OutputBytes == 0 && result.OutputDigest!.AsSpan().IndexOfAnyExcept((byte)0) == -1)
            result = result with { OutputDigest = null };
        ValidateDocumentExportTask(result);
        return result;
    }

    private static void ValidateDocumentExport(DocumentExportCreate request)
    {
        if (request.Id == Guid.Empty || request.Article <= 0 || request.SourceRevision <= 0 ||
            request.SourceRevision > request.Revision || !Enum.IsDefined(request.Format))
            throw InvalidDocumentExport();
    }

    private static void ValidateDocumentExportTask(DocumentExportTask task)
    {
        ValidateDocumentExport(task.Request);
        var ready = task.State == DocumentExportState.Succeeded;
        var terminal = task.State is DocumentExportState.Succeeded or DocumentExportState.Failed or
            DocumentExportState.Cancelled or DocumentExportState.Blocked;
        var failure = task.State is DocumentExportState.Failed or DocumentExportState.Blocked;
        if (!Enum.IsDefined(task.State) || !Enum.IsDefined(task.Failure) || task.Provider is < 1 or > 4 ||
            task.Created <= 0 || task.Expires <= task.Created ||
            (task.Started != 0 && task.Started < task.Created) ||
            (task.Finished != 0 && task.Finished < Math.Max(task.Created, task.Started)) ||
            (task.State is DocumentExportState.Running or DocumentExportState.Cancelling or DocumentExportState.Succeeded && task.Started == 0) ||
            terminal != (task.Finished != 0) || failure != (task.Failure != DocumentExportFailure.None) ||
            task.SourceDigest.Length != 32 ||
            (ready ? task.OutputDigest?.Length != 32 || task.OutputBytes is <= 0 or > 4 * 1024 * 1024 :
                task.OutputDigest is not null || task.OutputBytes != 0))
            throw InvalidDocumentExport();
    }

    private static ProtocolException InvalidDocumentExport() => new("Invalid document export frame.");
}
