using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.Shared.Contracts.AuthorTypography;

/// <summary>Validates closed profile facts without normalizing arbitrary or legacy values.</summary>
public static class AuthorTypographyContractValidator
{
    /// <summary>
    /// Admits exactly the five ID fields. This is a field validator, not a JSON codec or
    /// a persistence fallback. Unknown, missing, differently cased and extra fields refuse.
    /// </summary>
    public static bool TryCreateProfile(
        int schemaVersion,
        IReadOnlyDictionary<string, string>? fields,
        out AuthorTypographyProfile? profile)
    {
        profile = null;
        if (schemaVersion != AuthorTypographyCatalog.Version
            || fields is null
            || fields.Count != AuthorTypographyCatalog.Dimensions.Count)
        {
            return false;
        }
        // Enumerate the supplied keys rather than trusting a caller's case-insensitive comparer.
        foreach ((string dimension, string value) in fields)
        {
            if (!AuthorTypographyCatalog.Dimensions.TryGetValue(dimension, out IReadOnlyList<string>? allowed)
                || !allowed.Contains(value, StringComparer.Ordinal))
            {
                return false;
            }
        }
        profile = new AuthorTypographyProfile(
            schemaVersion,
            fields["fontFamily"],
            fields["fontSize"],
            fields["lineHeight"],
            fields["canvasWidth"],
            fields["paragraphSpacing"]);
        return true;
    }

    public static bool ValidateProfile(AuthorTypographyProfile? profile)
    {
        return profile is not null
            && TryCreateProfile(profile.SchemaVersion, new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["fontFamily"] = profile.FontFamily,
                ["fontSize"] = profile.FontSize,
                ["lineHeight"] = profile.LineHeight,
                ["canvasWidth"] = profile.CanvasWidth,
                ["paragraphSpacing"] = profile.ParagraphSpacing
            }, out _);
    }

    /// <summary>Checks an observation against the current authenticated scope before it is consumed.</summary>
    public static AuthorTypographyContractStatus ValidateSnapshot(
        AuthorTypographySnapshot? snapshot,
        AuthorTypographyScope? authenticatedScope)
    {
        if (!ValidateScope(authenticatedScope) || snapshot is null || !ValidateScope(snapshot.Scope))
        {
            return AuthorTypographyContractStatus.InvalidScope;
        }
        if (snapshot.Scope != authenticatedScope)
        {
            return AuthorTypographyContractStatus.ScopeMismatch;
        }
        if (snapshot.Revision < 0)
        {
            return AuthorTypographyContractStatus.InvalidRevision;
        }
        if (!ValidateProfile(snapshot.Profile))
        {
            return AuthorTypographyContractStatus.InvalidProfile;
        }
        string expected = ComputeSnapshotDigest(snapshot);
        return string.Equals(snapshot.ContentDigest, expected, StringComparison.Ordinal)
            ? AuthorTypographyContractStatus.Valid
            : AuthorTypographyContractStatus.DigestMismatch;
    }

    /// <summary>
    /// Content addressing detects accidental or adversarial substitutions, not authenticity.
    /// The authenticated server still owns authorization, CAS, idempotency and persistence.
    /// </summary>
    public static string ComputeSnapshotDigest(AuthorTypographySnapshot snapshot)
    {
        ArgumentNullException.ThrowIfNull(snapshot);
        if (!ValidateScope(snapshot.Scope) || snapshot.Revision < 0 || !ValidateProfile(snapshot.Profile))
        {
            throw new ArgumentException("Invalid author typography snapshot.", nameof(snapshot));
        }
        using IncrementalHash hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        Append(hash, AuthorTypographyCatalog.Schema);
        Append(hash, snapshot.Scope.AccountId.ToString(System.Globalization.CultureInfo.InvariantCulture));
        Append(hash, snapshot.Scope.SiteIdentity);
        Append(hash, snapshot.Revision.ToString(System.Globalization.CultureInfo.InvariantCulture));
        Append(hash, snapshot.Profile.FontFamily);
        Append(hash, snapshot.Profile.FontSize);
        Append(hash, snapshot.Profile.LineHeight);
        Append(hash, snapshot.Profile.CanvasWidth);
        Append(hash, snapshot.Profile.ParagraphSpacing);
        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }

    private static bool ValidateScope(AuthorTypographyScope? scope)
    {
        return scope is not null
            && scope.AccountId > 0
            && !string.IsNullOrWhiteSpace(scope.SiteIdentity)
            && scope.SiteIdentity.Length <= 128
            && !scope.SiteIdentity.Any(char.IsControl);
    }

    private static void Append(IncrementalHash hash, string value)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(value);
        Span<byte> length = stackalloc byte[sizeof(int)];
        BinaryPrimitives.WriteInt32BigEndian(length, bytes.Length);
        hash.AppendData(length);
        hash.AppendData(bytes);
    }
}
