using System.Diagnostics;
using System.Reflection;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Server.Operations;

namespace FsusBlog.V2.Server.Administration;

internal static class AdminClusterEndpoints
{
    internal static void Map(WebApplication app, AdminOperationsStore store, string session, string rateLimit)
    {
        var identity = AdminClusterIdentity.Capture(app.Configuration["FSUSBLOG_NODE_ID"] ?? "");
        app.MapGet(WireRoutes.AdminClusterStatus, async (HttpContext ctx, InstanceLease lease, Publications publications,
            CancellationToken ct) =>
        {
            var result = await store.ClusterStatus(ctx.Request.Cookies[session], identity, lease, publications, ct);
            ctx.Response.Headers[WireHeaders.AdminPermissionSession] = result.PermissionSession;
            return Results.Bytes(Wire.EncodeAdminClusterStatus(result.Status), Aeds.ContentType);
        }).RequireRateLimiting(rateLimit);
    }
}

internal sealed record AdminClusterIdentity(string NodeId, Guid InstanceId, string BuildVersion, long StartedAt)
{
    internal static AdminClusterIdentity Capture(string nodeId)
    {
        if (!Wire.ValidClusterNodeId(nodeId)) throw new InvalidOperationException("FSUSBLOG_NODE_ID is not a valid standalone node label.");
        using var process = Process.GetCurrentProcess();
        var assembly = typeof(AdminClusterIdentity).Assembly;
        var version = assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
            ?? assembly.GetName().Version?.ToString() ?? "unknown";
        return new(nodeId, Guid.NewGuid(), version, new DateTimeOffset(process.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds());
    }
}
