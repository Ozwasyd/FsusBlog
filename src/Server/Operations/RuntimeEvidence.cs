using System.Collections.Concurrent;
using System.Diagnostics;
using System.Diagnostics.Tracing;
using System.Text.Json;
using FsusBlog.V2.Contracts;
using Microsoft.AspNetCore.Routing;

namespace FsusBlog.V2.Server.Operations;

internal sealed class RuntimeEvidence : IAsyncDisposable
{
    private const int Background = 4;
    private const int OtherHttp = 5;
    private const int Publication = 6;
    private const int Lease = 7;
    private const int Comments = 8;
    private static readonly string[] Classes =
        ["homeHtml", "detailHtml", "homeAeds", "detailAeds", "background", "otherHttp", "publication", "lease", "comments"];
    private readonly string _directory;
    private readonly IHttpContextAccessor _http;
    private readonly StreamWriter _output;
    private readonly CollectionEvents _gc;
    private readonly ActivityListener _db;
    private readonly CancellationTokenSource _stop = new();
    private readonly AsyncLocal<int?> _background = new();
    private readonly long[] _queries = new long[Classes.Length];
    private readonly long[] _opens = new long[Classes.Length];
    private readonly long[] _requests = new long[Classes.Length];
    private readonly long[] _successes = new long[Classes.Length];
    private readonly Task _recording;
    private long _refreshes;
    private long _rebuilt;
    private long _renders;
    private long _observerTicks;
    private long _observerRequests;
    private long _observerSeen;
    private int _active;
    private int _pending;
    private int _activePeak;
    private int _pendingPeak;

    internal RuntimeEvidence(string directory, string output, IHttpContextAccessor http)
    {
        _directory = directory;
        _http = http;
        if (!Path.IsPathFullyQualified(directory) || !Directory.Exists(directory) || !Path.IsPathFullyQualified(output))
            throw new InvalidOperationException("Runtime evidence requires absolute local control and output paths.");
        _output = new StreamWriter(new FileStream(output, FileMode.CreateNew, FileAccess.Write, FileShare.Read));
        _gc = new CollectionEvents();
        _db = new ActivityListener
        {
            ShouldListenTo = static source => source.Name == "Npgsql",
            Sample = static (ref ActivityCreationOptions<ActivityContext> _) => ActivitySamplingResult.PropagationData,
            SampleUsingParentId = static (ref ActivityCreationOptions<string> _) => ActivitySamplingResult.PropagationData,
            ActivityStarted = CountDatabaseActivity
        };
        ActivitySource.AddActivityListener(_db);
        _recording = WriteSamples(_stop.Token);
    }

    // IHttpContextAccessor carries actual request ancestry through async Npgsql calls.
    // No query text, database identity, URI, account or Activity IDs are serialized.
    private void CountDatabaseActivity(Activity activity)
    {
        var bucket = _http.HttpContext is { } request ? Classify(request) : _background.Value ?? Background;
        if (activity.OperationName.StartsWith("CONNECT ", StringComparison.Ordinal))
            Interlocked.Increment(ref _opens[bucket]);
        else
            Interlocked.Increment(ref _queries[bucket]);
    }

    internal void CountRequest(HttpContext context, int bucket)
    {
        Interlocked.Increment(ref _requests[bucket]);
        if (context.Response.StatusCode == StatusCodes.Status200OK)
            Interlocked.Increment(ref _successes[bucket]);
    }

    internal bool SampleObserverCost() => (Interlocked.Increment(ref _observerSeen) & 1023) == 0;

    internal void AccountObserverSample(long ticks)
    {
        Interlocked.Add(ref _observerTicks, ticks);
        Interlocked.Increment(ref _observerRequests);
    }

    internal static int Classify(HttpContext context)
    {
        if (HttpMethods.IsGet(context.Request.Method))
            return (context.GetEndpoint() as RouteEndpoint)?.RoutePattern.RawText switch
            {
                "/" => 0,
                "/article/{id:int}" => 1,
                WireRoutes.PublicList => 2,
                WireRoutes.PublicArticle => 3,
                WireRoutes.CommentRoots => Comments,
                _ => OtherHttp
            };
        return OtherHttp;
    }

    internal IDisposable PublicationWork() => EnterBackground(Publication);
    internal IDisposable LeaseWork() => EnterBackground(Lease);

    private IDisposable EnterBackground(int category)
    {
        var prior = _background.Value;
        _background.Value = category;
        return new BackgroundScope(_background, prior);
    }

    private sealed class BackgroundScope(AsyncLocal<int?> category, int? prior) : IDisposable
    {
        public void Dispose() => category.Value = prior;
    }

    internal void CountRefresh(bool rebuilt)
    {
        Interlocked.Increment(ref _refreshes);
        if (rebuilt) Interlocked.Increment(ref _rebuilt);
    }

    internal void ChangeCache(int pending = 0, int active = 0)
    {
        if (pending != 0) ObservePeak(ref _pendingPeak, Interlocked.Add(ref _pending, pending));
        if (active != 0) ObservePeak(ref _activePeak, Interlocked.Add(ref _active, active));
        if (active > 0) Interlocked.Increment(ref _renders);
    }

    private static void ObservePeak(ref int peak, int current)
    {
        var previous = Volatile.Read(ref peak);
        while (previous < current)
        {
            var found = Interlocked.CompareExchange(ref peak, current, previous);
            if (found == previous) return;
            previous = found;
        }
    }

    private async Task WriteSamples(CancellationToken stop)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(100));
        var next = DateTime.UtcNow;
        var command = Path.Combine(_directory, "runtime.mark");
        try
        {
            while (await timer.WaitForNextTickAsync(stop))
            {
                var now = DateTime.UtcNow;
                string? mark = null;
                if (File.Exists(command))
                {
                    mark = File.ReadAllText(command).Trim();
                    if (mark is not ("positive-before" or "positive-after" or "measure-before" or "measure-after" or "drain"))
                        throw new InvalidOperationException("Unknown runtime evidence interval marker.");
                }
                if (mark is null && now < next) continue;
                if (mark == "measure-before")
                {
                    Interlocked.Exchange(ref _activePeak, Volatile.Read(ref _active));
                    Interlocked.Exchange(ref _pendingPeak, Volatile.Read(ref _pending));
                }
                Capture(now, mark);
                next = now.AddSeconds(5);
                if (mark is not null)
                    File.Move(command, Path.Combine(_directory, mark + ".ack"));
            }
        }
        catch (OperationCanceledException) when (stop.IsCancellationRequested) { }
        finally { Capture(DateTime.UtcNow, "shutdown"); }
    }

    private void Capture(DateTime utc, string? mark)
    {
        var memory = GC.GetGCMemoryInfo();
        var pauses = new List<Pause>();
        while (_gc.Pauses.TryDequeue(out var pause)) pauses.Add(pause);
        _output.WriteLine(JsonSerializer.Serialize(new
        {
            utc, mark, pid = Environment.ProcessId,
            managedAllocatedBytes = GC.GetTotalAllocatedBytes(precise: mark is not null),
            gcCollectionCounts = new[] { GC.CollectionCount(0), GC.CollectionCount(1), GC.CollectionCount(2) },
            gcTotalPauseMs = GC.GetTotalPauseDuration().TotalMilliseconds,
            gcPauses = pauses, gcUnmatched = Interlocked.Read(ref _gc.Unmatched),
            gcHeapBytes = memory.HeapSizeBytes, gcFragmentedBytes = memory.FragmentedBytes, gcCommittedBytes = memory.TotalCommittedBytes,
            requestCompleted = Counts(_requests), requestStatus200 = Counts(_successes),
            dbCommandStarts = Counts(_queries), dbPhysicalOpenStarts = Counts(_opens),
            threadPoolPending = ThreadPool.PendingWorkItemCount, threadPoolThreads = ThreadPool.ThreadCount,
            observerRequestSamples = Interlocked.Read(ref _observerRequests),
            observerRequestMeasuredTicks = Interlocked.Read(ref _observerTicks), clockTicksPerSecond = Stopwatch.Frequency,
            coldPending = Volatile.Read(ref _pending), coldActive = Volatile.Read(ref _active),
            coldPendingPeak = Volatile.Read(ref _pendingPeak), coldActivePeak = Volatile.Read(ref _activePeak),
            coldRenders = Interlocked.Read(ref _renders),
            refreshes = Interlocked.Read(ref _refreshes), projectionBuilds = Interlocked.Read(ref _rebuilt)
        }));
        _output.Flush();
    }

    private static Dictionary<string, long> Counts(long[] values)
    {
        var result = new Dictionary<string, long>(values.Length, StringComparer.Ordinal);
        for (var i = 0; i < values.Length; i++) result.Add(Classes[i], Interlocked.Read(ref values[i]));
        return result;
    }

    public async ValueTask DisposeAsync()
    {
        await _stop.CancelAsync();
        try { await _recording; }
        finally
        {
            _db.Dispose();
            _gc.Dispose();
            _output.Dispose();
            _stop.Dispose();
        }
    }

    private sealed record Pause(DateTime StartUtc, DateTime EndUtc, double Milliseconds);

    private sealed class CollectionEvents : EventListener
    {
        private DateTime _suspendedAt;
        private bool _isGcPause;
        internal ConcurrentQueue<Pause> Pauses { get; } = new();
        internal long Unmatched;

        protected override void OnEventSourceCreated(EventSource source)
        {
            if (source.Name == "Microsoft-Windows-DotNETRuntime")
                EnableEvents(source, EventLevel.Informational, (EventKeywords)0x1);
        }

        protected override void OnEventWritten(EventWrittenEventArgs ev)
        {
            // The CLR's native timestamps describe execution-engine suspension and
            // restart, independent of scheduling delay in the managed listener.
            if (ev.EventId == 9)
            {
                if (_suspendedAt != default) Interlocked.Increment(ref Unmatched);
                _suspendedAt = ev.TimeStamp.ToUniversalTime();
                _isGcPause = ev.Payload?[0] is 1u or 6u or 1 or 6;
            }
            else if (ev.EventId == 3)
            {
                var completed = ev.TimeStamp.ToUniversalTime();
                if (_suspendedAt == default || completed < _suspendedAt) Interlocked.Increment(ref Unmatched);
                else if (_isGcPause && Pauses is not null)
                    Pauses.Enqueue(new Pause(_suspendedAt, completed, (completed - _suspendedAt).TotalMilliseconds));
                _suspendedAt = default;
            }
        }
    }
}
