using System.Buffers.Binary;
using System.Net;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Administration;
using FsusBlogV2.Storage;

using static FsusBlog.V2.Integration.Tests.InboxFixture;

namespace FsusBlog.V2.Integration.Tests;

public sealed class AdminInboxNoticePostgresTests
{
    [PostgresFact]
    public async Task ExplicitActiveAccountReceivesOneAuditedNoticeAcrossProofAndResponseRetries()
    {
        await using var database = await ScratchDatabase.CreateTimed(out var ct);
        await using var db = await database.DataSource.OpenConnectionAsync(ct);
        var (primary, firstToken, _) = await FixtureSql.AdminAsync(db, ct, "notice-admin", 5, RandomNumberGenerator.GetBytes(8), [2]);
        var (_, otherAdmin, _) = await FixtureSql.AdminAsync(db, ct, "different-admin", 5, RandomNumberGenerator.GetBytes(8), [2]);
        var recipient = Guid.NewGuid();
        var stranger = Guid.NewGuid();
        var replacement = Secret();
        var recipientToken = Secret();
        var strangerToken = Secret();
        await SeedSession(db, recipient, "notice-account", recipientToken, ct);
        await SeedSession(db, stranger, "unrelated-account", strangerToken, ct);
        await using var server = await StartAdmin(database, ct,
            AdminInboxEndpoints.NoticeSetting, AdminInboxEndpoints.LiveSetting,
            AdminInboxEndpoints.SharedReadSetting);
        const long eventId = 9981221123;
        const string content = "An explicitly targeted system message 🐈";
        var notice = Wire.EncodeAdminInboxNotice(new(recipient, "", content));
        var otherNotice = Wire.EncodeAdminInboxNotice(new(stranger, "", content));
        var nonexistent = Wire.EncodeAdminInboxNotice(new(Guid.NewGuid(), "", content));
        await Send(WireRoutes.AdminInboxSendNoticePow, HttpStatusCode.Unauthorized, recipientToken, notice);
        await Send(WireRoutes.AdminInboxSendNotice, HttpStatusCode.Unauthorized, firstToken, notice);
        await Send(WireRoutes.AdminInboxSendNotice, HttpStatusCode.NotFound, firstToken, notice, admin: false);
        var proof = await Work(firstToken, notice);
        await Send(WireRoutes.AdminInboxSendNotice, HttpStatusCode.Unauthorized, otherAdmin, notice, proof);
        await Send(WireRoutes.AdminInboxSendNotice, HttpStatusCode.Unauthorized, firstToken, otherNotice, proof);
        await Send(WireRoutes.AdminInboxSendNotice, HttpStatusCode.Unauthorized, firstToken, notice, proof, eventId + 1);
        var parallel = await Work(firstToken, notice);
        const string system = "?status=system&shared=1";
        await RejectWake("?status=system", $"fsus-v2-admin-session={otherAdmin}", HttpStatusCode.BadRequest);
        await RejectWake(system, $"fsus-v2-session={strangerToken}", HttpStatusCode.Unauthorized);
        using var observer = AdminWakeClient($"fsus-v2-admin-session={otherAdmin}");
        await observer.ConnectAsync(WakeUri(server, WireRoutes.AdminInboxQueueWake + system), ct);
        var receipts = await Task.WhenAll(
            Send(WireRoutes.AdminInboxSendNotice, HttpStatusCode.OK, firstToken, notice, proof),
            Send(WireRoutes.AdminInboxSendNotice, HttpStatusCode.OK, firstToken, notice, parallel));
        using (var bound = CancellationTokenSource.CreateLinkedTokenSource(ct))
        {
            bound.CancelAfter(TimeSpan.FromSeconds(12));
            await ExpectWake(observer, bound.Token);
            await observer.CloseAsync(WebSocketCloseStatus.NormalClosure, null, bound.Token);
        }
        var responses = receipts.Select(data => Aeds.Decode(data, FrameType.ConversationDetailV2).ToArray()).ToArray();
        var id = BinaryPrimitives.ReadInt64LittleEndian(responses[0]);
        Assert.Equal(id, BinaryPrimitives.ReadInt64LittleEndian(responses[1]));
        Assert.Equal(new byte[] { 0, 1 }, responses.Select(data => data[34]).Order());
        Assert.All(responses, data =>
        {
            Assert.Equal(1, data[32]);
            Assert.Equal(1, BinaryPrimitives.ReadInt32LittleEndian(data.AsSpan(12)));
            Assert.Contains("系统消息", Encoding.UTF8.GetString(data));
        });
        await Send(WireRoutes.AdminInboxSendNotice, HttpStatusCode.Unauthorized, firstToken, notice, proof);
        await Send(WireRoutes.AdminInboxSendNotice, HttpStatusCode.Conflict, otherAdmin, notice, await Work(otherAdmin, notice));
        await Sql("update public.admin_session set digest=$1 where principal_id=$2", Store.TokenDigest(replacement)!, primary);
        var changed = Wire.EncodeAdminInboxNotice(new(recipient, "", "Replacement text"));
        await Send(WireRoutes.AdminInboxSendNotice, HttpStatusCode.Conflict, replacement, changed, await Work(replacement, changed));
        await Send(WireRoutes.AdminInboxSendNotice, HttpStatusCode.Conflict, replacement, otherNotice, await Work(replacement, otherNotice));

        var path = WireRoutes.InboxDetail.Replace("{id:long}", id.ToString(System.Globalization.CultureInfo.InvariantCulture), StringComparison.Ordinal);
        var account = await Get(path, recipientToken, HttpStatusCode.OK);
        Assert.Contains(content, Encoding.UTF8.GetString(account));
        Assert.DoesNotContain("notice-admin", Encoding.UTF8.GetString(account));
        await Get(path, strangerToken, HttpStatusCode.NotFound);
        var replay = Aeds.Decode(await Get(WireRoutes.InboxReplay, recipientToken, HttpStatusCode.OK), FrameType.InboxReplay).ToArray();
        Assert.Equal(2, BinaryPrimitives.ReadInt32LittleEndian(replay.AsSpan(4)));
        var unrelated = Aeds.Decode(await Get(WireRoutes.InboxReplay, strangerToken, HttpStatusCode.OK), FrameType.InboxReplay).ToArray();
        Assert.Equal(0, BinaryPrimitives.ReadInt32LittleEndian(unrelated.AsSpan(4)));
        await Sql("update public.blog_user set enabled=false where id=$1", recipient);
        var reused = await Send(WireRoutes.AdminInboxSendNotice, HttpStatusCode.OK, replacement, notice, await Work(replacement, notice));
        Assert.Equal(1, Aeds.Decode(reused, FrameType.ConversationDetailV2)[34]);
        var unavailable = await Send(WireRoutes.AdminInboxSendNotice, HttpStatusCode.NotFound, replacement, notice,
            await Work(replacement, notice, eventId + 1), eventId + 1);
        var missing = await Send(WireRoutes.AdminInboxSendNotice, HttpStatusCode.NotFound, replacement, nonexistent,
            await Work(replacement, nonexistent, eventId + 2), eventId + 2);
        Assert.Contains("Inbox account not found.", Encoding.UTF8.GetString(Aeds.Decode(unavailable, FrameType.ApiError)));
        Assert.Contains("Inbox account not found.", Encoding.UTF8.GetString(Aeds.Decode(missing, FrameType.ApiError)));
        await using var audit = Store.Sql(db, null, """
            select r.source_event_id,r.account_id,r.principal_id,r.session_reference,m.sender,c.read_through,
                (select count(*) from public.inbox_command),c.id
            from public.inbox_admin_notice r join public.inbox_conversation c on c.id=r.conversation_id
            join public.inbox_message m on m.id=r.message_id
            """);
        await using var rows = await audit.ExecuteReaderAsync(ct);
        Assert.True(await rows.ReadAsync(ct));
        Assert.Equal(eventId, rows.GetInt64(0));
        Assert.Equal(recipient, rows.GetGuid(1));
        Assert.Equal(primary, rows.GetGuid(2));
        Assert.Equal(SHA256.HashData(Store.TokenDigest(firstToken)!), rows.GetFieldValue<byte[]>(3));
        Assert.Equal(2, rows.GetInt16(4));
        Assert.True(rows.IsDBNull(5));
        Assert.Equal(0L, rows.GetInt64(6));
        Assert.Equal(id, rows.GetInt64(7));
        Assert.False(await rows.ReadAsync(ct));

        async Task RejectWake(string query, string cookie, HttpStatusCode status)
        {
            using var socket = AdminWakeClient(cookie);
            await Assert.ThrowsAsync<WebSocketException>(() => socket.ConnectAsync(WakeUri(server, WireRoutes.AdminInboxQueueWake + query), ct));
            Assert.Equal(status, socket.HttpStatusCode);
        }

        async Task<string> Work(string cookie, byte[] frame, long sourceEvent = eventId)
        {
            const string nonce = "7ddb277082ed464a845d2be0e1abeaba";
            var response = await Send(WireRoutes.AdminInboxSendNoticePow, HttpStatusCode.OK, cookie, frame, nonce, sourceEvent);
            return SolveChallenge(response, nonce);
        }

        async Task<byte[]> Send(string path, HttpStatusCode status, string token, byte[] frame, string? value = null,
            long sourceEvent = eventId, bool admin = true)
        {
            using var request = AdminRequest(HttpMethod.Post, path, token, frame, adminHost: admin);
            request.Headers.Add(WireHeaders.SourceEventId, sourceEvent.ToString(System.Globalization.CultureInfo.InvariantCulture));
            if (value is not null)
                request.Headers.Add(path == WireRoutes.AdminInboxSendNoticePow ? WireHeaders.PowClientNonce : WireHeaders.PowProof, value);
            return await ExpectBody(server, request, status, ct);
        }

        async Task<byte[]> Get(string path, string token, HttpStatusCode status)
        {
            using var request = SiteAedsFixture.Request(HttpMethod.Get, path, frame: null, token, handle: null);
            return await ExpectBody(server, request, status, ct);
        }

        Task Sql(string sql, params object[] parameters) =>
            FixtureSql.ExecuteAsync(db, null, ct, sql, parameters);
    }
}
