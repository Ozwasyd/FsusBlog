using System.Collections.Immutable;

using FsusBlog.Shared.Contracts.ArticleEmbeds.Authoring;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Unregistered source-only preparation facade. The canonical host dependency reader and permission,
/// whole-host graph revalidation, CAS/idempotency and revision/outbox/audit transaction are not supplied
/// here. There is no endpoint, DI registration, reader stub, authority grant or execution method.
/// </summary>
public static class ArticleEmbedRefreshPreparation
{
    /// <summary>
    /// Lists required integrations, not claims that a supplied observation satisfies them. Even a
    /// prepared or no-change candidate remains non-executing and cannot be used as a write capability.
    /// </summary>
    public static ImmutableArray<string> MissingExecutionCapabilities
    {
        get;
    } =
    [
        "canonical_host_draft_dependency_read",
        "current_host_and_target_permission_revalidation",
        "whole_host_dependency_graph_revalidation",
        "expected_revision_cas_and_idempotency",
        "canonical_no_source_change_revision_outbox_audit_commit"
    ];

    /// <summary>
    /// Passes explicitly supplied observations to the sole shared planner. Omitted real host facts
    /// produce a blocked result; no implementation invents a reader or substitutes a publication/cache.
    /// This method performs no database, transport, persistence, runtime registration or product import.
    /// </summary>
    public static ArticleEmbedRefreshPlanningResult Prepare(
        ArticleEmbedRefreshPlanRequest? request,
        ArticleEmbedRefreshHostFacts? observedHost,
        ArticleEmbedAuthoritySnapshot? currentAuthority,
        TimeProvider? time = null)
        => ArticleEmbedRefreshPlanner.Prepare(request, observedHost, currentAuthority, time);
}
