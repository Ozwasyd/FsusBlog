using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Tests.Integration;
using FsusBlog.Server.Tests.Unit;

using Npgsql;

namespace FsusBlog.Server.Tests.TestInfrastructure;

internal static class SecurityRiskAdmissionProcessIssue2040Worker
{
    internal const string Command = "security-risk-admission-issue2040-process";

    internal static async Task<int> RunAsync(string[] args)
    {
        if (args.Length != 4 || !Guid.TryParseExact(args[1], "N", out _)
            || !int.TryParse(args[2], NumberStyles.None, CultureInfo.InvariantCulture, out int parentId)
            || parentId <= 0 || parentId == Environment.ProcessId || args[3] is not ("admitted" or "in-flight" or "committed"))
        {
            return 64;
        }
        string temporary = OperatingSystem.IsMacOS() ? "/private/tmp/" : Path.GetFullPath(Path.GetTempPath());
        string root = Path.GetFullPath(args[0]);
        if (!Path.IsPathFullyQualified(args[0]) || !root.StartsWith(temporary, StringComparison.Ordinal)
            || !Path.GetFileName(root).StartsWith("fsusblog-security-risk-issue2040-", StringComparison.Ordinal))
        {
            return 64;
        }
        try
        {
            using Process parent = Process.GetProcessById(parentId);
            using var owner = new SecurityRiskIssue2040Owner(root, deleteRoot: false);
            string assembly = typeof(SecurityRiskAdmissionProcessIssue2040Worker).Assembly.Location;
            string assemblyDigest = Digest(await File.ReadAllBytesAsync(assembly));
            string rootDigest = Digest(Encoding.UTF8.GetBytes(root));
            if (!await owner.Queue.EnqueueAsync(SecurityRiskIssue2040Owner.Write() with
            {
                Id = args[1]
            }))
            {
                return 65;
            }
            if (args[3] is "in-flight" or "committed")
            {
                if (!owner.Queue.TryRead(out var delivery))
                {
                    return 66;
                }
                if (args[3] == "committed")
                {
                    string connection = Environment.GetEnvironmentVariable(SecurityRiskDurableReplayIssue2040IntegrationTests.DatabaseVariable)
                        ?? throw new InvalidOperationException("Task-owned PostgreSQL prerequisite missing.");
                    var database = new NpgsqlConnectionStringBuilder(connection);
                    if (!IPAddress.TryParse(database.Host, out IPAddress? address) || !IPAddress.IsLoopback(address)
                        || database.Database is not { } databaseName || !databaseName.StartsWith("fsus_security_risk_2040_", StringComparison.Ordinal))
                    {
                        return 67;
                    }
                    using var db = PostgresSqlSugarTestClient.Create(connection);
                    await new SecurityRiskEventStore(db).AppendAsync(delivery);
                }
            }
            Console.WriteLine($"security-risk-durable {args[1]} {Environment.ProcessId} {parentId} {assemblyDigest} {rootDigest} {args[3]}");
            Console.Out.Flush();
            while (!parent.HasExited)
            {
                await Task.Delay(TimeSpan.FromMilliseconds(100));
            }
            return 70;
        }
        catch (Exception)
        {
            Console.Error.WriteLine("security-risk-process-failed");
            return 71;
        }
    }

    private static string Digest(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));
}
