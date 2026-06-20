using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Models.Moderation;
using SqlSugar;

namespace FsusBlog.Server.Services.Security;

public interface ICommentAnonymousDisplayNameGenerator
{
    CommentAnonymousDisplayName Generate(CommentAnonymousDisplayNameRequest request);
}

public readonly record struct CommentAnonymousDisplayNameRequest(
    string? DisplayLanguage,
    string Scope,
    string StableSeed);

public readonly record struct CommentAnonymousDisplayName(
    string DisplayName,
    string DisplayLanguage);

public sealed class CommentAnonymousDisplayNameGenerator : ICommentAnonymousDisplayNameGenerator
{
    private static readonly string[] ZhCnNames =
    [
        "小明",
        "小林",
        "小周",
        "小雨",
        "阿宁",
        "晓禾",
        "子安",
        "文清",
        "若溪",
        "晨曦",
        "安然",
        "亦辰"
    ];

    private static readonly string[] EnNames =
    [
        "Alex",
        "Jordan",
        "Taylor",
        "Casey",
        "Morgan",
        "Riley",
        "Jamie",
        "Avery",
        "Quinn",
        "Cameron",
        "Reese",
        "Parker"
    ];

    public CommentAnonymousDisplayName Generate(CommentAnonymousDisplayNameRequest request)
    {
        string language = NormalizeDisplayLanguage(request.DisplayLanguage, RegionCodes.Unknown);
        string seed = $"{language}|{request.Scope}|{request.StableSeed}";
        int index = StableIndex(seed, language == "zh-CN" ? ZhCnNames.Length : EnNames.Length);
        return language == "zh-CN"
            ? new CommentAnonymousDisplayName($"匿名用户{ZhCnNames[index]}", language)
            : new CommentAnonymousDisplayName($"Anonymous User {EnNames[index]}", language);
    }

    internal static string NormalizeDisplayLanguage(string? displayLanguage, string? submitRegion)
    {
        string value = (displayLanguage ?? string.Empty).Trim();
        if (value.Equals("zh-CN", StringComparison.OrdinalIgnoreCase) ||
            value.Equals("zh", StringComparison.OrdinalIgnoreCase))
        {
            return "zh-CN";
        }

        if (value.Equals("en", StringComparison.OrdinalIgnoreCase) ||
            value.StartsWith("en-", StringComparison.OrdinalIgnoreCase))
        {
            return "en";
        }

        string region = (submitRegion ?? string.Empty).Trim().ToUpperInvariant();
        return region is "CN" or "CHN" or "ZH-CN"
            ? "zh-CN"
            : "en";
    }

    private static int StableIndex(string seed, int modulo)
    {
        Span<byte> hash = stackalloc byte[32];
        SHA256.HashData(Encoding.UTF8.GetBytes(seed), hash);
        uint value = BitConverter.ToUInt32(hash[..4]);
        return (int)(value % modulo);
    }
}

public interface ICommentActorResolver
{
    Task<CommentActorResolveResult> ResolveAsync(
        CommentActorResolveRequest request,
        CancellationToken cancellationToken = default);
}

public sealed class CommentActorResolver(
    ISqlSugarClient db,
    IAnonymousCommentPolicyService policyService,
    ICommentAnonymousDisplayNameGenerator displayNameGenerator,
    IAnonymousCredentialService credentialService,
    IZkAnonymousProofService zkProofService) : ICommentActorResolver
{
    public async Task<CommentActorResolveResult> ResolveAsync(
        CommentActorResolveRequest request,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        CommentAuthorModeDecision decision = policyService.EvaluateAuthorMode(
            request.AuthorMode,
            request.PublicSendExplicitlySelected);
        if (!decision.Allowed)
        {
            return CommentActorResolveResult.Reject(decision.Status, decision.Message);
        }

        string language = CommentAnonymousDisplayNameGenerator.NormalizeDisplayLanguage(
            request.DisplayLanguage,
            request.SubmitRegion);

        if (string.Equals(decision.EffectiveAuthorMode, CommentAuthorModes.Public, StringComparison.Ordinal))
        {
            if (request.UserId is not > 0)
            {
                return CommentActorResolveResult.Reject("public_user_required", "Public comment mode requires an authenticated user");
            }

            string? publicHandle = await db.Queryable<User>()
                .Where(u => u.Id == request.UserId.Value)
                .Select(u => u.PublicHandle)
                .FirstAsync();
            if (string.IsNullOrWhiteSpace(publicHandle))
            {
                return CommentActorResolveResult.Reject("public_handle_required", "Public comment mode requires a saved public handle");
            }

            publicHandle = NormalizeToken(publicHandle, 64)!;
            return CommentActorResolveResult.Allow(new CommentActor(
                UserId: request.UserId,
                AuthorMode: CommentAuthorModes.Public,
                PublicHandle: publicHandle,
                AnonymousHandle: null,
                DisplayName: publicHandle,
                DisplayLanguage: language,
                AnonymousNullifierHash: null,
                AnonymousScope: null,
                ModerationSubjectHash: Sha256Hex($"public:user:{request.UserId.Value}"),
                CredentialLevel: AnonymousCredentialLevels.Basic,
                ReputationBucket: "account",
                AccountAgeBucket: "known"));
        }

        string scope = NormalizeScope(request.AnonymousScope, request.ArticleId);
        if (string.Equals(decision.EffectiveAuthorMode, CommentAuthorModes.ZkAnonymous, StringComparison.Ordinal))
        {
            if (!TryNormalizeZkPublicInputs(request, out ZkAnonymousPublicInputs publicInputs))
            {
                return CommentActorResolveResult.Reject(
                    ZkProofVerificationStatuses.MissingProof,
                    ZkProofVerificationResult.MissingProof().Message);
            }

            ZkProofVerificationResult proof = await zkProofService.VerifyCommentProofAsync(
                new ZkProofVerificationRequest(
                    ActionContext: "comment.create",
                    Scope: scope,
                    CircuitId: publicInputs.CircuitId,
                    VerifyingKeyHash: publicInputs.VerifyingKeyHash,
                    PublicInputLayoutVersion: publicInputs.PublicInputLayoutVersion,
                    CredentialEpoch: publicInputs.CredentialEpoch,
                    NullifierHash: publicInputs.NullifierHash,
                    CredentialCommitment: publicInputs.CredentialCommitment,
                    CredentialRoot: publicInputs.CredentialRoot,
                    CredentialLevel: AnonymousCredentialLevels.StrongAnonymous,
                    ReputationBucket: publicInputs.ReputationBucket ?? ResolveReputationBucket(AnonymousCredentialLevels.StrongAnonymous),
                    PolicyHash: AnonymousCommentPolicySnapshotHash.Resolve(zkProofService.CurrentCommentPolicy),
                    Proof: request.ZkProof ?? [],
                    RevocationRoot: publicInputs.RevocationRoot,
                    IssuerPublicKeyHash: publicInputs.IssuerPublicKeyHash),
                cancellationToken);
            if (!proof.Verified)
            {
                return CommentActorResolveResult.Reject(proof.Status, proof.Message);
            }

            return CommentActorResolveResult.Allow(BuildAnonymousActor(
                decision.EffectiveAuthorMode,
                scope,
                language,
                publicInputs.NullifierHash,
                AnonymousCredentialLevels.StrongAnonymous,
                publicInputs.ReputationBucket ?? ResolveReputationBucket(AnonymousCredentialLevels.StrongAnonymous),
                "credential_bound"));
        }

        string nullifierHash = DeriveEngineeringNullifierHash(
            decision.EffectiveAuthorMode,
            scope,
            request.UserId,
            request.ProofToken);
        string credentialLevel = await ResolveCredentialLevelAsync(request.UserId, cancellationToken);
        return CommentActorResolveResult.Allow(BuildAnonymousActor(
            decision.EffectiveAuthorMode,
            scope,
            language,
            nullifierHash,
            credentialLevel,
            ResolveReputationBucket(credentialLevel),
            request.UserId is > 0 ? "account_bound" : "unbound"));
    }

    private CommentActor BuildAnonymousActor(
        string authorMode,
        string scope,
        string language,
        string nullifierHash,
        string credentialLevel,
        string reputationBucket,
        string accountAgeBucket)
    {
        string moderationSubjectHash = Sha256Hex($"comment:moderation:{authorMode}:{scope}:{nullifierHash}");
        CommentAnonymousDisplayName display = displayNameGenerator.Generate(new CommentAnonymousDisplayNameRequest(
            language,
            scope,
            nullifierHash));

        return new CommentActor(
            UserId: null,
            AuthorMode: authorMode,
            PublicHandle: null,
            AnonymousHandle: $"anon-{nullifierHash[..12]}",
            DisplayName: display.DisplayName,
            DisplayLanguage: display.DisplayLanguage,
            AnonymousNullifierHash: nullifierHash,
            AnonymousScope: scope,
            ModerationSubjectHash: moderationSubjectHash,
            CredentialLevel: credentialLevel,
            ReputationBucket: reputationBucket,
            AccountAgeBucket: accountAgeBucket);
    }

    private async Task<string> ResolveCredentialLevelAsync(int? userId, CancellationToken cancellationToken)
    {
        if (userId is not > 0)
        {
            return AnonymousCredentialLevels.Basic;
        }

        string? level = await credentialService.GetCredentialLevelAsync(userId, null, cancellationToken);
        return NormalizeToken(level, 32) ?? AnonymousCredentialLevels.Basic;
    }

    private static string ResolveReputationBucket(string credentialLevel)
        => credentialLevel switch
        {
            AnonymousCredentialLevels.Trusted => "trusted",
            AnonymousCredentialLevels.StrongAnonymous => "strong_anonymous",
            _ => "basic"
        };

    private static string DeriveEngineeringNullifierHash(
        string authorMode,
        string scope,
        int? userId,
        string? proofToken)
    {
        string account = userId is > 0
            ? userId.Value.ToString(CultureInfo.InvariantCulture)
            : "none";
        string proof = NormalizeToken(proofToken, 256) ?? "none";
        return Sha256Hex($"comment:nullifier:{authorMode}|{scope}|account:{account}|proof:{proof}");
    }

    private static bool TryNormalizeZkPublicInputs(
        CommentActorResolveRequest request,
        out ZkAnonymousPublicInputs publicInputs)
    {
        publicInputs = default;
        string? nullifierHash = NormalizeHexHash(request.NullifierHash, minLength: 32, maxLength: 128);
        string? credentialCommitment = NormalizeHexHash(request.CredentialCommitment, minLength: 32, maxLength: 128);
        string? credentialRoot = NormalizeRequiredToken(request.CredentialRoot, 128);
        string? revocationRoot = NormalizeRequiredToken(request.RevocationRoot, 128);
        string? issuerPublicKeyHash = NormalizeHexHash(request.IssuerPublicKeyHash, minLength: 32, maxLength: 128);
        string? circuitId = NormalizeRequiredToken(request.CircuitId, 128);
        string? verifyingKeyHash = NormalizeRequiredToken(request.VerifyingKeyHash, 128);
        string? reputationBucket = NormalizeToken(request.ReputationBucket, 64);
        if (nullifierHash is null ||
            credentialCommitment is null ||
            credentialRoot is null ||
            revocationRoot is null ||
            issuerPublicKeyHash is null ||
            circuitId is null ||
            verifyingKeyHash is null ||
            request.CredentialEpoch <= 0 ||
            request.PublicInputLayoutVersion == 0 ||
            request.ZkProof is null ||
            request.ZkProof.Length == 0)
        {
            return false;
        }

        publicInputs = new ZkAnonymousPublicInputs(
            nullifierHash,
            credentialCommitment,
            credentialRoot,
            revocationRoot,
            issuerPublicKeyHash,
            request.CredentialEpoch,
            circuitId,
            verifyingKeyHash,
            request.PublicInputLayoutVersion,
            reputationBucket);
        return true;
    }

    private static string NormalizeScope(string? value, int articleId)
    {
        string normalized = NormalizeToken(value, 128) ?? $"article:{Math.Max(articleId, 0)}";
        return normalized.Replace(' ', '_');
    }

    private static string? NormalizeToken(string? value, int maxLength)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        string normalized = value.Trim();
        return normalized.Length <= maxLength ? normalized : normalized[..maxLength];
    }

    private static string? NormalizeHexHash(string? value, int minLength, int maxLength)
    {
        string? normalized = NormalizeRequiredToken(value, maxLength);
        if (normalized is null ||
            normalized.Length < minLength ||
            !IsHexHash(normalized.AsSpan()))
        {
            return null;
        }

        return normalized.ToLowerInvariant();
    }

    private static string? NormalizeRequiredToken(string? value, int maxLength)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        string normalized = value.Trim();
        return normalized.Length <= maxLength ? normalized : null;
    }

    private static bool IsHexHash(ReadOnlySpan<char> value)
    {
        foreach (char ch in value)
        {
            if (!Uri.IsHexDigit(ch))
            {
                return false;
            }
        }

        return true;
    }

    private static string Sha256Hex(string value)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();

    private readonly record struct ZkAnonymousPublicInputs(
        string NullifierHash,
        string CredentialCommitment,
        string CredentialRoot,
        string RevocationRoot,
        string IssuerPublicKeyHash,
        long CredentialEpoch,
        string CircuitId,
        string VerifyingKeyHash,
        ushort PublicInputLayoutVersion,
        string? ReputationBucket);
}
