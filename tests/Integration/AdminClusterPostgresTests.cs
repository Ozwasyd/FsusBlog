using System.Net;
using System.Security.Cryptography;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Server;
using FsusBlogV2.Storage;

namespace FsusBlog.V2.Integration.Tests;

public sealed class AdminClusterPostgresTests
{
    [PostgresFact]
    public async Task SingleModeReportsOnlyTheCurrentPrimaryOwnerToCurrentSystemConfigSessions()
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(45));
        var ct = deadline.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var admin = Guid.NewGuid();
        var token = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
        await Execute("insert into public.admin_principal(id,handle,user_handle,enabled,generation) values($1,'observer',$2,true,1)",
            admin, RandomNumberGenerator.GetBytes(32));
        await Execute("insert into public.admin_passkey_credential values($1,$2,$3,0,false,false)", new byte[] { 1 }, admin, new byte[] { 2 });
        await Execute("insert into public.admin_session values($1,$2,1,clock_timestamp()+interval '10 minutes')", Store.TokenDigest(token)!, admin);
        await Execute("insert into public.admin_permission values($1,'admin.manage'), ($1,'audit.read')", admin);
        var settings = new Dictionary<string, string>
        {
            ["FSUSBLOG_ADMIN_ORIGIN"] = "http://localhost",
            ["FSUSBLOG_ADMIN_RP_ID"] = "localhost",
            ["FSUSBLOG_NODE_ID"] = "controlled-fixture",
        };
        await using var first = await ServerProcess.Start(fixture.ConnectionString, ct, settings);
        await Denied(first, HttpStatusCode.NotFound, token, adminOrigin: false);
        await Denied(first, HttpStatusCode.Unauthorized, null);
        await Denied(first, HttpStatusCode.Forbidden, token);
        await Execute("insert into public.admin_permission values($1,'system.config')", admin);

        var original = await Observation(first, token);
        Assert.Equal(1, original.Mode);
        Assert.Equal("controlled-fixture", original.NodeId);
        Assert.True(original.SnapshotReady);
        Assert.NotEqual(Guid.Empty, original.InstanceId);
        Assert.False(string.IsNullOrEmpty(original.BuildVersion));
        Assert.InRange(original.LeaseAgeMs, 0, 999);
        Assert.InRange(original.ObservedAt, original.StartedAt, DateTimeOffset.UtcNow.AddSeconds(2).ToUnixTimeMilliseconds());
        var again = await Observation(first, token);
        Assert.Equal((original.InstanceId, original.BuildVersion, original.StartedAt), (again.InstanceId, again.BuildVersion, again.StartedAt));

        await using (var cut = Store.Sql(db, null, """
            select pg_catalog.pg_terminate_backend(l.pid, 5000) from pg_catalog.pg_locks l
            where l.database=(select oid from pg_catalog.pg_database where datname=current_database())
                and l.locktype='advisory' and l.mode='ExclusiveLock' and l.granted and l.objsubid=1
                and ((l.classid::bigint << 32) | l.objid::bigint)=$1
            """, PublicationLocks.Ownership))
            Assert.True((bool)(await cut.ExecuteScalarAsync(ct))!);
        while (true)
        {
            using var ready = await first.Client.GetAsync("/health/ready", ct);
            if (ready.StatusCode == HttpStatusCode.ServiceUnavailable) break;
            Assert.Equal(HttpStatusCode.NoContent, ready.StatusCode);
            await Task.Delay(25, ct);
        }
        await Denied(first, HttpStatusCode.ServiceUnavailable, token);

        await using var second = await ServerProcess.Start(fixture.ConnectionString, ct, settings);
        var successor = await Observation(second, token);
        Assert.Equal(original.NodeId, successor.NodeId);
        Assert.NotEqual(original.InstanceId, successor.InstanceId);
        Assert.True(successor.SnapshotReady);
        await Execute("update public.admin_principal set generation=2 where id=$1", admin);
        await Denied(second, HttpStatusCode.Unauthorized, token);

        Task Execute(string sql, params object[] arguments) =>
            FixtureSql.ExecuteAsync(db, null, ct, sql, arguments);

        async Task<AdminClusterStatus> Observation(ServerProcess server, string credential)
        {
            using var response = await Request(server, credential);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.True(response.Headers.CacheControl?.NoStore);
            Assert.Matches("^[a-f0-9]{64}$", Assert.Single(response.Headers.GetValues(WireHeaders.AdminPermissionSession)));
            Assert.Equal(Aeds.ContentType, response.Content.Headers.ContentType?.MediaType);
            return Wire.DecodeAdminClusterStatus(await response.Content.ReadAsByteArrayAsync(ct));
        }

        async Task Denied(ServerProcess server, HttpStatusCode status, string? credential, bool adminOrigin = true)
        {
            using var response = await Request(server, credential, adminOrigin);
            Assert.Equal(status, response.StatusCode);
            Assert.True(response.Headers.CacheControl?.NoStore);
            var frame = await response.Content.ReadAsByteArrayAsync(ct);
            Assert.Throws<ProtocolException>(() => Wire.DecodeAdminClusterStatus(frame));
        }

        async Task<HttpResponseMessage> Request(ServerProcess server, string? credential, bool adminOrigin = true)
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, WireRoutes.AdminClusterStatus);
            if (adminOrigin) request.Headers.Host = "localhost";
            if (credential is not null) request.Headers.Add("Cookie", "fsus-v2-admin-session=" + credential);
            return await server.Client.SendAsync(request, ct);
        }
    }
}
