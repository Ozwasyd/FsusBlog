using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Tests.Unit;

namespace FsusBlog.Server.Tests.TestInfrastructure;

internal static class AdminAuditAdmissionProcessIssue2040Worker
{
    internal const string Command = "admin-audit-admission-issue2040-process";

    internal static async Task<int> RunAsync(string[] args)
    {
        if ((args.Length != 3 && args.Length != 4) || !Guid.TryParseExact(args[1], "N", out _)
            || !int.TryParse(args[2], NumberStyles.None, CultureInfo.InvariantCulture, out int parentId)
            || parentId <= 0 || parentId == Environment.ProcessId)
        {
            return 64;
        }
        string mode = args.Length == 4 ? args[3] : "admission";
        if (mode is not ("admission" or "commit-before-ack" or "in-flight"))
        {
            return 64;
        }
        string root = Path.GetFullPath(args[0]);
        string temporaryRoot = Path.GetFullPath(Path.GetTempPath());
        if (!root.StartsWith(temporaryRoot, StringComparison.Ordinal)
            || !Path.GetFileName(root).StartsWith("fsusblog-admin-audit-issue2040-", StringComparison.Ordinal))
        {
            return 64;
        }
        string connection = Environment.GetEnvironmentVariable("FSUSBLOG_ADMIN_AUDIT_PROCESS_DATABASE")
            ?? throw new InvalidOperationException("Owned process database missing.");
        using Process parent = Process.GetProcessById(parentId);
        using var owner = new AdminAuditIssue2040Owner(root,
            () => PostgresSqlSugarTestClient.Create(connection), deleteRoot: false);
        await owner.Channel.EnqueueAsync(AdminAuditIssue2040Owner.Record("accepted-before-kill"));
        string assembly = typeof(AdminAuditAdmissionProcessIssue2040Worker).Assembly.Location;
        string digest = Convert.ToHexStringLower(SHA256.HashData(await File.ReadAllBytesAsync(assembly)));
        Console.WriteLine($"admin-audit-admitted {args[1]} {Environment.ProcessId} {digest}");
        Console.Out.Flush();
        if (mode != "admission")
        {
            if (!owner.Channel.TryRead(out AdminAuditLog? delivery))
            {
                return 65;
            }
            using var db = PostgresSqlSugarTestClient.Create(connection);
            await new AdminAuditLogStore(db).WriteBatchAsync([delivery], CancellationToken.None);
            Console.WriteLine($"admin-audit-committed {args[1]} {Environment.ProcessId} {digest}");
            Console.Out.Flush();
        }
        while (!parent.HasExited)
        {
            await Task.Delay(TimeSpan.FromMilliseconds(250));
        }
        return 70;
    }
}
