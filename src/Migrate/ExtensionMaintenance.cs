using System.Collections.Immutable;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using FsusBlog.V2.Core.Extensions;
using Microsoft.Win32.SafeHandles;

namespace FsusBlogV2.Migrate;

internal static class ExtensionMaintenance
{
    private const string RootVariable = "FSUSBLOG_EXTENSION_ROOT";
    private const string IdentityVariable = "FSUSBLOG_EXTENSION_STORE_ID";
    private const string KeyVariable = "FSUSBLOG_EXTENSION_MAC_KEY_FILE";
    private const string Help = """
        FsusBlog V2 offline authoring extension store
        Set FSUSBLOG_EXTENSION_ROOT, FSUSBLOG_EXTENSION_STORE_ID and FSUSBLOG_EXTENSION_MAC_KEY_FILE.
          extension init TRUST.json
          extension status
          extension trust SEQUENCE:DIGEST TRUST.json
          extension activate SEQUENCE:DIGEST SOURCE ARCHIVE SIGNATURE
          extension deactivate SEQUENCE:DIGEST EXTENSION_ID
          extension quarantine SEQUENCE:DIGEST EXTENSION_ID REASON_CODE
          extension release SEQUENCE:DIGEST EXTENSION_ID QUARANTINE_RECEIPT APPROVAL_ID
        """;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        AllowDuplicateProperties = false,
        MaxDepth = 12,
        RespectNullableAnnotations = true,
        RespectRequiredConstructorParameters = true,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
    };

    internal static async Task<int> RunAsync(string[] args, CancellationToken cancellationToken)
    {
        if (args is [] or ["--help"] or ["help"])
        {
            Console.WriteLine(Help);
            return 0;
        }
        if (args is not (["init", _] or ["status"] or ["trust", _, _] or ["activate", _, _, _, _] or
            ["deactivate", _, _] or ["quarantine", _, _, _] or ["release", _, _, _, _]))
        {
            Console.Error.WriteLine("Unrecognized extension command. Run extension --help.");
            return 1;
        }

        try
        {
            if (OperatingSystem.IsWindows() || (!OperatingSystem.IsLinux() && !OperatingSystem.IsMacOS()))
                throw new ExtensionRejectedException("extension-platform");
            var root = new DirectoryInfo(AbsolutePath(RequireVariable(RootVariable)));
            var id = ParseId(RequireVariable(IdentityVariable));
            var keyPath = AbsolutePath(RequireVariable(KeyVariable));
            var keyDirectory = new FileInfo(keyPath).Directory!;
            var relative = Path.GetRelativePath(root.FullName, keyPath);
            if (relative != ".." && !relative.StartsWith("../", StringComparison.Ordinal)) throw new ExtensionRejectedException("extension-key-outside-store");
            RequirePrivateDirectory(keyDirectory);
            var mac = await ReadAsync(keyPath, 32, privateFile: true, cancellationToken);
            try
            {
                if (mac.Length != 32) throw new ExtensionRejectedException("extension-key-size");
                if (args is ["status"])
                {
                    var status = ExtensionInstallationStore.Inspect(root, id, mac, TimeProvider.System, cancellationToken);
                    Console.WriteLine(JsonSerializer.Serialize(status, Json));
                    return 0;
                }
                if (args is ["init", var config])
                {
                    var trust = await ReadTrustAsync(config, cancellationToken);
                    using var created = ExtensionInstallationStore.Create(root, id, mac, trust.Keys, trust.Sources, TimeProvider.System);
                    WriteCheckpoint(created.Checkpoint);
                    return 0;
                }

                var checkpoint = ParseCheckpoint(args[1]);
                using var store = ExtensionInstallationStore.OpenForMaintenance(root, id, mac, TimeProvider.System, checkpoint);
                switch (args)
                {
                    case ["trust", _, var trustFile]:
                        var trust = await ReadTrustAsync(trustFile, cancellationToken);
                        store.ReplaceTrust(trust.Keys, trust.Sources);
                        break;
                    case ["activate", _, var source, var archive, var signature]:
                        var data = await ReadAsync(archive, ExtensionInstallationStore.MaximumArchiveBytes, privateFile: false, cancellationToken);
                        var signed = await ReadAsync(signature, ExtensionInstallationStore.MaximumSignatureBytes, privateFile: false, cancellationToken);
                        store.InstallAndActivate(source, data, signed, ExtensionPlatform.ServerLinux, cancellationToken);
                        break;
                    case ["deactivate", _, var name]:
                        store.Deactivate(name);
                        break;
                    case ["quarantine", _, var name, var reason]:
                        store.Quarantine(name, reason);
                        break;
                    case ["release", _, var name, var receipt, var approval]:
                        store.ClearQuarantine(name, ParseId(receipt), ParseId(approval));
                        break;
                }
                WriteCheckpoint(store.Checkpoint);
                return 0;
            }
            finally { CryptographicOperations.ZeroMemory(mac); }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            Console.Error.WriteLine("Extension command cancelled.");
            return 130;
        }
        catch (ExtensionRejectedException error)
        {
            Console.Error.WriteLine(error.Code);
            return 1;
        }
        catch (JsonException)
        {
            Console.Error.WriteLine("extension-trust-shape");
            return 1;
        }
        catch (Exception error) when (error is ArgumentException or IOException or UnauthorizedAccessException)
        {
            Console.Error.WriteLine("extension-local-file-unavailable");
            return 1;
        }
    }

    private static async Task<Trust> ReadTrustAsync(string path, CancellationToken cancellationToken)
    {
        path = Path.GetFullPath(path);
        RequirePrivateDirectory(new FileInfo(path).Directory!);
        var bytes = await ReadAsync(path, 2 * 1024 * 1024, privateFile: true, cancellationToken);
        var trust = JsonSerializer.Deserialize<Trust>(bytes, Json);
        if (trust is null || trust.Keys.IsDefault || trust.Sources.IsDefault) throw new ExtensionRejectedException("extension-trust-shape");
        return trust;
    }

    private static async Task<byte[]> ReadAsync(string path, int limit, bool privateFile, CancellationToken cancellationToken)
    {
        if (OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        if ((File.GetAttributes(path) & (FileAttributes.ReparsePoint | FileAttributes.Directory | FileAttributes.Device)) != 0 ||
            (privateFile && File.GetUnixFileMode(path) != UnixFileMode.UserRead)) throw new ExtensionRejectedException("extension-input-mode");
        // Reject last-component symlinks at open and avoid blocking on a supplied FIFO.
        const int macOpen = 0x1000000 | 0x100 | 0x4; // O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK
        const int linuxOpen = 0x80000 | 0x20000 | 0x800;
        var descriptor = OpenInput(path, OperatingSystem.IsMacOS() ? macOpen : linuxOpen);
        if (descriptor < 0) throw new ExtensionRejectedException("extension-input-open");
        using var handle = new SafeFileHandle(descriptor, ownsHandle: true);
        await using var stream = new FileStream(handle, FileAccess.Read);
        if (!stream.CanSeek || stream.Length < 1 || stream.Length > limit) throw new ExtensionRejectedException("extension-input-size");
        var bytes = new byte[(int)stream.Length];
        await stream.ReadExactlyAsync(bytes, cancellationToken);
        var extra = new byte[1];
        if (await stream.ReadAsync(extra, cancellationToken) != 0) throw new ExtensionRejectedException("extension-input-size");
        return bytes;
    }

    [DllImport("libc", EntryPoint = "open")]
    private static extern int OpenInput([MarshalAs(UnmanagedType.LPUTF8Str)] string path, int flags);

    private static void RequirePrivateDirectory(DirectoryInfo directory)
    {
        if (OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        const UnixFileMode required = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute;
        if (!directory.Exists || File.GetUnixFileMode(directory.FullName) != required) throw new ExtensionRejectedException("extension-config-parent-mode");
        for (DirectoryInfo? component = directory; component is not null; component = component.Parent)
            if ((component.Attributes & FileAttributes.ReparsePoint) != 0) throw new ExtensionRejectedException("extension-config-parent-link");
    }

    private static string RequireVariable(string name) => Environment.GetEnvironmentVariable(name) is { Length: > 0 } value
        ? value : throw new ExtensionRejectedException("extension-operator-config-required");

    private static string AbsolutePath(string path) => Path.IsPathFullyQualified(path) ? Path.GetFullPath(path) :
        throw new ExtensionRejectedException("extension-operator-path-absolute");

    private static Guid ParseId(string text) => Guid.TryParseExact(text, "D", out var id) && id != Guid.Empty ? id :
        throw new ExtensionRejectedException("extension-identity-invalid");

    private static ExtensionCheckpoint ParseCheckpoint(string text)
    {
        var colon = text.IndexOf(':');
        if (text.Length is < 66 or > 84 || colon < 1 || !long.TryParse(text.AsSpan(0, colon), System.Globalization.NumberStyles.None,
            System.Globalization.CultureInfo.InvariantCulture, out var sequence) || sequence < 1 ||
            text.Length - colon - 1 != 64 || !text[(colon + 1)..].All(char.IsAsciiHexDigitLower))
            throw new ExtensionRejectedException("extension-checkpoint-shape");
        return new(sequence, text[(colon + 1)..]);
    }

    private static void WriteCheckpoint(ExtensionCheckpoint checkpoint) => Console.WriteLine(JsonSerializer.Serialize(checkpoint, Json));

    private sealed record Trust(ImmutableArray<ExtensionPublisherKey> Keys, ImmutableArray<ApprovedExtensionSource> Sources);
}
