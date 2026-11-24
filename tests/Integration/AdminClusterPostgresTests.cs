namespace FsusBlog.V2.Integration.Tests;

public sealed class AdminClusterPostgresTests
{
    [PostgresFact]
    public async Task SingleModeReportsOnlyTheCurrentPrimaryOwnerToCurrentSystemConfigSessions()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromSeconds(45));
        var (admin, token, _) = await fixture.AdminAsync("observer", 10, [1], [2], ct);
        var siteUser = await fixture.SignInSiteUser("cluster-site-user", ct);
        var settings = new Dictionary<string, string>
        {
            ["FSUSBLOG_ADMIN_ORIGIN"] = "http://localhost",
            ["FSUSBLOG_ADMIN_RP_ID"] = "localhost",
            ["FSUSBLOG_NODE_ID"] = "controlled-fixture",
        };
        await using var first = await ServerProcess.Start(fixture.ConnectionString, ct, settings);
        await Denied(first, NotFound, token, adminOrigin: false);
        await Denied(first, Unauthorized, null);
        await Denied(first, Unauthorized, siteUser.Token);

        var original = await Observation(first, token);
        Assert.Equal((1, "controlled-fixture", true), (original.Mode, original.NodeId, original.SnapshotReady));
        Assert.NotEqual(Guid.Empty, original.InstanceId);
        Assert.False(string.IsNullOrEmpty(original.BuildVersion));
        Assert.InRange(original.LeaseAgeMs, 0, 999);
        Assert.InRange(original.ObservedAt, original.StartedAt, DateTimeOffset.UtcNow.AddSeconds(2).ToUnixTimeMilliseconds());
        var again = await Observation(first, token);
        Assert.Equal((original.InstanceId, original.BuildVersion, original.StartedAt), (again.InstanceId, again.BuildVersion, again.StartedAt));

        Assert.True(await fixture.TerminateAdvisoryOwner(PublicationLocks.Ownership, 5000, ct));
        while (true)
        {
            using var ready = await first.Client.GetAsync("/health/ready", ct);
            if (ready.StatusCode == ServiceUnavailable) break;
            Assert.Equal(NoContent, ready.StatusCode);
            await Task.Delay(25, ct);
        }
        await Denied(first, ServiceUnavailable, token);

        await using var second = await ServerProcess.Start(fixture.ConnectionString, ct, settings);
        var successor = await Observation(second, token);
        Assert.Equal((original.NodeId, true), (successor.NodeId, successor.SnapshotReady));
        Assert.NotEqual(original.InstanceId, successor.InstanceId);
        await fixture.Exec("update public.admin_principal set generation=2 where id=$1", admin);
        await Denied(second, Unauthorized, token);

        async Task<AdminClusterStatus> Observation(ServerProcess server, string credential)
        {
            using var response = Ok(await Request(server, credential));
            Assert.True(response.Headers.CacheControl?.NoStore);
            Assert.Matches("^[a-f0-9]{64}$", Assert.Single(response.Headers.GetValues(WireHeaders.AdminPermissionSession)));
            Assert.Equal(Aeds.ContentType, response.Content.Headers.ContentType?.MediaType);
            return Wire.DecodeAdminClusterStatus(await response.Content.ReadAsByteArrayAsync(ct));
        }

        async Task Denied(ServerProcess server, HttpStatusCode status, string? credential, bool adminOrigin = true)
        {
            using var response = Expect(status, await Request(server, credential, adminOrigin));
            Assert.True(response.Headers.CacheControl?.NoStore);
            var frame = await response.Content.ReadAsByteArrayAsync(ct);
            Assert.Throws<ProtocolException>(() => Wire.DecodeAdminClusterStatus(frame));
        }

        Task<HttpResponseMessage> Request(ServerProcess server, string? credential, bool adminOrigin = true) =>
            SiteAedsFixture.AdminSend(server.Client, HttpMethod.Get, WireRoutes.AdminClusterStatus, credential, ct,
                configure: adminOrigin ? null : req => req.Headers.Host = null);
    }
}
