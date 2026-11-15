using System.Diagnostics;

namespace FsusBlog.V2.Integration.Tests;

internal static class FixtureProcess
{
    internal readonly record struct Result(int Code, string Output, string Error);

    internal static ProcessStartInfo Command(string executable, params string[] arguments)
    {
        var start = new ProcessStartInfo(executable);
        foreach (var argument in arguments) start.ArgumentList.Add(argument);
        return start;
    }

    internal static ProcessStartInfo Migration(string dsn, params string[] arguments)
    {
        var start = Command(Environment.GetEnvironmentVariable("DOTNET_BIN") ?? "dotnet",
            [Environment.GetEnvironmentVariable(PublicationTransparencyFact.MigrationPath)!, .. arguments]);
        start.Environment["FSUSBLOG_DB"] = dsn;
        return start;
    }

    internal static async Task<Result> Run(ProcessStartInfo start, CancellationToken ct)
    {
        start.UseShellExecute = false;
        start.RedirectStandardOutput = true;
        start.RedirectStandardError = true;
        using var process = Process.Start(start) ?? throw new InvalidOperationException("The native test command did not start.");
        var output = process.StandardOutput.ReadToEndAsync(ct);
        var error = process.StandardError.ReadToEndAsync(ct);
        try { await process.WaitForExitAsync(ct); }
        catch (OperationCanceledException)
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
            await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5));
            throw;
        }
        return new(process.ExitCode, await output, await error);
    }
}
