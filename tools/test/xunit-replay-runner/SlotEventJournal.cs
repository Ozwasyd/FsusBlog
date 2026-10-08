using System.Text.Json;
using System.Text.Json.Serialization;

namespace FsusBlog.XunitReplayRunner;

/// <summary>
/// Retains the original synchronous reporter callbacks before execution completes.
/// A journal is diagnostic material; the parent still owns the actual process result.
/// Journal failure never changes the original runner's result or test observations.
/// </summary>
internal sealed class SlotEventJournal : IDisposable
{
    private const int MaximumEvents = 100000;
    private const int MaximumEventBytes = 128 * 1024;
    private const int MaximumJournalBytes = 16 * 1024 * 1024;
    private const int StopReserveBytes = 4096;
    private static readonly JsonSerializerOptions s_options = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };
    private readonly string _planDigest;
    private readonly string _slotId;
    private readonly FileStream? _file;
    private int _sequence;
    private long _writtenBytes;
    private bool _stopped;

    private SlotEventJournal(string planDigest, string slotId, FileStream? file)
    {
        _planDigest = planDigest;
        _slotId = slotId;
        _file = file;
    }

    public static SlotEventJournal Open(string path, string planDigest, string slotId, int tests, int collections)
    {
        FileStream? file = null;
        try
        {
            var fullPath = Path.GetFullPath(path);
            Directory.CreateDirectory(Path.GetDirectoryName(fullPath)!);
            var options = new FileStreamOptions
            {
                Mode = FileMode.CreateNew,
                Access = FileAccess.Write,
                Share = FileShare.Read,
                BufferSize = 4096
            };
            if (!OperatingSystem.IsWindows())
            {
                options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
            }
            file = new FileStream(fullPath, options);
        }
        catch (Exception exception) when (IsOutputFailure(exception))
        {
            Console.Error.WriteLine($"xUnit slot journal unavailable: {exception.GetType().Name}");
        }
        var journal = new SlotEventJournal(planDigest, slotId, file);
        journal.Record("run-opened", new
        {
            Tests = tests,
            Collections = collections,
            MaximumEvents,
            MaximumEventBytes,
            MaximumJournalBytes
        });
        return journal;
    }

    public void Record(string kind, object payload)
    {
        if (_file is null || _stopped)
        {
            return;
        }
        try
        {
            if (_sequence >= MaximumEvents - 1)
            {
                throw new InvalidOperationException("journal event budget exhausted");
            }
            using var bytes = Encode(kind, payload);
            if (_writtenBytes + bytes.Length > MaximumJournalBytes - StopReserveBytes)
            {
                throw new InvalidOperationException("journal byte budget exhausted");
            }
            Append(bytes);
        }
        catch (Exception exception) when (IsOutputFailure(exception))
        {
            _stopped = true;
            Console.Error.WriteLine($"xUnit slot journal stopped: {exception.GetType().Name}");
            try
            {
                using var bytes = Encode("journal-stopped", new
                {
                    Reason = "output-or-capacity-failure",
                    ExceptionType = exception.GetType().Name
                });
                if (_writtenBytes + bytes.Length <= MaximumJournalBytes)
                {
                    Append(bytes);
                }
            }
            catch (Exception stopException) when (IsOutputFailure(stopException))
            {
                // The parent's actual process record must mark unavailable/truncated output.
            }
        }
    }

    private MemoryStream Encode(string kind, object payload)
    {
        var bytes = new BoundedEventStream(MaximumEventBytes);
        try
        {
            JsonSerializer.Serialize(bytes, new
            {
                Schema = "fsusblog.xunit-replay-slot-journal-event.v1",
                PlanDigest = _planDigest,
                SlotId = _slotId,
                ProcessId = Environment.ProcessId,
                Sequence = _sequence,
                Kind = kind,
                QualificationEligible = false,
                Payload = payload
            }, s_options);
            bytes.WriteByte((byte)'\n');
            return bytes;
        }
        catch
        {
            bytes.Dispose();
            throw;
        }
    }

    private void Append(MemoryStream bytes)
    {
        _file!.Write(bytes.GetBuffer().AsSpan(0, checked((int)bytes.Length)));
        _file.Flush(flushToDisk: true);
        _writtenBytes += bytes.Length;
        _sequence++;
    }

    private static bool IsOutputFailure(Exception exception)
    {
        return exception is IOException or UnauthorizedAccessException or JsonException
            or InvalidOperationException or NotSupportedException;
    }

    public void Dispose()
    {
        try
        {
            _file?.Dispose();
        }
        catch (Exception exception) when (IsOutputFailure(exception))
        {
            Console.Error.WriteLine($"xUnit slot journal close failed: {exception.GetType().Name}");
        }
    }

    private sealed class BoundedEventStream(int maximumBytes) : MemoryStream
    {
        public override void Write(byte[] buffer, int offset, int count)
        {
            CheckCapacity(count);
            base.Write(buffer, offset, count);
        }

        public override void Write(ReadOnlySpan<byte> buffer)
        {
            CheckCapacity(buffer.Length);
            base.Write(buffer);
        }

        public override void WriteByte(byte value)
        {
            CheckCapacity(1);
            base.WriteByte(value);
        }

        private void CheckCapacity(int count)
        {
            if (Length + count > maximumBytes)
            {
                throw new InvalidOperationException("journal event byte budget exhausted");
            }
        }
    }
}
