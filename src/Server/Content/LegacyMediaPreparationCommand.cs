using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using Microsoft.Win32.SafeHandles;
using SkiaSharp;

namespace FsusBlog.V2.Server.Content;

internal static class LegacyMediaPreparationCommand
{
    private const string Manifest = "manifest.json";
    private const UnixFileMode OwnedReadOnly = UnixFileMode.UserRead;
    private const UnixFileMode PrivateDirectory = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute;
    private const UnixFileMode SealedDirectory = UnixFileMode.UserRead | UnixFileMode.UserExecute;

    internal static async Task<int> RunAsync(string[] args)
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(8));
        ConsoleCancelEventHandler cancel = (_, signal) => { signal.Cancel = true; deadline.Cancel(); };
        Console.CancelKeyPress += cancel;
        try
        {
            switch (args)
            {
                case ["normalizer"]:
                {
                    var (_, identity) = ReadNormalizer();
                    Console.WriteLine(JsonSerializer.Serialize(new
                    {
                        normalizerSha256 = Digest(identity), identity.Platform, identity.RuntimeVersion, identity.Files,
                    }, LegacyMediaPreparation.Json));
                    return 0;
                }
                case ["prepare", var request, var requestHash, var custody, var normalizerHash, var output, var name]:
                    await Prepare(request, requestHash, custody, normalizerHash, output, name, deadline.Token);
                    return 0;
                default:
                    Console.Error.WriteLine("Use legacy-media normalizer or legacy-media prepare REQUEST_JSON REQUEST_SHA256 CUSTODY_PACKAGE NORMALIZER_SHA256 OUTPUT_PARENT NAME.");
                    return 2;
            }
        }
        catch (OperationCanceledException)
        {
            Console.Error.WriteLine("Offline legacy media preparation was cancelled or exceeded its deadline.");
            return 1;
        }
        catch (Exception error) when (error is ArgumentException or IOException or UnauthorizedAccessException or FormatException or
            InvalidOperationException or JsonException or KeyNotFoundException or CryptographicException or PlatformNotSupportedException or
            BusinessException or BadHttpRequestException or DllNotFoundException or BadImageFormatException or TypeInitializationException)
        {
            Console.Error.WriteLine(error.Message);
            return 1;
        }
        finally { Console.CancelKeyPress -= cancel; }
    }

    private static async Task Prepare(string requestPath, string requestHash, string custodyPath, string normalizerHash,
        string outputParent, string name, CancellationToken ct)
    {
        RequirePath(requestPath);
        RequirePath(custodyPath);
        RequirePath(outputParent);
        if (!IsHash(requestHash) || !IsHash(normalizerHash) || name.Length is < 1 or > 128 ||
            !char.IsAsciiLetterOrDigit(name[0]) || name.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not ('.' or '_' or '-')))
            throw new ArgumentException("Supply approved SHA-256 values and a simple offline output name.");
        var destination = Path.Join(outputParent, name);
        var servingRoots = new[] { AppContext.BaseDirectory, Environment.GetEnvironmentVariable("FSUSBLOG_WEB_DIST"),
            Environment.GetEnvironmentVariable(MediaEndpoints.StorageSetting),
            Environment.GetEnvironmentVariable(PublishedMediaEndpoints.StorageSetting) };
        if (Overlaps(custodyPath, destination) || servingRoots.Any(root => !string.IsNullOrEmpty(root) &&
                Overlaps(Path.GetFullPath(root), destination)))
            throw new ArgumentException("The offline output must be separate from the custody package and serving storage.");

        using var requestParent = NativeUnixFile.OpenDirectory(Path.GetDirectoryName(requestPath)!);
        var requestBytes = await Read(requestParent, Path.GetFileName(requestPath), requestHash,
            LegacyMediaPreparation.MaxManifestBytes, ct, allowOwnerWrite: true);
        var request = JsonSerializer.Deserialize<LegacyMediaPreparationRequest>(requestBytes, LegacyMediaPreparation.Json);
        ValidateRequest(request, requestBytes);
        using var custodyParent = OwnedDirectory(Path.GetDirectoryName(custodyPath)!, PrivateDirectory);
        using var custody = OwnedDirectory(custodyPath, SealedDirectory);
        var custodyBytes = await Read(custody, Manifest, request!.CustodyManifestSha256, LegacyMediaPreparation.MaxManifestBytes, ct);
        ValidateCustody(request, custodyBytes);

        var (library, identity) = ReadNormalizer();
        if (Digest(identity) != normalizerHash)
            throw new InvalidOperationException("The V2 image normalizer does not match the approved executable and codec digest.");
        var pinnedCodec = NativeLibrary.Load(library);
        NativeLibrary.SetDllImportResolver(typeof(SKBitmap).Assembly,
            (libraryName, _, _) => libraryName == "libSkiaSharp" ? pinnedCodec : IntPtr.Zero);

        using var parent = OwnedDirectory(outputParent, PrivateDirectory);
        using (var existing = NativeUnixFile.OpenFile(parent, name, NativeUnixFile.FileReadFlags, out var error))
            if (existing is not null || error != NativeUnixFile.NotFound)
                throw new IOException("The named offline output already exists or is inaccessible.");
        var pending = $".legacy-media-{Guid.NewGuid():N}.pending";
        var pendingPath = Path.Join(outputParent, pending);
        if (NativeUnixFile.MakeDirectoryAt(parent, pending, (uint)PrivateDirectory) != 0)
            throw new IOException("Could not create a new owner-private preparation directory.");

        byte[] manifest;
        using (var output = new MediaObjectDirectory(pendingPath, MediaImage.MaxBytes, [custodyPath]))
        {
            var prepared = new List<LegacyMediaPreparedAsset>(request.Assets.Length);
            long total = 0;
            foreach (var asset in request.Assets)
            {
                var leaf = $"{asset.AssetId:N}.blob";
                var source = await Read(custody, leaf, asset.RawSha256, MediaImage.MaxBytes, ct, exactLength: asset.RawBytes);
                var extension = asset.Extension.StartsWith('.') ? asset.Extension : "." + asset.Extension;
                var fileName = asset.AssetId.ToString("N") + extension;
                var format = MediaImage.FormatFor(fileName, asset.MediaType, webp: true);
                var image = MediaImage.Normalize(fileName, format, source, ct);
                if ((image.Width, image.Height) != (asset.Width, asset.Height) || (total += image.Bytes.Length) > LegacyMediaPreparation.MaxTotalBytes)
                    throw new InvalidOperationException("Normalized image dimensions or total bytes differ from the approved preparation bounds.");
                await output.Materialize(leaf, image.Bytes, image.Hash, ct);
                prepared.Add(new(asset.AssetId, asset.RawSha256, Hex(image.Hash), image.Bytes.Length,
                    (short)image.Format, image.Width, image.Height));
            }
            manifest = JsonSerializer.SerializeToUtf8Bytes(new LegacyMediaPreparationResult(
                LegacyMediaPreparation.ResultFormat, requestHash, normalizerHash, [.. prepared]), LegacyMediaPreparation.Json);
            if (manifest.Length > LegacyMediaPreparation.MaxManifestBytes)
                throw new InvalidOperationException("The prepared media manifest exceeds its byte limit.");
            await output.Materialize(Manifest, manifest, SHA256.HashData(manifest), ct);
        }
        using var sealedOutput = OwnedDirectory(pendingPath, PrivateDirectory);
        if (NativeUnixFile.SetMode(sealedOutput, (uint)SealedDirectory) != 0 || NativeUnixFile.Sync(sealedOutput) != 0)
            throw new IOException("Could not seal the prepared media directory.");
        ct.ThrowIfCancellationRequested();
        if (NativeUnixFile.RenameExclusiveAt(parent, pending, name) != 0 || NativeUnixFile.Sync(parent) != 0)
            throw new IOException("Could not establish the prepared media package exclusively.");
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            manifestSha256 = Hex(SHA256.HashData(manifest)), requestSha256 = requestHash, normalizerSha256 = normalizerHash,
        }, LegacyMediaPreparation.Json));
    }

    private static void ValidateRequest(LegacyMediaPreparationRequest? request, byte[] bytes)
    {
        if (request is null || request.Format != LegacyMediaPreparation.RequestFormat ||
            !IsHash(request.PlanSha256) || !IsHash(request.ProjectionSha256) || !IsHash(request.CustodyManifestSha256) ||
            request.SourceSiteId == Guid.Empty || request.TargetSiteId == Guid.Empty || request.SourceSiteId == request.TargetSiteId ||
            request.Assets is null || request.Assets.Length is < 1 or > LegacyMediaPreparation.MaxAssets ||
            request.References is null || request.References.Length < request.Assets.Length ||
            request.References.Length > LegacyMediaPreparation.MaxReferences)
            throw new InvalidOperationException("The reviewed legacy media request has an invalid format or bounds.");
        if (request.Assets.Any(asset => asset is null || asset.AssetId == Guid.Empty || !IsHash(asset.RawSha256) ||
            asset.RawBytes is < 1 or > MediaImage.MaxBytes || asset.Width < 1 || asset.Height < 1 ||
            asset.SourceOwnerId < 1 || asset.TargetOwnerId == Guid.Empty || asset.MediaType?.Length is not (>= 1 and <= 127) ||
            asset.Extension?.Length is not (>= 1 and <= 16) ||
            asset.Extension.Any(c => c != '.' && !char.IsAsciiLetterOrDigit(c))) ||
            request.Assets.Sum(asset => (long)asset.RawBytes) > LegacyMediaPreparation.MaxTotalBytes)
            throw new InvalidOperationException("The approved request contains an unsupported asset or owner.");
        if (request.References.Any(reference => reference is null || reference.AssetId == Guid.Empty || reference.ArticleId < 1 ||
            reference.SourceRevisionId < 1 || reference.Revision < 1 || reference.ReferenceCount < 1 || reference.AltText?.Length > 256) ||
            !request.Assets.Select(asset => asset.AssetId).ToHashSet().SetEquals(request.References.Select(reference => reference.AssetId)) ||
            request.Assets.Select(asset => asset.AssetId).Distinct().Count() != request.Assets.Length ||
            request.References.Select(reference => (reference.AssetId, reference.SourceRevisionId)).Distinct().Count() != request.References.Length ||
            !request.Assets.SequenceEqual(request.Assets.OrderBy(asset => asset.AssetId)) ||
            !request.References.SequenceEqual(request.References.OrderBy(reference => reference.AssetId)
                .ThenBy(reference => reference.ArticleId).ThenBy(reference => reference.SourceRevisionId)) ||
            !JsonSerializer.SerializeToUtf8Bytes(request, LegacyMediaPreparation.Json).AsSpan().SequenceEqual(bytes))
            throw new InvalidOperationException("The reviewed media revision bindings or canonical request bytes differ.");
    }

    private static void ValidateCustody(LegacyMediaPreparationRequest request, byte[] bytes)
    {
        using var document = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 12, AllowDuplicateProperties = false });
        var manifest = document.RootElement;
        var review = manifest.GetProperty("review");
        var files = manifest.GetProperty("files");
        var references = manifest.GetProperty("references");
        if (manifest.GetProperty("format").GetString() != "fsusblog-legacy-media-quarantine-v1" ||
            manifest.GetProperty("readyToApply").GetBoolean() || review.GetProperty("provider").GetString() != "postgres" ||
            review.GetProperty("sourceSiteId").GetGuid() != request.SourceSiteId || review.GetProperty("targetSiteId").GetGuid() != request.TargetSiteId ||
            files.GetArrayLength() != request.Assets.Length || references.GetArrayLength() != request.References.Length)
            throw new InvalidOperationException("The approved custody package does not match the reviewed media request.");

        var assets = request.Assets.ToDictionary(asset => asset.AssetId);
        foreach (var file in files.EnumerateArray())
            if (!assets.Remove(file.GetProperty("assetId").GetGuid(), out var asset) ||
                file.GetProperty("storageClass").GetString() != "private" || file.GetProperty("bytes").GetInt64() != asset.RawBytes ||
                file.GetProperty("sha256").GetString() != asset.RawSha256 || file.GetProperty("mediaType").GetString() != asset.MediaType ||
                file.GetProperty("extension").GetString() != asset.Extension || file.GetProperty("width").GetInt64() != asset.Width ||
                file.GetProperty("height").GetInt64() != asset.Height || file.GetProperty("sourceOwnerId").GetInt64() != asset.SourceOwnerId ||
                file.GetProperty("targetOwnerId").GetGuid() != asset.TargetOwnerId)
                throw new InvalidOperationException("An approved private asset or owner differs from its custody manifest.");

        var revisions = request.References.ToDictionary(reference => (reference.AssetId, reference.SourceRevisionId));
        foreach (var reference in references.EnumerateArray())
            if (!revisions.Remove((reference.GetProperty("assetId").GetGuid(), reference.GetProperty("sourceId").GetInt64()), out var binding) ||
                reference.GetProperty("sourceKind").GetString() != "revision" || reference.GetProperty("articleId").GetInt32() != binding.ArticleId ||
                reference.GetProperty("referenceCount").GetInt32() != binding.ReferenceCount ||
                reference.GetProperty("altText").GetString() != binding.AltText)
                throw new InvalidOperationException("An approved source revision reference differs from its custody manifest.");
    }

    private static (string NativeLibrary, NormalizerIdentity Identity) ReadNormalizer()
    {
        if (!NativeUnixFile.Supported) throw new PlatformNotSupportedException("Offline image preparation requires macOS or Linux on ARM64 or x64.");
        var platform = RuntimeInformation.RuntimeIdentifier;
        var root = AppContext.BaseDirectory;
        var library = Path.Join(root, "runtimes", OperatingSystem.IsMacOS() ? "osx" : platform, "native",
            OperatingSystem.IsMacOS() ? "libSkiaSharp.dylib" : "libSkiaSharp.so");
        var files = new[] { typeof(MediaImage).Assembly.Location, typeof(SKBitmap).Assembly.Location,
            typeof(MediaObjectDirectory).Assembly.Location, typeof(LegacyMediaPreparation).Assembly.Location, library };
        var identities = files.Select(path =>
        {
            var name = Path.GetRelativePath(root, path);
            if (!Path.IsPathFullyQualified(path) || name.StartsWith("../", StringComparison.Ordinal) || Path.IsPathRooted(name))
                throw new InvalidOperationException("Load the image normalizer from a complete V2 package.");
            using var directory = NativeUnixFile.OpenDirectory(Path.GetDirectoryName(path)!);
            using var handle = NativeUnixFile.OpenFile(directory, Path.GetFileName(path), NativeUnixFile.FileReadFlags, out _);
            if (handle is null || !NativeUnixFile.IsRegular(handle)) throw new IOException("A V2 normalizer package member is unavailable.");
            using var file = new FileStream(handle, FileAccess.Read);
            return new NormalizerFile(name, Hex(SHA256.HashData(file)));
        }).OrderBy(file => file.Name, StringComparer.Ordinal).ToArray();
        return (library, new(platform, Environment.Version.ToString(), identities));
    }

    private static async Task<byte[]> Read(SafeFileHandle directory, string name, string digest, int limit, CancellationToken ct,
        bool allowOwnerWrite = false, int? exactLength = null)
    {
        using var handle = NativeUnixFile.OpenFile(directory, name, NativeUnixFile.FileReadFlags, out _);
        if (handle is null || !NativeUnixFile.IsRegular(handle, OwnedReadOnly, owned: true) &&
            !(allowOwnerWrite && NativeUnixFile.IsRegular(handle, OwnedReadOnly | UnixFileMode.UserWrite, owned: true)))
            throw new IOException("An approved offline media input is missing or has unexpected permissions.");
        using var file = new FileStream(handle, FileAccess.Read);
        if (file.Length < 1 || file.Length > limit || exactLength.HasValue && file.Length != exactLength)
            throw new IOException("An approved offline media input has an unexpected length.");
        var bytes = new byte[(int)file.Length];
        await file.ReadExactlyAsync(bytes, ct);
        if (file.ReadByte() != -1 || Hex(SHA256.HashData(bytes)) != digest)
            throw new IOException("An approved offline media input does not match its SHA-256.");
        return bytes;
    }

    private static SafeFileHandle OwnedDirectory(string path, UnixFileMode mode)
    {
        var handle = NativeUnixFile.OpenDirectory(path);
        if (NativeUnixFile.HasMode(handle, mode, owned: true)) return handle;
        handle.Dispose();
        throw new IOException("Offline media directories require exact owner-private permissions.");
    }

    private static void RequirePath(string path)
    {
        if (!NativeUnixFile.Supported || !Path.IsPathFullyQualified(path) || path == "/" ||
            Path.TrimEndingDirectorySeparator(Path.GetFullPath(path)) != path)
            throw new ArgumentException("Use canonical absolute offline media paths on 64-bit macOS or Linux.");
    }

    private static bool Overlaps(string first, string second) => Contains(first, second) || Contains(second, first);
    private static bool Contains(string path, string candidate) =>
        Path.GetRelativePath(path, candidate) is var relative &&
        relative != ".." && !relative.StartsWith("../", StringComparison.Ordinal) && !Path.IsPathRooted(relative);
    private static bool IsHash(string? value) => value is { Length: 64 } &&
        value.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f');
    private static string Digest(NormalizerIdentity identity) =>
        Hex(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(identity, LegacyMediaPreparation.Json)));
    private static string Hex(byte[] bytes) => Convert.ToHexStringLower(bytes);

    private sealed record NormalizerIdentity(string Platform, string RuntimeVersion, NormalizerFile[] Files);
    private sealed record NormalizerFile(string Name, string Sha256);
}
