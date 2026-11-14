using System.Collections.Immutable;
using System.IO.Compression;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;
using static FsusBlog.V2.Core.Extensions.ExtensionManifestReader;
using static FsusBlog.V2.Core.Extensions.ExtensionPackageVerifier;

namespace FsusBlog.V2.Core.Extensions;

/// <summary>Host-owned single-hook approval. Holds the original private registry lock until the result is checked.</summary>
public sealed class PureRenderPlugin : IDisposable
{
    public const string HookName = "article.beforeRenderMarkdown";
    public const int MaximumMarkdownBytes = 16 * 1024;
    public const int MaximumSourceBytes = 16 * 1024;
    private static readonly UTF8Encoding Utf8 = new(false, true);
    private static readonly JsonSerializerOptions ManifestJson = new(Json) { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, MaxDepth = 8 };
    private readonly string _root;
    private readonly TimeProvider _clock;
    private readonly long _started;
    private readonly SignedArchiveTrust _trust;
    private readonly string _registryDigest;
    private readonly FileStream _lease;

    public string JavaScript { get; }
    public int TimeoutMs { get; }

    public static PureRenderPlugin Open(DirectoryInfo root, string id, TimeProvider clock, CancellationToken ct = default)
    {
        ct.ThrowIfCancellationRequested();
        var directory = ExtensionDisk.ValidatePrivateRoot(root);
        if (!IsIdentifier(id) || id.Count(c => c is '.' or '-') < 2) throw Reject("plugin-id");
        var lease = Acquire(directory);
        try
        {
            var start = clock.GetTimestamp();
            var json = ExtensionDisk.Read(directory, "platform-plugin.json", 32 * 1024, ct);
            var policy = JsonSerializer.Deserialize<Policy>(json, Json) ?? throw Reject("plugin-approval");
            if (!policy.Enabled || policy.PluginId != id || policy.Permissions is not ["article.render"] || policy.Source is null ||
                policy.Key is null || !IsDigest(policy.Source.ArchiveSha256)) throw Reject("plugin-approval");
            var verifier = new ExtensionPackageVerifier([policy.Key], [policy.Source], clock);
            var bytes = ReadArchive(directory, policy.Source.ArchiveSha256, ct);
            var entries = ReadPackage(bytes, ct);
            var trust = verifier.VerifyApprovedPayload(policy.Source.Reference, bytes, entries.Checksums, entries.Signature, ct);
            var manifest = JsonSerializer.Deserialize<Manifest>(entries.Manifest, ManifestJson) ?? throw Reject("plugin-manifest");
            if (manifest.Id != id || manifest.Author != policy.Source.Publisher ||
                !Label(manifest.Name, 128) || !Label(manifest.Description, 512) || !IsVersion(manifest.Version) ||
                manifest.Version.Split('.') is not [var major, var minor, var patch] || !Canonical(major) || !Canonical(minor) || !Canonical(patch) ||
                manifest.Fsusblog != ">=1.3.0 <2.0.0" ||
                manifest.Runtime != new Runtime("javascript", "index.js") || manifest.ConfigSchema != "config.schema.json" ||
                manifest.Capabilities is not ["article.render"] || manifest.Permissions != new Permissions(false, false, "none") ||
                manifest.Hooks is not [{ Name: HookName, Priority: 0, TimeoutMs: >= 1 and <= 250, ExecutionMode: "async", Scope: "local", Idempotent: true, FailPolicy: "fail-closed" }])
                throw Reject("plugin-manifest-subset");
            using var schema = JsonDocument.Parse(entries.Schema);
            if (schema.RootElement.ValueKind != JsonValueKind.Object || schema.RootElement.EnumerateObject().Count() != 3 ||
                !schema.RootElement.TryGetProperty("type", out var type) || type.ValueKind != JsonValueKind.String || type.GetString() != "object" ||
                !schema.RootElement.TryGetProperty("properties", out var properties) || properties.ValueKind != JsonValueKind.Object || properties.EnumerateObject().Any() ||
                !schema.RootElement.TryGetProperty("additionalProperties", out var additional) || additional.ValueKind != JsonValueKind.False)
                throw Reject("plugin-config-subset");
            trust.RequireCurrent(clock, ct);
            return new(directory, Utf8.GetString(entries.JavaScript), manifest.Hooks[0].TimeoutMs, clock, start, trust, Digest(json), lease);
        }
        catch (Exception error)
        {
            lease.Dispose();
            if (error is JsonException or DecoderFallbackException) throw Reject("plugin-package-encoding");
            throw;
        }
    }

    private PureRenderPlugin(string root, string script, int timeout, TimeProvider clock, long started,
        SignedArchiveTrust trust, string registryDigest, FileStream lease)
    {
        _root = root;
        JavaScript = script;
        TimeoutMs = timeout;
        _clock = clock;
        _started = started;
        _trust = trust;
        _registryDigest = registryDigest;
        _lease = lease;
    }

    public void VerifyCompletion(CancellationToken ct = default)
    {
        ObjectDisposedException.ThrowIf(_lease.SafeFileHandle.IsClosed, this);
        ExtensionDisk.ValidatePrivateRoot(new(_root));
        if (Digest(ExtensionDisk.Read(_root, "platform-plugin.json", 32 * 1024, ct)) != _registryDigest)
            throw Reject("plugin-approval-changed");
        ReadArchive(_root, _trust.Source.ArchiveSha256, ct);
        if (_clock.GetElapsedTime(_started) >= TimeSpan.FromSeconds(15)) throw Reject("plugin-operation-expired");
        if (_clock.GetElapsedTime(_started) >= _trust.ValidUntil - _trust.CheckedAt)
            throw Reject("publisher-key-not-current");
        _trust.RequireCurrent(_clock, ct);
    }

    public void Dispose() => _lease.Dispose();

    private static FileStream Acquire(string directory)
    {
        if (OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        var path = Path.Combine(directory, "runner.lock");
        if ((File.GetAttributes(path) & (FileAttributes.ReparsePoint | FileAttributes.Directory | FileAttributes.Device)) != 0 ||
            File.GetUnixFileMode(path) != (UnixFileMode.UserRead | UnixFileMode.UserWrite)) throw Reject("plugin-lock-shape");
        const int macFlags = 0x1000000 | 0x100 | 0x4 | 0x2; // O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK | O_RDWR
        const int linuxFlags = 0x80000 | 0x20000 | 0x800 | 0x2;
        var descriptor = OpenLock(path, OperatingSystem.IsMacOS() ? macFlags : linuxFlags);
        if (descriptor < 0) throw Reject("plugin-lock-unavailable");
        var handle = new SafeFileHandle(descriptor, ownsHandle: true);
        try
        {
            if (Lock(handle, 2 | 4) != 0) throw Reject("plugin-runner-busy"); // LOCK_EX | LOCK_NB
            return new FileStream(handle, FileAccess.ReadWrite);
        }
        catch { handle.Dispose(); throw; }
    }

    [DllImport("libc", EntryPoint = "open")]
    private static extern int OpenLock([MarshalAs(UnmanagedType.LPUTF8Str)] string path, int flags);

    [DllImport("libc", EntryPoint = "flock")]
    private static extern int Lock(SafeFileHandle descriptor, int flags);

    private static byte[] ReadArchive(string root, string digest, CancellationToken ct)
    {
        var bytes = ExtensionDisk.Read(root, digest + ".fspkg", 64 * 1024, ct);
        if (Digest(bytes) != digest) throw Reject("archive-digest");
        return bytes;
    }

    private static Package ReadPackage(byte[] bytes, CancellationToken ct)
    {
        try
        {
            using var stream = new MemoryStream(bytes, writable: false);
            using var zip = new ZipArchive(stream, ZipArchiveMode.Read);
            if (zip.Entries.Count != 5) throw Reject("plugin-package-entries");
            var data = new Dictionary<string, byte[]>(StringComparer.Ordinal);
            foreach (var entry in zip.Entries)
            {
                ct.ThrowIfCancellationRequested();
                var name = entry.FullName;
                int maximum = name switch
                {
                    "manifest.json" or "config.schema.json" or "signature/checksums.json" => 4096,
                    "index.js" => MaximumSourceBytes,
                    "signature/signature.sig" => 132,
                    _ => 0
                };
                var type = (entry.ExternalAttributes >> 16) & 0xf000;
                if (entry.Length <= 0 || entry.Length > maximum || type is not (0 or 0x8000) ||
                    (entry.ExternalAttributes & ((int)FileAttributes.Directory | (int)FileAttributes.ReparsePoint)) != 0 || data.ContainsKey(name))
                    throw Reject("plugin-package-entry");
                using var file = entry.Open();
                var content = new byte[(int)entry.Length];
                file.ReadExactly(content);
                if (file.ReadByte() != -1) throw Reject("plugin-package-entry");
                data.Add(name, content);
            }
            var checksums = data["signature/checksums.json"];
            var signed = data["signature/signature.sig"];
            var hashes = JsonSerializer.Deserialize<Dictionary<string, string>>(checksums, Json) ?? throw Reject("plugin-checksums");
            if (hashes.Count != 3) throw Reject("plugin-checksums");
            foreach (var name in new[] { "manifest.json", "config.schema.json", "index.js" })
                if (!hashes.TryGetValue(name, out var hash) || hash != Digest(data[name])) throw Reject("plugin-checksums");
            return new(data["manifest.json"], data["config.schema.json"], data["index.js"], checksums, signed);
        }
        catch (Exception error) when (error is IOException or InvalidDataException or NotSupportedException)
        {
            throw Reject("plugin-archive-invalid");
        }
    }

    private static bool Label(string value, int max) => value.Length > 0 && value.Length <= max && !value.Any(char.IsControl);
    private static bool Canonical(string versionPart) => versionPart == "0" || versionPart[0] != '0';
    private static ExtensionRejectedException Reject(string code) => new(code);

    private sealed record Policy(string PluginId, bool Enabled, ImmutableArray<string> Permissions, ExtensionPublisherKey Key, ApprovedExtensionSource Source);
    private sealed record Manifest(string Id, string Name, string Version, string Fsusblog, string Author, string Description,
        Runtime Runtime, ImmutableArray<Hook> Hooks, ImmutableArray<string> Capabilities, Permissions Permissions, string ConfigSchema);
    private sealed record Permissions(bool Network, bool Filesystem, string Database);
    private sealed record Runtime(string Type, string Entry);
    private sealed record Hook(string Name, int Priority, int TimeoutMs, string FailPolicy, string ExecutionMode, string Scope, bool Idempotent);
    private sealed record Package(byte[] Manifest, byte[] Schema, byte[] JavaScript, byte[] Checksums, byte[] Signature);
}
