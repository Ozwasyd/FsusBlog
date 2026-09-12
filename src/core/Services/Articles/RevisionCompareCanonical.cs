using System.Collections.Immutable;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.Core.Services.Articles;

internal static class RevisionCompareCanonical
{
    public static string Sha256(ReadOnlySpan<byte> value)
        => Convert.ToHexStringLower(SHA256.HashData(value));

    public static bool IsSha256(string value)
        => value.Length == 64 && value.All(static character => character is >= '0' and <= '9' or >= 'a' and <= 'f');

    public static string PackageDigest(
        int articleId,
        RevisionCompareSourceKind sourceKind,
        string sourceIdentity,
        long? revisionId,
        int? revisionNo,
        long? serverRevision,
        string? documentEpoch,
        string sourceDigest,
        int sourceByteLength,
        ImmutableArray<RevisionCompareMetadataValue> metadata,
        ImmutableArray<RevisionCompareSnapshot> snapshots)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        Append(hash, RevisionCompareContract.SchemaVersion);
        Append(hash, articleId);
        Append(hash, (int)sourceKind);
        Append(hash, sourceIdentity);
        Append(hash, revisionId);
        Append(hash, revisionNo);
        Append(hash, serverRevision);
        Append(hash, documentEpoch);
        Append(hash, sourceDigest);
        Append(hash, sourceByteLength);
        foreach (RevisionCompareMetadataValue value in metadata)
        {
            Append(hash, value.FieldId);
            Append(hash, (int)value.ValueType);
            Append(hash, value.CanonicalValue);
            Append(hash, value.Sensitive);
        }
        foreach (RevisionCompareSnapshot snapshot in snapshots)
        {
            Append(hash, (int)snapshot.Kind);
            Append(hash, (int)snapshot.State);
            Append(hash, snapshot.Reference);
            Append(hash, snapshot.SchemaVersion);
            Append(hash, snapshot.PayloadDigest);
        }
        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }

    public static string PlanDigest(
        RevisionComparePlanRequest request,
        RevisionComparePackageReference basePackage,
        RevisionComparePackageReference comparePackage,
        RevisionCompareAdmission admission)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        Append(hash, RevisionCompareContract.SchemaVersion);
        Append(hash, RevisionCompareContract.PlannerVersion);
        Append(hash, request.ArticleId);
        Append(hash, request.Reader.AdminPrincipalId);
        Append(hash, request.Reader.SiteScope);
        Append(hash, request.Reader.RequestId);
        AppendSelector(hash, request.Base);
        AppendSelector(hash, request.Compare);
        AppendPackageReference(hash, basePackage);
        AppendPackageReference(hash, comparePackage);
        Append(hash, OptionsDigest(request.Options));
        Append(hash, BudgetDigest(request.Budgets));
        Append(hash, admission.ContentDigest);
        Append(hash, request.CancellationIdentity);
        Append(hash, request.ExpiresAtUtc.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture));
        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }

    public static string PermissionScopeDigest(RevisionComparePlanRequest request)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        Append(hash, RevisionCompareContract.SchemaVersion);
        Append(hash, request.ArticleId);
        Append(hash, request.Reader.AdminPrincipalId);
        Append(hash, request.Reader.SiteScope);
        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }

    public static string MetadataSchemaDigest()
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        Append(hash, RevisionCompareContract.SchemaVersion);
        foreach (RevisionCompareMetadataDescriptor descriptor in RevisionCompareMetadataRegistry.Descriptors)
        {
            Append(hash, descriptor.FieldId);
            Append(hash, (int)descriptor.ValueType);
            Append(hash, descriptor.Sensitive);
            Append(hash, descriptor.Normalization);
            Append(hash, descriptor.DisplayFormat);
            Append(hash, descriptor.Authority);
        }
        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }

    public static string OptionsDigest(RevisionCompareOptions options)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        Append(hash, (int)options.ViewMode);
        Append(hash, (int)options.WordSegmentation);
        Append(hash, options.ContextLineCount);
        Append(hash, options.HeadingNavigation);
        foreach (string fieldId in options.MetadataFields.Order(StringComparer.Ordinal))
        {
            Append(hash, fieldId);
        }
        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }

    public static string BudgetDigest(RevisionCompareBudgets budgets)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        AppendBudgets(hash, budgets);
        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }

    public static string AdmissionDigest(
        RevisionCompareAdmissionMode mode,
        int baseSourceByteCount,
        int compareSourceByteCount,
        int baseLineCount,
        int compareLineCount,
        long initialEstimatedMemoryBytes,
        long minimumEstimatedOutputBytes,
        int tokenLimit,
        int hunkLimit,
        int chunkLimit)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        Append(hash, RevisionCompareContract.SchemaVersion);
        Append(hash, (int)mode);
        Append(hash, baseSourceByteCount);
        Append(hash, compareSourceByteCount);
        Append(hash, baseLineCount);
        Append(hash, compareLineCount);
        Append(hash, initialEstimatedMemoryBytes);
        Append(hash, minimumEstimatedOutputBytes);
        Append(hash, tokenLimit);
        Append(hash, hunkLimit);
        Append(hash, chunkLimit);
        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }

    public static string ReceiptDigest(RevisionComparePlanReceipt receipt)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        Append(hash, receipt.SchemaVersion);
        Append(hash, receipt.RequestId);
        Append(hash, (int)receipt.Status);
        Append(hash, receipt.ReasonCode);
        Append(hash, receipt.PlanDigest);
        Append(hash, receipt.BasePackageDigest);
        Append(hash, receipt.ComparePackageDigest);
        AppendOptionalPackageReference(hash, receipt.BasePackageReference);
        AppendOptionalPackageReference(hash, receipt.ComparePackageReference);
        Append(hash, receipt.PermissionScopeDigest);
        Append(hash, receipt.MetadataSchemaDigest);
        Append(hash, receipt.OptionsDigest);
        Append(hash, receipt.BudgetDigest);
        Append(hash, receipt.AdmissionDigest);
        Append(hash, receipt.CancellationIdentity);
        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }

    public static RevisionComparePackageReference Reference(RevisionComparePackage package)
        => new(
            package.SourceKind,
            package.SourceIdentity,
            package.RevisionId,
            package.RevisionNo,
            package.ServerRevision,
            package.DocumentEpoch,
            package.SourceDigest,
            package.PackageDigest,
            package.RawMarkdown.Length);

    public static bool ReferenceMatches(RevisionComparePackageReference reference, RevisionComparePackage package)
        => reference == Reference(package);

    private static void AppendSelector(IncrementalHash hash, RevisionCompareSourceSelector selector)
    {
        Append(hash, (int)selector.Kind);
        Append(hash, selector.RevisionId);
        Append(hash, selector.DraftKey);
        Append(hash, selector.ExpectedServerRevision);
        Append(hash, selector.DocumentEpoch);
        Append(hash, selector.ExpectedSourceDigest);
    }

    private static void AppendPackageReference(IncrementalHash hash, RevisionComparePackageReference reference)
    {
        Append(hash, (int)reference.SourceKind);
        Append(hash, reference.SourceIdentity);
        Append(hash, reference.RevisionId);
        Append(hash, reference.RevisionNo);
        Append(hash, reference.ServerRevision);
        Append(hash, reference.DocumentEpoch);
        Append(hash, reference.SourceDigest);
        Append(hash, reference.PackageDigest);
        Append(hash, reference.SourceByteLength);
    }

    private static void AppendOptionalPackageReference(
        IncrementalHash hash,
        RevisionComparePackageReference? reference)
    {
        Append(hash, reference is not null);
        if (reference is not null)
        {
            AppendPackageReference(hash, reference);
        }
    }

    private static void AppendBudgets(IncrementalHash hash, RevisionCompareBudgets budgets)
    {
        Append(hash, budgets.MaxSourceBytes);
        Append(hash, budgets.MaxLineCount);
        Append(hash, budgets.MaxTokenCount);
        Append(hash, budgets.MaxOutputBytes);
        Append(hash, budgets.MaxMemoryBytes);
        Append(hash, budgets.MaxHunksPerChunk);
        Append(hash, budgets.MaxChunks);
        Append(hash, budgets.TimeoutMilliseconds);
    }

    public static void Append(IncrementalHash hash, object? value)
    {
        string text = value switch
        {
            null => "null",
            DateTimeOffset timestamp => timestamp.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture),
            IFormattable formattable => formattable.ToString(null, CultureInfo.InvariantCulture),
            _ => value.ToString() ?? string.Empty
        };
        byte[] bytes = Encoding.UTF8.GetBytes(text);
        Span<byte> length = stackalloc byte[4];
        System.Buffers.Binary.BinaryPrimitives.WriteInt32LittleEndian(length, bytes.Length);
        hash.AppendData(length);
        hash.AppendData(bytes);
    }
}
