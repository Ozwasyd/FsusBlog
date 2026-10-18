using System.Collections.Immutable;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Services.DocumentExport;
using FsusBlog.Shared.Contracts.ArticlePackages;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>Explicit portable binding to supplied frozen input, never a persistent authorization receipt.</summary>
public sealed record ArticlePackageFrozenExportCandidateInput(
    ArticlePackageIdentity PortableArticle,
    DocumentExportFrozenInput Input);

/// <summary>
/// Preserved document-input coordinates. Different digest domains are not equated with package
/// property or metadata digests, and these supplied coordinates do not establish source authority.
/// </summary>
public sealed record ArticlePackageFrozenExportSourceBinding(
    ArticlePackageIdentity PortableArticle,
    string FrozenInputId,
    string FrozenInputContentDigest,
    long UserId,
    string SiteScope,
    long SourceVersion,
    string SourceDigest,
    string MetadataDigest,
    string PropertyDigest,
    string AssetManifestDigest,
    string FontManifestDigest,
    string RendererDigest,
    string ReadingStyleAuthorityDigest);

/// <summary>Owned finite archive candidate; no download, permission, retention or export execution receipt.</summary>
public sealed class ArticlePackageFrozenExportCandidate
{
    private readonly byte[] _archive;

    internal ArticlePackageFrozenExportCandidate(
        ArticlePackageImportZipCandidate archiveCandidate,
        byte[] ownedArchive,
        ArticlePackageFrozenExportSourceBinding[] sourceBindings)
    {
        Candidate = archiveCandidate.Candidate;
        ArchiveByteLength = archiveCandidate.ArchiveByteLength;
        ArchiveSha256 = archiveCandidate.ArchiveSha256;
        _archive = ownedArchive;
        SourceBindings = Array.AsReadOnly((ArticlePackageFrozenExportSourceBinding[])sourceBindings.Clone());
    }

    public ArticlePackageValidatedImportCandidate Candidate
    {
        get;
    }
    public int ArchiveByteLength
    {
        get;
    }
    public string ArchiveSha256
    {
        get;
    }
    public IReadOnlyList<ArticlePackageFrozenExportSourceBinding> SourceBindings
    {
        get;
    }

    public byte[] CopyArchiveBytes() => (byte[])_archive.Clone();

    public ArticlePackageManifestCandidateResult RequireExportAuthority()
        => new(false, "article_package_export_authority_unavailable");
}

/// <summary>
/// Sole finite package candidate writer. Binds actual supplied frozen revision bytes, writes the
/// existing finite manifest/checksum layout through official ZIP, and reuses the actual byte reader.
/// No provider registration, store read, renderer, external asset lookup, temporary file or download.
/// Complete dependencies and content assets are refused until the package schema can represent them.
/// </summary>
public static class ArticlePackageFrozenExportCandidateWriter
{
    public const long MaxFrozenInputBytes = 64L * 1024 * 1024;
    public const int MaxAssetsPerInput = 256;

    public static ArticlePackageManifestCandidateResult TryWriteCandidate(
        ArticlePackageManifestCandidatePlan? plan,
        IReadOnlyList<ArticlePackageFrozenExportCandidateInput>? inputs,
        out ArticlePackageFrozenExportCandidate? candidate,
        CancellationToken cancellationToken = default)
    {
        candidate = null;
        try
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (plan is null || inputs is null)
            {
                return Invalid("article_package_export_input_invalid");
            }
            int count;
            try
            {
                count = inputs.Count;
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception)
            {
                // Foreign collection getters cannot release their private diagnostics.
                return Invalid("article_package_export_input_invalid");
            }
            if (count is < 1 or > ArticlePackageManifestCandidateCodec.MaxArticles
                || count != plan.Articles.Count)
            {
                return Invalid("article_package_export_source_binding_mismatch");
            }
            var held = new ArticlePackageFrozenExportCandidateInput[count];
            long inputBytes = 0;
            for (int index = 0; index < count; index++)
            {
                cancellationToken.ThrowIfCancellationRequested();
                ArticlePackageFrozenExportCandidateInput item;
                try
                {
                    item = inputs[index];
                }
                catch (OperationCanceledException)
                {
                    throw;
                }
                catch (Exception)
                {
                    return Invalid("article_package_export_input_invalid");
                }
                if (item?.Input is null || item.PortableArticle.Value is null || item.Input.Coordinate is null
                    || item.Input.MarkdownUtf8.IsDefaultOrEmpty || item.Input.Assets.IsDefault)
                {
                    return Invalid("article_package_export_input_invalid");
                }
                if (item.Input.FrozenEmbeds is not null)
                {
                    // The new frozen slot retains real typed projection bytes, but the finite
                    // package manifest has no dependency mapping. Never silently drop that slot.
                    return Invalid("article_package_export_dependency_schema_unavailable");
                }
                if (item.Input.Assets.Length > MaxAssetsPerInput
                    || !AddBytes(ref inputBytes, item.Input.MarkdownUtf8.Length))
                {
                    return Invalid("article_package_export_byte_budget_exceeded");
                }
                var ownedAssets = new DocumentExportAsset[item.Input.Assets.Length];
                for (int assetIndex = 0; assetIndex < ownedAssets.Length; assetIndex++)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    DocumentExportAsset asset = item.Input.Assets[assetIndex];
                    if (asset is null || asset.Bytes.IsDefault)
                    {
                        return Invalid("article_package_export_input_invalid");
                    }
                    if (asset.Role != "font")
                    {
                        return Invalid("article_package_manifest_assets_authority_unavailable");
                    }
                    if (!AddBytes(ref inputBytes, asset.Bytes.Length))
                    {
                        return Invalid("article_package_export_byte_budget_exceeded");
                    }
                    ownedAssets[assetIndex] = asset;
                }
                // ImmutableArray may alias a caller-owned row array. Freeze the exact rows
                // budgeted here so later Validate/Seal cannot copy substituted larger buffers.
                held[index] = item with
                {
                    Input = item.Input with
                    {
                        Assets = ownedAssets.ToImmutableArray()
                    }
                };
            }
            // The global raw/font byte budget is checked before the source owner's defensive
            // array copies. Presentation fonts are validated there, not emitted as content assets.
            var byPortable = new Dictionary<string, DocumentExportFrozenInput>(StringComparer.Ordinal);
            foreach (ArticlePackageFrozenExportCandidateInput item in held)
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (!byPortable.TryAdd(item.PortableArticle.Value!, item.Input))
                {
                    return Invalid("article_package_export_source_binding_mismatch");
                }
            }
            var files = new List<ArticlePackageFileBytes>(count + 2)
            {
                new(ArticlePackageInventory.ManifestPath, ArticlePackageManifestCandidateCodec.WriteCandidate(plan.Manifest))
            };
            long fileBytes = files[0].Bytes.Length;
            var bindings = new ArticlePackageFrozenExportSourceBinding[count];
            for (int index = 0; index < count; index++)
            {
                cancellationToken.ThrowIfCancellationRequested();
                ArticlePackageManifestPlannedArticle article = plan.Articles[index];
                if (!byPortable.TryGetValue(article.Manifest.PortableArticle.Value!, out DocumentExportFrozenInput? supplied))
                {
                    return Invalid("article_package_export_source_binding_mismatch");
                }
                DocumentExportContractValidator.Validate(supplied);
                DocumentExportFrozenInput owned = DocumentExportContractValidator.Seal(supplied);
                // Seal owns arrays, but recomputing a seal must not conceal source drift.
                if (owned.ContentDigest != supplied.ContentDigest)
                {
                    return Invalid("article_package_export_source_binding_mismatch");
                }
                DocumentExportContractValidator.Validate(owned);
                if (owned.Coordinate.Kind != DocumentExportCoordinateKind.Revision)
                {
                    return Invalid("article_package_export_coordinate_unavailable");
                }
                if (owned.Coordinate.ArticleId != article.Manifest.Source.ArticleId
                    || owned.Coordinate.RevisionId != article.Manifest.Source.ArticleRevisionId
                    || owned.SiteScope != article.Manifest.Source.SiteScope)
                {
                    return Invalid("article_package_export_source_binding_mismatch");
                }
                byte[] markdown = article.CopySourceBytes();
                if (!owned.MarkdownUtf8.AsSpan().SequenceEqual(markdown))
                {
                    return Invalid("article_package_export_source_binding_mismatch");
                }
                if (!AddBytes(ref fileBytes, markdown.Length))
                {
                    return Invalid("article_package_export_byte_budget_exceeded");
                }
                files.Add(new("articles/" + article.Manifest.PortableArticle.FileNameToken + ".md", markdown));
                bindings[index] = new(article.Manifest.PortableArticle, owned.InputId, owned.ContentDigest,
                    owned.UserId, owned.SiteScope,
                    owned.Coordinate.SourceVersion, owned.SourceDigest, owned.MetadataDigest, owned.PropertyDigest,
                    owned.AssetManifestDigest, owned.FontManifestDigest, owned.RendererDigest,
                    owned.ReadingStyleAuthorityDigest);
            }
            files.Sort(static (left, right) => string.CompareOrdinal(left.Path, right.Path));
            byte[] checksums = WriteChecksums(files);
            if (!AddBytes(ref fileBytes, checksums.Length))
            {
                return Invalid("article_package_export_byte_budget_exceeded");
            }
            files.Add(new(ArticlePackageInventory.ChecksumsPath, checksums));
            files.Sort(static (left, right) => string.CompareOrdinal(left.Path, right.Path));
            cancellationToken.ThrowIfCancellationRequested();
            byte[] archiveBytes = WriteArchive(files, cancellationToken);
            ArticlePackageManifestCandidateResult read = ArticlePackageImportZipCandidateReader.TryReadCandidate(
                archiveBytes, out ArticlePackageImportZipCandidate? archiveCandidate, cancellationToken);
            if (!read.IsValid)
            {
                return read.ReasonCode == "article_package_import_cancelled"
                    ? Invalid("article_package_export_cancelled")
                    : read;
            }
            if (archiveCandidate!.Candidate.Manifest.SemanticDigest != plan.Manifest.SemanticDigest)
            {
                return Invalid("article_package_export_source_binding_mismatch");
            }
            cancellationToken.ThrowIfCancellationRequested();
            candidate = new(archiveCandidate, archiveBytes, bindings);
            return new(true, null);
        }
        catch (OperationCanceledException)
        {
            return Invalid("article_package_export_cancelled");
        }
        catch (ArgumentException)
        {
            return Invalid("article_package_export_input_invalid");
        }
        catch (IndexOutOfRangeException)
        {
            return Invalid("article_package_export_input_invalid");
        }
        catch (InvalidDataException)
        {
            return Invalid("article_package_export_input_invalid");
        }
        catch (IOException)
        {
            return Invalid("article_package_export_output_invalid");
        }
    }

    private static bool AddBytes(ref long total, long bytes)
    {
        if (bytes < 0 || bytes > MaxFrozenInputBytes - total)
        {
            return false;
        }
        total += bytes;
        return true;
    }

    private static byte[] WriteChecksums(List<ArticlePackageFileBytes> files)
    {
        ArticlePackageInventoryEntry[] inventory = [.. files.Select(file =>
            new ArticlePackageInventoryEntry(file.Path, ArticlePackageEntryKind.RegularFile,
                file.Bytes.Length, file.Bytes.Length)),
            new(ArticlePackageInventory.ChecksumsPath, ArticlePackageEntryKind.RegularFile, 0, 0)];
        ArticlePackageChecksumEntry[] rows = [.. files.Select(file => new ArticlePackageChecksumEntry(
            file.Path, file.Bytes.Length, Convert.ToHexStringLower(SHA256.HashData(file.Bytes.Span))))];
        ArticlePackageChecksumValidationResult result = ArticlePackageChecksums.ComputeComponentDigest(inventory, rows);
        if (!result.IsValid)
        {
            throw new InvalidDataException(result.ReasonCode);
        }
        using var bytes = new MemoryStream();
        using (var writer = new Utf8JsonWriter(bytes))
        {
            writer.WriteStartObject();
            writer.WriteString("schema", ArticlePackageChecksums.Schema);
            writer.WriteNumber("version", ArticlePackageChecksums.Version);
            writer.WriteString("algorithm", ArticlePackageChecksums.Algorithm);
            writer.WriteString("componentDigest", result.ComponentDigest);
            writer.WriteStartArray("files");
            foreach (ArticlePackageChecksumEntry row in rows)
            {
                writer.WriteStartObject();
                writer.WriteString("path", row.Path);
                writer.WriteNumber("byteLength", row.ByteLength);
                writer.WriteString("sha256", row.Sha256);
                writer.WriteEndObject();
            }
            writer.WriteEndArray();
            writer.WriteEndObject();
        }
        return bytes.ToArray();
    }

    private static byte[] WriteArchive(List<ArticlePackageFileBytes> files, CancellationToken cancellationToken)
    {
        using var bytes = new MemoryStream();
        using var bounded = new BoundedArchiveStream(bytes, cancellationToken);
        using (var archive = new ZipArchive(bounded, ZipArchiveMode.Create, leaveOpen: true,
            entryNameEncoding: new UTF8Encoding(false, true)))
        {
            foreach (ArticlePackageFileBytes file in files)
            {
                cancellationToken.ThrowIfCancellationRequested();
                ZipArchiveEntry entry = archive.CreateEntry(file.Path, CompressionLevel.NoCompression);
                entry.LastWriteTime = new DateTimeOffset(1980, 1, 1, 0, 0, 0, TimeSpan.Zero);
                entry.ExternalAttributes = unchecked((int)0x81a40000);
                using Stream output = entry.Open();
                ReadOnlySpan<byte> remaining = file.Bytes.Span;
                while (!remaining.IsEmpty)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    int size = Math.Min(64 * 1024, remaining.Length);
                    output.Write(remaining[..size]);
                    remaining = remaining[size..];
                }
            }
        }
        cancellationToken.ThrowIfCancellationRequested();
        return bytes.ToArray();
    }

    private sealed class BoundedArchiveStream(MemoryStream destination, CancellationToken cancellationToken) : Stream
    {
        public override bool CanRead => false;
        public override bool CanSeek => true;
        public override bool CanWrite => true;
        public override long Length => destination.Length;
        public override long Position
        {
            get => destination.Position;
            set
            {
                if (value < 0 || value > ArticlePackageImportZipCandidateReader.MaxArchiveBytes)
                {
                    throw new IOException("article_package_export_archive_budget_exceeded");
                }
                destination.Position = value;
            }
        }

        public override void Write(byte[] buffer, int offset, int count) => Write(buffer.AsSpan(offset, count));
        public override void Write(ReadOnlySpan<byte> buffer)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (buffer.Length > ArticlePackageImportZipCandidateReader.MaxArchiveBytes - Position)
            {
                throw new IOException("article_package_export_archive_budget_exceeded");
            }
            destination.Write(buffer);
        }
        public override void Flush() => destination.Flush();
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin)
        {
            long basis = origin switch
            {
                SeekOrigin.Begin => 0,
                SeekOrigin.Current => Position,
                SeekOrigin.End => Length,
                _ => throw new ArgumentOutOfRangeException(nameof(origin))
            };
            Position = checked(basis + offset);
            return Position;
        }
    }

    private static ArticlePackageManifestCandidateResult Invalid(string reason) => new(false, reason);
}
