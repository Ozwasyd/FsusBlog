namespace FsusBlog.V2.Integration.Tests;

public sealed class InboxWakePostgresTests
{
    [PostgresFact]
    public async Task NotificationSessionReconnectsAndReleasesTheSocketOnStop()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromSeconds(20));
        using var wake = new InboxWake(fixture.ConnectionString, NullLogger<InboxWake>.Instance);
        const string listenerSql = "select pid from pg_stat_activity where datname=current_database() and query=$1 and pid<>pg_backend_pid()";

        var listening = wake.Changed;
        await wake.StartAsync(ct);
        try
        {
            await listening.WaitAsync(ct);
            var first = await fixture.Scalar<int>(listenerSql, "listen fsus_v2_inbox");
            await CheckNotification();

            var reconnected = wake.Changed;
            Assert.True(await fixture.Scalar<bool>("select pg_terminate_backend($1)", first));
            await reconnected.WaitAsync(ct);
            var second = await fixture.Scalar<int>(listenerSql, "listen fsus_v2_inbox");
            Assert.NotEqual(first, second);
            await CheckNotification();

            await wake.StopAsync(ct);
            Assert.True(wake.ExecuteTask?.IsCompletedSuccessfully);
            while (await fixture.Scalar<bool>("select exists(select from pg_stat_activity where pid=$1)", second))
                await Task.Delay(25, ct);
        }
        finally
        {
            await wake.StopAsync(ct);
        }

        async Task CheckNotification()
        {
            var notification = wake.Changed;
            await fixture.Scalar("select pg_notify('fsus_v2_inbox', '')");
            await notification.WaitAsync(ct);
        }
    }
}
