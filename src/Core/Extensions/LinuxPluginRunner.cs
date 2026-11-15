namespace FsusBlog.V2.Core.Extensions;

internal sealed class LinuxPluginRunner(string expected, LinuxWorkerUnit unit)
{
    private const string OptIn = "FSUSBLOG_PLATFORM_PLUGIN_LINUX";
    private const string ExpectedInstall = "FSUSBLOG_PLATFORM_PLUGIN_LINUX_INSTALL_SHA256";
    private const string Install = "/opt/fsusblog-platform-plugin-arm64";
    private static readonly byte[] Ready = "FSUS-JINT-ARM64-V1\n"u8.ToArray();
    private static readonly VerifiedWorkerPayload Payload = new("plugin", new(128 * 1024, 1024, 1100, 8, 256 * 1024 * 1024, 1));
    private static readonly IReadOnlyDictionary<string, string?> Required = new Dictionary<string, string?>
    {
        ["launcher"] = null,
        ["rootfs/dotnet/dotnet"] = null,
        ["rootfs/app/FsusBlog.V2.PluginWorker.dll"] = null,
    };

    internal static LinuxPluginRunner Open()
    {
        if (Environment.GetEnvironmentVariable(OptIn) != "1" ||
            Environment.GetEnvironmentVariable(ExpectedInstall) is not { } expected || !ExtensionManifestReader.IsDigest(expected))
            throw new ExtensionRejectedException("plugin-isolation-unavailable");
        return new(expected, LinuxWorkerUnit.Open("platform-plugin", "plugin", new(3, 4, 134217728, 24)));
    }

    internal Task<byte[]> RunAsync(byte[] request, CancellationToken ct) =>
        unit.RunAsync(Install + "/launcher", Install + "/rootfs", request, Ready, PureRenderContract.MarkdownBytes,
            cancellation => Payload.Verify(Install, expected, ValidPath, Required, cancellation), Accept, ct);

    private static bool ValidPath(string path) => path == "rootfs/lib/aarch64-linux-gnu/libstdc++.so.6" ||
        ExtensionManifestReader.IsPackagePath(path);

    private static byte[] Accept(int exit, byte[] result, byte[] errors)
    {
        if (exit == 2 && errors.Length == 0) throw new ExtensionRejectedException("plugin-execution-rejected");
        if (exit != 0 || errors.Length != 0) throw new ExtensionRejectedException("plugin-worker-failure");
        return result;
    }
}
