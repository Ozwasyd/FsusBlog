using Npgsql;

namespace FsusBlog.V2.Server.Communication;

internal sealed class InboxWake(NpgsqlDataSource source, ILogger<InboxWake> log) : BackgroundService
{
    private TaskCompletionSource _next = NewPulse();

    internal Task Changed => Volatile.Read(ref _next).Task;

    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        while (!stop.IsCancellationRequested)
        {
            try
            {
                await using var connection = await source.OpenConnectionAsync(stop);
                connection.Notification += (_, _) => Pulse();
                await using (var listen = new NpgsqlCommand("listen fsus_v2_inbox", connection))
                    await listen.ExecuteNonQueryAsync(stop);
                // A stream can have missed a commit while the listener was unavailable.
                Pulse();
                while (!stop.IsCancellationRequested) await connection.WaitAsync(stop);
            }
            catch (NpgsqlException failure) when (!stop.IsCancellationRequested)
            {
                log.LogWarning(failure, "Inbox wake listener will reconnect.");
                await Task.Delay(TimeSpan.FromSeconds(2), stop);
            }
        }
    }

    private void Pulse() => Interlocked.Exchange(ref _next, NewPulse()).TrySetResult();
    private static TaskCompletionSource NewPulse() => new(TaskCreationOptions.RunContinuationsAsynchronously);
}
