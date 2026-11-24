using System.Collections.Concurrent;
using System.Diagnostics.Tracing;
using Microsoft.AspNetCore.Routing;

namespace FsusBlog.V2.Server.Operations;

internal sealed class RuntimeEvidence : IAsyncDisposable
{
    private static readonly IReadOnlyDictionary<string, object> GcConfiguration = GC.GetConfigurationVariables()
        .Where(option => option.Key is "GCConserveMem" or "GCConserveMemory" or "GCHeapCount" or
            "GCHeapHardLimit" or "GCDynamicAdaptationMode")
        .ToDictionary(option => option.Key, option => option.Value, StringComparer.Ordinal);
    private const int Background = 4;
    private const int OtherHttp = 5;
    private const int Publication = 6;
    private const int Lease = 7;
    private const int Comments = 8;
    private const int SlowRequestLimit = 4096;
    private const int SlowRequestMilliseconds = 20;
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
    private readonly bool _captureSlowRequests;
    private readonly ConcurrentQueue<SlowRequest> _slowRequests = new();
    private readonly Task _recording;
    private long _refreshes;
    private long _rebuilt;
    private long _renders;
    private long _observerTicks;
    private long _observerRequests;
    private long _observerSeen;
    private int _slowRequestCount;
    private bool _measureActive;
    private int _active;
    private int _pending;
    private int _activePeak;
    private int _pendingPeak;

    internal RuntimeEvidence(string directory, string output, IHttpContextAccessor http, bool captureSlowRequests = false)
    {
        _directory = directory;
        _http = http;
        _captureSlowRequests = captureSlowRequests;
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

    internal long SlowRequestStart(int bucket) => _captureSlowRequests && bucket < Background && Volatile.Read(ref _measureActive)
        ? Stopwatch.GetTimestamp() : 0;

    internal void CountRequest(HttpContext context, int bucket, long started)
    {
        Interlocked.Increment(ref _requests[bucket]);
        if (context.Response.StatusCode == StatusCodes.Status200OK)
            Interlocked.Increment(ref _successes[bucket]);
        if (started == 0) return;
        var elapsed = Stopwatch.GetElapsedTime(started);
        if (elapsed.TotalMilliseconds < SlowRequestMilliseconds || Interlocked.Increment(ref _slowRequestCount) > SlowRequestLimit) return;
        var finished = DateTime.UtcNow;
        _slowRequests.Enqueue(new(Classes[bucket], finished - elapsed, finished, elapsed.TotalMilliseconds,
            context.Response.StatusCode, context.Response.ContentLength));
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
                    Volatile.Write(ref _measureActive, true);
                }
                else if (mark == "measure-after") Volatile.Write(ref _measureActive, false);
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
        List<SlowRequest>? slow = null;
        if (_captureSlowRequests)
        {
            slow = [];
            while (_slowRequests.TryDequeue(out var request)) slow.Add(request);
        }
        _output.WriteLine(JsonSerializer.Serialize(new
        {
            utc, mark, pid = Environment.ProcessId,
            gcServer = System.Runtime.GCSettings.IsServerGC, gcConfiguration = GcConfiguration,
            managedAllocatedBytes = GC.GetTotalAllocatedBytes(precise: mark is not null),
            gcCollectionCounts = new[] { GC.CollectionCount(0), GC.CollectionCount(1), GC.CollectionCount(2) },
            gcTotalPauseMs = GC.GetTotalPauseDuration().TotalMilliseconds,
            gcPauses = pauses, gcUnmatched = _gc.Unmatched, gcOpenSuspensions = _gc.Pending,
            gcHeapBytes = memory.HeapSizeBytes, gcFragmentedBytes = memory.FragmentedBytes, gcCommittedBytes = memory.TotalCommittedBytes,
            requestCompleted = Counts(_requests), requestStatus200 = Counts(_successes),
            dbCommandStarts = Counts(_queries), dbPhysicalOpenStarts = Counts(_opens),
            threadPoolPending = ThreadPool.PendingWorkItemCount, threadPoolThreads = ThreadPool.ThreadCount,
            observerRequestSamples = Interlocked.Read(ref _observerRequests),
            observerRequestMeasuredTicks = Interlocked.Read(ref _observerTicks), clockTicksPerSecond = Stopwatch.Frequency,
            slowRequests = slow, slowRequestThresholdMs = _captureSlowRequests ? SlowRequestMilliseconds : (int?)null,
            slowRequestOmitted = Math.Max(0, Volatile.Read(ref _slowRequestCount) - SlowRequestLimit),
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

    internal sealed record Pause(ushort ClrInstanceId, DateTime StartUtc, DateTime RestartUtc, DateTime EndUtc)
    {
        public double SuspensionMilliseconds => (RestartUtc - StartUtc).TotalMilliseconds;
        public double ResumeMilliseconds => (EndUtc - RestartUtc).TotalMilliseconds;
        public double Milliseconds => (EndUtc - StartUtc).TotalMilliseconds;
    }

    private sealed record SlowRequest(string Route, DateTime StartUtc, DateTime EndUtc, double Milliseconds,
        int Status, long? ContentLength);

    private sealed class CollectionEvents : EventListener
    {
        private readonly PauseSequence _sequence = new();
        internal ConcurrentQueue<Pause> Pauses => _sequence.Pauses;
        internal long Unmatched => _sequence.Unmatched;
        internal int Pending => _sequence.Pending;

        protected override void OnEventSourceCreated(EventSource source)
        {
            if (_sequence is not null && source.Name == "Microsoft-Windows-DotNETRuntime")
                EnableEvents(source, EventLevel.Informational, (EventKeywords)0x1);
        }

        internal CollectionEvents()
        {
            // Existing sources are discovered during the base constructor,
            // before the pause reader's fields are initialized.
            foreach (var source in EventSource.GetSources()) OnEventSourceCreated(source);
        }

        protected override void OnEventWritten(EventWrittenEventArgs ev)
        {
            if (ev.EventId is 3 or 7 or 9)
                _sequence.Add(ev.EventId, ev.Version, ev.Payload, ev.TimeStamp.ToUniversalTime());
        }
    }

    internal sealed class PauseSequence
    {
        private sealed record Suspension(DateTime Started, DateTime Restarted, bool IsGarbageCollection);
        private readonly Dictionary<ushort, Suspension> _active = new();
        private long _unmatched;
        internal long Unmatched => Interlocked.Read(ref _unmatched);
        internal int Pending { get { lock (_active) return _active.Count; } }
        internal ConcurrentQueue<Pause> Pauses { get; } = new();

        // .NET 10 emits native EventPipe timestamps. The Version 1 suspend
        // payload is Reason, Count, ClrInstanceID, and the restart payload is
        // ClrInstanceID alone. Count is not a stable identity for the pause.
        internal void Add(int id, byte version, IReadOnlyList<object?>? fields, DateTime time)
        {
            var start = id == 9;
            var expectedCount = start ? 3 : 1;
            lock (_active)
            {
                if (version != 1 || fields?.Count != expectedCount || fields[^1] is not ushort instance ||
                    start && fields[0] is not (uint or int))
                {
                    Interlocked.Increment(ref _unmatched);
                    return;
                }
                if (start)
                {
                    if (_active.ContainsKey(instance)) Interlocked.Increment(ref _unmatched);
                    _active[instance] = new Suspension(time, default, fields[0] is 1u or 6u or 1 or 6);
                    return;
                }
                if (!_active.TryGetValue(instance, out var pending))
                {
                    Interlocked.Increment(ref _unmatched);
                    return;
                }
                if (id == 7 && pending.Restarted == default && time >= pending.Started)
                {
                    _active[instance] = pending with { Restarted = time };
                    return;
                }
                _active.Remove(instance);
                if (id != 3 || pending.Restarted == default || time < pending.Restarted)
                {
                    Interlocked.Increment(ref _unmatched);
                    return;
                }
                if (pending.IsGarbageCollection)
                    Pauses.Enqueue(new Pause(instance, pending.Started, pending.Restarted, time));
            }
        }
    }
}
