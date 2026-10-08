using System.Collections.Concurrent;
using System.Globalization;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Models.Moderation;
using FsusBlog.Server.Modules.Endpoints;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.Validation;

using Microsoft.AspNetCore.DataProtection;

using SqlSugar;

namespace FsusBlog.Server.Services.Fixtures;

public sealed record CommentFixtureZkAuthorityEvidence(
    string Schema,
    string AuthorityClass,
    string Backend,
    bool Simulation,
    bool ProductionUsable,
    string SemanticRole,
    string OperationPlanDigest,
    string PublicInputsDigest,
    string RootDigest,
    bool TicketStoredInProductionOneTimeStore,
    bool TicketExposed);

public sealed record CommentAnonymousFixtureCreateRequest(
    string Owner,
    string TestSession,
    string PlanDigest,
    string SemanticRole,
    int ArticleId,
    string Content,
    string? ParentId,
    string? RootId,
    string? ReplyToCommentId,
    string Scope,
    string DisplayLanguage,
    RegionModerationDecision? RegionDecision);

public sealed record CommentAnonymousFixtureCreateResult(
    CommentCreateResult Comment,
    CommentFixtureZkAuthorityEvidence AuthorityEvidence);

public interface ICommentAnonymousFixtureProvider
{
    Task<CommentAnonymousFixtureCreateResult> CreateAsync(
        CommentAnonymousFixtureCreateRequest request,
        CancellationToken cancellationToken = default);
}

public interface ICommentAnonymousFixtureCapabilityVault
{
    void Store(string owner, string testSession, long commentId, string managementSecret);
    bool TryGet(string owner, string testSession, long commentId, out string managementSecret);
    void Remove(string owner, string testSession, long commentId);
}

public sealed record CommentAnonymousFixtureOperationReference(
    string OperationPlanDigest,
    string Owner,
    string TestSession,
    string PlanDigest,
    string SemanticRole,
    int ArticleId,
    string ContentDigest,
    string? ParentId,
    string? RootId,
    string? ReplyToCommentId,
    string Scope,
    string DisplayLanguage,
    long CommentId,
    string ManagementSecret,
    CommentCreateResult Comment,
    CommentFixtureZkAuthorityEvidence AuthorityEvidence);

public interface ICommentAnonymousFixtureOperationLedger
{
    Task<CommentAnonymousFixtureOperationReference?> ReadAsync(string operationPlanDigest, CancellationToken cancellationToken);
    Task StoreAsync(CommentAnonymousFixtureOperationReference reference, CancellationToken cancellationToken);
    Task RemoveAsync(string operationPlanDigest, CancellationToken cancellationToken);
}

/// <summary>
/// Development-only durable idempotency reference. Private management capability
/// material is protected by the application's persisted data-protection ring.
/// </summary>
public sealed class CommentAnonymousFixtureOperationLedger(
    IConfiguration configuration,
    IDataProtectionProvider dataProtectionProvider) : ICommentAnonymousFixtureOperationLedger
{
    private const string Schema = "fsusblog.comment-anonymous-fixture-operation.v2";
    private static readonly SemaphoreSlim s_gate = new(1, 1);
    private static readonly JsonSerializerOptions s_json = new()
    {
        PropertyNameCaseInsensitive = true,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
    };
    private readonly IDataProtector _protector = dataProtectionProvider.CreateProtector(
        "FsusBlog.CommentAnonymousFixtureOperationLedger.v2");
    private readonly string _root = Path.Combine(
        Path.GetFullPath(configuration["FSUSBLOG_DATA_ROOT"] ?? Path.Combine(AppContext.BaseDirectory, "data")),
        "test-fixtures",
        "comment-anonymous-operations");

    public async Task<CommentAnonymousFixtureOperationReference?> ReadAsync(
        string operationPlanDigest,
        CancellationToken cancellationToken)
    {
        string path = ResolvePath(operationPlanDigest);
        await s_gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            return File.Exists(path) ? ReadCore(path, operationPlanDigest) : null;
        }
        finally
        {
            s_gate.Release();
        }
    }

    public async Task StoreAsync(
        CommentAnonymousFixtureOperationReference reference,
        CancellationToken cancellationToken)
    {
        string path = ResolvePath(reference.OperationPlanDigest);
        await s_gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            Directory.CreateDirectory(_root);
            if (!OperatingSystem.IsWindows())
                File.SetUnixFileMode(_root, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            if (File.Exists(path))
            {
                CommentAnonymousFixtureOperationReference existing = ReadCore(path, reference.OperationPlanDigest);
                if (existing != reference)
                    throw new InvalidOperationException("Anonymous fixture operation ledger contains a conflicting reference.");
                return;
            }
            var stored = new StoredReference(
                Schema,
                reference.OperationPlanDigest,
                reference.Owner,
                reference.TestSession,
                reference.PlanDigest,
                reference.SemanticRole,
                reference.ArticleId,
                reference.ContentDigest,
                reference.ParentId,
                reference.RootId,
                reference.ReplyToCommentId,
                reference.Scope,
                reference.DisplayLanguage,
                reference.CommentId,
                _protector.Protect(reference.ManagementSecret),
                reference.Comment with
                {
                    ManagementSecret = null
                },
                reference.AuthorityEvidence,
                string.Empty);
            stored = stored with
            {
                RecordDigest = StoredDigest(stored)
            };
            string temporaryPath = $"{path}.{Guid.NewGuid():N}.tmp";
            try
            {
                await File.WriteAllTextAsync(
                    temporaryPath,
                    JsonSerializer.Serialize(stored, s_json),
                    new UTF8Encoding(false),
                    cancellationToken).ConfigureAwait(false);
                if (!OperatingSystem.IsWindows())
                    File.SetUnixFileMode(temporaryPath, UnixFileMode.UserRead | UnixFileMode.UserWrite);
                File.Move(temporaryPath, path, overwrite: false);
            }
            finally
            {
                File.Delete(temporaryPath);
            }
        }
        finally
        {
            s_gate.Release();
        }
    }

    public async Task RemoveAsync(string operationPlanDigest, CancellationToken cancellationToken)
    {
        string path = ResolvePath(operationPlanDigest);
        await s_gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            File.Delete(path);
        }
        finally
        {
            s_gate.Release();
        }
    }

    private CommentAnonymousFixtureOperationReference ReadCore(string path, string operationPlanDigest)
    {
        if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
            throw new InvalidOperationException("Anonymous fixture operation ledger rejects symbolic links.");
        StoredReference stored = JsonSerializer.Deserialize<StoredReference>(File.ReadAllText(path), s_json)
            ?? throw new InvalidOperationException("Anonymous fixture operation ledger entry is missing.");
        if (stored.Schema != Schema || stored.OperationPlanDigest != operationPlanDigest
            || stored.RecordDigest != StoredDigest(stored)
            || stored.CommentId <= 0 || stored.ArticleId <= 0
            || string.IsNullOrWhiteSpace(stored.Owner)
            || !HttpTestSessionKeyScope.IsValidSessionId(stored.TestSession)
            || !IsCanonicalDigest(stored.PlanDigest)
            || string.IsNullOrWhiteSpace(stored.ProtectedManagementSecret))
            throw new InvalidOperationException("Anonymous fixture operation ledger entry is invalid.");
        return new CommentAnonymousFixtureOperationReference(
            stored.OperationPlanDigest,
            stored.Owner,
            stored.TestSession,
            stored.PlanDigest,
            stored.SemanticRole,
            stored.ArticleId,
            stored.ContentDigest,
            stored.ParentId,
            stored.RootId,
            stored.ReplyToCommentId,
            stored.Scope,
            stored.DisplayLanguage,
            stored.CommentId,
            _protector.Unprotect(stored.ProtectedManagementSecret),
            stored.Comment,
            stored.AuthorityEvidence);
    }

    private string ResolvePath(string operationPlanDigest)
    {
        if (operationPlanDigest.Length != 64
            || operationPlanDigest.AsSpan().IndexOfAnyExcept("0123456789abcdef") >= 0)
            throw new InvalidOperationException("Anonymous fixture operation digest is invalid.");
        return Path.Combine(_root, $"{operationPlanDigest}.json");
    }

    private static string StoredDigest(StoredReference stored)
        => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(
            JsonSerializer.Serialize(stored with
            {
                RecordDigest = string.Empty
            }, s_json))));

    private static bool IsCanonicalDigest(string? value)
        => value is not null
            && value.StartsWith("sha256:", StringComparison.Ordinal)
            && value.Length == 71
            && value.AsSpan(7).IndexOfAnyExcept("0123456789abcdef") < 0;

    private sealed record StoredReference(
        string Schema,
        string OperationPlanDigest,
        string Owner,
        string TestSession,
        string PlanDigest,
        string SemanticRole,
        int ArticleId,
        string ContentDigest,
        string? ParentId,
        string? RootId,
        string? ReplyToCommentId,
        string Scope,
        string DisplayLanguage,
        long CommentId,
        string ProtectedManagementSecret,
        CommentCreateResult Comment,
        CommentFixtureZkAuthorityEvidence AuthorityEvidence,
        string RecordDigest);
}

/// <summary>
/// Process-local test capability custody. A process exit intentionally destroys
/// the only anonymous cleanup authority; the outer isolated namespace remains
/// the recovery boundary and this store must never be described as durable.
/// </summary>
public sealed class CommentAnonymousFixtureCapabilityVault : ICommentAnonymousFixtureCapabilityVault
{
    private readonly ConcurrentDictionary<VaultKey, string> _secrets = new();

    public void Store(string owner, string testSession, long commentId, string managementSecret)
    {
        if (string.IsNullOrWhiteSpace(owner)
            || !HttpTestSessionKeyScope.IsValidSessionId(testSession)
            || commentId <= 0
            || string.IsNullOrWhiteSpace(managementSecret)
            || !_secrets.TryAdd(new VaultKey(owner, testSession, commentId), managementSecret))
            throw new InvalidOperationException("Anonymous fixture capability custody failed closed.");
    }

    public bool TryGet(string owner, string testSession, long commentId, out string managementSecret)
        => _secrets.TryGetValue(new VaultKey(owner, testSession, commentId), out managementSecret!);

    public void Remove(string owner, string testSession, long commentId)
        => _secrets.TryRemove(new VaultKey(owner, testSession, commentId), out _);

    private readonly record struct VaultKey(string Owner, string TestSession, long CommentId);
}

/// <summary>
/// Development-only composition for the external ZK root/proof authority. The
/// ticket, nullifier, comment command, moderation, outbox, cache and invalidation
/// paths remain the scoped production implementations.
/// </summary>
public sealed class CommentAnonymousFixtureProvider(
    IWebHostEnvironment environment,
    IHttpContextAccessor httpContextAccessor,
    ITestSessionContext testSessionContext,
    IConfiguration configuration,
    ISqlSugarClient db,
    ILoggerFactory loggerFactory,
    ICommentNotificationService notifications,
    ICommentModerationService moderation,
    IAnonymousCommentPolicyService policy,
    ICommentAnonymousNullifierService nullifiers,
    ICacheRawWriter cacheWriter,
    ICacheOneTimeStore oneTimeStore,
    ICacheRawReader cacheReader,
    ICommentAnonymousDisplayNameGenerator displayNames,
    ICacheInvalidationDispatcher invalidations,
    ICommentMutationOutbox outbox,
    IArticleCommentPolicyService articlePolicy,
    ICommentAnonymousFixtureCapabilityVault capabilities,
    ICommentAnonymousFixtureOperationLedger operationLedger,
    ICommentManagementCapabilityService managementCapabilities,
    ICommentAuthorManagementService authorManagement,
    TimeProvider? timeProvider = null) : ICommentAnonymousFixtureProvider
{
    private const long CredentialEpoch = 1;
    private const uint CircuitNumericId = 1;
    private const string EvidenceSchema = "fsusblog.comment-fixture-zk-authority-evidence.v1";
    private const string AuthorityClass = "local-dev-simulation";
    private static readonly ConcurrentDictionary<string, SemaphoreSlim> s_operationGates = new(StringComparer.Ordinal);

    public async Task<CommentAnonymousFixtureCreateResult> CreateAsync(
        CommentAnonymousFixtureCreateRequest request,
        CancellationToken cancellationToken = default)
    {
        RequireActivation(request);
        AnonymousCommentPolicySnapshot policySnapshot = await policy.GetCurrentAsync(cancellationToken).ConfigureAwait(false);
        if (!policySnapshot.AnonymousCommentsEnabled || !policySnapshot.ZkAnonymousEnabled)
            throw new InvalidOperationException("Current production comment policy does not enable ZK anonymous comments.");
        string policyHash = AnonymousCommentPolicySnapshotHash.Resolve(policySnapshot);
        string operationPlanDigest = ComputeOperationPlanDigest(request, policyHash);
        SemaphoreSlim operationGate = s_operationGates.GetOrAdd(operationPlanDigest, static _ => new SemaphoreSlim(1, 1));
        await operationGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            return await CreateCoreAsync(request, policySnapshot, policyHash, operationPlanDigest, cancellationToken)
                .ConfigureAwait(false);
        }
        finally
        {
            operationGate.Release();
        }
    }

    private async Task<CommentAnonymousFixtureCreateResult> CreateCoreAsync(
        CommentAnonymousFixtureCreateRequest request,
        AnonymousCommentPolicySnapshot policySnapshot,
        string policyHash,
        string operationPlanDigest,
        CancellationToken cancellationToken)
    {
        CommentAnonymousFixtureOperationReference? existing = await operationLedger.ReadAsync(
            operationPlanDigest,
            cancellationToken).ConfigureAwait(false);
        if (existing is not null)
            return await ReplayExistingAsync(request, operationPlanDigest, existing, cancellationToken).ConfigureAwait(false);

        DateTimeOffset now = DateTimeOffset.UtcNow;
        byte[] credentialRoot = DeriveBytes("credential-root", request.TestSession);
        byte[] revocationRoot = DeriveBytes("revocation-root", request.TestSession);
        byte[] nullifier = DeriveBytes("nullifier", request.Owner, request.SemanticRole, request.Scope);
        string verifyingKeyHash = Digest("verifying-key", request.TestSession);
        string issuerPublicKeyHash = Digest("issuer-public-key", request.TestSession);
        var rootSnapshot = new AnonymousCredentialRootSnapshotCoreModel(
            CredentialEpoch,
            now.AddMinutes(10).ToUnixTimeMilliseconds(),
            now.AddMinutes(20).ToUnixTimeMilliseconds(),
            CircuitNumericId,
            AnonymousPrivacyContract.PublicInputLayoutVersion,
            true,
            true,
            AnonymousPrivacyContract.CircuitId,
            verifyingKeyHash,
            issuerPublicKeyHash,
            credentialRoot,
            revocationRoot,
            Encoding.UTF8.GetBytes("{\"anonymity_sets\":[{\"is_eligible\":true,\"may_comment\":true,\"rate_class\":\"common\",\"requires_moderation\":false,\"size\":20}]}"));
        var rootReader = new FixtureRootReader(rootSnapshot, now);
        IConfiguration localConfiguration = BuildSimulationConfiguration(configuration, verifyingKeyHash);
        using var verifier = new ProductionZkProofVerifier(
            localConfiguration,
            rootReader,
            new LocalDevZkProofBackend(localConfiguration),
            loggerFactory.CreateLogger<ProductionZkProofVerifier>());
        var proofService = new CommentFixtureZkSimulationProofService(
            new ZkAnonymousProofService(localConfiguration, verifier));
        var rootService = new FixtureRootService(rootSnapshot);
        var tickets = new AnonymousCommentTicketService(
            cacheWriter,
            oneTimeStore,
            rootService,
            proofService,
            nullifiers,
            policy,
            localConfiguration,
            TimeProvider.System,
            cacheReader,
            articlePolicy);
        var attribution = new CommentAttributionPrivacyService(
            loggerFactory.CreateLogger<CommentAttributionPrivacyService>(),
            policy: policy,
            nullifiers: nullifiers,
            tickets: tickets,
            displayNames: displayNames,
            configuration: localConfiguration,
            zkProofs: proofService);
        var commands = new CommentCommandService(
            db,
            loggerFactory.CreateLogger<CommentCommandService>(),
            notifications,
            moderation,
            attribution,
            invalidations,
            localConfiguration,
            outbox,
            articlePolicy,
            timeProvider);

        var proofRequest = new ProductionZkProofBackendRequest(
            AnonymousPrivacyContract.CommentCreateActionContext,
            request.Scope,
            AnonymousPrivacyContract.CircuitId,
            verifyingKeyHash,
            AnonymousPrivacyContract.PublicInputLayoutVersion,
            Convert.ToHexStringLower(nullifier),
            Convert.ToHexStringLower(credentialRoot),
            policyHash,
            true,
            true,
            AnonymousPrivacyContract.CommonRateClass,
            false,
            ReadOnlyMemory<byte>.Empty,
            Convert.ToHexStringLower(revocationRoot),
            issuerPublicKeyHash);
        byte[] publicInputs = NativeGroth16PublicInputCodec.Encode(proofRequest).ToArray();
        byte[] proof = DeriveBytes("proof", Convert.ToHexStringLower(publicInputs));
        var ticketRequest = new AnonymousCommentTicketRequestCoreModel(
            request.ArticleId,
            request.ParentId,
            request.RootId,
            request.ReplyToCommentId,
            CircuitNumericId,
            AnonymousPrivacyContract.PublicInputLayoutVersion,
            AnonymousPrivacyContract.CommentCreateActionContext,
            request.Scope,
            AnonymousPrivacyContract.CircuitId,
            verifyingKeyHash,
            nullifier,
            credentialRoot,
            revocationRoot,
            true,
            true,
            AnonymousPrivacyContract.CommonRateClass,
            false,
            proof,
            publicInputs);
        AnonymousCommentTicketIssueResult issued = await tickets.IssueAsync(ticketRequest, cancellationToken).ConfigureAwait(false);
        if (!issued.Issued)
            throw new InvalidOperationException($"Local ZK authority could not issue a production ticket: {issued.Status}.");

        CommentCreateResult created;
        try
        {
            created = await commands.CreateStrongAnonymousCommentResultAsync(
                new AnonymousCommentCreateRequestCoreModel(
                    request.ArticleId,
                    request.Content,
                    request.ParentId,
                    request.RootId,
                    request.ReplyToCommentId,
                    request.Scope,
                    request.DisplayLanguage,
                    issued.Response.Ticket),
                request.RegionDecision,
                cancellationToken).ConfigureAwait(false);
        }
        catch
        {
            await tickets.ConsumeTicketAsync(issued.Response.Ticket, CancellationToken.None).ConfigureAwait(false);
            throw;
        }

        if (!created.Created || created.CommentId <= 0 || string.IsNullOrWhiteSpace(created.ManagementSecret))
        {
            await tickets.ConsumeTicketAsync(issued.Response.Ticket, CancellationToken.None).ConfigureAwait(false);
            throw new InvalidOperationException($"Production anonymous comment command failed: {created.FailureCode ?? "unknown"}.");
        }
        var evidence = new CommentFixtureZkAuthorityEvidence(
            EvidenceSchema,
            AuthorityClass,
            LocalDevZkProofBackend.BackendName,
            true,
            false,
            request.SemanticRole,
            operationPlanDigest,
            Convert.ToHexStringLower(SHA256.HashData(publicInputs)),
            Convert.ToHexStringLower(SHA256.HashData(credentialRoot)),
            true,
            false);
        var reference = new CommentAnonymousFixtureOperationReference(
            operationPlanDigest,
            request.Owner,
            request.TestSession,
            request.PlanDigest,
            request.SemanticRole,
            request.ArticleId,
            Digest("content", request.Content),
            request.ParentId,
            request.RootId,
            request.ReplyToCommentId,
            request.Scope,
            request.DisplayLanguage,
            created.CommentId,
            created.ManagementSecret,
            created with
            {
                ManagementSecret = null
            },
            evidence);
        await StoreOperationOrCompensateAsync(
            operationLedger,
            capabilities,
            managementCapabilities,
            authorManagement,
            reference).ConfigureAwait(false);
        return new CommentAnonymousFixtureCreateResult(
            created with
            {
                ManagementSecret = null
            },
            evidence);
    }

    private void RequireActivation(CommentAnonymousFixtureCreateRequest request)
    {
        HttpContext? context = httpContextAccessor.HttpContext;
        if (!IsActivationAllowed(environment, configuration, context, testSessionContext, request))
            throw new InvalidOperationException("Local anonymous fixture activation failed closed.");
    }

    internal static bool IsActivationAllowed(
        IWebHostEnvironment environment,
        IConfiguration configuration,
        HttpContext? context,
        ITestSessionContext testSessionContext,
        CommentAnonymousFixtureCreateRequest request)
    {
        string expectedSecret = LocalCommentFixtureEndpoints.ResolveSecret(configuration);
        string providedSecret = context?.Request.Headers[LocalCommentFixtureEndpoints.SecretHeaderName].ToString() ?? string.Empty;
        return LocalCommentFixtureEndpoints.IsEnabled(configuration, environment)
            && context is not null
            && context.Connection.RemoteIpAddress is { } remote
            && IPAddress.IsLoopback(remote)
            && !string.IsNullOrWhiteSpace(expectedSecret)
            && !string.IsNullOrWhiteSpace(providedSecret)
            && FixedTimeEquals(expectedSecret.Trim(), providedSecret.Trim())
            && HttpTestSessionKeyScope.IsValidSessionId(request.TestSession)
            && IsCanonicalDigest(request.PlanDigest)
            && testSessionContext.IsActive
            && StringComparer.Ordinal.Equals(testSessionContext.SessionId, request.TestSession)
            && StringComparer.Ordinal.Equals(
                context.Request.Headers[HttpTestSessionKeyScope.HeaderName].ToString(),
                request.TestSession);
    }

    internal static IConfiguration BuildSimulationConfiguration(
        IConfiguration baseline,
        string verifyingKeyHash)
        => new ConfigurationBuilder()
            .AddConfiguration(baseline)
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["ASPNETCORE_ENVIRONMENT"] = Environments.Development,
                ["AnonymousIdentity:ZkVerifier:Enabled"] = "true",
                ["AnonymousIdentity:ZkVerifier:CircuitId"] = AnonymousPrivacyContract.CircuitId,
                ["AnonymousIdentity:ZkVerifier:VerifyingKeyHash"] = verifyingKeyHash,
                ["AnonymousIdentity:ZkVerifier:PublicInputLayoutVersion"] = AnonymousPrivacyContract.PublicInputLayoutVersion.ToString(),
                ["AnonymousIdentity:ZkVerifier:MaxProofBytes"] = AnonymousPrivacyContract.MaxGroth16ProofBytes.ToString(),
                ["AnonymousIdentity:ZkVerifier:Backend"] = LocalDevZkProofBackend.BackendName,
                ["AnonymousIdentity:ZkVerifier:LocalDevFixture:Enabled"] = "true"
            })
            .Build();

    internal static string ComputeOperationPlanDigest(
        CommentAnonymousFixtureCreateRequest request,
        string policyHash)
    {
        RegionModerationDecision? region = request.RegionDecision;
        string canonical = JsonSerializer.Serialize(new
        {
            Schema = "fsusblog.comment-fixture-zk-operation-plan.v1",
            request.Owner,
            request.TestSession,
            request.PlanDigest,
            request.SemanticRole,
            ArticleId = request.ArticleId.ToString(CultureInfo.InvariantCulture),
            ContentDigest = Digest("content", request.Content),
            request.ParentId,
            request.RootId,
            request.ReplyToCommentId,
            request.Scope,
            request.DisplayLanguage,
            PolicyHash = policyHash,
            Region = region is null
                ? null
                : new
                {
                    region.CanPublish,
                    region.SubmitRegion,
                    SubmitRegionConfidence = region.SubmitRegionConfidence.ToString("R", CultureInfo.InvariantCulture),
                    region.RegionProvider,
                    region.SubmitIpHash,
                    BlockedRegions = region.BlockedRegions.Order(StringComparer.Ordinal).ToArray(),
                    RiskLabels = region.RiskLabels.Order(StringComparer.Ordinal).ToArray(),
                    RuleHits = region.RuleHits
                        .OrderBy(item => item.RuleId, StringComparer.Ordinal)
                        .ThenBy(item => item.Region, StringComparer.Ordinal)
                        .Select(item => new
                        {
                            item.RuleId,
                            item.Region,
                            item.Category,
                            item.Severity,
                            item.SubmitAction,
                            item.DisplayAction,
                            item.PublicReason,
                            item.InternalReason
                        })
                        .ToArray(),
                    region.PolicyVersion,
                    region.DecisionReason,
                    region.PublicReason,
                    region.RequiresManualReview,
                    region.HideUntilReviewed
                }
        });
        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(canonical)));
    }

    private async Task<CommentAnonymousFixtureCreateResult> ReplayExistingAsync(
        CommentAnonymousFixtureCreateRequest request,
        string operationPlanDigest,
        CommentAnonymousFixtureOperationReference existing,
        CancellationToken cancellationToken)
    {
        Comment? row = await db.Queryable<Comment>()
            .Where(item => item.Id == existing.CommentId)
            .FirstAsync(cancellationToken).ConfigureAwait(false);
        string? parentId = row?.ParentId?.ToString(CultureInfo.InvariantCulture);
        string? rootId = row?.RootId?.ToString(CultureInfo.InvariantCulture);
        string? replyToCommentId = row?.ReplyToCommentId?.ToString(CultureInfo.InvariantCulture);
        if (row is null || row.IsDeleted
            || existing.OperationPlanDigest != operationPlanDigest
            || existing.Owner != request.Owner
            || existing.TestSession != request.TestSession
            || existing.PlanDigest != request.PlanDigest
            || existing.SemanticRole != request.SemanticRole
            || existing.ArticleId != request.ArticleId
            || existing.ContentDigest != Digest("content", request.Content)
            || existing.ParentId != request.ParentId
            || existing.RootId != request.RootId
            || existing.ReplyToCommentId != request.ReplyToCommentId
            || existing.Scope != request.Scope
            || existing.DisplayLanguage != request.DisplayLanguage
            || row.ArticleId != request.ArticleId
            || row.AuthorMode != CommentAuthorModes.ZkAnonymous
            || row.Content != request.Content
            || parentId != request.ParentId
            || rootId != request.RootId
            || replyToCommentId != request.ReplyToCommentId
            || row.AnonymousScope != request.Scope
            || row.AnonymousDisplayLanguage != request.DisplayLanguage)
            throw new InvalidOperationException("Anonymous fixture operation ledger reference is stale or cross-plan.");

        if (capabilities.TryGet(request.Owner, request.TestSession, row.Id, out string currentSecret))
        {
            if (!FixedTimeEquals(existing.ManagementSecret, currentSecret))
                throw new InvalidOperationException("Anonymous fixture capability custody conflicts with its durable operation reference.");
        }
        else
        {
            capabilities.Store(request.Owner, request.TestSession, row.Id, existing.ManagementSecret);
        }
        return new CommentAnonymousFixtureCreateResult(
            existing.Comment with
            {
                IdempotencyReplay = true,
                ManagementSecret = null
            },
            existing.AuthorityEvidence);
    }

    internal static async Task StoreOperationOrCompensateAsync(
        ICommentAnonymousFixtureOperationLedger operationLedger,
        ICommentAnonymousFixtureCapabilityVault capabilities,
        ICommentManagementCapabilityService managementCapabilities,
        ICommentAuthorManagementService authorManagement,
        CommentAnonymousFixtureOperationReference reference)
    {
        try
        {
            await operationLedger.StoreAsync(reference, CancellationToken.None).ConfigureAwait(false);
            capabilities.Store(
                reference.Owner,
                reference.TestSession,
                reference.CommentId,
                reference.ManagementSecret);
            return;
        }
        catch (Exception custodyError)
        {
            var recoveryErrors = new List<Exception>();
            try
            {
                await operationLedger.RemoveAsync(reference.OperationPlanDigest, CancellationToken.None).ConfigureAwait(false);
            }
            catch (Exception error)
            {
                recoveryErrors.Add(error);
            }
            capabilities.Remove(reference.Owner, reference.TestSession, reference.CommentId);
            try
            {
                await CompensateAnonymousCommentAsync(
                    managementCapabilities,
                    authorManagement,
                    reference.CommentId,
                    reference.ManagementSecret).ConfigureAwait(false);
            }
            catch (Exception error)
            {
                recoveryErrors.Add(error);
            }
            if (recoveryErrors.Count > 0)
                throw new AggregateException(
                    "Anonymous fixture durable custody failed and production compensation was incomplete; outer isolated namespace recovery is required.",
                    [custodyError, .. recoveryErrors]);
            throw new InvalidOperationException(
                "Anonymous fixture durable custody failed; the committed comment was compensated through production delete semantics.",
                custodyError);
        }
    }

    internal static async Task StoreCapabilityOrCompensateAsync(
        ICommentAnonymousFixtureCapabilityVault capabilities,
        ICommentManagementCapabilityService managementCapabilities,
        ICommentAuthorManagementService authorManagement,
        string owner,
        string testSession,
        long commentId,
        string managementSecret)
    {
        try
        {
            capabilities.Store(owner, testSession, commentId, managementSecret);
            return;
        }
        catch (Exception custodyError)
        {
            try
            {
                await CompensateAnonymousCommentAsync(
                    managementCapabilities,
                    authorManagement,
                    commentId,
                    managementSecret).ConfigureAwait(false);
            }
            catch (Exception compensationError)
            {
                throw new AggregateException(
                    "Anonymous fixture capability custody failed and production compensation was incomplete; outer isolated namespace recovery is required.",
                    custodyError,
                    compensationError);
            }

            throw new InvalidOperationException(
                "Anonymous fixture capability custody failed; the committed comment was compensated through production delete semantics.",
                custodyError);
        }
    }

    private static async Task CompensateAnonymousCommentAsync(
        ICommentManagementCapabilityService managementCapabilities,
        ICommentAuthorManagementService authorManagement,
        long commentId,
        string managementSecret)
    {
        CommentManagementChallengeResult challenge = await managementCapabilities.IssueChallengeAsync(
            commentId,
            managementSecret,
            CommentManagementPurposes.Delete,
            CancellationToken.None).ConfigureAwait(false);
        if (!challenge.Issued || string.IsNullOrWhiteSpace(challenge.Challenge))
            throw new InvalidOperationException("Production anonymous cleanup challenge was unavailable after fixture custody failure.");
        CommentAuthorMutationResult deleted = await authorManagement.DeleteAsAnonymousAsync(
            commentId,
            managementSecret,
            challenge.Challenge,
            CancellationToken.None).ConfigureAwait(false);
        if (!deleted.Success)
            throw new InvalidOperationException($"Production anonymous cleanup failed after fixture custody failure: {deleted.Code}.");
    }

    private static byte[] DeriveBytes(params string[] parts)
        => SHA256.HashData(Encoding.UTF8.GetBytes(string.Join('\0', ["fsusblog.comment-fixture-zk.v1", .. parts])));

    private static string Digest(params string[] parts)
        => Convert.ToHexStringLower(DeriveBytes(parts));

    private static bool IsCanonicalDigest(string? value)
        => value is not null
            && value.StartsWith("sha256:", StringComparison.Ordinal)
            && value.Length == 71
            && value.AsSpan(7).IndexOfAnyExcept("0123456789abcdef") < 0;

    private static bool FixedTimeEquals(string expected, string actual)
    {
        byte[] expectedBytes = Encoding.UTF8.GetBytes(expected);
        byte[] actualBytes = Encoding.UTF8.GetBytes(actual);
        return expectedBytes.Length == actualBytes.Length
            && CryptographicOperations.FixedTimeEquals(expectedBytes, actualBytes);
    }

    private sealed class FixtureRootService(AnonymousCredentialRootSnapshotCoreModel snapshot) : IAnonymousCredentialRootService
    {
        public Task<Result<AnonymousCredentialRootSnapshotCoreModel>> GetCurrentSnapshotAsync(
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return Task.FromResult(Result<AnonymousCredentialRootSnapshotCoreModel>.Success(snapshot));
        }

        public void Invalidate()
        {
        }
    }

    private sealed class FixtureRootReader : IAnonymousCredentialRootReader
    {
        public FixtureRootReader(AnonymousCredentialRootSnapshotCoreModel snapshot, DateTimeOffset loadedAt)
        {
            string credentialRoot = Convert.ToHexStringLower(snapshot.CredentialRoot);
            string revocationRoot = Convert.ToHexStringLower(snapshot.RevocationRoot);
            CurrentSnapshot = new AnonymousCredentialRootRuntimeSnapshot(
                [new AnonymousCredentialAcceptedRoot(
                    snapshot.CredentialEpoch,
                    credentialRoot,
                    revocationRoot,
                    snapshot.IssuerPublicKeyHash,
                    AnonymousCredentialRootStatuses.Active,
                    DateTimeOffset.FromUnixTimeMilliseconds(snapshot.RootGraceExpiresAtUnixMs))],
                1,
                loadedAt);
        }

        public AnonymousCredentialRootRuntimeSnapshot CurrentSnapshot
        {
            get;
        }

        public Task RefreshAsync(CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return Task.CompletedTask;
        }

        public bool IsRootAccepted(string rootHash, long epoch)
            => CurrentSnapshot.AcceptedRootByEpochAndHash.ContainsKey((epoch, rootHash));

        public bool IsRootAccepted(string rootHash, string revocationRootHash, string issuerPublicKeyHash, long epoch)
            => CurrentSnapshot.AcceptedRootLookup.ContainsKey((epoch, rootHash, revocationRootHash, issuerPublicKeyHash));
    }

}

/// <summary>
/// Request-scoped adapter for the explicitly activated local comment fixture.
/// It is never registered in DI and never mutates the global ZK production
/// policy; proof verification remains delegated to the local simulation backend.
/// </summary>
internal sealed class CommentFixtureZkSimulationProofService(
    IZkAnonymousProofService proofService) : IZkAnonymousProofService
{
    private static readonly ZkCommentPolicySnapshot s_simulationReadiness = new(
        Enabled: true,
        NativeVerifierConfigured: true,
        TrustedSetupVerified: true,
        CredentialRequired: true,
        CredentialRootReady: true,
        UnavailableReason: string.Empty);

    public AnonymousCommentPolicySnapshot CurrentCommentPolicy => proofService.CurrentCommentPolicy;

    public ZkAnonymousPolicySnapshot CurrentZkPolicy => proofService.CurrentZkPolicy;

    public ZkCommentPolicySnapshot CurrentZkCommentPolicy => s_simulationReadiness;

    public Task<ZkProofVerificationResult> VerifyCommentProofAsync(
        ZkProofVerificationRequest request,
        CancellationToken cancellationToken = default)
        => proofService.VerifyCommentProofAsync(request, cancellationToken);
}
