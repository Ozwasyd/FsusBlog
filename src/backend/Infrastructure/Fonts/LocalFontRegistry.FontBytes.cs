using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text.Json;

using FsusBlog.Shared.Contracts.Fonts;

namespace FsusBlog.Server.Infrastructure.Fonts;

public sealed partial class LocalFontRegistry
{
    public async Task<IReadOnlyList<FontRegistryFaceBytes>> ReadFaceBytesAsync(
        IReadOnlyList<FontFaceReadRequest> requests,
        long maximumBytes,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(requests);
        if (maximumBytes <= 0 || maximumBytes > FontPackageLimits.MaxTotalBytes
            || requests.Count == 0 || requests.Count > FontPackageLimits.MaxFaces)
        {
            throw new FontRegistryException("font_byte_budget_invalid", "Font byte read budget or face count is invalid.");
        }

        FontFaceReadRequest[] frozenRequests = requests.ToArray();
        if (frozenRequests.Any(static request => request is null)
            || frozenRequests.Distinct().Count() != frozenRequests.Length)
        {
            throw new FontRegistryException("font_byte_request_invalid", "Font byte requests must be non-null and unique.");
        }

        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            RegistryDocument document = await LoadAsync(cancellationToken).ConfigureAwait(false);
            byte[] registryDigest = RegistryDigest(document);
            var selected = new List<(FontFaceReadRequest Request, FontRegistryFace Face)>();
            long totalBytes = 0;
            foreach (FontFaceReadRequest request in frozenRequests)
            {
                FontRegistryEntry entry = document.Fonts[FindFontIndex(document, request.FontId)];
                if (entry.BuiltIn || entry.Faces.Count == 0)
                {
                    throw new FontRegistryException("font_owned_faces_unavailable", "The font has no owned local faces.");
                }

                FontManifest manifest = JsonSerializer.Deserialize<FontManifest>(entry.ManifestJson, s_jsonOptions)!;
                if (entry.InstallState != FontInstallStates.Installed
                    || entry.Version != manifest.Version || entry.Version != request.Version
                    || entry.Family != request.Family)
                {
                    throw new FontRegistryException("font_identity_changed", "The installed font identity differs from the frozen request.");
                }

                FontRegistryFace[] faces = entry.Faces.Where(face => face.Weight == request.Weight
                    && face.Style == request.Style && face.ContentHash == request.ContentHash).ToArray();
                if (faces.Length != 1)
                {
                    throw new FontRegistryException("font_face_unavailable", "The exact installed font face is unavailable or ambiguous.");
                }

                FontRegistryFace face = faces[0];
                if (face.SizeBytes > maximumBytes - totalBytes)
                {
                    throw new FontRegistryException("font_byte_budget_exceeded", "Installed font bytes exceed the batch budget.");
                }

                totalBytes += face.SizeBytes;
                selected.Add((request, face));
            }

            var result = new List<FontRegistryFaceBytes>(selected.Count);
            var openedAssets = new List<FontAssetFile>(selected.Count);
            try
            {
                foreach ((FontFaceReadRequest request, FontRegistryFace face) in selected)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    FontAssetFile asset = FontAssetFile.Open(_root, face.ContentHash, cancellationToken);
                    openedAssets.Add(asset);
                    if (asset.Stream.Length != face.SizeBytes)
                    {
                        throw AssetIntegrityFailure();
                    }

                    byte[] bytes = new byte[checked((int)face.SizeBytes)];
                    await asset.Stream.ReadExactlyAsync(bytes, cancellationToken).ConfigureAwait(false);
                    byte[] tail = new byte[1];
                    if (await asset.Stream.ReadAsync(tail, cancellationToken).ConfigureAwait(false) != 0
                        || !string.Equals(Convert.ToHexStringLower(SHA256.HashData(bytes)), face.ContentHash, StringComparison.Ordinal))
                    {
                        throw AssetIntegrityFailure();
                    }

                    asset.ValidateUnchanged(cancellationToken);
                    result.Add(new FontRegistryFaceBytes(request, ImmutableArray.CreateRange(bytes)));
                }

                RegistryDocument after = await LoadAsync(cancellationToken).ConfigureAwait(false);
                if (!RegistryDigest(after).AsSpan().SequenceEqual(registryDigest))
                {
                    throw new FontRegistryException("font_registry_changed", "Font registry changed during the byte read.");
                }

                // Keep every original descriptor until the batch is complete so
                // both its content version and its current directory/name are checked.
                foreach (FontAssetFile asset in openedAssets)
                {
                    asset.ValidateUnchanged(cancellationToken);
                }

                cancellationToken.ThrowIfCancellationRequested();
                return result.AsReadOnly();
            }
            finally
            {
                foreach (FontAssetFile asset in openedAssets)
                {
                    asset.Dispose();
                }
            }
        }
        catch (IOException)
        {
            throw AssetIntegrityFailure();
        }
        finally
        {
            _gate.Release();
        }
    }

    private static byte[] RegistryDigest(RegistryDocument document)
        => SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(document, s_jsonOptions));

    private static FontRegistryException AssetIntegrityFailure()
        => new("font_asset_integrity_invalid", "An owned font asset is missing or changed during the byte read.");
}
