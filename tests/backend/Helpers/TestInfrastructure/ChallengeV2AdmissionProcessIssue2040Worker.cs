using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;

using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.Unit;

namespace FsusBlog.Server.Tests.TestInfrastructure;

internal static class ChallengeV2AdmissionProcessIssue2040Worker
{
    internal const string Command = "challenge-v2-admission-issue2040-process";

    internal static async Task<int> RunAsync(string[] args)
    {
        if (args.Length != 5 || !Path.IsPathFullyQualified(args[0]) || !Guid.TryParseExact(args[1], "N", out _)
            || !int.TryParse(args[2], NumberStyles.None, CultureInfo.InvariantCulture, out int parentId)
            || parentId <= 0 || parentId == Environment.ProcessId || !bool.TryParse(args[3], out bool high)
            || args[4] is not ("admission" or "in-flight" or "commit-before-ack"))
        {
            return 64;
        }
        string root = Path.GetFullPath(args[0]);
        string temporaryRoot = Path.GetFullPath(ChallengeV2Issue2040Owner.TemporaryRoot).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!root.StartsWith(temporaryRoot, StringComparison.Ordinal)
            || !Path.GetFileName(root).StartsWith("fsusblog-challenge-issue2040-", StringComparison.Ordinal))
        {
            return 64;
        }
        using Process parent = Process.GetProcessById(parentId);
        using var owner = new ChallengeV2Issue2040Owner(root: root, deleteRoot: false);
        await owner.Queue.WriteAsync(ChallengeV2Issue2040Owner.Event("process-required", high));
        string digest = Convert.ToHexStringLower(SHA256.HashData(
            await File.ReadAllBytesAsync(typeof(ChallengeV2AdmissionProcessIssue2040Worker).Assembly.Location)));
        Announce("admitted", args[1], digest);
        if (args[4] != "admission")
        {
            if (!owner.Queue.TryRead(out ChallengeV2AuditEvent? delivery) || delivery is null)
            {
                return 65;
            }
            Announce("in-flight", args[1], digest);
            if (args[4] == "commit-before-ack")
            {
                string connection = Environment.GetEnvironmentVariable("FSUSBLOG_CHALLENGE_PROCESS_DATABASE")
                    ?? throw new InvalidOperationException("challenge_process_database_required");
                using var db = PostgresSqlSugarTestClient.Create(connection);
                var stored = await new SecurityChallengePersistenceService(db).RecordAttemptAsync(delivery.Attempt);
                if (!ChallengeV2DurableDelivery.MatchesStored(ChallengeV2DurableDelivery.GetRequired(delivery.Attempt), stored))
                {
                    return 66;
                }
                // Deliberately stop between the real transaction and journal ACK.
                // The production journal remains pending; no fake commit witness.
                Announce("committed", args[1], digest);
            }
        }
        while (!parent.HasExited)
        {
            await Task.Delay(TimeSpan.FromMilliseconds(250));
        }
        return 70;
    }

    private static void Announce(string state, string invocation, string digest)
    {
        Console.WriteLine($"challenge-{state} {invocation} {Environment.ProcessId} {digest}");
        Console.Out.Flush();
    }
}
