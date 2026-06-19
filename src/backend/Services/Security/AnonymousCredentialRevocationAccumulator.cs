using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.Core.Common;

namespace FsusBlog.Server.Services.Security;

public sealed record AnonymousCredentialNonMembershipWitness(
    long Epoch,
    string RevocationRootHash,
    string IssuerPublicKeyHash,
    string RevocationHandleHash,
    string PreviousRevocationHandleHash,
    string NextRevocationHandleHash,
    string WitnessHash);

public static class AnonymousCredentialRevocationAccumulator
{
    private const string HandleDomain = "fsus.anonymous.revocation.handle.v1";
    private const string EmptyRootDomain = "fsus.anonymous.revocation.accumulator.empty.v1";
    private const string LeafDomain = "fsus.anonymous.revocation.accumulator.leaf.v1";
    private const string NodeDomain = "fsus.anonymous.revocation.accumulator.node.v1";
    private const string RootDomain = "fsus.anonymous.revocation.accumulator.root.v1";
    private const string WitnessDomain = "fsus.anonymous.revocation.nonmembership.v1";

    public static string DeriveHandleHash(string issuerPublicKeyHash, string credentialBinding)
        => Sha256Hex(
            HandleDomain,
            NormalizeHexToken(issuerPublicKeyHash, 128),
            NormalizeToken(credentialBinding, 256));

    public static Result<string> TryComputeRoot(
        long epoch,
        string issuerPublicKeyHash,
        IEnumerable<string> revokedHandleHashes)
    {
        string issuer = NormalizeHexToken(issuerPublicKeyHash, 128);
        if (epoch <= 0 || !IsHexHash(issuer, minLength: 32, maxLength: 128))
        {
            return Result<string>.Failure(ErrorCode.Validation, "anonymous_credential_accumulator_invalid");
        }

        Result<string[]> normalizedHandles = NormalizeHandles(revokedHandleHashes);
        if (normalizedHandles.IsFailure || normalizedHandles.Value is null)
        {
            return Result<string>.Failure(normalizedHandles.Error);
        }

        return Result<string>.Success(ComputeRootCore(epoch, issuer, normalizedHandles.Value));
    }

    public static Result<AnonymousCredentialNonMembershipWitness> CreateNonMembershipWitness(
        long epoch,
        string revocationRootHash,
        string issuerPublicKeyHash,
        string revocationHandleHash,
        IEnumerable<string> revokedHandleHashes)
    {
        string root = NormalizeHexToken(revocationRootHash, 128);
        string issuer = NormalizeHexToken(issuerPublicKeyHash, 128);
        string handle = NormalizeHexToken(revocationHandleHash, 128);
        Result<string[]> normalizedHandles = NormalizeHandles(revokedHandleHashes);
        if (epoch <= 0 ||
            !IsHexHash(root, minLength: 32, maxLength: 128) ||
            !IsHexHash(issuer, minLength: 32, maxLength: 128) ||
            !IsHexHash(handle, minLength: 32, maxLength: 128) ||
            normalizedHandles.IsFailure ||
            normalizedHandles.Value is null)
        {
            return Result<AnonymousCredentialNonMembershipWitness>.Failure(ErrorCode.Validation, "anonymous_credential_witness_invalid");
        }

        string expectedRoot = ComputeRootCore(epoch, issuer, normalizedHandles.Value);
        if (!string.Equals(expectedRoot, root, StringComparison.OrdinalIgnoreCase))
        {
            return Result<AnonymousCredentialNonMembershipWitness>.Failure(ErrorCode.Validation, "anonymous_credential_revocation_root_mismatch");
        }

        if (Array.BinarySearch(normalizedHandles.Value, handle, StringComparer.OrdinalIgnoreCase) >= 0)
        {
            return Result<AnonymousCredentialNonMembershipWitness>.Failure(ErrorCode.Validation, "anonymous_credential_revoked");
        }

        (string previous, string next) = ResolveNeighbors(normalizedHandles.Value, handle);
        string witness = Sha256Hex(
            WitnessDomain,
            epoch.ToString(CultureInfo.InvariantCulture),
            root,
            issuer,
            handle,
            previous,
            next);
        return Result<AnonymousCredentialNonMembershipWitness>.Success(new AnonymousCredentialNonMembershipWitness(
            epoch,
            root,
            issuer,
            handle,
            previous,
            next,
            witness));
    }

    public static bool VerifyNonMembershipWitness(
        AnonymousCredentialNonMembershipWitness witness,
        IEnumerable<string> revokedHandleHashes)
    {
        Result<AnonymousCredentialNonMembershipWitness> expected = CreateNonMembershipWitness(
            witness.Epoch,
            witness.RevocationRootHash,
            witness.IssuerPublicKeyHash,
            witness.RevocationHandleHash,
            revokedHandleHashes);
        return expected.IsSuccess &&
            expected.Value is not null &&
            string.Equals(expected.Value.PreviousRevocationHandleHash, NormalizeHexToken(witness.PreviousRevocationHandleHash, 128), StringComparison.OrdinalIgnoreCase) &&
            string.Equals(expected.Value.NextRevocationHandleHash, NormalizeHexToken(witness.NextRevocationHandleHash, 128), StringComparison.OrdinalIgnoreCase) &&
            string.Equals(expected.Value.WitnessHash, NormalizeHexToken(witness.WitnessHash, 128), StringComparison.OrdinalIgnoreCase);
    }

    public static bool IsHexHash(string? value, int minLength = 32, int maxLength = 128)
    {
        string normalized = NormalizeHexToken(value, maxLength);
        return normalized.Length >= minLength &&
            normalized.Length <= maxLength &&
            normalized.All(static ch => Uri.IsHexDigit(ch));
    }

    private static Result<string[]> NormalizeHandles(IEnumerable<string> revokedHandleHashes)
    {
        string[] handles = revokedHandleHashes
            .Select(static item => NormalizeHexToken(item, 128))
            .Where(static item => item.Length > 0)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(static item => item, StringComparer.OrdinalIgnoreCase)
            .ToArray();
        if (handles.Any(static item => !IsHexHash(item, minLength: 32, maxLength: 128)))
        {
            return Result<string[]>.Failure(ErrorCode.Validation, "anonymous_credential_revocation_handle_invalid");
        }

        return Result<string[]>.Success(handles);
    }

    private static string ComputeRootCore(long epoch, string issuerPublicKeyHash, IReadOnlyList<string> handles)
    {
        string epochText = epoch.ToString(CultureInfo.InvariantCulture);
        if (handles.Count == 0)
        {
            return Sha256Hex(EmptyRootDomain, epochText, issuerPublicKeyHash);
        }

        List<string> level = handles
            .Select(handle => Sha256Hex(LeafDomain, epochText, issuerPublicKeyHash, handle))
            .ToList();
        while (level.Count > 1)
        {
            var next = new List<string>((level.Count + 1) / 2);
            for (int index = 0; index < level.Count; index += 2)
            {
                string left = level[index];
                string right = index + 1 < level.Count ? level[index + 1] : left;
                next.Add(Sha256Hex(NodeDomain, epochText, issuerPublicKeyHash, left, right));
            }

            level = next;
        }

        return Sha256Hex(RootDomain, epochText, issuerPublicKeyHash, level[0]);
    }

    private static (string Previous, string Next) ResolveNeighbors(IReadOnlyList<string> sortedHandles, string handle)
    {
        string previous = string.Empty;
        foreach (string current in sortedHandles)
        {
            int comparison = string.Compare(current, handle, StringComparison.OrdinalIgnoreCase);
            if (comparison > 0)
            {
                return (previous, current);
            }

            previous = current;
        }

        return (previous, string.Empty);
    }

    private static string NormalizeHexToken(string? value, int maxLength)
        => NormalizeToken(value, maxLength).ToLowerInvariant();

    private static string NormalizeToken(string? value, int maxLength)
    {
        string normalized = string.IsNullOrWhiteSpace(value) ? string.Empty : value.Trim();
        return normalized.Length <= maxLength ? normalized : normalized[..maxLength];
    }

    private static string Sha256Hex(params string[] parts)
        => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(string.Join('\0', parts))));
}
