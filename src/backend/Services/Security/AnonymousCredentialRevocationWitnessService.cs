using System.Security.Cryptography;
using System.Text;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using SqlSugar;

namespace FsusBlog.Server.Services.Security;

public interface IAnonymousCredentialRevocationWitnessService
{
    Task<Result<AnonymousCredentialRevocationWitnessResponseCoreModel>> CreateWitnessAsync(
        AnonymousCredentialRevocationWitnessRequestCoreModel request,
        CancellationToken cancellationToken = default);
}

public static class AnonymousCredentialRevocationWitnessLimits
{
    public const int MaxRequestFrameBytes = 8 * 1024;
}

public sealed class AnonymousCredentialRevocationWitnessService(
    IAnonymousCredentialRootService rootService,
    ISqlSugarClient db) : IAnonymousCredentialRevocationWitnessService
{
    public async Task<Result<AnonymousCredentialRevocationWitnessResponseCoreModel>> CreateWitnessAsync(
        AnonymousCredentialRevocationWitnessRequestCoreModel request,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        Result<AnonymousCredentialRootSnapshotCoreModel> root = await rootService.GetCurrentSnapshotAsync(cancellationToken);
        if (!root.IsSuccess)
        {
            return Result<AnonymousCredentialRevocationWitnessResponseCoreModel>.Failure(root.Error);
        }

        AnonymousCredentialRootSnapshotCoreModel snapshot = root.Value;
        Result snapshotValidation = ValidateRequestAgainstSnapshot(request, snapshot);
        if (snapshotValidation.IsFailure)
        {
            return Result<AnonymousCredentialRevocationWitnessResponseCoreModel>.Failure(snapshotValidation.Error);
        }

        AnonymousCredentialRevocationAccumulatorProfile profile =
            AnonymousCredentialRevocationAccumulator.ResolveProfileFromCircuitMetadata(
                Encoding.UTF8.GetString(snapshot.CircuitMetadata));
        Result compatible = AnonymousCredentialRevocationAccumulator.EnsureProductionZkCompatible(profile);
        if (compatible.IsFailure)
        {
            return Result<AnonymousCredentialRevocationWitnessResponseCoreModel>.Failure(compatible.Error);
        }

        string revocationRoot = Convert.ToHexStringLower(request.RevocationRoot);
        string revocationHandleHash = Convert.ToHexStringLower(request.RevocationHandleHash);
        List<string> revokedHandles = await db.Queryable<AnonymousCredentialRevocation>()
            .Where(item => item.Epoch == request.CredentialEpoch)
            .Select(static item => item.RevocationHandleHash)
            .ToListAsync(cancellationToken);

        Result<AnonymousCredentialNonMembershipWitness> witness =
            AnonymousCredentialRevocationAccumulator.CreateCircuitFriendlyNonMembershipWitness(
                request.CredentialEpoch,
                revocationRoot,
                request.IssuerPublicKeyHash,
                revocationHandleHash,
                revokedHandles);
        if (!witness.IsSuccess || witness.Value is null)
        {
            return Result<AnonymousCredentialRevocationWitnessResponseCoreModel>.Failure(witness.Error);
        }

        return ToResponse(witness.Value);
    }

    private static Result ValidateRequestAgainstSnapshot(
        AnonymousCredentialRevocationWitnessRequestCoreModel request,
        AnonymousCredentialRootSnapshotCoreModel snapshot)
    {
        if (!snapshot.ZkAnonymousEnabled ||
            request.CredentialEpoch <= 0 ||
            request.CredentialEpoch != snapshot.CredentialEpoch ||
            request.CircuitNumericId != snapshot.CircuitNumericId ||
            request.PublicInputLayoutVersion != snapshot.PublicInputLayoutVersion ||
            !string.Equals(request.CircuitId, snapshot.CircuitId, StringComparison.Ordinal) ||
            !string.Equals(request.IssuerPublicKeyHash, snapshot.IssuerPublicKeyHash, StringComparison.OrdinalIgnoreCase) ||
            request.RevocationRoot.Length == 0 ||
            snapshot.RevocationRoot.Length == 0 ||
            request.RevocationHandleHash.Length == 0)
        {
            return Result.Failure(ErrorCode.Validation, "anonymous_credential_revocation_witness_request_invalid");
        }

        if (!CryptographicOperations.FixedTimeEquals(request.RevocationRoot, snapshot.RevocationRoot))
        {
            return Result.Failure(ErrorCode.Validation, "anonymous_credential_revocation_root_mismatch");
        }

        string handle = Convert.ToHexStringLower(request.RevocationHandleHash);
        return AnonymousCredentialRevocationAccumulator.IsHexHash(handle)
            ? Result.Success()
            : Result.Failure(ErrorCode.Validation, "anonymous_credential_revocation_handle_invalid");
    }

    private static Result<AnonymousCredentialRevocationWitnessResponseCoreModel> ToResponse(
        AnonymousCredentialNonMembershipWitness witness)
    {
        if (witness.SiblingHashes is null ||
            witness.SiblingHashes.Count != 128)
        {
            return Result<AnonymousCredentialRevocationWitnessResponseCoreModel>.Failure(
                ErrorCode.Validation,
                "anonymous_credential_witness_invalid");
        }

        if (!TryDecodeHex(witness.RevocationRootHash, out byte[] revocationRoot) ||
            !TryDecodeHex(witness.RevocationHandleHash, out byte[] revocationHandleHash) ||
            !TryDecodeHex(witness.LeafKey, out byte[] leafKey) ||
            !TryDecodeHex(witness.WitnessHash, out byte[] witnessHash) ||
            !TryConcatSiblingHashes(witness.SiblingHashes, out byte[] siblingHashes))
        {
            return Result<AnonymousCredentialRevocationWitnessResponseCoreModel>.Failure(
                ErrorCode.Validation,
                "anonymous_credential_witness_invalid");
        }

        return Result<AnonymousCredentialRevocationWitnessResponseCoreModel>.Success(
            new AnonymousCredentialRevocationWitnessResponseCoreModel(
                witness.Epoch,
                witness.AlgorithmId,
                witness.PathDepth,
                revocationRoot,
                witness.IssuerPublicKeyHash,
                revocationHandleHash,
                leafKey,
                witnessHash,
                siblingHashes));
    }

    private static bool TryConcatSiblingHashes(IReadOnlyList<string> siblings, out byte[] bytes)
    {
        bytes = new byte[siblings.Count * 32];
        for (int index = 0; index < siblings.Count; index++)
        {
            if (!TryDecodeHex(siblings[index], out byte[] sibling) ||
                sibling.Length != 32)
            {
                bytes = [];
                return false;
            }

            sibling.CopyTo(bytes.AsSpan(index * 32, 32));
        }

        return true;
    }

    private static bool TryDecodeHex(string value, out byte[] bytes)
    {
        bytes = [];
        string normalized = value.Trim();
        if (normalized.Length == 0 ||
            normalized.Length % 2 != 0 ||
            !normalized.All(static ch => Uri.IsHexDigit(ch)))
        {
            return false;
        }

        try
        {
            bytes = Convert.FromHexString(normalized);
            return bytes.Length > 0;
        }
        catch (FormatException)
        {
            bytes = [];
            return false;
        }
    }
}
