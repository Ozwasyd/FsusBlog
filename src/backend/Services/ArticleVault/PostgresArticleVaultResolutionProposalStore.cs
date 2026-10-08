using FsusBlog.Shared.Contracts.ArticleVault;

using Npgsql;

namespace FsusBlog.Server.Services.ArticleVault;

/// <summary>
/// Stores canonical proposal bytes append-only. Only this proposal table is written; the original
/// execution store remains the authority for the frozen plan. No article, operation or local writer,
/// permission provider, cleanup mechanism, connection fallback or current-fact reader is introduced.
/// </summary>
public sealed class PostgresArticleVaultResolutionProposalStore(
    NpgsqlDataSource dataSource,
    IArticleVaultExecutionStore executionStore,
    TimeProvider timeProvider) : IArticleVaultResolutionProposalStore
{
    public async Task SealAsync(
        ArticleVaultResolutionPlan proposal,
        ArticleVaultResolutionPlanInput current,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        RequireValid(ArticleVaultResolutionPlanner.VerifyCurrent(proposal, current));
        long nowUnixMs = timeProvider.GetUtcNow().ToUnixTimeMilliseconds();
        if (nowUnixMs < proposal.Confirmation.ConfirmedAtUnixMs || nowUnixMs > proposal.ExpiresAtUnixMs)
        {
            throw Rejected("article_vault_resolution_proposal_current_window_invalid");
        }

        await RequireOriginalBindingAsync(proposal, cancellationToken).ConfigureAwait(false);
        byte[] bytes = ArticleVaultResolutionPlanner.Serialize(proposal);
        if (bytes.Length > ArticleVaultGitFactDecoder.MaxOutputBytes)
        {
            throw Rejected("article_vault_resolution_proposal_size_limit");
        }

        await using NpgsqlConnection connection = await dataSource.OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        await using var command = new NpgsqlCommand("""
            INSERT INTO article_vault_resolution_proposal (
                resolution_operation_identity, content_sha256, original_plan_reference, original_plan_sha256,
                site_identity, vault_identity, proposal_bytes, stored_at_utc)
            VALUES (@operation, @digest, @plan, @plan_digest, @site, @vault, @bytes, @stored)
            ON CONFLICT (resolution_operation_identity) DO NOTHING
            """, connection);
        command.Parameters.AddWithValue("operation", proposal.ResolutionOperationIdentity);
        command.Parameters.AddWithValue("digest", proposal.ContentSha256);
        command.Parameters.AddWithValue("plan", proposal.Binding.PlanCandidateIdentity);
        command.Parameters.AddWithValue("plan_digest", proposal.Binding.PlanSha256);
        command.Parameters.AddWithValue("site", proposal.Binding.SiteIdentity);
        command.Parameters.AddWithValue("vault", proposal.Binding.VaultIdentity);
        command.Parameters.AddWithValue("bytes", bytes);
        command.Parameters.AddWithValue("stored", timeProvider.GetUtcNow().UtcDateTime);
        int inserted = await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
        await connection.DisposeAsync().ConfigureAwait(false);
        if (inserted == 1)
        {
            return;
        }

        ArticleVaultResolutionPlan? existing = await ReadExactAsync(
            proposal.ResolutionOperationIdentity, proposal.ContentSha256, cancellationToken).ConfigureAwait(false);
        if (existing is null || !ArticleVaultResolutionPlanner.Serialize(existing).AsSpan().SequenceEqual(bytes))
        {
            throw Rejected("article_vault_resolution_proposal_append_conflict");
        }
    }

    public async Task<ArticleVaultResolutionPlan?> ReadExactAsync(
        string resolutionOperationIdentity,
        string proposalSha256,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (resolutionOperationIdentity is not { Length: 75 }
            || !resolutionOperationIdentity.StartsWith("resolution-", StringComparison.Ordinal)
            || !IsDigest(resolutionOperationIdentity[11..]) || !IsDigest(proposalSha256))
        {
            throw Rejected("article_vault_resolution_proposal_reference_invalid");
        }

        await using NpgsqlConnection connection = await dataSource.OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        await using var command = new NpgsqlCommand("""
            SELECT original_plan_reference, original_plan_sha256, site_identity, vault_identity, proposal_bytes
            FROM article_vault_resolution_proposal
            WHERE resolution_operation_identity = @operation AND content_sha256 = @digest
            """, connection);
        command.Parameters.AddWithValue("operation", resolutionOperationIdentity);
        command.Parameters.AddWithValue("digest", proposalSha256);
        await using NpgsqlDataReader reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            return null;
        }

        byte[] bytes = reader.GetFieldValue<byte[]>(4);
        if (bytes.Length > ArticleVaultGitFactDecoder.MaxOutputBytes)
        {
            throw Rejected("article_vault_resolution_proposal_store_tampered");
        }

        ArticleVaultResolutionPlanResult decoded = ArticleVaultResolutionPlanner.TryDeserialize(bytes);
        ArticleVaultResolutionPlan proposal = decoded.Plan
            ?? throw Rejected(decoded.ReasonCode ?? "article_vault_resolution_proposal_store_tampered");

        RequireValid(ArticleVaultResolutionPlanner.ValidateStructure(proposal));
        if (proposal.ResolutionOperationIdentity != resolutionOperationIdentity || proposal.ContentSha256 != proposalSha256
            || proposal.Binding.PlanCandidateIdentity != reader.GetString(0)
            || proposal.Binding.PlanSha256 != reader.GetString(1)
            || proposal.Binding.SiteIdentity != reader.GetString(2) || proposal.Binding.VaultIdentity != reader.GetString(3)
            || !ArticleVaultResolutionPlanner.Serialize(proposal).AsSpan().SequenceEqual(bytes))
        {
            throw Rejected("article_vault_resolution_proposal_store_tampered");
        }

        await reader.DisposeAsync().ConfigureAwait(false);
        await connection.DisposeAsync().ConfigureAwait(false);
        await RequireOriginalBindingAsync(proposal, cancellationToken).ConfigureAwait(false);
        return proposal;
    }

    private async Task RequireOriginalBindingAsync(ArticleVaultResolutionPlan proposal, CancellationToken cancellationToken)
    {
        ArticleVaultSealedExecutionBundle bundle = await executionStore.LoadSealedAsync(
            proposal.Binding.PlanCandidateIdentity, proposal.Binding.PlanSha256, cancellationToken).ConfigureAwait(false)
            ?? throw Rejected("article_vault_resolution_proposal_original_plan_missing");
        ArticleVaultExecutionIntegrity.ValidateBundle(bundle);
        VaultSyncPlanItem[] items = bundle.Plan.Groups.Where(group => group.GroupIdentity == proposal.Binding.GroupIdentity)
            .SelectMany(static group => group.Items).Where(item => item.OperationIdentity == proposal.Binding.OperationIdentity).ToArray();
        if (items.Length != 1 || bundle.PlanReference != proposal.Binding.PlanCandidateIdentity
            || bundle.PlanSha256 != proposal.Binding.PlanSha256 || bundle.Plan.SiteIdentity != proposal.Binding.SiteIdentity
            || bundle.Plan.VaultIdentity != proposal.Binding.VaultIdentity || bundle.Plan.DeviceIdentity != proposal.Binding.DeviceIdentity
            || bundle.Plan.RootManifestSha256 != proposal.RootManifestSha256
            || items[0].PortableArticleIdentity != proposal.Binding.PortableArticleIdentity
            || items[0].ServerArticleIdentity != proposal.Binding.ServerArticleIdentity
            || items[0].Preconditions.ArticleManifestSha256 != proposal.Binding.ArticleManifestSha256
            || items[0].Preconditions.ServerObservationSha256 != proposal.Binding.ServerObservationSha256
            || items[0].Base.ContentSha256 != proposal.Binding.Coordinates.Base.ContentSha256
            || items[0].Local.ContentSha256 != proposal.Binding.Coordinates.Local.ContentSha256
            || items[0].Server.ContentSha256 != proposal.Binding.Coordinates.Server.ContentSha256)
        {
            throw Rejected("article_vault_resolution_proposal_original_binding_drift");
        }
    }

    private static void RequireValid(ArticleVaultValidationResult validation)
    {
        if (!validation.IsValid)
        {
            throw Rejected(validation.ReasonCode ?? "article_vault_resolution_proposal_rejected");
        }
    }

    private static bool IsDigest(string? value)
        => value is { Length: 64 } && value.All(static character => character is >= '0' and <= '9' or >= 'a' and <= 'f');

    private static ArticleVaultExecutionRejectedException Rejected(string reason)
        => new(reason);
}
