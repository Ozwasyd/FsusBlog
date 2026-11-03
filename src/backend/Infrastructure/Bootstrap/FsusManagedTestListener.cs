using System.Net;
using System.Net.Sockets;

using Microsoft.Win32.SafeHandles;

namespace FsusBlog.Server.Infrastructure.Bootstrap;

// Only the managed acceptance launcher supplies this descriptor. Ordinary application
// startup retains its existing URL/endpoint configuration.
internal static class FsusManagedTestListener
{
    internal static void Configure(WebApplicationBuilder builder)
    {
        string? rawFd = Environment.GetEnvironmentVariable("FSUSBLOG_RUNTIME_LISTEN_FD");
        bool requested = Environment.GetEnvironmentVariable("FSUSBLOG_MANAGED_TEST_LISTENER") == "1";
        bool partialBinding = new[] { "FSUSBLOG_RUNTIME_LISTEN_SOCKET", "FSUSBLOG_RUNTIME_LISTEN_PORT", "FSUSBLOG_RUNTIME_LISTEN_ATTEMPT_ID" }
            .Any(key => Environment.GetEnvironmentVariable(key) is not null);
        if (rawFd is null && !requested && !partialBinding)
            return;

        if (!requested || !OperatingSystem.IsLinux())
            throw new InvalidOperationException("Inherited listener requires explicit managed-test admission on Linux.");

        string Required(string key) => Environment.GetEnvironmentVariable(key) is { } value && !string.IsNullOrWhiteSpace(value)
            ? value : throw new InvalidOperationException($"Inherited listener binding missing: {key}.");

        _ = Required("FSUSBLOG_TEST_RUN_ID");
        _ = Required("FSUSBLOG_TEST_NAMESPACE");
        _ = Required("FSUSBLOG_RUNTIME_PORT_LEASE_ID");
        _ = Required("FSUSBLOG_RUNTIME_LISTEN_ATTEMPT_ID");
        string inode = Required("FSUSBLOG_RUNTIME_LISTEN_SOCKET");
        if (!int.TryParse(rawFd, out int fd) || fd < 3
            || !int.TryParse(Required("FSUSBLOG_RUNTIME_LISTEN_PORT"), out int port) || port is < 1 or > 65535
            || !System.Text.RegularExpressions.Regex.IsMatch(inode, @"^socket:\[\d+\]$"))
            throw new InvalidOperationException("Invalid inherited listener descriptor binding.");

        if (new FileInfo($"/proc/self/fd/{fd}").LinkTarget != inode)
            throw new InvalidOperationException("Inherited listener socket identity mismatch.");
        using (var handle = new SafeSocketHandle((IntPtr)fd, ownsHandle: false))
        using (var socket = new Socket(handle))
        {
            if (socket.AddressFamily != AddressFamily.InterNetwork || socket.SocketType != SocketType.Stream
                || socket.LocalEndPoint is not IPEndPoint endpoint || !endpoint.Address.Equals(IPAddress.Loopback) || endpoint.Port != port
                || (int)socket.GetSocketOption(SocketOptionLevel.Socket, SocketOptionName.AcceptConnection)! != 0
                || (int)socket.GetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress)! != 0)
                throw new InvalidOperationException("Inherited listener kernel state mismatch.");
        }

        string? urls = builder.Configuration["urls"];
        if (string.IsNullOrWhiteSpace(urls)
            || urls.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Length != 1
            || !Uri.TryCreate(urls, UriKind.Absolute, out Uri? url)
            || url.Scheme != "http" || url.Host != "127.0.0.1" || url.Port != port
            || builder.Configuration.GetSection("Kestrel:Endpoints").GetChildren().Any()
            || builder.Configuration.GetValue<bool>("RuntimeTuning:Http3:Enabled"))
            throw new InvalidOperationException("Inherited listener requires exactly its admitted loopback HTTP URL and no additional endpoints.");

        builder.WebHost.ConfigureKestrel(options => options.ListenHandle((ulong)fd));
    }
}
