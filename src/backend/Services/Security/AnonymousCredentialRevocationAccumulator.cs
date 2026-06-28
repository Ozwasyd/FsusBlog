using System.Collections.Concurrent;
using System.Globalization;
using System.Numerics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using FsusBlog.Core.Common;

namespace FsusBlog.Server.Services.Security;

public enum AnonymousCredentialRevocationAccumulatorAlgorithm
{
    Unknown = 0,
    LegacySha256HashTreeV1 = 1,
    CircuitFriendlyNonMembershipV1 = 2
}

public sealed record AnonymousCredentialRevocationAccumulatorProfile(
    AnonymousCredentialRevocationAccumulatorAlgorithm Algorithm,
    string AlgorithmId,
    bool ProductionZkReady,
    string UnavailableReason,
    ushort PathDepth = 0,
    string HashId = "",
    string TreeId = "")
{
    public bool IsProductionZkCompatible => ProductionZkReady && string.IsNullOrWhiteSpace(UnavailableReason);
}

public sealed record AnonymousCredentialNonMembershipWitness(
    long Epoch,
    string RevocationRootHash,
    string IssuerPublicKeyHash,
    string RevocationHandleHash,
    string PreviousRevocationHandleHash,
    string NextRevocationHandleHash,
    string WitnessHash,
    string AlgorithmId = AnonymousCredentialRevocationAccumulator.LegacySha256HashTreeAlgorithmId,
    ushort PathDepth = 0,
    IReadOnlyList<string>? SiblingHashes = null,
    string LeafKey = "");

public static class AnonymousCredentialRevocationAccumulator
{
    private const string HandleDomain = "fsus.anonymous.revocation.handle.v1";
    private const string EmptyRootDomain = "fsus.anonymous.revocation.accumulator.empty.v1";
    private const string LeafDomain = "fsus.anonymous.revocation.accumulator.leaf.v1";
    private const string NodeDomain = "fsus.anonymous.revocation.accumulator.node.v1";
    private const string RootDomain = "fsus.anonymous.revocation.accumulator.root.v1";
    private const string WitnessDomain = "fsus.anonymous.revocation.nonmembership.v1";
    private const string CircuitFriendlyLeafDomain = "fsus.anonymous.revocation.circuit.leaf.v1";
    private const string CircuitFriendlyNodeDomain = "fsus.anonymous.revocation.circuit.node.v1";
    private const string CircuitFriendlyWitnessDomain = "fsus.anonymous.revocation.circuit.nonmembership.v1";
    private const string CircuitFriendlyEmptyLeafDomain = "fsus.anonymous.revocation.circuit.empty.v1";
    private const string CircuitFriendlySiblingDigestDomain = "fsus.anonymous.revocation.circuit.sibling-digest.v1";
    private const string CircuitFriendlyMimcRoundDomain = "fsus.anonymous.revocation.circuit.mimc7.bn254.round.v1";
    private const string CircuitFriendlyHandleSetDomain = "fsus.anonymous.revocation.circuit.handle-set.v1";
    private const string CircuitFriendlyHashId = "mimc7-bn254.v1";
    private const string CircuitFriendlyTreeId = "sparse-merkle.v1";
    private const int CircuitFriendlyTreeDepth = 128;
    private const int CircuitFriendlyMimcRounds = 91;
    private const int CircuitFriendlyRootCacheMaxEntries = 64;
    private static readonly BigInteger CircuitFriendlyFieldPrime = BigInteger.Parse(
        "21888242871839275222246405745257275088548364400416034343698204186575808495617",
        CultureInfo.InvariantCulture);
    private static readonly Lazy<BigInteger[]> CircuitFriendlyMimcRoundConstants = new(BuildCircuitFriendlyMimcRoundConstants);
    private static readonly Lazy<string[]> CircuitFriendlyDefaultSparseRoots = new(BuildCircuitFriendlyDefaultSparseRoots);
    private static readonly ConcurrentDictionary<CircuitFriendlyTreeCacheKey, Lazy<Result<CircuitFriendlySparseTree>>> CircuitFriendlyTreeCache = new();
    private static long CircuitFriendlyTreeCacheEpoch;

    public const string LegacySha256HashTreeAlgorithmId = "legacy-sha256-hash-tree.v1";
    public const string CircuitFriendlyNonMembershipAlgorithmId = "circuit-friendly-non-membership.v1";
    public const string RevocationAccumulatorMetadataProperty = "revocationAccumulator";

    public static AnonymousCredentialRevocationAccumulatorProfile LegacySha256Profile { get; } = new(
        AnonymousCredentialRevocationAccumulatorAlgorithm.LegacySha256HashTreeV1,
                LegacySha256HashTreeAlgorithmId,
                ProductionZkReady: false,
        "legacy_sha256_not_circuit_friendly");

    public static string DeriveHandleHash(string issuerPublicKeyHash, string credentialBinding)
        => Sha256Hex(
            HandleDomain,
            NormalizeHexToken(issuerPublicKeyHash, 128),
            NormalizeToken(credentialBinding, 256));

    public static AnonymousCredentialRevocationAccumulatorProfile ResolveProfileFromCircuitMetadata(string? circuitMetadata)
    {
        if (string.IsNullOrWhiteSpace(circuitMetadata))
        {
            return LegacySha256Profile;
        }

        try
        {
            using JsonDocument document = JsonDocument.Parse(circuitMetadata);
            if (!document.RootElement.TryGetProperty(RevocationAccumulatorMetadataProperty, out JsonElement accumulator) ||
                accumulator.ValueKind != JsonValueKind.Object)
            {
                return LegacySha256Profile;
            }

            string algorithmId = ReadString(accumulator, "algorithm");
            bool productionZkReady = ReadBoolean(accumulator, "productionZkReady");
            ushort depth = ReadUInt16(accumulator, "depth");
            string hashId = ReadString(accumulator, "hash");
            string treeId = ReadString(accumulator, "tree");
            return ResolveProfile(algorithmId, productionZkReady, depth, hashId, treeId);
        }
        catch (JsonException)
        {
            return new AnonymousCredentialRevocationAccumulatorProfile(
                AnonymousCredentialRevocationAccumulatorAlgorithm.Unknown,
                string.Empty,
                ProductionZkReady: false,
                "revocation_accumulator_metadata_invalid");
        }
    }

    public static AnonymousCredentialRevocationAccumulatorProfile ResolveProfile(
        string? algorithmId,
        bool productionZkReady,
        ushort pathDepth = 0,
        string? hashId = null,
        string? treeId = null)
    {
        string normalized = NormalizeToken(algorithmId, 128).ToLowerInvariant();
        if (normalized.Length == 0 || string.Equals(normalized, LegacySha256HashTreeAlgorithmId, StringComparison.Ordinal))
        {
            return new AnonymousCredentialRevocationAccumulatorProfile(
                AnonymousCredentialRevocationAccumulatorAlgorithm.LegacySha256HashTreeV1,
                LegacySha256HashTreeAlgorithmId,
                productionZkReady,
                "legacy_sha256_not_circuit_friendly");
        }

        if (string.Equals(normalized, CircuitFriendlyNonMembershipAlgorithmId, StringComparison.Ordinal))
        {
            ushort effectiveDepth = pathDepth == 0 ? (ushort)CircuitFriendlyTreeDepth : pathDepth;
            string effectiveHash = NormalizeToken(hashId, 64).ToLowerInvariant();
            string effectiveTree = NormalizeToken(treeId, 64).ToLowerInvariant();
            if (effectiveHash.Length == 0)
            {
                effectiveHash = CircuitFriendlyHashId;
            }

            if (effectiveTree.Length == 0)
            {
                effectiveTree = CircuitFriendlyTreeId;
            }

            string unavailable = productionZkReady
                ? ResolveCircuitFriendlyProfileUnavailableReason(effectiveDepth, effectiveHash, effectiveTree)
                : "circuit_friendly_accumulator_not_marked_production_ready";
            return new AnonymousCredentialRevocationAccumulatorProfile(
                AnonymousCredentialRevocationAccumulatorAlgorithm.CircuitFriendlyNonMembershipV1,
                CircuitFriendlyNonMembershipAlgorithmId,
                productionZkReady,
                unavailable,
                effectiveDepth,
                effectiveHash,
                effectiveTree);
        }

        return new AnonymousCredentialRevocationAccumulatorProfile(
            AnonymousCredentialRevocationAccumulatorAlgorithm.Unknown,
            normalized,
            productionZkReady,
            "revocation_accumulator_algorithm_unknown");
    }

    public static Result EnsureProductionZkCompatible(AnonymousCredentialRevocationAccumulatorProfile profile)
        => profile.IsProductionZkCompatible
            ? Result.Success()
            : Result.Failure(ErrorCode.Validation, "anonymous_credential_revocation_accumulator_not_production_ready");

    private static string ResolveCircuitFriendlyProfileUnavailableReason(
        ushort pathDepth,
        string hashId,
        string treeId)
    {
        if (pathDepth != CircuitFriendlyTreeDepth)
        {
            return "circuit_friendly_accumulator_depth_mismatch";
        }

        if (!string.Equals(hashId, CircuitFriendlyHashId, StringComparison.Ordinal))
        {
            return "circuit_friendly_accumulator_hash_mismatch";
        }

        return string.Equals(treeId, CircuitFriendlyTreeId, StringComparison.Ordinal)
            ? string.Empty
            : "circuit_friendly_accumulator_tree_mismatch";
    }

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

    public static Result<string> TryComputeRoot(
        long epoch,
        string issuerPublicKeyHash,
        IEnumerable<string> revokedHandleHashes,
        AnonymousCredentialRevocationAccumulatorProfile profile)
        => profile.Algorithm == AnonymousCredentialRevocationAccumulatorAlgorithm.CircuitFriendlyNonMembershipV1
            ? TryComputeCircuitFriendlyRoot(epoch, issuerPublicKeyHash, revokedHandleHashes)
            : TryComputeRoot(epoch, issuerPublicKeyHash, revokedHandleHashes);

    public static Result<string> TryComputeCircuitFriendlyRoot(
        long epoch,
        string issuerPublicKeyHash,
        IEnumerable<string> revokedHandleHashes)
    {
        Result<CircuitFriendlySparseTree> tree = BuildCircuitFriendlySparseTree(epoch, issuerPublicKeyHash, revokedHandleHashes);
        return tree.IsSuccess && tree.Value is not null
            ? Result<string>.Success(tree.Value.RootHash)
            : Result<string>.Failure(tree.Error);
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

    public static Result<AnonymousCredentialNonMembershipWitness> CreateCircuitFriendlyNonMembershipWitness(
        long epoch,
        string revocationRootHash,
        string issuerPublicKeyHash,
        string revocationHandleHash,
        IEnumerable<string> revokedHandleHashes)
    {
        string root = NormalizeHexToken(revocationRootHash, 128);
        string issuer = NormalizeHexToken(issuerPublicKeyHash, 128);
        string handle = NormalizeHexToken(revocationHandleHash, 128);
        Result<CircuitFriendlySparseTree> tree = BuildCircuitFriendlySparseTree(epoch, issuer, revokedHandleHashes);
        if (epoch <= 0 ||
            !IsHexHash(root, minLength: 32, maxLength: 128) ||
            !IsHexHash(issuer, minLength: 32, maxLength: 128) ||
            !IsHexHash(handle, minLength: 32, maxLength: 128) ||
            tree.IsFailure ||
            tree.Value is null)
        {
            return Result<AnonymousCredentialNonMembershipWitness>.Failure(ErrorCode.Validation, "anonymous_credential_witness_invalid");
        }

        if (!string.Equals(tree.Value.RootHash, root, StringComparison.OrdinalIgnoreCase))
        {
            return Result<AnonymousCredentialNonMembershipWitness>.Failure(ErrorCode.Validation, "anonymous_credential_revocation_root_mismatch");
        }

        if (tree.Value.RevokedHandles.Contains(handle, StringComparer.OrdinalIgnoreCase))
        {
            return Result<AnonymousCredentialNonMembershipWitness>.Failure(ErrorCode.Validation, "anonymous_credential_revoked");
        }

        BigInteger key = ResolveCircuitFriendlyLeafKey(handle);
        var siblings = new string[CircuitFriendlyTreeDepth];
        BigInteger cursor = key;
        string[] defaults = CircuitFriendlyDefaultSparseRoots.Value;
        for (int level = 0; level < CircuitFriendlyTreeDepth; level++)
        {
            Dictionary<BigInteger, string> nodes = tree.Value.Levels[level];
            BigInteger siblingIndex = cursor ^ BigInteger.One;
            siblings[level] = nodes.TryGetValue(siblingIndex, out string? sibling)
                ? sibling
                : defaults[level];
            cursor >>= 1;
        }

        (string previous, string next) = ResolveNeighbors(tree.Value.RevokedHandles, handle);
        string witnessHash = CircuitFriendlyHash(
            CircuitFriendlyWitnessDomain,
            epoch.ToString(CultureInfo.InvariantCulture),
            root,
            issuer,
            handle,
            FormatCircuitFriendlyLeafKey(key),
            ComputeSiblingDigest(siblings));
        return Result<AnonymousCredentialNonMembershipWitness>.Success(new AnonymousCredentialNonMembershipWitness(
            epoch,
            root,
            issuer,
            handle,
            previous,
            next,
            witnessHash,
            CircuitFriendlyNonMembershipAlgorithmId,
            CircuitFriendlyTreeDepth,
            siblings,
            FormatCircuitFriendlyLeafKey(key)));
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
            FixedHexEquals(expected.Value.PreviousRevocationHandleHash, NormalizeHexToken(witness.PreviousRevocationHandleHash, 128)) &&
            FixedHexEquals(expected.Value.NextRevocationHandleHash, NormalizeHexToken(witness.NextRevocationHandleHash, 128)) &&
            FixedHexEquals(expected.Value.WitnessHash, NormalizeHexToken(witness.WitnessHash, 128));
    }

    public static bool VerifyCircuitFriendlyNonMembershipWitness(
        AnonymousCredentialNonMembershipWitness witness,
        IEnumerable<string> revokedHandleHashes)
        => VerifyCircuitFriendlyNonMembershipWitness(witness, revokedHandleHashes, ResolveProfile(
            CircuitFriendlyNonMembershipAlgorithmId,
            productionZkReady: true));

    public static bool VerifyCircuitFriendlyNonMembershipWitness(
        AnonymousCredentialNonMembershipWitness witness,
        IEnumerable<string> revokedHandleHashes,
        AnonymousCredentialRevocationAccumulatorProfile profile)
    {
        if (!profile.IsProductionZkCompatible)
        {
            return false;
        }

        string root = NormalizeHexToken(witness.RevocationRootHash, 128);
        string issuer = NormalizeHexToken(witness.IssuerPublicKeyHash, 128);
        string handle = NormalizeHexToken(witness.RevocationHandleHash, 128);
        Result<string[]> normalizedHandles = NormalizeHandles(revokedHandleHashes);
        Result<string> expectedRoot = TryComputeCircuitFriendlyRoot(witness.Epoch, issuer, normalizedHandles.Value ?? []);
        if (normalizedHandles.IsFailure ||
            expectedRoot.IsFailure ||
            expectedRoot.Value is null ||
            normalizedHandles.Value is null ||
            normalizedHandles.Value.Contains(handle, StringComparer.OrdinalIgnoreCase) ||
            !FixedHexEquals(expectedRoot.Value, root))
        {
            return false;
        }

        return VerifyCircuitFriendlyNonMembershipWitness(witness, profile);
    }

    public static bool VerifyCircuitFriendlyNonMembershipWitness(AnonymousCredentialNonMembershipWitness witness)
        => VerifyCircuitFriendlyNonMembershipWitness(witness, ResolveProfile(
            CircuitFriendlyNonMembershipAlgorithmId,
            productionZkReady: true));

    public static bool VerifyCircuitFriendlyNonMembershipWitness(
        AnonymousCredentialNonMembershipWitness witness,
        AnonymousCredentialRevocationAccumulatorProfile profile)
    {
        if (!profile.IsProductionZkCompatible)
        {
            return false;
        }

        if (!TryNormalizeCircuitFriendlyWitness(
                witness,
                profile,
                out string root,
                out string issuer,
                out string handle,
                out BigInteger key,
                out string[] siblingHashes))
        {
            return false;
        }

        string computed = CircuitFriendlyDefaultSparseRoots.Value[0];
        BigInteger cursor = key;
        for (int level = 0; level < CircuitFriendlyTreeDepth; level++)
        {
            string sibling = siblingHashes[level];
            computed = cursor.IsEven
                ? CircuitFriendlyNodeHash(computed, sibling, level)
                : CircuitFriendlyNodeHash(sibling, computed, level);
            cursor >>= 1;
        }

        string witnessHash = CircuitFriendlyHash(
            CircuitFriendlyWitnessDomain,
            witness.Epoch.ToString(CultureInfo.InvariantCulture),
            root,
            issuer,
            handle,
            FormatCircuitFriendlyLeafKey(key),
            ComputeSiblingDigest(siblingHashes));
        return FixedHexEquals(computed, root) &&
            FixedHexEquals(witnessHash, NormalizeHexToken(witness.WitnessHash, 128));
    }

    private static bool FixedHexEquals(string expected, string actual)
    {
        string normalizedExpected = NormalizeHexToken(expected, 128);
        string normalizedActual = NormalizeHexToken(actual, 128);
        return normalizedExpected.Length == normalizedActual.Length &&
            CryptographicOperations.FixedTimeEquals(
                Encoding.ASCII.GetBytes(normalizedExpected),
                Encoding.ASCII.GetBytes(normalizedActual));
    }

    private static bool TryNormalizeCircuitFriendlyWitness(
        AnonymousCredentialNonMembershipWitness witness,
        AnonymousCredentialRevocationAccumulatorProfile profile,
        out string root,
        out string issuer,
        out string handle,
        out BigInteger key,
        out string[] siblingHashes)
    {
        root = NormalizeHexToken(witness.RevocationRootHash, 128);
        issuer = NormalizeHexToken(witness.IssuerPublicKeyHash, 128);
        handle = NormalizeHexToken(witness.RevocationHandleHash, 128);
        key = BigInteger.Zero;
        siblingHashes = [];

        if (witness.Epoch <= 0 ||
            !string.Equals(witness.AlgorithmId, CircuitFriendlyNonMembershipAlgorithmId, StringComparison.Ordinal) ||
            witness.PathDepth != profile.PathDepth ||
            witness.SiblingHashes is null ||
            witness.SiblingHashes.Count != profile.PathDepth ||
            !IsHexHash(root, minLength: 32, maxLength: 128) ||
            !IsHexHash(issuer, minLength: 32, maxLength: 128) ||
            !IsHexHash(handle, minLength: 32, maxLength: 128))
        {
            return false;
        }

        key = ResolveCircuitFriendlyLeafKey(handle);
        if (!string.Equals(witness.LeafKey, FormatCircuitFriendlyLeafKey(key), StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        siblingHashes = new string[CircuitFriendlyTreeDepth];
        for (int index = 0; index < siblingHashes.Length; index++)
        {
            string sibling = NormalizeHexToken(witness.SiblingHashes[index], 128);
            if (!IsHexHash(sibling, minLength: 32, maxLength: 128))
            {
                siblingHashes = [];
                return false;
            }

            siblingHashes[index] = sibling;
        }

        return true;
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

    private static Result<CircuitFriendlySparseTree> BuildCircuitFriendlySparseTree(
        long epoch,
        string issuerPublicKeyHash,
        IEnumerable<string> revokedHandleHashes)
    {
        string issuer = NormalizeHexToken(issuerPublicKeyHash, 128);
        Result<string[]> normalizedHandles = NormalizeHandles(revokedHandleHashes);
        if (epoch <= 0 ||
            !IsHexHash(issuer, minLength: 32, maxLength: 128) ||
            normalizedHandles.IsFailure ||
            normalizedHandles.Value is null)
        {
            return Result<CircuitFriendlySparseTree>.Failure(ErrorCode.Validation, "anonymous_credential_accumulator_invalid");
        }

        return GetOrBuildCircuitFriendlySparseTree(epoch, issuer, normalizedHandles.Value);
    }

    private static Result<CircuitFriendlySparseTree> GetOrBuildCircuitFriendlySparseTree(
        long epoch,
        string issuer,
        string[] normalizedHandles)
    {
        TryEvictCircuitFriendlyTreeCacheEpoch(epoch);
        var key = new CircuitFriendlyTreeCacheKey(epoch, issuer, ComputeCircuitFriendlyHandleSetHash(normalizedHandles));
        Lazy<Result<CircuitFriendlySparseTree>> lazy = CircuitFriendlyTreeCache.GetOrAdd(
            key,
            static (cacheKey, state) => new Lazy<Result<CircuitFriendlySparseTree>>(
                () => BuildCircuitFriendlySparseTreeCore(cacheKey.Epoch, cacheKey.IssuerPublicKeyHash, state),
                LazyThreadSafetyMode.ExecutionAndPublication),
            normalizedHandles);
        Result<CircuitFriendlySparseTree> result = lazy.Value;
        if (CircuitFriendlyTreeCache.Count > CircuitFriendlyRootCacheMaxEntries)
        {
            foreach (CircuitFriendlyTreeCacheKey candidate in CircuitFriendlyTreeCache.Keys)
            {
                if (CircuitFriendlyTreeCache.Count <= CircuitFriendlyRootCacheMaxEntries)
                {
                    break;
                }

                CircuitFriendlyTreeCache.TryRemove(candidate, out _);
            }
        }

        return result;
    }

    private static void TryEvictCircuitFriendlyTreeCacheEpoch(long epoch)
    {
        long current = Volatile.Read(ref CircuitFriendlyTreeCacheEpoch);
        if (current == epoch)
        {
            return;
        }

        long previous = Interlocked.CompareExchange(ref CircuitFriendlyTreeCacheEpoch, epoch, current);
        if (previous == current)
        {
            CircuitFriendlyTreeCache.Clear();
        }
    }

    internal static void ClearCircuitFriendlyRootCacheForTests()
    {
        CircuitFriendlyTreeCache.Clear();
        Volatile.Write(ref CircuitFriendlyTreeCacheEpoch, 0);
    }

    private static string ComputeCircuitFriendlyHandleSetHash(IReadOnlyList<string> normalizedHandles)
        => Sha256Hex(CircuitFriendlyHandleSetDomain, string.Join('\n', normalizedHandles));

    private static Result<CircuitFriendlySparseTree> BuildCircuitFriendlySparseTreeCore(
        long epoch,
        string issuer,
        string[] normalizedHandles)
    {
        var leaves = new Dictionary<BigInteger, string>();
        foreach (string handle in normalizedHandles)
        {
            BigInteger key = ResolveCircuitFriendlyLeafKey(handle);
            string leaf = CircuitFriendlyHash(
                CircuitFriendlyLeafDomain,
                epoch.ToString(CultureInfo.InvariantCulture),
                issuer,
                handle,
                FormatCircuitFriendlyLeafKey(key));
            if (leaves.TryGetValue(key, out string? existing) &&
                !string.Equals(existing, leaf, StringComparison.Ordinal))
            {
                return Result<CircuitFriendlySparseTree>.Failure(ErrorCode.Validation, "anonymous_credential_accumulator_key_collision");
            }

            leaves[key] = leaf;
        }

        string[] defaults = CircuitFriendlyDefaultSparseRoots.Value;
        var levels = new List<Dictionary<BigInteger, string>>(CircuitFriendlyTreeDepth + 1)
        {
            leaves
        };
        Dictionary<BigInteger, string> current = leaves;
        for (int level = 0; level < CircuitFriendlyTreeDepth; level++)
        {
            var next = new Dictionary<BigInteger, string>();
            foreach (BigInteger parent in current.Keys.Select(static key => key >> 1).Distinct())
            {
                BigInteger leftIndex = parent << 1;
                BigInteger rightIndex = leftIndex + BigInteger.One;
                string left = current.TryGetValue(leftIndex, out string? leftHash) ? leftHash : defaults[level];
                string right = current.TryGetValue(rightIndex, out string? rightHash) ? rightHash : defaults[level];
                next[parent] = CircuitFriendlyNodeHash(left, right, level);
            }

            current = next;
            levels.Add(current);
        }

        string root = current.TryGetValue(BigInteger.Zero, out string? rootHash)
            ? rootHash
            : defaults[CircuitFriendlyTreeDepth];
        return Result<CircuitFriendlySparseTree>.Success(new CircuitFriendlySparseTree(
            root,
            levels,
            normalizedHandles));
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
        string[] handles = sortedHandles as string[] ?? sortedHandles.ToArray();
        int index = Array.BinarySearch(handles, handle, StringComparer.OrdinalIgnoreCase);
        if (index < 0)
        {
            index = ~index;
            string previous = index > 0 ? handles[index - 1] : string.Empty;
            string next = index < handles.Length ? handles[index] : string.Empty;
            return (previous, next);
        }

        return (
            index > 0 ? handles[index - 1] : string.Empty,
            index + 1 < handles.Length ? handles[index + 1] : string.Empty);
    }

    private static BigInteger ResolveCircuitFriendlyLeafKey(string handle)
    {
        string normalized = NormalizeHexToken(handle, 128);
        string keyHex = normalized.Length >= 32 ? normalized[..32] : normalized.PadRight(32, '0');
        return FieldFromHex(keyHex);
    }

    private static string FormatCircuitFriendlyLeafKey(BigInteger key)
    {
        byte[] bytes = key.ToByteArray(isUnsigned: true, isBigEndian: true);
        Span<byte> buffer = stackalloc byte[16];
        int copyLength = Math.Min(bytes.Length, buffer.Length);
        bytes.AsSpan(bytes.Length - copyLength, copyLength).CopyTo(buffer[^copyLength..]);
        return Convert.ToHexStringLower(buffer);
    }

    private static string CircuitFriendlyNodeHash(string left, string right, int level)
        => CircuitFriendlyHash(
            CircuitFriendlyNodeDomain,
            level.ToString(CultureInfo.InvariantCulture),
            left,
            right);

    private static string ComputeSiblingDigest(IEnumerable<string> siblings)
    {
        BigInteger state = FieldFromToken(CircuitFriendlySiblingDigestDomain);
        int index = 0;
        foreach (string sibling in siblings)
        {
            state = CircuitFriendlyMiMCPermute(Mod(
                state +
                FieldFromToken(index.ToString(CultureInfo.InvariantCulture)) +
                FieldFromToken(NormalizeHexToken(sibling, 128))));
            index++;
        }

        return FormatField(state);
    }

    private static string[] BuildCircuitFriendlyDefaultSparseRoots()
    {
        var defaults = new string[CircuitFriendlyTreeDepth + 1];
        defaults[0] = CircuitFriendlyHash(CircuitFriendlyEmptyLeafDomain, "0");
        for (int level = 0; level < CircuitFriendlyTreeDepth; level++)
        {
            defaults[level + 1] = CircuitFriendlyNodeHash(defaults[level], defaults[level], level);
        }

        return defaults;
    }

    private static BigInteger[] BuildCircuitFriendlyMimcRoundConstants()
    {
        var constants = new BigInteger[CircuitFriendlyMimcRounds];
        constants[0] = BigInteger.Zero;
        for (int i = 1; i < constants.Length; i++)
        {
            constants[i] = HashToField($"{CircuitFriendlyMimcRoundDomain}:{i}");
        }

        return constants;
    }

    private static string CircuitFriendlyHash(params string[] parts)
    {
        BigInteger state = BigInteger.Zero;
        foreach (string part in parts)
        {
            state = CircuitFriendlyMiMCPermute(Mod(state + FieldFromToken(part)));
        }

        return FormatField(state);
    }

    private static BigInteger CircuitFriendlyMiMCPermute(BigInteger value)
    {
        BigInteger x = value;
        foreach (BigInteger roundConstant in CircuitFriendlyMimcRoundConstants.Value)
        {
            x = Pow7(Mod(x + roundConstant));
        }

        return Mod(x + value);
    }

    private static BigInteger Pow7(BigInteger value)
    {
        BigInteger x2 = Mod(value * value);
        BigInteger x4 = Mod(x2 * x2);
        return Mod(Mod(x4 * x2) * value);
    }

    private static BigInteger FieldFromToken(string? value)
    {
        string normalized = NormalizeToken(value, 4096);
        string hex = NormalizeHexToken(value, 4096);
        if (hex.Length > 0 &&
            hex.Length % 2 == 0 &&
            hex.All(static ch => Uri.IsHexDigit(ch)))
        {
            return FieldFromHex(hex);
        }

        return HashToField(normalized);
    }

    private static BigInteger FieldFromHex(string hex)
    {
        byte[] bytes = Convert.FromHexString(hex.Length % 2 == 0 ? hex : $"0{hex}");
        return Mod(new BigInteger(bytes, isUnsigned: true, isBigEndian: true));
    }

    private static BigInteger HashToField(string value)
        => Mod(new BigInteger(
            SHA256.HashData(Encoding.UTF8.GetBytes(value)),
            isUnsigned: true,
            isBigEndian: true));

    private static string FormatField(BigInteger value)
    {
        byte[] bytes = Mod(value).ToByteArray(isUnsigned: true, isBigEndian: true);
        Span<byte> buffer = stackalloc byte[32];
        int copyLength = Math.Min(bytes.Length, buffer.Length);
        bytes.AsSpan(bytes.Length - copyLength, copyLength).CopyTo(buffer[^copyLength..]);
        return Convert.ToHexStringLower(buffer);
    }

    private static BigInteger Mod(BigInteger value)
    {
        BigInteger result = value % CircuitFriendlyFieldPrime;
        return result.Sign < 0 ? result + CircuitFriendlyFieldPrime : result;
    }

    private static string NormalizeHexToken(string? value, int maxLength)
        => NormalizeToken(value, maxLength).ToLowerInvariant();

    private static string NormalizeToken(string? value, int maxLength)
    {
        string normalized = string.IsNullOrWhiteSpace(value) ? string.Empty : value.Trim();
        return normalized.Length <= maxLength ? normalized : normalized[..maxLength];
    }

    private static string ReadString(JsonElement parent, string propertyName)
        => parent.TryGetProperty(propertyName, out JsonElement value) &&
            value.ValueKind == JsonValueKind.String
            ? value.GetString() ?? string.Empty
            : string.Empty;

    private static bool ReadBoolean(JsonElement parent, string propertyName)
        => parent.TryGetProperty(propertyName, out JsonElement value) &&
            value.ValueKind == JsonValueKind.True;

    private static ushort ReadUInt16(JsonElement parent, string propertyName)
        => parent.TryGetProperty(propertyName, out JsonElement value) &&
            value.ValueKind == JsonValueKind.Number &&
            value.TryGetUInt16(out ushort result)
            ? result
            : (ushort)0;

    private static string Sha256Hex(params string[] parts)
        => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(string.Join('\0', parts))));

    private readonly record struct CircuitFriendlyTreeCacheKey(
        long Epoch,
        string IssuerPublicKeyHash,
        string HandleSetHash);

    private sealed record CircuitFriendlySparseTree(
        string RootHash,
        IReadOnlyList<Dictionary<BigInteger, string>> Levels,
        string[] RevokedHandles);
}
