using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using FsusBlog.V2.Core;
using FsusBlog.V2.Core.Extensions;

namespace FsusBlogV2.Migrate;

internal sealed class LinuxPluginRunner
{
    private const string OptIn = "FSUSBLOG_PLATFORM_PLUGIN_LINUX";
    private const string ExpectedInstall = "FSUSBLOG_PLATFORM_PLUGIN_LINUX_INSTALL_SHA256";
    private const string Install = "/opt/fsusblog-platform-plugin-arm64";
    private const string Launcher = Install + "/launcher";
    private const string Root = Install + "/rootfs";
    private const string FileManifest = "payload.sha256";
    private static readonly byte[] Ready = "FSUS-JINT-ARM64-V1\n"u8.ToArray();
    private static readonly string[] Limits =
    [
        "Type=exec", "ExitType=cgroup", "Restart=no", "NoNewPrivileges=yes", "LimitCORE=0",
        "KillMode=control-group", "SendSIGKILL=yes", "TimeoutStopSec=250ms", "RuntimeMaxSec=4s",
        "MemoryMax=134217728", "MemorySwapMax=0", "TasksMax=24", "CPUQuota=100%", "CPUQuotaPeriodSec=100ms",
        "OOMPolicy=kill"
    ];
    private readonly uint _uid;
    private readonly string _session;
    private readonly string _expectedInstall;

    private LinuxPluginRunner(uint uid, string expectedInstall)
    {
        _uid = uid;
        _session = $"/run/user/{uid}";
        _expectedInstall = expectedInstall;
    }

    internal static LinuxPluginRunner Open()
    {
        if (!OperatingSystem.IsLinux() || RuntimeInformation.ProcessArchitecture != Architecture.Arm64 ||
            Environment.GetEnvironmentVariable(OptIn) != "1" ||
            Environment.GetEnvironmentVariable(ExpectedInstall) is not { } expected || !ExtensionManifestReader.IsDigest(expected))
            throw Deny("plugin-isolation-unavailable");
        var uid = GetUserId();
        if (uid == 0) throw Deny("plugin-isolation-unavailable");
        return new(uid, expected);
    }

    internal async Task<byte[]> RunAsync(byte[] request, CancellationToken ct)
    {
        var unit = $"fsus-platform-plugin-{Guid.NewGuid():N}.service";
        var group = $"/sys/fs/cgroup/user.slice/user-{_uid}.slice/user@{_uid}.service/app.slice/{unit}";
        var start = Start("/usr/bin/systemd-run", "--user", "--quiet", "--pipe", "--wait", "--collect",
            "--expand-environment=no", "--slice=app.slice", "--unit=" + unit);
        foreach (var limit in Limits) start.ArgumentList.Add("--property=" + limit);
        foreach (var argument in new[] { "--", Launcher, Root }) start.ArgumentList.Add(argument);

        CheckInstall(ct);
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(TimeSpan.FromSeconds(3));
        ct.ThrowIfCancellationRequested();
        using var process = Process.Start(start) ?? throw Deny("plugin-worker-start");
        var errors = PlatformPluginCommand.ReadAsync(process.StandardError.BaseStream, 4096, deadline.Token);
        Task<byte[]>? output = null;
        var dispatched = false;
        try
        {
            var stdout = process.StandardOutput.BaseStream;
            var marker = new byte[Ready.Length];
            await stdout.ReadExactlyAsync(marker, deadline.Token);
            if (!marker.AsSpan().SequenceEqual(Ready) || !await AdmittedAsync(unit, group, deadline.Token))
                throw Deny("plugin-worker-admission");
            output = PlatformPluginCommand.ReadAsync(stdout, PureRenderContract.MarkdownBytes, deadline.Token);
            dispatched = true;
            await process.StandardInput.BaseStream.WriteAsync(request, deadline.Token);
            process.StandardInput.Close();
            var result = await output;
            var stderr = await errors;
            await process.WaitForExitAsync(deadline.Token);
            if (process.ExitCode == 2 && stderr.Length == 0) throw Deny("plugin-execution-rejected");
            if (process.ExitCode != 0 || stderr.Length != 0) throw Deny("plugin-worker-failure");
            await WaitDrained(group, deadline.Token);
            CheckInstall(deadline.Token);
            return result;
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { throw Deny("plugin-worker-deadline"); }
        catch (EndOfStreamException) { throw Deny("plugin-worker-admission"); }
        finally
        {
            deadline.Cancel();
            await CleanupAsync(process, unit, group, dispatched);
            try
            {
                if (output is not null) await Task.WhenAll(errors, output);
                else await errors;
            }
            catch (Exception) { } // The enclosing worker operation already supplies the outcome.
        }
    }

    private async Task<bool> AdmittedAsync(string unit, string group, CancellationToken ct)
    {
        if (Control(group, "cgroup.type") != "domain" || Control(group, "memory.max") != "134217728" ||
            Control(group, "memory.swap.max") != "0" || Control(group, "memory.oom.group") != "1" ||
            Control(group, "pids.max") != "24" || Control(group, "cpu.max") != "100000 100000" || !Populated(group)) return false;
        using var show = Process.Start(Start("/usr/bin/systemctl", "--user", "show", "--property=MainPID",
            "--property=ControlGroup", "--property=ActiveState", unit)) ?? throw Deny("plugin-worker-admission");
        show.StandardInput.Close();
        var output = PlatformPluginCommand.ReadAsync(show.StandardOutput.BaseStream, 4096, ct);
        var errors = PlatformPluginCommand.ReadAsync(show.StandardError.BaseStream, 4096, ct);
        try
        {
            await show.WaitForExitAsync(ct);
            var lines = System.Text.Encoding.ASCII.GetString(await output).Split('\n', StringSplitOptions.RemoveEmptyEntries);
            var groupPath = group["/sys/fs/cgroup".Length..];
            if (show.ExitCode != 0 || (await errors).Length != 0 || lines.Length != 3 ||
                !lines.Contains($"ControlGroup={groupPath}", StringComparer.Ordinal) ||
                !lines.Contains("ActiveState=active", StringComparer.Ordinal) ||
                lines.SingleOrDefault(line => line.StartsWith("MainPID=", StringComparison.Ordinal)) is not { } main ||
                !int.TryParse(main.AsSpan(8), System.Globalization.NumberStyles.None,
                    System.Globalization.CultureInfo.InvariantCulture, out var pid) || pid <= 1) return false;
            return Control($"/proc/{pid}", "cgroup") == $"0::{groupPath}" &&
                Control(group, "cgroup.procs").Split('\n').Contains(main[8..], StringComparer.Ordinal);
        }
        finally { await ReapClientAsync(show); }
    }

    private static string Control(string group, string file)
    {
        var path = Path.Combine(group, file);
        using var input = new StreamReader(path);
        var read = new char[513];
        var size = input.ReadBlock(read, 0, read.Length);
        return size < read.Length ? new string(read, 0, size).Trim() : throw Deny("plugin-worker-admission");
    }

    private static bool Populated(string group)
    {
        try
        {
            var events = Control(group, "cgroup.events").Split('\n');
            if (events.Contains("populated 1", StringComparer.Ordinal)) return true;
            if (events.Contains("populated 0", StringComparer.Ordinal)) return false;
            throw Deny("plugin-worker-admission");
        }
        catch (Exception error) when (error is DirectoryNotFoundException or FileNotFoundException) { return false; }
    }

    private static async Task WaitDrained(string group, CancellationToken ct)
    {
        while (Populated(group)) await Task.Delay(20, ct);
    }

    private async Task CleanupAsync(Process process, string unit, string group, bool dispatched)
    {
        if (process.HasExited && !Populated(group)) return;
        if (!dispatched) await ReapClientAsync(process);
        using var cleanup = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        using var stop = Process.Start(Start("/usr/bin/systemctl", "--user", "stop", unit)) ??
            throw Deny("plugin-worker-drain");
        stop.StandardInput.Close();
        try
        {
            var output = PlatformPluginCommand.ReadAsync(stop.StandardOutput.BaseStream, 4096, cleanup.Token);
            var errors = PlatformPluginCommand.ReadAsync(stop.StandardError.BaseStream, 4096, cleanup.Token);
            await stop.WaitForExitAsync(cleanup.Token);
            await Task.WhenAll(output, errors);
            if (stop.ExitCode != 0 && Populated(group)) throw Deny("plugin-worker-drain");
            await WaitDrained(group, cleanup.Token);
        }
        catch (OperationCanceledException) { throw Deny("plugin-worker-drain"); }
        finally
        {
            await ReapClientAsync(stop);
            await ReapClientAsync(process);
        }
    }

    private static async Task ReapClientAsync(Process process)
    {
        if (process.HasExited) return;
        try { process.Kill(entireProcessTree: false); }
        catch (InvalidOperationException) when (process.HasExited) { }
        await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(1));
    }

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

    private void CheckInstall(CancellationToken ct)
    {
        try { VerifyInstall(_expectedInstall, ct); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            throw Deny("plugin-install-untrusted");
        }
    }

    private static void VerifyInstall(string expected, CancellationToken ct)
    {
        for (DirectoryInfo? current = new(Install); current is not null; current = current.Parent)
        {
            using var parent = NativeUnixFile.OpenDirectory(current.FullName);
            if (!NativeUnixFile.IsRootControlled(parent, regular: false)) throw Deny("plugin-install-untrusted");
        }
        using var manifest = Open(Install, FileManifest);
        var manifestLength = manifest.Length;
        if (manifestLength is < 1 or > 128 * 1024) throw Deny("plugin-install-manifest");
        var bytes = new byte[(int)manifestLength];
        manifest.ReadExactly(bytes);
        if (manifest.ReadByte() != -1 || Convert.ToHexStringLower(SHA256.HashData(bytes)) != expected)
            throw Deny("plugin-install-digest");
        var listed = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var entry in System.Text.Encoding.ASCII.GetString(bytes).Split('\n', StringSplitOptions.RemoveEmptyEntries))
        {
            if (entry.Length < 67 || entry[64..66] != "  " || !ExtensionManifestReader.IsDigest(entry[..64]) ||
                (entry[66..] != "rootfs/lib/aarch64-linux-gnu/libstdc++.so.6" && !ExtensionManifestReader.IsPackagePath(entry[66..])) || !listed.TryAdd(entry[66..], entry[..64]))
                throw Deny("plugin-install-manifest");
        }
        if (listed.Count is < 5 or > 1024 || !listed.ContainsKey("launcher") || !listed.ContainsKey("rootfs/dotnet/dotnet") ||
            !listed.ContainsKey("rootfs/app/FsusBlog.V2.PluginWorker.dll")) throw Deny("plugin-install-manifest");
        long remaining = 256 * 1024 * 1024;
        var entryCount = 0;
        VerifyDirectory(new(Install), 0);

        void VerifyDirectory(DirectoryInfo directory, int depth)
        {
            if (depth > 8) throw Deny("plugin-install-size");
            using var handle = NativeUnixFile.OpenDirectory(directory.FullName);
            if (!NativeUnixFile.IsRootControlled(handle, regular: false)) throw Deny("plugin-install-untrusted");
            foreach (var entry in directory.EnumerateFileSystemInfos())
            {
                ct.ThrowIfCancellationRequested();
                if (++entryCount > 1100) throw Deny("plugin-install-size");
                if ((entry.Attributes & FileAttributes.ReparsePoint) != 0) throw Deny("plugin-install-untrusted");
                if (entry is DirectoryInfo child) { VerifyDirectory(child, depth + 1); continue; }
                var relative = Path.GetRelativePath(Install, entry.FullName);
                if (relative == FileManifest) continue;
                if (!listed.Remove(relative, out var digest)) throw Deny("plugin-install-manifest");
                using var file = Open(directory.FullName, entry.Name);
                var length = file.Length;
                if (length < 1 || length > remaining) throw Deny("plugin-install-size");
                remaining -= length;
                if (Convert.ToHexStringLower(SHA256.HashData(file)) != digest) throw Deny("plugin-install-digest");
            }
            if (directory.FullName == Install && listed.Count != 0) throw Deny("plugin-install-manifest");
        }
    }

    private static FileStream Open(string path, string name)
    {
        using var directory = NativeUnixFile.OpenDirectory(path);
        var handle = NativeUnixFile.OpenFile(directory, name, NativeUnixFile.FileReadFlags, out _) ??
            throw Deny("plugin-install-untrusted");
        try
        {
            if (!NativeUnixFile.IsRootControlled(handle, regular: true)) throw Deny("plugin-install-untrusted");
            return new FileStream(handle, FileAccess.Read);
        }
        catch { handle.Dispose(); throw; }
    }

    [DllImport("libc.so.6", EntryPoint = "geteuid")]
    private static extern uint GetUserId();

    private static ExtensionRejectedException Deny(string code) => new(code);
}
