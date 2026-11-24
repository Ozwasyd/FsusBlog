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

    internal static ProcessStartInfo Migration(string dsn, params string[] arguments) =>
        Cli(dsn, Environment.GetEnvironmentVariable(PublicationTransparencyFact.MigrationPath), arguments);

    internal static ProcessStartInfo Cli(string? dsn, string? explicitPath, params string[] arguments)
    {
        var migrate = explicitPath;
        if (string.IsNullOrEmpty(migrate))
        {
            var current = new DirectoryInfo(AppContext.BaseDirectory);
            while (current is not null && !File.Exists(Path.Combine(current.FullName, "FsusBlog.V2.slnx")))
                current = current.Parent;
            Assert.NotNull(current);
            var configuration = new DirectoryInfo(AppContext.BaseDirectory).Parent!.Name;
            migrate = Path.Combine(current!.FullName, "src", "Cli", "bin", configuration, "net10.0", "FsusBlog.V2.Cli.dll");
            if (!File.Exists(migrate))
                migrate = Path.Combine(current.FullName, "src", "Cli", "bin", "Release", "net10.0", "FsusBlog.V2.Cli.dll");
        }
        if (!Path.IsPathFullyQualified(migrate) || !File.Exists(migrate))
            throw new InvalidOperationException("Supply the absolute path to the built migration CLI.");
        var start = Command(Environment.GetEnvironmentVariable("DOTNET_HOST_PATH") ??
            Environment.GetEnvironmentVariable("DOTNET_BIN") ?? "dotnet", [migrate, .. arguments]);
        if (dsn is not null) start.Environment["FSUSBLOG_DB"] = dsn;
        return start;
    }

    internal static async Task Stop(Process child, TimeSpan timeout)
    {
        if (!child.HasExited) child.Kill(entireProcessTree: true);
        await child.WaitForExitAsync().WaitAsync(timeout);
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
            await Stop(process, TimeSpan.FromSeconds(5));
            throw;
        }
        return new(process.ExitCode, await output, await error);
    }
}
