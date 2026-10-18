using System.Collections.Immutable;

using FsusBlog.Shared.Contracts.ArticleEmbeds.Authoring;
using FsusBlog.Shared.Contracts.ArticleVault;
using FsusBlog.Shared.Contracts.ArticleVault.Dependencies;

namespace FsusBlog.Server.Services.ArticleVault;

/// <summary>
/// Reads the exact already accepted server result and its authorized historical bytes after
/// dependency preflight. It neither executes the article writer nor asserts later stage receipts.
/// The whole read returns only after every named item succeeds; cancellation exposes no partial group.
/// </summary>
public sealed class ArticleVaultDependencyAcceptedSourceStage(
    IArticleVaultExecutionStore executionStore,
    ArticleVaultAcceptedSourceAdapter acceptedSource,
    TimeProvider timeProvider)
{
    public async Task<ArticleVaultDependencyAcceptedSources> ReadAsync(
        ArticleVaultSealedExecutionBundle bundle,
        ArticleVaultDependencyPlan dependencies,
        ArticleVaultPlanRequest request,
        ArticleVaultPlanVerificationContext context,
        IReadOnlyList<VaultDependencyPlanInput> currentInputs,
        ArticleEmbedResolutionBudgetLimits budgets,
        ArticleVaultOperationIdentity operation,
        string resultReference,
        string resultSha256,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ArticleVaultValidationResult admission = ArticleVaultDependencyExecutionPreflight.Verify(
            bundle, dependencies, request, context, currentInputs, budgets, timeProvider);
        Require(admission);
        Require(ArticleVaultOperationVerifier.ValidateIdentity(operation, bundle.Plan));
        RequireCurrentWindow(bundle, operation);

        ArticleVaultExecutionResult result = await executionStore.LoadResultAsync(resultReference, cancellationToken)
            .ConfigureAwait(false) ?? throw Rejected("article_vault_dependency_accepted_result_missing");
        if (result.ResultReference != resultReference || result.ContentSha256 != resultSha256)
        {
            throw Rejected("article_vault_dependency_accepted_result_mismatch");
        }
        ArticleVaultMaterializationPreflight materialization = ArticleVaultMaterializationPreflightVerifier.Prepare(
            bundle, result, operation);
        var sources = ImmutableArray.CreateBuilder<ArticleVaultAcceptedSource>();
        foreach (ArticleVaultMaterializationInstruction instruction in materialization.SourceInstructions)
        {
            cancellationToken.ThrowIfCancellationRequested();
            RequireCurrentWindow(bundle, operation);
            if (instruction.NewSource is null)
            {
                // A deletion has no historical source package. Its conditional removal instruction
                // still requires the original native owner and is never executed here.
                continue;
            }
            ArticleVaultAcceptedSource source = await acceptedSource.ReadAsync(operation, resultReference,
                resultSha256, instruction.OperationIdentity, cancellationToken).ConfigureAwait(false);
            VaultDependencyPlanInput input = currentInputs.Single(item =>
                item.Manifest.Binding.PortableArticleIdentity == instruction.PortableArticleIdentity);
            if (source.Instruction != instruction || source.Source != input.Manifest.Source
                || !source.Package.RawMarkdown.AsSpan().SequenceEqual(input.SourceBytes.Span))
            {
                throw Rejected("article_vault_dependency_accepted_source_mismatch");
            }
            sources.Add(source);
        }
        cancellationToken.ThrowIfCancellationRequested();
        RequireCurrentWindow(bundle, operation);
        return new(operation, dependencies.ContentSha256, result, materialization, sources.ToImmutable());
    }

    private void RequireCurrentWindow(ArticleVaultSealedExecutionBundle bundle, ArticleVaultOperationIdentity operation)
    {
        long now = timeProvider.GetUtcNow().ToUnixTimeMilliseconds();
        if (bundle.Plan.CancellationRequested || now < bundle.Plan.CreatedAtUnixMs
            || now > operation.DeadlineUnixMs || now > bundle.Plan.ExpiresAtUnixMs)
        {
            throw Rejected("article_vault_dependency_accepted_read_window_invalid");
        }
    }

    private static void Require(ArticleVaultValidationResult result)
    {
        if (!result.IsValid)
        {
            throw Rejected(result.ReasonCode!);
        }
    }

    private static ArticleVaultExecutionRejectedException Rejected(string reason) => new(reason);
}

/// <summary>
/// Authorized source-read output, not a journal, stage receipt or terminal acceptance claim.
/// A server result proves neither relation/search/cache rebuild nor local/base consistency.
/// </summary>
public sealed record ArticleVaultDependencyAcceptedSources(
    ArticleVaultOperationIdentity Operation,
    string DependencyPlanSha256,
    ArticleVaultExecutionResult ServerResult,
    ArticleVaultMaterializationPreflight Materialization,
    ImmutableArray<ArticleVaultAcceptedSource> Sources)
{
    public bool CanCommitBase => false;
    public bool HasVerifiedTerminalReceipt => false;
}
