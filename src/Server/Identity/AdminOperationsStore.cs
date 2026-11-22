using FsusBlog.V2.Contracts;
using FsusBlog.V2.Server.Analytics;
using FsusBlog.V2.Server.Comments;
using FsusBlog.V2.Server.Operations;
using FsusBlog.V2.Server.Security;
using FsusBlogV2.Storage;

namespace FsusBlog.V2.Server.Administration;

internal sealed class AdminOperationsStore(AdminSessionGate gate)
{
    internal Task<(AdminSiteTraffic Traffic, string PermissionSession)> ReadSiteTraffic(string? token, SiteTraffic traffic, CancellationToken ct) =>
        gate.WithLiveAdmin(token, async (db, tx, admin) =>
            (await traffic.ReadAsync(db, tx, ct), AdminSessionGate.PermissionBinding(admin.Digest)), ct);

    internal Task<(AdminOperationsStatus Status, string PermissionSession)> OperationsStatus(string? token, Publications publications, CancellationToken ct) =>
        gate.WithLiveAdmin(token, async (db, tx, admin) =>
        {
            await using var query = Store.Sql(db, tx, """
                select count(*), min(created_at)
                from public.blog_outbox where processed_at is null and kind in ('publish','retract','delete')
                """);
            await using var result = await query.ExecuteReaderAsync(ct);
            await result.ReadAsync(ct);
            var pending = result.GetInt64(0);
            var oldest = result.IsDBNull(1) ? 0 : result.GetUnixMilliseconds(1);
            var snapshot = publications.Snapshot;
            return (new AdminOperationsStatus(snapshot is not null, snapshot?.Watermark ?? 0, pending, oldest),
                AdminSessionGate.PermissionBinding(admin.Digest));
        }, ct);

    internal Task<(AdminClusterStatus Status, string PermissionSession)> ClusterStatus(string? token,
        AdminClusterIdentity instance, InstanceLease lease, Publications publications, CancellationToken ct) =>
        gate.WithLiveAdmin(token, (_, _, admin) =>
        {
            var ready = publications.Snapshot is not null;
            var age = lease.ObserveAgeMilliseconds();
            var status = new AdminClusterStatus(1, instance.NodeId, instance.InstanceId, instance.BuildVersion, instance.StartedAt,
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), age, ready);
            return Task.FromResult((status, AdminSessionGate.PermissionBinding(admin.Digest)));
        }, ct);

    internal Task<(AdminRiskReadiness Controls, string PermissionSession)> RiskReadiness(string? token,
        InstalledCommentRoutes commentRoutes, bool trustLoopbackProxy, CancellationToken ct) =>
        gate.WithLiveAdmin(token, async (db, tx, admin) =>
        {
            var replyMode = 0;
            if (commentRoutes.SignedInReply)
                replyMode = await CurrentSchema.HasCommentReplySchemaAsync(db, tx, ct) ? 2 : 1;

            if (commentRoutes.RootPowPolicy) await RootCommentPowPolicy.Read(db, tx, ct);
            var controls = new AdminRiskReadiness(
                PublicReadMode: 1, // Public comment queries always map with the fixed query limiter.
                RootWriteMode: commentRoutes.RootSubmission ? 1 : 0,
                ReplyWriteMode: replyMode,
                ForwardingMode: trustLoopbackProxy ? 1 : 0,
                DynamicRisk: 0, // Root comment proof configuration does not implement general risk scoring.
                StrongAnonymous: 0); // No anonymous credential or proof runtime is installed.
            return (controls, AdminSessionGate.PermissionBinding(admin.Digest));
        }, ct);
}
