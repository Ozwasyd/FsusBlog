using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.Shared.Contracts.AuthorTypography;

/// <summary>Validates closed profile facts without normalizing arbitrary or legacy values.</summary>
public static class AuthorTypographyContractValidator
{
    /// <summary>Validates the payload without deriving a default or accepting a persistence operation.</summary>
    public static bool ValidateCommand(AuthorTypographyCommand? command)
    {
        return command is not null
            && command.ExpectedRevision >= 0
            && (command.Mutation switch
            {
                AuthorTypographyMutation.SetProfile => ValidateProfile(command.Profile),
                AuthorTypographyMutation.Reset => command.Profile is null,
                _ => false
            });
    }

    /// <summary>Request IDs must be nonempty and are interpreted only inside the authenticated scope.</summary>
    public static bool ValidateMutationRequest(
        AuthorTypographyScope? authenticatedScope,
        AuthorTypographyMutationRequest? request)
    {
        return ValidateScope(authenticatedScope)
            && request is not null
            && request.RequestId != Guid.Empty
            && ValidateCommand(request.Command);
    }

    /// <summary>Content address binds the exact scope, request identity, action, expected revision and payload.</summary>
    public static string ComputeRequestDigest(
        AuthorTypographyScope authenticatedScope,
        AuthorTypographyMutationRequest request)
    {
        if (!ValidateMutationRequest(authenticatedScope, request))
        {
            throw new ArgumentException("Invalid author typography request.", nameof(request));
        }
        using IncrementalHash hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        Append(hash, AuthorTypographyCatalog.Schema);
        Append(hash, "request");
        Append(hash, authenticatedScope.AccountId.ToString(System.Globalization.CultureInfo.InvariantCulture));
        Append(hash, authenticatedScope.SiteIdentity);
        Append(hash, request.RequestId.ToString("D"));
        Append(hash, request.Command.ExpectedRevision.ToString(System.Globalization.CultureInfo.InvariantCulture));
        Append(hash, request.Command.Mutation == AuthorTypographyMutation.SetProfile ? "set" : "reset");
        if (request.Command.Profile is { } profile)
        {
            Append(hash, profile.FontFamily);
            Append(hash, profile.FontSize);
            Append(hash, profile.LineHeight);
            Append(hash, profile.CanvasWidth);
            Append(hash, profile.ParagraphSpacing);
        }
        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }

    /// <summary>Validates persisted-record content and its command-to-snapshot revision/profile binding.</summary>
    public static bool ValidateRecordedRequest(
        AuthorTypographyRecordedRequest? record,
        AuthorTypographyScope? authenticatedScope)
    {
        return IsRecordedRequestWellFormed(record, authenticatedScope)
            && string.Equals(record!.ContentDigest, ComputeRecordedRequestDigest(record, authenticatedScope!), StringComparison.Ordinal);
    }

    /// <summary>Seals record content, without authenticating storage or manufacturing a transaction receipt.</summary>
    public static string ComputeRecordedRequestDigest(
        AuthorTypographyRecordedRequest record,
        AuthorTypographyScope authenticatedScope)
    {
        if (!IsRecordedRequestWellFormed(record, authenticatedScope))
        {
            throw new ArgumentException("Invalid author typography recorded request.", nameof(record));
        }
        using IncrementalHash hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        Append(hash, AuthorTypographyCatalog.Schema);
        Append(hash, "recorded-request");
        Append(hash, ComputeRequestDigest(authenticatedScope, record.Request));
        Append(hash, record.CommittedSnapshot.ContentDigest);
        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }

    private static bool IsRecordedRequestWellFormed(
        AuthorTypographyRecordedRequest? record,
        AuthorTypographyScope? authenticatedScope)
    {
        return record is not null
            && ValidateMutationRequest(authenticatedScope, record.Request)
            && ValidateSnapshot(record.CommittedSnapshot, authenticatedScope) == AuthorTypographyContractStatus.Valid
            && record.Request.Command.ExpectedRevision < long.MaxValue
            && record.CommittedSnapshot.Revision == record.Request.Command.ExpectedRevision + 1
            && (record.Request.Command.Mutation == AuthorTypographyMutation.Reset
                || record.Request.Command.Profile == record.CommittedSnapshot.Profile);
    }

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

    /// <summary>Validates scope coordinates without authenticating the caller or normalizing supplied identity.</summary>
    public static bool ValidateScope(AuthorTypographyScope? scope)
    {
        return scope is not null
            && scope.AccountId > 0
            && !string.IsNullOrWhiteSpace(scope.SiteIdentity)
            && scope.SiteIdentity.Length <= 128
            && string.Equals(scope.SiteIdentity, scope.SiteIdentity.Trim(), StringComparison.Ordinal)
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
