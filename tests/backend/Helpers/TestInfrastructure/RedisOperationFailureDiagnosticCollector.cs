using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;

using FsusBlog.Server.Infrastructure.Cache;

namespace FsusBlog.Server.Tests.TestInfrastructure;

// This bounded test-only subscriber is not a producer receipt or an HTTP observation.
internal sealed class RedisOperationFailureDiagnosticCollector : IDisposable
{
    internal const int MaximumEvents = 2048;
    private readonly object _gate = new();
    private readonly RedisOperationFailureDiagnostic?[] _events;
    private readonly IDisposable _subscription;
    private int _count;
    private long _dropped;

    internal RedisOperationFailureDiagnosticCollector(int capacity = MaximumEvents)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(capacity, 1);
        ArgumentOutOfRangeException.ThrowIfGreaterThan(capacity, MaximumEvents);
        _events = new RedisOperationFailureDiagnostic[capacity];
        _subscription = RedisOperationFailureDiagnostics.Subscribe(Observe);
    }

    internal RedisOperationDiagnosticSnapshot Snapshot()
    {
        lock (_gate)
        {
            return new(_events.Length, _count, _dropped,
                _dropped == 0 ? "complete-observed-events" : "overflow-incomplete",
                _events.Take(_count).Select(static item => item!).OrderBy(static item => item.Sequence).ToArray());
        }
    }

    public void Dispose() => _subscription.Dispose();

    private void Observe(RedisOperationFailureDiagnostic observation)
    {
        lock (_gate)
        {
            if (_count == _events.Length)
            {
                _dropped++;
                return;
            }

            _events[_count++] = observation;
        }
    }

    [ModuleInitializer]
    internal static void Initialize()
    {
        string? enabled = Environment.GetEnvironmentVariable("FSUSBLOG_TEST_REDIS_DIAGNOSTICS");
        if (string.IsNullOrEmpty(enabled))
        {
            return;
        }

        if (enabled != "1")
        {
            throw new InvalidOperationException("redis_diagnostic_opt_in_invalid");
        }

        try
        {
            string runId = RequireIdentity("FSUSBLOG_TEST_LOCAL_REDIS_RUN_ID", 128, hexadecimal: false);
            string commit = RequireIdentity("FSUSBLOG_TEST_SOURCE_COMMIT", 40, hexadecimal: true);
            string fingerprint = RequireIdentity("FSUSBLOG_TEST_SOURCE_FINGERPRINT", 64, hexadecimal: true);
            string root = Environment.GetEnvironmentVariable("FSUSBLOG_TEST_REDIS_DIAGNOSTIC_ROOT") ?? "";
            ValidatePrivateRoot(root, runId);
            string testHash = HashAssembly(typeof(RedisOperationFailureDiagnosticCollector).Assembly.Location);
            string serverHash = HashAssembly(typeof(RedisOperationExecutor).Assembly.Location);
            var identity = new RedisOperationDiagnosticIdentity(
                "diagnostic-only-not-qualification", runId, commit, fingerprint,
                testHash, serverHash, Environment.ProcessId, Stopwatch.Frequency);
            string prefix = $"testhost-{Environment.ProcessId}";
            WritePrivate(root, $"{prefix}-started.json", new
            {
                Identity = identity,
                FinalizedAtProcessExit = false,
                TimingAuthority = "executor-observation-not-transport-throw",
                Capacity = MaximumEvents
            });
            var collector = new RedisOperationFailureDiagnosticCollector();
            AppDomain.CurrentDomain.ProcessExit += (_, _) =>
            {
                try
                {
                    collector.Dispose();
                    ValidatePrivateRoot(root, runId);
                    WritePrivate(root, $"{prefix}-final.json", new
                    {
                        Identity = identity,
                        FinalizedAtProcessExit = true,
                        TimingAuthority = "executor-observation-not-transport-throw",
                        Snapshot = collector.Snapshot()
                    });
                }
                catch (Exception)
                {
                    // Retain the started marker: a missing final artifact is explicitly incomplete, not business success.
                    Console.Error.WriteLine("redis_diagnostic_finalization_failed");
                }
            };
        }
        catch (Exception)
        {
            // No exception detail or path is allowed to escape failed opt-in admission.
            throw new InvalidOperationException("redis_diagnostic_initialization_failed");
        }
    }

    internal static void ValidatePrivateRoot(string root, string runId)
    {
        if (OperatingSystem.IsWindows() || !Path.IsPathFullyQualified(root)
            || Path.GetFullPath(root) != root
            || !Path.GetFileName(root).StartsWith($"redis-diagnostics-{runId}.", StringComparison.Ordinal))
        {
            throw new InvalidOperationException("redis_diagnostic_root_invalid");
        }

        var directory = new DirectoryInfo(root);
        if (!directory.Exists || File.GetUnixFileMode(root)
            != (UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute))
        {
            throw new InvalidOperationException("redis_diagnostic_root_not_private");
        }

        for (DirectoryInfo? current = directory; current is not null; current = current.Parent)
        {
            if (current.LinkTarget is not null || (current.Attributes & FileAttributes.ReparsePoint) != 0)
            {
                throw new InvalidOperationException("redis_diagnostic_root_symlink");
            }
        }
    }

    private static string RequireIdentity(string variable, int length, bool hexadecimal)
    {
        string value = Environment.GetEnvironmentVariable(variable) ?? "";
        bool valid = hexadecimal
            ? value.Length == length && value.All(static character => char.IsAsciiHexDigit(character))
            : value.Length is > 0 && value.Length <= length
                && value.All(static character => char.IsAsciiLetterOrDigit(character) || character is '-' or '_');
        if (!valid)
        {
            throw new InvalidOperationException("redis_diagnostic_identity_invalid");
        }

        return value;
    }

    private static string HashAssembly(string path)
    {
        using FileStream stream = File.OpenRead(path);
        return Convert.ToHexStringLower(SHA256.HashData(stream));
    }

    private static void WritePrivate(string root, string name, object value)
        => PublishPrivate(root, name, stream =>
        {
            var jsonOptions = new JsonSerializerOptions(JsonSerializerDefaults.Web);
            jsonOptions.Converters.Add(new JsonStringEnumConverter());
            JsonSerializer.Serialize(stream, value, jsonOptions);
        }, static stream => stream.Flush(flushToDisk: true));

    internal static void PublishPrivate(
        string root,
        string name,
        Action<FileStream> write,
        Action<FileStream> flush)
    {
        if (OperatingSystem.IsWindows())
        {
            throw new InvalidOperationException("redis_diagnostic_private_output_unsupported");
        }

        var options = new FileStreamOptions
        {
            Mode = FileMode.CreateNew,
            Access = FileAccess.Write,
            Share = FileShare.None,
            UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite
        };
        string pending = Path.Combine(root, $"{name}.pending-{Guid.NewGuid():N}");
        using (var stream = new FileStream(pending, options))
        {
            write(stream);
            flush(stream);
        }

        // Failed writes/flushes/disposal retain a distinct nonfinal leaf; publication never replaces an existing final.
        File.Move(pending, Path.Combine(root, name), overwrite: false);
    }
}

internal sealed record RedisOperationDiagnosticSnapshot(
    int Capacity,
    int RetainedCount,
    long DroppedCount,
    string Completeness,
    RedisOperationFailureDiagnostic[] Events);

internal sealed record RedisOperationDiagnosticIdentity(
    string Scope,
    string RunId,
    string SourceCommit,
    string SourceFingerprint,
    string TestAssemblySha256,
    string ServerAssemblySha256,
    int ProcessId,
    long StopwatchFrequency);
