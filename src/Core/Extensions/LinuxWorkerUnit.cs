using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;

namespace FsusBlog.V2.Core.Extensions;

internal sealed record LinuxWorkerLimits(int DeadlineSeconds, int RuntimeSeconds, int MemoryBytes, int Tasks);

internal sealed class LinuxWorkerUnit(uint uid, string name, string errorPrefix, LinuxWorkerLimits limits)
{
    private static readonly string[] Properties =
    [
        "Type=exec", "ExitType=cgroup", "Restart=no", "NoNewPrivileges=yes", "LimitCORE=0",
        "KillMode=control-group", "SendSIGKILL=yes", "TimeoutStopSec=250ms",
        "MemorySwapMax=0", "CPUQuota=100%", "CPUQuotaPeriodSec=100ms", "OOMPolicy=kill"
    ];
    private readonly uint _uid = uid;
    private readonly string _session = $"/run/user/{uid}";
    private string Deadline => Failure("deadline");

    internal static LinuxWorkerUnit Open(string name, string errorPrefix, LinuxWorkerLimits limits)
    {
        if (!OperatingSystem.IsLinux() || RuntimeInformation.ProcessArchitecture != Architecture.Arm64 || !BitConverter.IsLittleEndian)
            throw new ExtensionRejectedException(errorPrefix + "-isolation-unavailable");
        var uid = GetUserId();
        if (uid == 0) throw new ExtensionRejectedException(errorPrefix + "-isolation-unavailable");
        return new(uid, name, errorPrefix, limits);
    }

    internal async Task<byte[]> RunAsync(string launcher, string root, ReadOnlyMemory<byte> request,
        ReadOnlyMemory<byte> ready, int maximumOutput, Action<CancellationToken> verify,
        Func<int, byte[], byte[], byte[]> accept, CancellationToken ct)
    {
        var unit = $"fsus-{name}-{Guid.NewGuid():N}.service";
        var group = $"/sys/fs/cgroup/user.slice/user-{_uid}.slice/user@{_uid}.service/app.slice/{unit}";
        var start = Start("/usr/bin/systemd-run", "--user", "--quiet", "--pipe", "--wait", "--collect",
            "--expand-environment=no", "--slice=app.slice", "--unit=" + unit);
        foreach (var limit in Properties) start.ArgumentList.Add("--property=" + limit);
        start.ArgumentList.Add(FormattableString.Invariant($"--property=RuntimeMaxSec={limits.RuntimeSeconds}s"));
        start.ArgumentList.Add(FormattableString.Invariant($"--property=MemoryMax={limits.MemoryBytes}"));
        start.ArgumentList.Add(FormattableString.Invariant($"--property=TasksMax={limits.Tasks}"));
        foreach (var argument in new[] { "--", launcher, root }) start.ArgumentList.Add(argument);

        verify(ct);
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(TimeSpan.FromSeconds(limits.DeadlineSeconds));
        ct.ThrowIfCancellationRequested();
        using var process = Process.Start(start) ?? throw Deny("start");
        Task<byte[]>? errors = null;
        Task<byte[]>? output = null;
        var dispatched = false;
        return await PluginWorkerCompletion.RunAsync(Execute,
            () => PluginWorkerCompletion.ReleaseProcessAsync(deadline, () => CleanupAsync(process, unit, group, dispatched), output, errors));

        async Task<byte[]> Execute()
        {
            try
            {
                errors = PluginWorkerCompletion.ReadAsync(process.StandardError.BaseStream, 4096, deadline.Token);
                var stdout = process.StandardOutput.BaseStream;
                var marker = new byte[ready.Length];
                await stdout.ReadExactlyAsync(marker, deadline.Token);
                if (!marker.AsSpan().SequenceEqual(ready.Span) || !await AdmittedAsync(unit, group, deadline.Token, ct))
                    throw Deny("admission");
                output = PluginWorkerCompletion.ReadAsync(stdout, maximumOutput, deadline.Token);
                dispatched = true;
                await process.StandardInput.BaseStream.WriteAsync(request, deadline.Token);
                process.StandardInput.Close();
                var result = await output;
                var stderr = await errors;
                await process.WaitForExitAsync(deadline.Token);
                var value = accept(process.ExitCode, result, stderr);
                try { await WaitDrained(group, deadline.Token); }
                catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
                catch (Exception error) { throw PluginWorkerCompletion.Translate(error, PluginWorkerCompletion.DrainFailure); }
                verify(deadline.Token);
                return value;
            }
            catch (OperationCanceledException error) when (!ct.IsCancellationRequested)
            {
                throw PluginWorkerCompletion.Translate(error, Deadline);
            }
            catch (EndOfStreamException error) { throw PluginWorkerCompletion.Translate(error, Failure("admission")); }
        }
    }

    private async Task<bool> AdmittedAsync(string unit, string group, CancellationToken deadline, CancellationToken caller)
    {
        if (Control(group, "cgroup.type") != "domain" || Control(group, "memory.max") != limits.MemoryBytes.ToString(CultureInfo.InvariantCulture) ||
            Control(group, "memory.swap.max") != "0" || Control(group, "memory.oom.group") != "1" ||
            Control(group, "pids.max") != limits.Tasks.ToString(CultureInfo.InvariantCulture) || Control(group, "cpu.max") != "100000 100000" || !Populated(group)) return false;
        using var inspection = CancellationTokenSource.CreateLinkedTokenSource(deadline);
        using var show = Process.Start(Start("/usr/bin/systemctl", "--user", "show", "--property=MainPID",
            "--property=ControlGroup", "--property=ActiveState", unit)) ?? throw Deny("admission");
        Task<byte[]>? output = null;
        Task<byte[]>? errors = null;
        return await PluginWorkerCompletion.RunAsync(Inspect,
            () => PluginWorkerCompletion.ReleaseProcessAsync(inspection, () => ReapClientAsync(show), output, errors));

        async Task<bool> Inspect()
        {
            try
            {
                show.StandardInput.Close();
                output = PluginWorkerCompletion.ReadAsync(show.StandardOutput.BaseStream, 4096, inspection.Token);
                errors = PluginWorkerCompletion.ReadAsync(show.StandardError.BaseStream, 4096, inspection.Token);
                await show.WaitForExitAsync(inspection.Token);
                var lines = System.Text.Encoding.ASCII.GetString(await output).Split('\n', StringSplitOptions.RemoveEmptyEntries);
                var groupPath = group["/sys/fs/cgroup".Length..];
                if (show.ExitCode != 0 || (await errors).Length != 0 || lines.Length != 3 ||
                    !lines.Contains($"ControlGroup={groupPath}", StringComparer.Ordinal) ||
                    !lines.Contains("ActiveState=active", StringComparer.Ordinal) ||
                    lines.SingleOrDefault(line => line.StartsWith("MainPID=", StringComparison.Ordinal)) is not { } main ||
                    !int.TryParse(main.AsSpan(8), System.Globalization.NumberStyles.None,
                        System.Globalization.CultureInfo.InvariantCulture, out var pid) || pid <= 1 ||
                    Control($"/proc/{pid}", "cgroup") != $"0::{groupPath}" ||
                    !Control(group, "cgroup.procs").Split('\n').Contains(main[8..], StringComparer.Ordinal))
                    throw Deny("admission");
                return true;
            }
            catch (OperationCanceledException error) when (!caller.IsCancellationRequested)
            {
                throw PluginWorkerCompletion.Translate(error, Deadline);
            }
        }
    }

    private string Control(string group, string file)
    {
        var path = Path.Combine(group, file);
        using var input = new StreamReader(path);
        var read = new char[513];
        var size = input.ReadBlock(read, 0, read.Length);
        return size < read.Length ? new string(read, 0, size).Trim() : throw Deny("admission");
    }

    private bool Populated(string group)
    {
        try
        {
            var events = Control(group, "cgroup.events").Split('\n');
            if (events.Contains("populated 1", StringComparer.Ordinal)) return true;
            if (events.Contains("populated 0", StringComparer.Ordinal)) return false;
            throw Deny("admission");
        }
        catch (Exception error) when (error is DirectoryNotFoundException or FileNotFoundException) { return false; }
    }

    private async Task WaitDrained(string group, CancellationToken ct)
    {
        while (Populated(group)) await Task.Delay(20, ct);
    }

    private async Task CleanupAsync(Process process, string unit, string group, bool dispatched)
    {
        var needsStop = true;
        // Before admission, stop the submission client first, then check its unique unit even if reaping failed.
        await PluginWorkerCompletion.ReleaseAsync(() =>
        {
            needsStop = !dispatched || !process.HasExited || Populated(group);
            return Task.CompletedTask;
        }, () => !dispatched ? ReapClientAsync(process) : Task.CompletedTask,
            () => needsStop ? StopUnit() : Task.CompletedTask,
            () => needsStop ? ReapClientAsync(process) : Task.CompletedTask);

        async Task StopUnit()
        {
            using var cleanup = new CancellationTokenSource(TimeSpan.FromSeconds(2));
            using var stop = Process.Start(Start("/usr/bin/systemctl", "--user", "stop", unit)) ??
                throw new ExtensionRejectedException(PluginWorkerCompletion.DrainFailure);
            Task<byte[]>? output = null;
            Task<byte[]>? errors = null;
            await PluginWorkerCompletion.ReleaseAsync(async () =>
            {
                stop.StandardInput.Close();
                output = PluginWorkerCompletion.ReadAsync(stop.StandardOutput.BaseStream, 4096, cleanup.Token);
                errors = PluginWorkerCompletion.ReadAsync(stop.StandardError.BaseStream, 4096, cleanup.Token);
                await stop.WaitForExitAsync(cleanup.Token);
                await Task.WhenAll(output, errors);
                if (stop.ExitCode != 0 && Populated(group)) throw new ExtensionRejectedException(PluginWorkerCompletion.DrainFailure);
                await WaitDrained(group, cleanup.Token);
            }, () => PluginWorkerCompletion.ReleaseProcessAsync(cleanup, () => ReapClientAsync(stop), output, errors));
        }
    }

    private static Task ReapClientAsync(Process process) =>
        PluginWorkerCompletion.ReapProcessAsync(process, entireProcessTree: false, TimeSpan.FromSeconds(1));

    private ProcessStartInfo Start(string file, params string[] arguments)
    {
        var start = new ProcessStartInfo(file)
        {
            UseShellExecute = false, WorkingDirectory = "/", RedirectStandardInput = true,
            RedirectStandardOutput = true, RedirectStandardError = true
        };
        foreach (var item in arguments) start.ArgumentList.Add(item);
        start.Environment.Clear();
        start.Environment["LC_ALL"] = "C";
        start.Environment["XDG_RUNTIME_DIR"] = _session;
        start.Environment["DBUS_SESSION_BUS_ADDRESS"] = $"unix:path={_session}/bus";
        return start;
    }

    [DllImport("libc.so.6", EntryPoint = "geteuid")]
    private static extern uint GetUserId();

    private string Failure(string code) => $"{errorPrefix}-worker-{code}";
    private ExtensionRejectedException Deny(string code) => new(Failure(code));
}
