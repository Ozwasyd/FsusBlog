namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Independent plan verifier: replans from the template record, the bound input, and current
/// authorities, then rejects any tamper, drift, or expiry. A plan that cannot be recomputed
/// byte-identically is never consumable.
/// </summary>
public sealed class ArticleTemplateExpansionVerifier(
    IArticleTemplateExpansionPlanner planner,
    TimeProvider timeProvider) : IArticleTemplateExpansionVerifier
{
    public Task<ArticleTemplateVerificationResult> VerifyAsync(
        ArticleTemplateExpansionPlan plan,
        ArticleTemplateActor currentActor,
        ArticlePropertyDefinitionOwner currentPropertyOwner,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(plan);
        ArticleTemplateContract.ValidateActor(currentActor);
        ArticlePropertyDefinitionContract.ValidateOwner(currentPropertyOwner);
        cancellationToken.ThrowIfCancellationRequested();
        if (!string.Equals(ArticleTemplateContract.ComputePermissionDigest(currentActor),
                ArticleTemplateContract.ComputePermissionDigest(plan.Input.Actor), StringComparison.Ordinal)
            || plan.Dependencies.PropertyPins.Any(pin => pin.Owner != currentPropertyOwner))
        {
            return Task.FromResult(new ArticleTemplateVerificationResult(false,
                [new("expansion_plan_context_drift", "current actor or property owner differs from plan")]));
        }
        return VerifyAsync(plan, cancellationToken);
    }

    public async Task<ArticleTemplateVerificationResult> VerifyAsync(
        ArticleTemplateExpansionPlan plan,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(plan);
        var violations = new List<ArticleTemplateVerificationViolation>();

        // Bind the immutable object consumed by create, not only its supplied declaration.
        if (!string.Equals(plan.DefaultsDigest, ArticleTemplateContract.ComputeDefaultsDigest(plan.Defaults),
                StringComparison.Ordinal))
        {
            violations.Add(new("expansion_plan_defaults_digest_mismatch", "consumed defaults differ from declared digest"));
        }
        if (!string.Equals(
                plan.ContentDigest,
                ArticleTemplateContract.ComputeExpansionPlanDigest(plan),
                StringComparison.Ordinal))
        {
            violations.Add(new("expansion_plan_digest_tamper", "plan content digest mismatch"));
        }
        if (plan.ExpiresAtUtc != plan.IssuedAtUtc.Add(ArticleTemplateExpansionPlanner.s_planTimeToLive))
        {
            violations.Add(new("expansion_plan_expiry_tamper", "plan expiry does not match issuance ttl"));
        }
        DateTime now = timeProvider.GetUtcNow().UtcDateTime;
        if (plan.IssuedAtUtc > now)
        {
            violations.Add(new("expansion_plan_issuance_future", "plan issuance is after the verifier clock"));
        }
        if (plan.ExpiresAtUtc <= now)
        {
            violations.Add(new("expansion_plan_expired", "plan expired"));
        }

        if (violations.Count != 0)
        {
            return new ArticleTemplateVerificationResult(false, Array.AsReadOnly(violations.ToArray()));
        }

        try
        {
            ArticleTemplateExpansionPlan recomputed = await planner.PlanAsync(
                plan.Input, cancellationToken).ConfigureAwait(false);
            if (!string.Equals(recomputed.ContentDigest, plan.ContentDigest, StringComparison.Ordinal))
            {
                violations.Add(new("expansion_plan_recompute_mismatch", "authorities drifted from pinned plan"));
            }
            if (!recomputed.ExpandedSource.SequenceEqual(plan.ExpandedSource))
            {
                violations.Add(new("expansion_plan_source_mismatch", "expanded source bytes drifted"));
            }
        }
        catch (ArticleTemplateAccessDeniedException)
        {
            violations.Add(new("expansion_plan_permission_lost", "actor no longer has use permission"));
        }
        catch (ArticleTemplateNotFoundException)
        {
            violations.Add(new("expansion_plan_template_missing", "template or version no longer exists"));
        }
        catch (ArticleTemplateReferenceException exception)
        {
            violations.Add(new("expansion_plan_reference_stale", exception.Code));
        }
        catch (ArticleTemplateExpansionException exception)
        {
            violations.Add(new("expansion_plan_input_stale", exception.Code));
        }

        return new ArticleTemplateVerificationResult(violations.Count == 0, Array.AsReadOnly(violations.ToArray()));
    }
}
