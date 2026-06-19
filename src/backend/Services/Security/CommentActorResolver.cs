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

            string? username = await db.Queryable<User>()
                .Where(u => u.Id == request.UserId.Value)
                .Select(u => u.Username)
                .FirstAsync();
            if (string.IsNullOrWhiteSpace(username))
            {
                return CommentActorResolveResult.Reject("public_user_missing", "Public comment user was not found");
            }

            string publicHandle = NormalizeToken(username, 64) ?? $"user-{request.UserId.Value}";
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
        string nullifierSeed = string.Join(
            '|',
            decision.EffectiveAuthorMode,
            scope,
            request.UserId is > 0 ? $"account:{request.UserId.Value}" : "account:none",
            string.IsNullOrWhiteSpace(request.ProofToken) ? "proof:none" : $"proof:{request.ProofToken.Trim()}");
        string nullifierHash = Sha256Hex($"comment:nullifier:{nullifierSeed}");

        if (string.Equals(decision.EffectiveAuthorMode, CommentAuthorModes.ZkAnonymous, StringComparison.Ordinal))
        {
            ZkProofVerificationResult proof = await zkProofService.VerifyCommentProofAsync(
                new ZkProofVerificationRequest(
                    ActionContext: "comment.create",
                    Scope: scope,
                    CircuitId: string.Empty,
                    VerifyingKeyHash: string.Empty,
                    PublicInputLayoutVersion: 0,
                    CredentialEpoch: 0,
                    NullifierHash: nullifierHash,
                    CredentialCommitment: string.Empty,
                    CredentialRoot: string.Empty,
                    ReputationBucket: AnonymousCredentialLevels.StrongAnonymous,
                    Proof: request.ZkProof ?? []),
                cancellationToken);
            if (!proof.Verified)
            {
                return CommentActorResolveResult.Reject(proof.Status, proof.Message);
            }
        }

        string credentialLevel = await ResolveCredentialLevelAsync(request.UserId, cancellationToken);
        string moderationSubjectHash = Sha256Hex($"comment:moderation:{decision.EffectiveAuthorMode}:{scope}:{nullifierHash}");
        CommentAnonymousDisplayName display = displayNameGenerator.Generate(new CommentAnonymousDisplayNameRequest(
            language,
            scope,
            nullifierHash));

        return CommentActorResolveResult.Allow(new CommentActor(
            UserId: null,
            AuthorMode: decision.EffectiveAuthorMode,
            PublicHandle: null,
            AnonymousHandle: $"anon-{nullifierHash[..12]}",
            DisplayName: display.DisplayName,
            DisplayLanguage: display.DisplayLanguage,
            AnonymousNullifierHash: nullifierHash,
            AnonymousScope: scope,
            ModerationSubjectHash: moderationSubjectHash,
            CredentialLevel: credentialLevel,
            ReputationBucket: ResolveReputationBucket(credentialLevel),
            AccountAgeBucket: request.UserId is > 0 ? "account_bound" : "unbound"));
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

    private static string Sha256Hex(string value)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
}
