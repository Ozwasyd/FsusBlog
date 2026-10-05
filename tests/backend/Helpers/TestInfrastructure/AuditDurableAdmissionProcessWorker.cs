using System.Diagnostics;
using System.Globalization;

using FsusBlog.Server.Tests.Unit;

namespace FsusBlog.Server.Tests.TestInfrastructure;

internal static class AuditDurableAdmissionProcessWorker
{
    internal const string Command = "audit-durable-admission-process";

    internal static async Task<int> RunAsync(string[] args)
    {
        if (args.Length != 3 || !Guid.TryParseExact(args[1], "N", out _)
            || !int.TryParse(args[2], NumberStyles.None, CultureInfo.InvariantCulture, out int parentId))
        {
            return 64;
        }
        string root = Path.GetFullPath(args[0]);
        string temporaryRoot = Path.GetFullPath(Path.GetTempPath());
        if (!root.StartsWith(temporaryRoot, StringComparison.Ordinal)
            || !Path.GetFileName(root).StartsWith("fsusblog-audit-issue2040-", StringComparison.Ordinal))
        {
            return 64;
        }
        using Process parent = Process.GetProcessById(parentId);
        using var owner = new AuditDurableTestOwner(root, deleteRoot: false);
        if (!owner.Channel.TryWrite(AuditDurableAdmissionIssue2040Tests.Record("accepted-before-kill")))
        {
            return 71;
        }
        Console.WriteLine($"audit-durable-admitted {args[1]} {Environment.ProcessId} {owner.Channel.Snapshot().DurablePendingCount}");
        Console.Out.Flush();
        while (!parent.HasExited)
        {
            await Task.Delay(TimeSpan.FromMilliseconds(250));
        }
        return 70;
    }
}
