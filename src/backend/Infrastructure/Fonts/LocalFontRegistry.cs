using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;

using FsusBlog.Shared.Contracts.Fonts;

namespace FsusBlog.Server.Infrastructure.Fonts;

public static class FontInstallStates
{
    public const string Installed = "installed";
}

public sealed class FontRegistryException(string code, string message) : InvalidOperationException(message)
{
    public string Code
    {
        get;
    } = code;
}

public sealed record FontRegistryFace(
    int Weight,
    string Style,
    string FilePath,
    string ContentHash,
    long SizeBytes,
    string? UnicodeRange,
    bool Critical,
    string FontDisplay);

public sealed record FontRegistryEntry(
    string Id,
    string Name,
    string Family,
    string Category,
    string Version,
    string ManifestJson,
    string LicenseText,
    string LicenseSourceJson,
    string InstallState,
    bool Enabled,
    bool BuiltIn,
    DateTimeOffset InstalledAt,
    DateTimeOffset UpdatedAt,
    IReadOnlyList<FontRegistryFace> Faces);

public sealed record FontActivation(
    string Scope,
    string UiFontId,
    string ProseFontId,
    string CodeFontId,
    string CjkFontId,
    string EmojiFontId,
    long ConfigVersion,
    DateTimeOffset UpdatedAt)
{
    public const string DefaultScope = "default";
}

public sealed record FontActivationSelection(
    string UiFontId,
    string ProseFontId,
    string CodeFontId,
    string CjkFontId,
    string EmojiFontId);

public sealed record FontRegistrySnapshot(
    IReadOnlyList<FontRegistryEntry> Fonts,
    IReadOnlyList<FontActivation> Activations);

public sealed record FontRegistryPreview(
    FontRegistryEntry Font,
    IReadOnlyList<FontRegistryFace> Faces);

public interface IFontRegistry
{
    Task<FontRegistrySnapshot> ReadAsync(CancellationToken cancellationToken = default);

    Task<FontRegistryEntry> InstallAsync(
        ValidatedFontPackage package,
        CancellationToken cancellationToken = default);

    Task<FontRegistryEntry> SetEnabledAsync(
        string id,
        bool enabled,
        CancellationToken cancellationToken = default);

    Task<FontRegistryPreview> PreviewAsync(
        string id,
        CancellationToken cancellationToken = default);

    Task<FontActivation> ActivateAsync(
        string scope,
        FontActivationSelection selection,
        CancellationToken cancellationToken = default);

    Task DeleteAsync(
        string id,
        FontActivationSelection? replacement = null,
        CancellationToken cancellationToken = default);
}

public static class FontBuiltIns
{
    public static FontRegistryEntry UiSans
    {
        get;
    } = Create(
        "fsusblog.font.builtin-ui-sans",
        "FsusBlog UI Sans",
        "Google Sans, Noto Sans SC, Noto Sans TC, Noto Sans JP, ui-sans-serif, system-ui, sans-serif",
        FontCategories.UiSans);

    public static FontRegistryEntry ProseSans
    {
        get;
    } = Create(
        "fsusblog.font.builtin-prose-sans",
        "FsusBlog Prose Sans",
        "Google Sans, Noto Sans SC, Noto Sans TC, Noto Sans JP, ui-sans-serif, system-ui, sans-serif",
        FontCategories.ProseSans);

    public static FontRegistryEntry CodeMono
    {
        get;
    } = Create(
        "fsusblog.font.builtin-code-mono",
        "FsusBlog Code Mono",
        "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace",
        FontCategories.CodeMono);

    public static FontRegistryEntry CjkSans
    {
        get;
    } = Create(
        "fsusblog.font.builtin-cjk-sans",
        "FsusBlog CJK Sans",
        "Noto Sans SC, Noto Sans TC, Noto Sans JP, sans-serif",
        FontCategories.CjkSans);

    public static FontRegistryEntry Emoji
    {
        get;
    } = Create(
        "fsusblog.font.builtin-emoji",
        "FsusBlog Emoji",
        "Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, sans-serif",
        FontCategories.Emoji);

    internal static IReadOnlyList<FontRegistryEntry> All
    {
        get;
    } =
        [UiSans, ProseSans, CodeMono, CjkSans, Emoji];

    private static FontRegistryEntry Create(
        string id,
        string name,
        string family,
        string category)
        => new(
            id,
            name,
            family,
            category,
            "builtin",
            "{}",
            string.Empty,
            "{}",
            FontInstallStates.Installed,
            Enabled: true,
            BuiltIn: true,
            DateTimeOffset.UnixEpoch,
            DateTimeOffset.UnixEpoch,
            []);
}

public sealed partial class LocalFontRegistry : IFontRegistry, IFontByteSource
{
    private static readonly JsonSerializerOptions s_jsonOptions = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = false,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        WriteIndented = true
    };

    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly string _root;
    private readonly string _assetRoot;
    private readonly string _registryPath;
    private readonly TimeProvider _timeProvider;

    public LocalFontRegistry(string root, TimeProvider? timeProvider = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(root);
        _root = Path.GetFullPath(root);
        _assetRoot = Path.Combine(_root, "assets");
        _registryPath = Path.Combine(_root, "registry.json");
        _timeProvider = timeProvider ?? TimeProvider.System;
    }

    public async Task<FontRegistrySnapshot> ReadAsync(CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            RegistryDocument document = await LoadAsync(cancellationToken).ConfigureAwait(false);
            return ToSnapshot(document);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<FontRegistryEntry> InstallAsync(
        ValidatedFontPackage package,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(package);
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            ValidatePackageForInstall(package);
            RegistryDocument document = await LoadAsync(cancellationToken).ConfigureAwait(false);
            if (document.Fonts.Any(entry => string.Equals(entry.Id, package.Manifest.Id, StringComparison.Ordinal)))
            {
                throw new FontRegistryException(
                    "font_already_installed",
                    $"Font '{package.Manifest.Id}' is already installed.");
            }

            Directory.CreateDirectory(_assetRoot);
            foreach (FontPackageFace face in package.Faces)
            {
                await WriteAssetAsync(face, cancellationToken).ConfigureAwait(false);
            }

            DateTimeOffset now = _timeProvider.GetUtcNow();
            var entry = new FontRegistryEntry(
                package.Manifest.Id,
                package.Manifest.Name,
                package.Manifest.Family,
                package.Manifest.Category,
                package.Manifest.Version,
                package.ManifestJson,
                package.LicenseText,
                package.LicenseSourceJson,
                FontInstallStates.Installed,
                Enabled: false,
                BuiltIn: false,
                now,
                now,
                [
                    .. package.Faces.Select(face => new FontRegistryFace(
                        face.Descriptor.Weight,
                        face.Descriptor.Style,
                        $"assets/{face.ContentHash}.woff2",
                        face.ContentHash,
                        face.SizeBytes,
                        face.Descriptor.UnicodeRange,
                        face.Descriptor.Critical,
                        package.Manifest.Loading.Display))
                ]);
            document.Fonts.Add(entry);
            await SaveAsync(document, cancellationToken).ConfigureAwait(false);
            return entry;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<FontRegistryEntry> SetEnabledAsync(
        string id,
        bool enabled,
        CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            RegistryDocument document = await LoadAsync(cancellationToken).ConfigureAwait(false);
            int index = FindFontIndex(document, id);
            FontRegistryEntry current = document.Fonts[index];
            if (!enabled && IsActive(document, id))
            {
                throw new FontRegistryException(
                    "active_font_replacement_required",
                    "An active font cannot be disabled until its activation has a replacement.");
            }

            if (enabled)
            {
                await VerifyAssetsAsync([current], cancellationToken).ConfigureAwait(false);
            }

            FontRegistryEntry updated = current with
            {
                Enabled = enabled,
                UpdatedAt = _timeProvider.GetUtcNow()
            };
            document.Fonts[index] = updated;
            await SaveAsync(document, cancellationToken).ConfigureAwait(false);
            return updated;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<FontRegistryPreview> PreviewAsync(
        string id,
        CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            RegistryDocument document = await LoadAsync(cancellationToken).ConfigureAwait(false);
            FontRegistryEntry entry = document.Fonts[FindFontIndex(document, id)];
            return new FontRegistryPreview(entry, entry.Faces);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<FontActivation> ActivateAsync(
        string scope,
        FontActivationSelection selection,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(scope);
        ArgumentNullException.ThrowIfNull(selection);
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            RegistryDocument document = await LoadAsync(cancellationToken).ConfigureAwait(false);
            EnsureSelectionEnabled(document, selection);
            await VerifyAssetsAsync(
                ResolveSelectionEntries(document, selection),
                cancellationToken).ConfigureAwait(false);
            int activationIndex = document.Activations.FindIndex(
                activation => string.Equals(activation.Scope, scope, StringComparison.Ordinal));
            long nextVersion = activationIndex >= 0
                ? checked(document.Activations[activationIndex].ConfigVersion + 1)
                : 1;
            var activation = new FontActivation(
                scope,
                selection.UiFontId,
                selection.ProseFontId,
                selection.CodeFontId,
                selection.CjkFontId,
                selection.EmojiFontId,
                nextVersion,
                _timeProvider.GetUtcNow());
            if (activationIndex >= 0)
            {
                document.Activations[activationIndex] = activation;
            }
            else
            {
                document.Activations.Add(activation);
            }

            await SaveAsync(document, cancellationToken).ConfigureAwait(false);
            return activation;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task DeleteAsync(
        string id,
        FontActivationSelection? replacement = null,
        CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            RegistryDocument document = await LoadAsync(cancellationToken).ConfigureAwait(false);
            int index = FindFontIndex(document, id);
            FontRegistryEntry target = document.Fonts[index];
            if (target.BuiltIn)
            {
                throw new FontRegistryException("builtin_font_delete_forbidden", "Built-in fonts cannot be deleted.");
            }

            bool active = IsActive(document, id);
            if (active && replacement is null)
            {
                throw new FontRegistryException(
                    "active_font_replacement_required",
                    "Deleting an active font requires an enabled replacement or built-in fallback.");
            }

            if (active)
            {
                EnsureSelectionEnabled(document, replacement!);
                DateTimeOffset now = _timeProvider.GetUtcNow();
                for (int activationIndex = 0; activationIndex < document.Activations.Count; activationIndex++)
                {
                    FontActivation activation = document.Activations[activationIndex];
                    if (References(activation, id))
                    {
                        document.Activations[activationIndex] = new FontActivation(
                            activation.Scope,
                            replacement!.UiFontId,
                            replacement.ProseFontId,
                            replacement.CodeFontId,
                            replacement.CjkFontId,
                            replacement.EmojiFontId,
                            checked(activation.ConfigVersion + 1),
                            now);
                    }
                }
            }

            document.Fonts.RemoveAt(index);
            await SaveAsync(document, cancellationToken).ConfigureAwait(false);
            DeleteUnreferencedAssets(document, target);
        }
        finally
        {
            _gate.Release();
        }
    }

    private async Task<RegistryDocument> LoadAsync(CancellationToken cancellationToken)
    {
        RegistryDocument document;
        if (!File.Exists(_registryPath))
        {
            document = new RegistryDocument();
        }
        else
        {
            await using FileStream source = new(
                _registryPath,
                FileMode.Open,
                FileAccess.Read,
                FileShare.Read,
                bufferSize: 16 * 1024,
                FileOptions.Asynchronous | FileOptions.SequentialScan);
            try
            {
                document = await JsonSerializer.DeserializeAsync<RegistryDocument>(
                    source,
                    s_jsonOptions,
                    cancellationToken).ConfigureAwait(false)
                    ?? throw new FontRegistryException(
                        "font_registry_invalid",
                        "Font registry document is empty.");
            }
            catch (JsonException exception)
            {
                throw new FontRegistryException(
                    "font_registry_invalid",
                    $"Font registry document is invalid: {exception.Message}");
            }
        }

        if (document.Fonts is null || document.Activations is null)
        {
            throw new FontRegistryException(
                "font_registry_invalid",
                "Font registry collections cannot be null.");
        }

        foreach (FontRegistryEntry builtIn in FontBuiltIns.All)
        {
            FontRegistryEntry? existing = document.Fonts.FirstOrDefault(
                entry => string.Equals(entry.Id, builtIn.Id, StringComparison.Ordinal));
            if (existing is null)
            {
                document.Fonts.Add(builtIn);
            }
            else if (!IsCanonicalBuiltIn(existing, builtIn))
            {
                throw new FontRegistryException(
                    "font_registry_invalid",
                    $"Built-in font registry entry '{builtIn.Id}' is invalid.");
            }
        }

        ValidateDocument(document);
        return document;
    }

    private async Task SaveAsync(
        RegistryDocument document,
        CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(_root);
        string temporaryPath = Path.Combine(_root, $".registry-{Guid.NewGuid():N}.tmp");
        try
        {
            await using (var destination = new FileStream(
                temporaryPath,
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.None,
                bufferSize: 16 * 1024,
                FileOptions.Asynchronous | FileOptions.WriteThrough))
            {
                await JsonSerializer.SerializeAsync(
                    destination,
                    document,
                    s_jsonOptions,
                    cancellationToken).ConfigureAwait(false);
                await destination.FlushAsync(cancellationToken).ConfigureAwait(false);
            }

            File.Move(temporaryPath, _registryPath, overwrite: true);
        }
        finally
        {
            if (File.Exists(temporaryPath))
            {
                File.Delete(temporaryPath);
            }
        }
    }

    private async Task WriteAssetAsync(FontPackageFace face, CancellationToken cancellationToken)
    {
        string path = Path.Combine(_assetRoot, $"{face.ContentHash}.woff2");
        if (File.Exists(path))
        {
            byte[] existing = await File.ReadAllBytesAsync(path, cancellationToken).ConfigureAwait(false);
            if (!existing.AsSpan().SequenceEqual(face.ContentBytes))
            {
                throw new FontRegistryException(
                    "font_asset_hash_collision",
                    $"Existing font asset '{face.ContentHash}' does not match its content hash.");
            }

            return;
        }

        string temporaryPath = Path.Combine(_assetRoot, $".asset-{Guid.NewGuid():N}.tmp");
        try
        {
            await File.WriteAllBytesAsync(temporaryPath, face.ContentBytes, cancellationToken).ConfigureAwait(false);
            try
            {
                File.Move(temporaryPath, path);
            }
            catch (IOException) when (File.Exists(path))
            {
                byte[] existing = await File.ReadAllBytesAsync(path, cancellationToken).ConfigureAwait(false);
                if (!existing.AsSpan().SequenceEqual(face.ContentBytes))
                {
                    throw new FontRegistryException(
                        "font_asset_hash_collision",
                        $"Existing font asset '{face.ContentHash}' does not match its content hash.");
                }
            }
        }
        finally
        {
            if (File.Exists(temporaryPath))
            {
                File.Delete(temporaryPath);
            }
        }
    }

    private static int FindFontIndex(RegistryDocument document, string id)
    {
        int index = document.Fonts.FindIndex(
            entry => string.Equals(entry.Id, id, StringComparison.Ordinal));
        return index >= 0
            ? index
            : throw new FontRegistryException("font_not_found", $"Font '{id}' is not installed.");
    }

    private static void EnsureSelectionEnabled(
        RegistryDocument document,
        FontActivationSelection selection)
    {
        string[] ids =
        [
            selection.UiFontId,
            selection.ProseFontId,
            selection.CodeFontId,
            selection.CjkFontId,
            selection.EmojiFontId
        ];
        foreach (string id in ids)
        {
            FontRegistryEntry? entry = document.Fonts.FirstOrDefault(
                font => string.Equals(font.Id, id, StringComparison.Ordinal));
            if (entry is null || !entry.Enabled)
            {
                throw new FontRegistryException(
                    "font_activation_target_unavailable",
                    $"Font activation target '{id}' is not installed and enabled.");
            }
        }
    }

    private static IReadOnlyList<FontRegistryEntry> ResolveSelectionEntries(
        RegistryDocument document,
        FontActivationSelection selection)
        => new[]
        {
            selection.UiFontId,
            selection.ProseFontId,
            selection.CodeFontId,
            selection.CjkFontId,
            selection.EmojiFontId
        }
        .Distinct(StringComparer.Ordinal)
        .Select(id => document.Fonts.Single(font => string.Equals(font.Id, id, StringComparison.Ordinal)))
        .ToArray();

    private async Task VerifyAssetsAsync(
        IEnumerable<FontRegistryEntry> entries,
        CancellationToken cancellationToken)
    {
        foreach (FontRegistryEntry entry in entries.Where(static entry => !entry.BuiltIn))
        {
            foreach (FontRegistryFace face in entry.Faces)
            {
                string path = Path.Combine(_assetRoot, $"{face.ContentHash}.woff2");
                if (!File.Exists(path))
                {
                    throw new FontRegistryException(
                        "font_asset_integrity_invalid",
                        $"Font asset for '{entry.Id}' is missing.");
                }

                byte[] content = await File.ReadAllBytesAsync(path, cancellationToken).ConfigureAwait(false);
                string contentHash = Convert.ToHexStringLower(SHA256.HashData(content));
                if (content.LongLength != face.SizeBytes
                    || !string.Equals(contentHash, face.ContentHash, StringComparison.Ordinal))
                {
                    throw new FontRegistryException(
                        "font_asset_integrity_invalid",
                        $"Font asset for '{entry.Id}' failed SHA-256 verification.");
                }
            }
        }
    }

    private static bool IsActive(RegistryDocument document, string id)
        => document.Activations.Any(activation => References(activation, id));

    private static bool References(FontActivation activation, string id)
        => string.Equals(activation.UiFontId, id, StringComparison.Ordinal)
            || string.Equals(activation.ProseFontId, id, StringComparison.Ordinal)
            || string.Equals(activation.CodeFontId, id, StringComparison.Ordinal)
            || string.Equals(activation.CjkFontId, id, StringComparison.Ordinal)
            || string.Equals(activation.EmojiFontId, id, StringComparison.Ordinal);

    private void DeleteUnreferencedAssets(RegistryDocument document, FontRegistryEntry deleted)
    {
        HashSet<string> retainedHashes = document.Fonts
            .SelectMany(static entry => entry.Faces)
            .Select(static face => face.ContentHash)
            .ToHashSet(StringComparer.Ordinal);
        foreach (FontRegistryFace face in deleted.Faces)
        {
            if (!retainedHashes.Contains(face.ContentHash))
            {
                string path = Path.Combine(_assetRoot, $"{face.ContentHash}.woff2");
                if (File.Exists(path))
                {
                    File.Delete(path);
                }
            }
        }
    }

    private static FontRegistrySnapshot ToSnapshot(RegistryDocument document)
        => new(
            document.Fonts.AsReadOnly(),
            document.Activations.AsReadOnly());

    private static void ValidatePackageForInstall(ValidatedFontPackage package)
    {
        if (package.Faces.Count != package.Manifest.Faces.Count)
        {
            throw new FontRegistryException(
                "font_package_proof_invalid",
                "Validated font package face count changed before installation.");
        }

        long totalBytes = 0;
        long criticalBytes = 0;
        foreach (FontPackageFace face in package.Faces)
        {
            if (!package.Manifest.Faces.Contains(face.Descriptor)
                || face.SizeBytes != face.ContentBytes.LongLength
                || !string.Equals(
                    face.ContentHash,
                    Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(face.ContentBytes)),
                    StringComparison.Ordinal))
            {
                throw new FontRegistryException(
                    "font_package_proof_invalid",
                    "Validated font package changed before installation.");
            }

            totalBytes = checked(totalBytes + face.SizeBytes);
            if (face.Descriptor.Critical)
            {
                criticalBytes = checked(criticalBytes + face.SizeBytes);
            }
        }

        if (totalBytes > package.Manifest.Budgets.TotalBytes
            || criticalBytes > package.Manifest.Budgets.CriticalBytes)
        {
            throw new FontRegistryException(
                "font_package_proof_invalid",
                "Validated font package budget changed before installation.");
        }
    }

    private static void ValidateDocument(RegistryDocument document)
    {
        if (document.Fonts.Select(static entry => entry.Id).Distinct(StringComparer.Ordinal).Count()
            != document.Fonts.Count
            || document.Activations.Select(static activation => activation.Scope).Distinct(StringComparer.Ordinal).Count()
            != document.Activations.Count)
        {
            throw new FontRegistryException(
                "font_registry_invalid",
                "Font registry contains duplicate font IDs or activation scopes.");
        }

        var enabledIds = document.Fonts
            .Where(static entry => entry.Enabled)
            .Select(static entry => entry.Id)
            .ToHashSet(StringComparer.Ordinal);
        foreach (FontRegistryEntry entry in document.Fonts)
        {
            if (string.IsNullOrWhiteSpace(entry.Id)
                || string.IsNullOrWhiteSpace(entry.Family)
                || entry.Faces is null)
            {
                throw new FontRegistryException(
                    "font_registry_invalid",
                    "Font registry contains an invalid font entry.");
            }

            if (!entry.BuiltIn)
            {
                ValidatePersistedPackageMetadata(entry);
            }

            foreach (FontRegistryFace face in entry.Faces)
            {
                string expectedPath = $"assets/{face.ContentHash}.woff2";
                if (!IsSha256(face.ContentHash)
                    || face.SizeBytes <= 0
                    || !string.Equals(face.FilePath, expectedPath, StringComparison.Ordinal))
                {
                    throw new FontRegistryException(
                        "font_registry_invalid",
                        $"Font registry face for '{entry.Id}' is invalid.");
                }
            }
        }

        foreach (FontActivation activation in document.Activations)
        {
            if (string.IsNullOrWhiteSpace(activation.Scope)
                || activation.ConfigVersion <= 0
                || !enabledIds.Contains(activation.UiFontId)
                || !enabledIds.Contains(activation.ProseFontId)
                || !enabledIds.Contains(activation.CodeFontId)
                || !enabledIds.Contains(activation.CjkFontId)
                || !enabledIds.Contains(activation.EmojiFontId))
            {
                throw new FontRegistryException(
                    "font_registry_invalid",
                    $"Font activation '{activation.Scope}' references unavailable fonts.");
            }
        }
    }

    private static void ValidatePersistedPackageMetadata(FontRegistryEntry entry)
    {
        try
        {
            FontManifest manifest = JsonSerializer.Deserialize<FontManifest>(
                entry.ManifestJson,
                s_jsonOptions)
                ?? throw new JsonException("Font manifest was null.");
            FontManifestValidation validation = FontManifestValidator.Validate(
                manifest,
                new Version(1, 3, 0));
            FontSourceDescriptor source = JsonSerializer.Deserialize<FontSourceDescriptor>(
                entry.LicenseSourceJson,
                s_jsonOptions)
                ?? throw new JsonException("Font source metadata was null.");
            if (!validation.IsValid
                || !string.Equals(manifest.Id, entry.Id, StringComparison.Ordinal)
                || !string.Equals(manifest.Family, entry.Family, StringComparison.Ordinal)
                || string.IsNullOrWhiteSpace(entry.LicenseText)
                || !Equals(source, manifest.Source)
                || manifest.Faces.Count != entry.Faces.Count
                || manifest.Faces.Any(face => !entry.Faces.Any(
                    stored => stored.Weight == face.Weight
                        && string.Equals(stored.Style, face.Style, StringComparison.Ordinal)
                        && string.Equals(stored.ContentHash, face.ContentHash, StringComparison.Ordinal))))
            {
                throw new FontRegistryException(
                    "font_registry_invalid",
                    $"Font registry metadata for '{entry.Id}' is invalid.");
            }
        }
        catch (JsonException exception)
        {
            throw new FontRegistryException(
                "font_registry_invalid",
                $"Font registry metadata for '{entry.Id}' is invalid: {exception.Message}");
        }
    }

    private static bool IsCanonicalBuiltIn(
        FontRegistryEntry existing,
        FontRegistryEntry canonical)
        => existing.BuiltIn
            && existing.Enabled
            && existing.Faces is { Count: 0 }
            && string.Equals(existing.Name, canonical.Name, StringComparison.Ordinal)
            && string.Equals(existing.Family, canonical.Family, StringComparison.Ordinal)
            && string.Equals(existing.Category, canonical.Category, StringComparison.Ordinal)
            && string.Equals(existing.Version, canonical.Version, StringComparison.Ordinal);

    private static bool IsSha256(string? value)
        => value is { Length: 64 }
            && value.All(static character => character is >= '0' and <= '9'
                or >= 'a' and <= 'f');

    private sealed class RegistryDocument
    {
        public List<FontRegistryEntry> Fonts { get; init; } = [];

        public List<FontActivation> Activations { get; init; } = [];
    }
}
