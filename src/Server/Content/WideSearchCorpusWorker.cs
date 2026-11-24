using System.Threading.Channels;

namespace FsusBlog.V2.Server.Content;

internal sealed record WideSearchCorpusReady(WideSearchCorpusStage Stage, byte[] ManifestFrame);
internal sealed record PublicProjectionState(PublicSnapshot Source, WideSearchCorpusReady? Wide = null, bool WideBlocked = false);

internal sealed class WideSearchCorpusSignal
{
    private readonly Channel<byte> _changes = Channel.CreateBounded<byte>(new BoundedChannelOptions(1)
    {
        SingleReader = true,
        FullMode = BoundedChannelFullMode.DropWrite,
        AllowSynchronousContinuations = false
    });

    internal void Notify() => _changes.Writer.TryWrite(0);
    internal void Consume() => _changes.Reader.TryRead(out _);
    internal Task<bool> Wait(CancellationToken ct) => _changes.Reader.WaitToReadAsync(ct).AsTask();
}

internal sealed class PublicProjection(WideSearchCorpusSignal? signal = null)
{
    private PublicProjectionState? _current;
    private int _wideStopped;
    internal PublicProjectionState? Current => Volatile.Read(ref _current);

    internal void Replace(PublicSnapshot? source)
    {
        var previous = Current;
        if (ReferenceEquals(previous?.Source, source)) return;
        var replacement = source is null ? null : new PublicProjectionState(source);
        do
        {
            var observed = Interlocked.CompareExchange(ref _current, replacement, previous);
            if (ReferenceEquals(observed, previous))
            {
                signal?.Notify();
                return;
            }
            previous = observed;
        }
        while (!ReferenceEquals(previous?.Source, source));
    }

    internal bool TryAttach(PublicProjectionState expected, WideSearchCorpusReady ready) =>
        Volatile.Read(ref _wideStopped) == 0 && expected.Wide is null && !expected.WideBlocked &&
        Transition(expected, expected with { Wide = ready });

    internal bool TryBlockWide(PublicProjectionState expected) =>
        !expected.WideBlocked && Transition(expected, expected with { Wide = null, WideBlocked = true });

    internal void StopWide()
    {
        Interlocked.Exchange(ref _wideStopped, 1);
        while (Current is { WideBlocked: false } active && !TryBlockWide(active)) { }
    }

    private bool Transition(PublicProjectionState expected, PublicProjectionState replacement)
    {
        if (!ReferenceEquals(Interlocked.CompareExchange(ref _current, replacement, expected), expected)) return false;
        signal?.Notify();
        return true;
    }
}

internal sealed class WideSearchCorpusWorker(PublicProjection projection, WideSearchCorpusSignal signal,
    ILogger<WideSearchCorpusWorker> log, InstanceLease? lease = null,
    Func<PublicSnapshot, CancellationToken, WideSearchCorpusStage?>? build = null) : BackgroundService
{
    private const int MaxOpenSpools = 2;
    private const int MaxDocuments = 100_000;

    private sealed class Slot(WideSearchCorpusStage stage)
    {
        internal readonly WideSearchCorpusStage Stage = stage;
        internal bool Retired;
        internal bool CloseObserved;
    }

    private sealed record BuildJob(PublicProjectionState State, CancellationTokenSource Stop, Task<WideSearchCorpusStage?> Work);

    internal static bool IsEligible(PublicSnapshot source) => source.PublicArticleCount is
        > WireLimits.SearchCorpusMaxPages * WireLimits.SearchIndexPageSize and <= MaxDocuments;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken, lease?.Stopped ?? CancellationToken.None);
        var ct = stop.Token;
        using var closeAdmission = ct.UnsafeRegister(static state => ((PublicProjection)state!).StopWide(), projection);
        var slots = new List<Slot>(MaxOpenSpools);
        var waits = new List<Task>(MaxOpenSpools + 2);
        var ownershipUncertain = false;
        BuildJob? pending = null;
        Task<bool>? change = null;

        try
        {
            while (!ownershipUncertain && CurrentLease())
            {
                var current = projection.Current;
                RetireObsolete(current?.Wide?.Stage);
                SweepClosed();
                if (ownershipUncertain) break;

                if (pending is { } job)
                {
                    if (!ReferenceEquals(current, job.State) && !job.Stop.IsCancellationRequested) job.Stop.Cancel();
                    if (job.Work.IsCompleted)
                    {
                        pending = null;
                        await Collect(job, admit: true);
                        continue;
                    }
                }
                else if (slots.Count < MaxOpenSpools &&
                         current is { Wide: null, WideBlocked: false } source && IsEligible(source.Source))
                {
                    var canceled = CancellationTokenSource.CreateLinkedTokenSource(ct);
                    var work = Task.Run(() => (build ?? Build)(source.Source, canceled.Token), canceled.Token);
                    pending = new BuildJob(source, canceled, work);
                }

                change ??= signal.Wait(ct);
                waits.Clear();
                waits.Add(change);
                if (pending is { } inProgress) waits.Add(inProgress.Work);
                foreach (var slot in slots)
                    if (slot.Retired && !slot.CloseObserved) waits.Add(slot.Stage.Closed);

                if (ReferenceEquals(await Task.WhenAny(waits), change))
                {
                    if (!await change) break;
                    signal.Consume();
                    change = null;
                }
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
        finally
        {
            projection.StopWide();
            if (!ct.IsCancellationRequested) stop.Cancel();
            RetireObsolete(null);
            if (pending is { } job)
            {
                job.Stop.Cancel();
                await Collect(job, admit: false);
            }
            RetireObsolete(null);
            foreach (var slot in slots)
            {
                if (slot.CloseObserved) continue;
                try { await slot.Stage.Closed; }
                catch (Exception failure) { log.LogError(failure, "Wide search spool closure could not be confirmed."); }
            }
        }

        bool CurrentLease() => !ct.IsCancellationRequested && lease?.IsCurrent is not false;

        async Task Collect(BuildJob job, bool admit)
        {
            using var cancellation = job.Stop;
            WideSearchCorpusStage? stage;
            try { stage = await job.Work; }
            catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { return; }
            catch (Exception failure)
            {
                ownershipUncertain |= failure is WideSearchCorpusCleanupException;
                if (admit && CurrentLease()) projection.TryBlockWide(job.State);
                log.LogError(failure, "Wide search spool build failed for generation {Generation}.", job.State.Source.Generation);
                return;
            }

            if (stage is not null) slots.Add(new Slot(stage));
            if (!admit || cancellation.IsCancellationRequested || !CurrentLease() ||
                !ReferenceEquals(projection.Current, job.State)) return;
            if (stage is null)
            {
                projection.TryBlockWide(job.State);
                return;
            }

            byte[] frame;
            try
            {
                if (stage.Manifest.DocumentCount != job.State.Source.PublicArticleCount)
                    throw new ProtocolException("Wide search corpus document count does not match its source snapshot.");
                frame = WideSearchCorpusWire.Encode(job.State.Source.Generation, stage.Manifest);
            }
            catch (Exception failure)
            {
                projection.TryBlockWide(job.State);
                log.LogError(failure, "Wide search manifest could not be sealed for generation {Generation}.", job.State.Source.Generation);
                return;
            }
            if (CurrentLease()) projection.TryAttach(job.State, new WideSearchCorpusReady(stage, frame));
        }

        void RetireObsolete(WideSearchCorpusStage? current)
        {
            foreach (var slot in slots)
            {
                if (slot.Retired || ReferenceEquals(current, slot.Stage)) continue;
                slot.Retired = true;
                try { slot.Stage.Dispose(); }
                catch (Exception failure)
                {
                    ownershipUncertain = true;
                    log.LogError(failure, "Wide search spool retirement failed.");
                }
            }
        }

        void SweepClosed()
        {
            for (var i = slots.Count - 1; i >= 0; i--)
            {
                var slot = slots[i];
                if (!slot.Retired || slot.CloseObserved || !slot.Stage.Closed.IsCompleted) continue;
                slot.CloseObserved = true;
                if (slot.Stage.Closed.IsCompletedSuccessfully) slots.RemoveAt(i);
                else
                {
                    ownershipUncertain = true;
                    log.LogError(slot.Stage.Closed.Exception, "Wide search spool closure could not be confirmed.");
                }
            }
        }
    }

    private static WideSearchCorpusStage? Build(PublicSnapshot source, CancellationToken ct) =>
        WideSearchCorpusStage.Build(source.WideSearchArticles, WireLimits.SearchWideCorpusMaxPages,
            WireLimits.SearchWideCorpusTotalBytes, ct);
}
