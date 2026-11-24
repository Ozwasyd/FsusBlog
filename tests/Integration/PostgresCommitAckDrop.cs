using System.Net.Sockets;

namespace FsusBlog.V2.Integration.Tests;

internal sealed class PostgresCommitAckDrop : IAsyncDisposable
{
    private readonly CancellationTokenSource _stop = new();
    private readonly UnixDomainSocketEndPoint _upstream;
    private readonly string _directory;
    private readonly Socket _listener;
    private readonly Task _worker;
    private TaskCompletionSource? _nextCommit;

    internal string ConnectionString { get; }

    internal PostgresCommitAckDrop(string connectionString)
    {
        var settings = new NpgsqlConnectionStringBuilder(connectionString);
        var host = settings.Host;
        if (OperatingSystem.IsWindows() || !Socket.OSSupportsUnixDomainSockets || string.IsNullOrEmpty(host) ||
            !Path.IsPathRooted(host) || host.Contains(','))
            throw new ArgumentException("The commit acknowledgment fixture needs one PostgreSQL Unix socket.", nameof(connectionString));

        var name = $".s.PGSQL.{settings.Port}";
        _upstream = new UnixDomainSocketEndPoint(Path.Combine(host, name));
        _directory = Path.Combine("/tmp", $"fsus-pg-ack-{Guid.NewGuid():N}");
        Directory.CreateDirectory(_directory, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        settings.Host = _directory;
        settings.SslMode = SslMode.Disable;
        settings.GssEncryptionMode = GssEncryptionMode.Disable;
        ConnectionString = settings.ConnectionString;
        _listener = UnixSocket();
        try
        {
            _listener.Bind(new UnixDomainSocketEndPoint(Path.Combine(_directory, name)));
            _listener.Listen(2);
            _worker = Run(_stop.Token);
        }
        catch
        {
            _listener.Dispose();
            _stop.Dispose();
            Directory.Delete(_directory, recursive: true);
            throw;
        }
    }

    internal Task DropNextCommitAcknowledgment()
    {
        var drop = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        if (Interlocked.CompareExchange(ref _nextCommit, drop, null) is not null)
            throw new InvalidOperationException("A PostgreSQL COMMIT acknowledgment drop is already armed.");
        return drop.Task;
    }

    private async Task Run(CancellationToken stopped)
    {
        while (true)
        {
            using var clientSocket = await _listener.AcceptAsync(stopped);
            using var serverSocket = UnixSocket();
            await serverSocket.ConnectAsync(_upstream, stopped);
            using var client = new NetworkStream(clientSocket);
            using var server = new NetworkStream(serverSocket);
            using var connection = CancellationTokenSource.CreateLinkedTokenSource(stopped);
            var send = client.CopyToAsync(server, connection.Token);
            var receive = ForwardResponses(server, client, connection.Token);
            try
            {
                var completed = await Task.WhenAny(send, receive);
                await completed;
            }
            finally
            {
                await connection.CancelAsync();
                try { await Task.WhenAll(send, receive); }
                catch (OperationCanceledException) when (connection.IsCancellationRequested) { }
            }
        }
    }

    private async Task ForwardResponses(Stream server, Stream client, CancellationToken ct)
    {
        var header = new byte[5];
        while (await server.ReadAsync(header.AsMemory(0, 1), ct) != 0)
        {
            await server.ReadExactlyAsync(header.AsMemory(1), ct);
            var length = BinaryPrimitives.ReadInt32BigEndian(header.AsSpan(1));
            if (length is < 4 or > 16 * 1024 * 1024)
                throw new InvalidDataException("Invalid PostgreSQL response frame length.");
            var body = new byte[length - 4];
            await server.ReadExactlyAsync(body, ct);
            if (header[0] == (byte)'C' && body.AsSpan().SequenceEqual("COMMIT\0"u8) &&
                Interlocked.Exchange(ref _nextCommit, null) is { } drop)
            {
                // Withhold both responses, then close the client connection once PostgreSQL is idle.
                var ready = new byte[6];
                try
                {
                    await server.ReadExactlyAsync(ready, ct);
                    if (!ready.AsSpan().SequenceEqual(new byte[] { (byte)'Z', 0, 0, 0, 5, (byte)'I' }))
                        throw new InvalidDataException("Expected PostgreSQL ReadyForQuery (idle) after COMMIT.");
                    drop.SetResult();
                }
                catch (Exception fault)
                {
                    drop.SetException(fault);
                    throw;
                }
                return;
            }
            await client.WriteAsync(header, ct);
            await client.WriteAsync(body, ct);
        }
    }

    private static Socket UnixSocket() => new(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);

    public async ValueTask DisposeAsync()
    {
        await _stop.CancelAsync();
        try { await _worker; }
        catch (OperationCanceledException) when (_stop.IsCancellationRequested) { }
        finally
        {
            Interlocked.Exchange(ref _nextCommit, null)?.TrySetCanceled();
            _listener.Dispose();
            _stop.Dispose();
            Directory.Delete(_directory, recursive: true);
        }
    }
}
