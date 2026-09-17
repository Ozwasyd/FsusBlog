using System.Globalization;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Shared.Contracts.Validation;

using SqlSugar;

namespace FsusBlog.Server.Services.Security;

public interface IBlindCredentialIssuanceService
{
    Task<Result<BlindCredentialIssueResponseCoreModel>> IssueAsync(
        int accountId,
        BlindCredentialIssueRequestCoreModel request,
        CancellationToken cancellationToken = default);
}

public sealed class BlindCredentialIssuanceService(
    ISqlSugarClient db,
    IAnonymousCredentialIssuanceAuditStore issuanceQuota,
    IAnonymousCredentialRootService roots,
    IRfc9474BlindCredentialSigner signer,
    IBlindCredentialRuntimeGate runtimeGate,
    IConfiguration configuration) : IBlindCredentialIssuanceService
{
    private const int UserStatusBanned = 1;
    private const int UserStatusDeleted = 2;

    public async Task<Result<BlindCredentialIssueResponseCoreModel>> IssueAsync(
        int accountId,
        BlindCredentialIssueRequestCoreModel request,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!runtimeGate.IsEnabled ||
            accountId <= 0 ||
            !RequestMatchesProfile(request, signer, configuration))
        {
            return Denied();
        }

        Result<AnonymousCredentialRootSnapshotCoreModel> root =
            await roots.GetCurrentSnapshotAsync(cancellationToken);
        if (!root.IsSuccess || !RequestMatchesRoot(request, signer, root.Value))
        {
            return Denied();
        }

        BlindCredentialEligibilityRow? account = await db.Queryable<User>()
            .Where(user => user.Id == accountId)
            .Select(user => new BlindCredentialEligibilityRow
            {
                Status = user.Status,
                DeletedAt = user.DeletedAt,
                AnonymousCredentialLevel = user.AnonymousCredentialLevel,
                AnonymousCredentialStatus = user.AnonymousCredentialStatus
            })
            .FirstAsync();

        string configuredLevel = ResolveCredentialLevel(configuration);
        if (account is null ||
            account.DeletedAt.HasValue ||
            account.Status == UserStatusDeleted ||
            (account.Status == UserStatusBanned &&
                !configuration.GetValue("AnonymousCredentialIssuer:AllowBannedAccountIssuance", false)) ||
            !string.Equals(
                Normalize(account.AnonymousCredentialStatus),
                AnonymousCredentialStatuses.Active,
                StringComparison.Ordinal) ||
            !string.Equals(
                Normalize(account.AnonymousCredentialLevel),
                configuredLevel,
                StringComparison.Ordinal))
        {
            return Denied();
        }

        string quotaSubject = BuildEpochScopedQuotaSubject(accountId, request.CredentialEpoch, configuration);
        bool reserved = await issuanceQuota.TryRecordIssuedAsync(
            new AnonymousCredentialIssuanceAuditWrite(
                quotaSubject,
                request.CredentialEpoch,
                AnonymousCredentialIssuanceStatuses.Issued,
                DateTime.UtcNow),
            cancellationToken);
        if (!reserved)
        {
            return Denied();
        }

        // Re-check immediately before the private-key operation so a reloaded
        // emergency disable cannot be bypassed by a request already in flight.
        if (!runtimeGate.IsEnabled)
        {
            return Denied();
        }

        Result<byte[]> blindSignature = await signer.BlindSignAsync(
            request.BlindedMessage,
            cancellationToken);
        if (!blindSignature.IsSuccess ||
            blindSignature.Value is not { Length: Rfc9474BlindCredentialProfile.ModulusBytes } signature)
        {
            return Denied();
        }

        long ttlMinutes = Math.Clamp(
            configuration.GetValue("AnonymousCredentialIssuer:CredentialTtlMinutes", 1440),
            60,
            60 * 24 * 31);
        long expiresAtUnixMs = Math.Min(
            root.Value.RootExpiresAtUnixMs,
            DateTimeOffset.UtcNow.AddMinutes(ttlMinutes).ToUnixTimeMilliseconds());
        return Result<BlindCredentialIssueResponseCoreModel>.Success(
            new BlindCredentialIssueResponseCoreModel(
                request.CredentialEpoch,
                expiresAtUnixMs,
                request.CircuitNumericId,
                request.PublicInputLayoutVersion,
                request.CircuitId,
                configuredLevel,
                Rfc9474BlindCredentialProfile.SchemeId,
                signer.KeyId,
                signature));
    }

    internal static string BuildEpochScopedQuotaSubject(
        int accountId,
        long epoch,
        IConfiguration configuration)
    {
        string? pepper = configuration["AnonymousCredentialIssuer:SubjectHashPepper"];
        if (string.IsNullOrWhiteSpace(pepper) || pepper.Trim().Length < 32)
        {
            throw new InvalidOperationException(
                "AnonymousCredentialIssuer:SubjectHashPepper must contain at least 32 characters.");
        }
        byte[] pepperBytes = Encoding.UTF8.GetBytes(pepper.Trim());
        byte[] key = SHA256.HashData(pepperBytes);
        byte[] input = Encoding.UTF8.GetBytes(string.Create(
            CultureInfo.InvariantCulture,
            $"fsusblog:blind-issuance-quota:v1:{epoch}:{accountId}"));
        try
        {
            return Convert.ToHexStringLower(HMACSHA256.HashData(key, input));
        }
        finally
        {
            CryptographicOperations.ZeroMemory(pepperBytes);
            CryptographicOperations.ZeroMemory(key);
            CryptographicOperations.ZeroMemory(input);
        }
    }

    internal static string ResolveCredentialLevel(IConfiguration configuration)
    {
        string level = Normalize(configuration["AnonymousCredentialIssuer:BlindRsa:CredentialLevel"]);
        return level.Length is > 0 and <= AnonymousPrivacyContract.MaxCredentialLevelBytes
            ? level
            : AnonymousCredentialLevels.Basic;
    }

    private static bool RequestMatchesProfile(
        BlindCredentialIssueRequestCoreModel request,
        IRfc9474BlindCredentialSigner signer,
        IConfiguration configuration) =>
        signer.IsConfigured &&
        request.CredentialEpoch > 0 &&
        request.CircuitNumericId > 0 &&
        request.PublicInputLayoutVersion == AnonymousPrivacyContract.PublicInputLayoutVersion &&
        string.Equals(request.CircuitId, AnonymousPrivacyContract.CircuitId, StringComparison.Ordinal) &&
        string.Equals(request.SchemeId, Rfc9474BlindCredentialProfile.SchemeId, StringComparison.Ordinal) &&
        string.Equals(request.IssuerPublicKeyId, signer.KeyId, StringComparison.Ordinal) &&
        string.Equals(
            Normalize(request.CredentialLevel),
            ResolveCredentialLevel(configuration),
            StringComparison.Ordinal) &&
        request.BlindedMessage is { Length: Rfc9474BlindCredentialProfile.ModulusBytes };

    internal static bool RequestMatchesRoot(
        BlindCredentialIssueRequestCoreModel request,
        IRfc9474BlindCredentialSigner signer,
        AnonymousCredentialRootSnapshotCoreModel root) =>
        request.CredentialEpoch == root.CredentialEpoch &&
        root.ZkAnonymousEnabled &&
        root.VerifierConfigured &&
        request.CircuitNumericId == root.CircuitNumericId &&
        request.PublicInputLayoutVersion == root.PublicInputLayoutVersion &&
        string.Equals(request.CircuitId, root.CircuitId, StringComparison.Ordinal) &&
        string.Equals(signer.PublicKeyHash, root.IssuerPublicKeyHash, StringComparison.OrdinalIgnoreCase) &&
        root.RootExpiresAtUnixMs > DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    private static string Normalize(string? value) =>
        (value ?? string.Empty).Trim().ToLowerInvariant();

    private static Result<BlindCredentialIssueResponseCoreModel> Denied() =>
        Result<BlindCredentialIssueResponseCoreModel>.Failure(
            ErrorCode.Forbidden,
            "anonymous_credential_blind_issue_denied");

    private sealed class BlindCredentialEligibilityRow
    {
        public int Status
        {
            get; set;
        }
        public DateTime? DeletedAt
        {
            get; set;
        }
        public string AnonymousCredentialLevel { get; set; } = string.Empty;
        public string AnonymousCredentialStatus { get; set; } = string.Empty;
    }
}
