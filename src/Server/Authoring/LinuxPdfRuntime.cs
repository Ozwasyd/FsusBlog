using System.Security.Cryptography;
using FsusBlog.V2.Core.Extensions;

namespace FsusBlog.V2.Server.Authoring;

internal sealed class LinuxPdfRuntime(string expected, LinuxWorkerUnit unit, IReadOnlyDictionary<string, string?> required)
{
    private const string Install = "/opt/fsusblog-pdf-arm64";
    private const string Launcher = Install + "/launcher";
    private const string Root = Install + "/rootfs";
    private const string FontDigest = "2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b";
    private static readonly VerifiedWorkerPayload Payload = new("pdf", new(2 * 1024 * 1024, 8192, 10000, 16, 512 * 1024 * 1024, 0));

    internal static LinuxPdfRuntime Read(string? root, string? digest)
    {
        if (!string.Equals(root, Install, StringComparison.Ordinal) || digest is null || !ExtensionManifestReader.IsDigest(digest) ||
            !File.Exists("/usr/bin/bwrap") || !File.Exists("/usr/bin/systemd-run") || !File.Exists("/usr/bin/systemctl") ||
            !Directory.Exists(Root + "/proc"))
            throw new InvalidOperationException("Offline Linux PDF requires the verified ARM64 renderer and systemd sandbox.");

        var required = new Dictionary<string, string?>
        {
            ["launcher"] = null,
            ["rootfs/lib/ld-linux-aarch64.so.1"] = null,
            ["rootfs/render/bin/python3"] = null,
            ["rootfs/render/worker.py"] = ResourceDigest("FsusBlog.PdfRender"),
            ["rootfs/render/lib/fsus-pdf-seal.so"] = null,
            ["rootfs/render/fonts.conf"] = ResourceDigest("FsusBlog.LinuxPdfFonts"),
            ["rootfs/render/fonts/NotoSansCJKsc-Regular.otf"] = FontDigest
        };
        var runtime = new LinuxPdfRuntime(digest, LinuxWorkerUnit.Open("document-pdf", "pdf", new(12, 14, 256 * 1024 * 1024, 24)), required);
        runtime.Verify(CancellationToken.None);
        return runtime;
    }

    internal Task<byte[]> RenderAsync(byte[] request, CancellationToken ct) =>
        unit.RunAsync(Launcher, Root, request, PdfWorkerProtocol.Ready, PdfWorkerProtocol.MaximumOutput,
            Verify, PdfWorkerProtocol.Accept, ct);

    private void Verify(CancellationToken cancellation) => Payload.Verify(Install, expected, ValidPath, required, cancellation);

    private static string ResourceDigest(string name)
    {
        using var stream = typeof(LinuxPdfRuntime).Assembly.GetManifestResourceStream(name)
            ?? throw new InvalidOperationException("The offline PDF renderer resource is missing.");
        return Convert.ToHexStringLower(SHA256.HashData(stream));
    }

    private static bool ValidPath(string path) => path == "launcher" ||
        (path.Length <= 512 && path.StartsWith("rootfs/", StringComparison.Ordinal) &&
        path.Split('/').All(component => component.Length > 0 && component is not ("." or "..") &&
            component.All(character => char.IsAsciiLetterOrDigit(character) || character is '.' or '-' or '_' or '+')));
}
