using System.Net.Sockets;
using Npgsql;

namespace FsusBlog.V2.Server.Communication;

internal sealed class InboxWake(string connectionString, ILogger<InboxWake> log) : BackgroundService
{
    private static readonly TimeSpan WaitSlice = TimeSpan.FromSeconds(1);
    private readonly string _listenerConnection = new NpgsqlConnectionStringBuilder(connectionString)
    {
        Pooling = false, Enlist = false, Multiplexing = false, Timeout = 3, CommandTimeout = 2,
    }.ConnectionString;
    private TaskCompletionSource _next = NewPulse();

    internal Task Changed => Volatile.Read(ref _next).Task;

    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        while (!stop.IsCancellationRequested)
        {
            try
            {
                await using var connection = new NpgsqlConnection(_listenerConnection);
                await connection.OpenAsync();
                connection.Notification += (_, _) => Pulse();
                await using (var listen = new NpgsqlCommand("listen fsus_v2_inbox", connection))
                    await listen.ExecuteNonQueryAsync();
                // A stream can have missed a commit while the listener was unavailable.
                Pulse();
                // Let Npgsql finish the bounded wait before closing the notification socket.
                while (!stop.IsCancellationRequested) await connection.WaitAsync(WaitSlice);
            }
            catch (Exception failure) when (failure is NpgsqlException or SocketException)
            {
                if (stop.IsCancellationRequested) return;
                log.LogWarning(failure, "Inbox wake listener will reconnect.");
                await Task.Delay(TimeSpan.FromSeconds(2), stop);
            }
        }
    }

    private void Pulse() => Interlocked.Exchange(ref _next, NewPulse()).TrySetResult();
    private static TaskCompletionSource NewPulse() => new(TaskCreationOptions.RunContinuationsAsynchronously);
}
