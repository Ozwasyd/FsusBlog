using System.Net;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Server;
using Npgsql;

namespace FsusBlog.V2.Integration.Tests;

internal static class InboxFixture
{
    private const string AdminHost = "localhost";
    private const string AdminOrigin = "http://localhost";

    internal static Task<ServerProcess> StartAdmin(ScratchDatabase fixture, CancellationToken ct, params string[] enabled)
    {
        var settings = new Dictionary<string, string>
        {
            ["FSUSBLOG_ADMIN_ORIGIN"] = AdminOrigin,
            ["FSUSBLOG_ADMIN_RP_ID"] = AdminHost,
        };
        foreach (var flag in enabled) settings.Add(flag, "true");
        return ServerProcess.Start(fixture.ConnectionString, ct, settings);
    }

    internal static HttpRequestMessage AdminRequest(HttpMethod method, string path, string token, byte[]? frame = null,
        bool adminHost = true, bool site = false)
    {
        var request = SiteAedsFixture.Request(method, path, frame, site ? token : null, handle: null);
        if (adminHost) request.Headers.Host = AdminHost;
        if (!site) request.Headers.Add("Cookie", $"fsus-v2-admin-session={token}");
        return request;
    }

    internal static async Task<byte[]> ExpectBody(ServerProcess server, HttpRequestMessage request, HttpStatusCode status, CancellationToken ct)
    {
        using var response = await server.Client.SendAsync(request, ct);
        Assert.Equal(status, response.StatusCode);
        return await response.Content.ReadAsByteArrayAsync(ct);
    }

    internal static string Secret() => Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));

    internal static async Task SeedSession(NpgsqlConnection db, Guid id, string name, string token, CancellationToken ct, bool canAuthor = false)
    {
        await FixtureSql.SiteAccountAsync(db, null, ct, id, name, canAuthor);
        await FixtureSql.ExecuteAsync(db, null, ct, """
            insert into public.user_session(digest,user_id,generation,expires_at) values($1,$2,1,now()+interval '5 minutes')
            """, Store.TokenDigest(token)!, id);
    }

    internal static Uri WakeUri(ServerProcess server, string path) =>
        new UriBuilder(new Uri(server.Client.BaseAddress!, path)) { Scheme = "ws" }.Uri;

    internal static ClientWebSocket WakeClient(string origin, string? cookie, string? host = null, bool collect = true)
    {
        var socket = new ClientWebSocket();
        socket.Options.CollectHttpResponseDetails = collect;
        socket.Options.AddSubProtocol("fsus-inbox-wake.v2");
        if (host is not null) socket.Options.SetRequestHeader("Host", host);
        socket.Options.SetRequestHeader("Origin", origin);
        if (cookie is not null) socket.Options.SetRequestHeader("Cookie", cookie);
        return socket;
    }

    internal static ClientWebSocket AdminWakeClient(string cookie, bool collect = true) => WakeClient(AdminOrigin, cookie, AdminHost, collect);

    internal static async Task ExpectWake(ClientWebSocket socket, CancellationToken ct)
    {
        var bytes = new byte[Aeds.HeaderSize + 8];
        var frame = await socket.ReceiveAsync(bytes.AsMemory(), ct);
        Assert.Equal(WebSocketMessageType.Binary, frame.MessageType);
        Assert.True(frame.EndOfMessage);
        Assert.Equal(Wire.EncodeEmptySuccess(), bytes[..frame.Count]);
    }

    internal static BinaryReader Reader(byte[] frame, FrameType type) => new(new MemoryStream(Aeds.Decode(frame, type).ToArray()));

    internal static string Text(BinaryReader reader) => Encoding.UTF8.GetString(reader.ReadBytes(reader.ReadInt32()));

    internal static (string Cursor, long[] Ids) Page(byte[] frame, FrameType type = FrameType.AdminInboxPage)
    {
        using var reader = Reader(frame, type);
        var cursor = Text(reader);
        var ids = new long[reader.ReadInt32()];
        for (var index = 0; index < ids.Length; index++)
        {
            ids[index] = ConversationId(reader);
            if (type == FrameType.AdminInboxSharedPage) reader.ReadInt32();
        }
        return (cursor, ids);
    }

    internal static long ConversationId(BinaryReader reader)
    {
        var id = reader.ReadInt64();
        SkipConversationFields(reader);
        return id;
    }

    internal static void SkipConversationFields(BinaryReader reader)
    {
        reader.ReadBytes(16);
        Text(reader);
        reader.ReadInt32();
        reader.ReadBoolean();
        reader.ReadInt64();
    }

    internal static List<(long Id, bool Internal, string Body)> Messages(BinaryReader reader)
    {
        int count = reader.ReadInt32();
        List<(long Id, bool Internal, string Body)> result = [];
        for (var index = 0; index < count; index++)
        {
            var id = reader.ReadInt64();
            reader.ReadInt32();
            var hidden = reader.ReadBoolean();
            reader.ReadInt64();
            result.Add((id, hidden, Text(reader)));
        }
        return result;
    }
}
