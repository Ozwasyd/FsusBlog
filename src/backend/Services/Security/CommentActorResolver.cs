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
    IZkAnonymousProofService zkProofService,
    IConfiguration configuration) : ICommentActorResolver
{
    public async Task<CommentActorResolveResult> ResolveAsync(
        CommentActorResolveRequest request,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        CommentAuthorModeDecision decision = await policyService.EvaluateAuthorModeAsync(
            request.AuthorMode,
            request.PublicSendExplicitlySelected,
            cancellationToken);
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
            _ = zkProofService;
            return CommentActorResolveResult.Reject(
                "anonymous_ticket_required",
                "ZK anonymous comments must be submitted with a single-use anonymous comment ticket");
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
        string moderationSubjectHash = Convert.ToHexStringLower(
            AnonymousCommentTicketService.CreateModerationSubjectHash(nullifierHash, configuration));
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

        string? level = await credentialService.GetAccountCredentialLevelAsync(userId.Value, null, cancellationToken);
        return NormalizeToken(level, 32) ?? AnonymousCredentialLevels.Basic;
    }

    private static string ResolveReputationBucket(string credentialLevel)
        => credentialLevel switch
        {
            AnonymousCredentialLevels.Trusted => "trusted",
            AnonymousCredentialLevels.StrongAnonymous => "strong_anonymous",
            _ => "basic"
        };

    private string DeriveEngineeringNullifierHash(
        string authorMode,
        string scope,
        int? userId,
        string? proofToken)
    {
        _ = userId;
        _ = proofToken;
        byte[] key = ResolveNullifierPepper(configuration);
        byte[] material = Encoding.UTF8.GetBytes(string.Concat(
            "fsus.anonymous.nullifier.v2|",
            NormalizeToken(authorMode, 32) ?? CommentAuthorModes.Anonymous,
            "|",
            NormalizeRequiredToken(scope, 256) ?? "global"));
        return Convert.ToHexStringLower(HMACSHA256.HashData(key, material));
    }

    private static byte[] ResolveNullifierPepper(IConfiguration configuration)
    {
        string? value = configuration["AnonymousIdentity:NullifierPepper"];
        if (string.IsNullOrWhiteSpace(value) || value.Trim().Length < 32)
        {
            throw new InvalidOperationException("AnonymousIdentity:NullifierPepper must be configured with at least 32 characters.");
        }

        return SHA256.HashData(Encoding.UTF8.GetBytes(value.Trim()));
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

    private static string? NormalizeRequiredToken(string? value, int maxLength)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        string normalized = value.Trim();
        return normalized.Length <= maxLength ? normalized : null;
    }

    private static string Sha256Hex(string value)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();

}
