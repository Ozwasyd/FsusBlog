using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace FsusBlog.Server.Tests.Unit;

internal sealed class BackendPropertyExecutionJournal : IDisposable
{
    private const int MaximumBytes = 16 * 1024 * 1024;
    private const int MaximumEventBytes = 128 * 1024;
    private const int MaximumEvents = 100000;
    private readonly object _identity;
    private readonly FileStream? _file;
    private int _sequence;
    private long _storedBytes;
    private bool _stopped;
    private object? _firstFailure;

    private BackendPropertyExecutionJournal(object identity, FileStream? file)
    {
        _identity = identity;
        _file = file;
    }

    public static BackendPropertyExecutionJournal Open(string canonicalTestId, string streamId)
    {
        string? seed = null;
        string? directory = Environment.GetEnvironmentVariable("FSUSBLOG_RANDOM_EXECUTION_DIR");
        FileStream? file = null;
        if (directory is not null)
        {
            try
            {
                using var streams = JsonDocument.Parse(Environment.GetEnvironmentVariable("FSUSBLOG_RANDOM_STREAMS_JSON") ?? "{}");
                if (streams.RootElement.TryGetProperty($"{canonicalTestId}\0{streamId}", out var value))
                    seed = value.GetString();
                if (streamId.Length == 0 || streamId.Any(character => !(char.IsAsciiLetterLower(character) || char.IsAsciiDigit(character) || character == '-')))
                    throw new InvalidOperationException("random journal stream filename is invalid");
                var options = new FileStreamOptions { Mode = FileMode.CreateNew, Access = FileAccess.Write, Share = FileShare.Read };
                if (!OperatingSystem.IsWindows())
                    options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
                file = new FileStream(Path.Combine(directory, $"{streamId}.events.jsonl"), options);
            }
            catch (Exception exception)
            {
                Console.Error.WriteLine($"backend property journal unavailable: {exception.GetType().Name}");
            }
        }
        var journal = new BackendPropertyExecutionJournal(new
        {
            CanonicalTestId = canonicalTestId,
            StreamId = streamId,
            DerivedSeed = seed,
            RunId = Environment.GetEnvironmentVariable("FSUSBLOG_RANDOM_EXECUTION_RUN"),
            AttemptId = Environment.GetEnvironmentVariable("FSUSBLOG_RANDOM_EXECUTION_ATTEMPT"),
            ReplayPlanDigest = Environment.GetEnvironmentVariable("FSUSBLOG_REPLAY_PLAN_DIGEST")
        }, file);
        journal.Record("execution-opened", new
        {
        });
        return journal;
    }

    public void Observe(string sampleSerialization, int caseIndex, Action oracle)
    {
        string Digest(string value) => $"sha256:{Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)))}";
        string caseIdentity = Digest($"{caseIndex}:{sampleSerialization}");
        Record("case-generated", new
        {
            CaseIndex = caseIndex,
            CaseIdentity = caseIdentity,
            SampleSerialization = sampleSerialization,
            InputDigest = Digest(sampleSerialization)
        });
        try
        {
            oracle();
        }
        catch (Exception exception)
        {
            var failure = new
            {
                CaseIndex = caseIndex,
                CaseIdentity = caseIdentity,
                ExceptionType = exception.GetType().FullName,
                exception.Message,
                exception.StackTrace
            };
            _firstFailure ??= failure;
            Record("case-outcome", new
            {
                Outcome = "failed",
                Failure = failure,
                FirstFailure = _firstFailure
            });
            throw;
        }
        Record("case-outcome", new
        {
            CaseIndex = caseIndex,
            CaseIdentity = caseIdentity,
            Outcome = "passed"
        });
    }

    public void Complete(int observedCases)
    {
        if (_firstFailure is null)
            Record("execution-completed", new
            {
                Outcome = "passed",
                ObservedCases = observedCases
            });
    }

    private void Record(string kind, object payload)
    {
        if (_file is null || _stopped)
            return;
        try
        {
            byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(new
            {
                Schema = "fsusblog.random-execution-event.v1",
                QualificationEligible = false,
                ProcessId = Environment.ProcessId,
                Identity = _identity,
                Sequence = _sequence,
                Kind = kind,
                Payload = payload
            }, new JsonSerializerOptions(JsonSerializerDefaults.Web));
            if (bytes.Length + 1 > MaximumEventBytes || _storedBytes + bytes.Length + 1 > MaximumBytes || _sequence >= MaximumEvents)
                throw new InvalidOperationException("backend property journal capacity exhausted");
            _file.Write(bytes);
            _file.WriteByte((byte)'\n');
            _file.Flush(flushToDisk: true);
            _storedBytes += bytes.Length + 1;
            _sequence++;
        }
        catch (Exception exception)
        {
            _stopped = true;
            Console.Error.WriteLine($"backend property journal stopped: {exception.GetType().Name}");
        }
    }

    public void Dispose()
    {
        try
        {
            _file?.Dispose();
        }
        catch (IOException exception)
        {
            Console.Error.WriteLine($"backend property journal close failed: {exception.GetType().Name}");
        }
    }
}
