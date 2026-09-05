namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Independent journal verifier. It replays sealed canvas facts without calling the operation
/// engine or any article, relation, property, workspace, search, or editor authority.
/// </summary>
public static class AuthoringCanvasOperationVerifier
{
    public static AuthoringCanvasOperationVerificationResult Verify(
        AuthoringCanvasOperationSnapshot initial,
        IReadOnlyList<AuthoringCanvasOperationJournalEntry> journal,
        AuthoringCanvasOperationSnapshot current)
    {
        ArgumentNullException.ThrowIfNull(initial);
        ArgumentNullException.ThrowIfNull(journal);
        ArgumentNullException.ThrowIfNull(current);
        var reasons = new List<string>();
        var nodes = initial.Nodes.ToDictionary(static node => node.Id);
        var edges = initial.Edges.ToDictionary(static edge => edge.Id);
        AuthoringCanvasViewport viewport = initial.Header.Viewport;
        long revision = initial.Header.Revision;
        string contentDigest = initial.Header.ContentDigest;
        Guid? parentJournalId = null;

        foreach (AuthoringCanvasOperationJournalEntry entry in journal)
        {
            if (entry.CanvasId != initial.Header.Id
                || entry.Revision != revision + 1
                || entry.ParentJournalId != parentJournalId
                || !string.Equals(entry.PreviousContentDigest, contentDigest, StringComparison.Ordinal))
            {
                reasons.Add($"journal_chain_invalid:{entry.JournalId:D}");
            }
            if (!string.Equals(
                entry.JournalDigest,
                AuthoringCanvasOperationContract.ComputeJournalDigest((entry with
                {
                    JournalDigest = string.Empty
                })),
                StringComparison.Ordinal))
            {
                reasons.Add($"journal_digest_mismatch:{entry.JournalId:D}");
            }
            if (entry.ForwardFacts.Count != entry.InverseFacts.Count
                || entry.ForwardFacts.Count > AuthoringCanvasOperationContract.MaxFactsPerTransaction)
            {
                reasons.Add($"journal_fact_set_invalid:{entry.JournalId:D}");
                continue;
            }

            Dictionary<FactKey, AuthoringCanvasOperationFact> inverse = entry.InverseFacts
                .ToDictionary(static fact => new FactKey(fact.Kind, fact.Id));
            foreach (AuthoringCanvasOperationFact forward in entry.ForwardFacts)
            {
                try
                {
                    AuthoringCanvasOperationContract.ValidateFact(forward);
                    if (!inverse.TryGetValue(new FactKey(forward.Kind, forward.Id), out AuthoringCanvasOperationFact? expected)
                        || !Matches(expected, nodes, edges, viewport))
                    {
                        reasons.Add($"journal_before_fact_mismatch:{entry.JournalId:D}:{forward.Id:D}");
                    }
                    Apply(forward, nodes, edges, ref viewport);
                }
                catch (AuthoringCanvasValidationException exception)
                {
                    reasons.Add($"journal_fact_invalid:{entry.JournalId:D}:{exception.Code}");
                }
            }
            revision = entry.Revision;
            contentDigest = entry.ContentDigest;
            parentJournalId = entry.JournalId;
        }

        ValidateFinalState(nodes, edges, viewport, reasons);
        if (current.Header.Revision != revision
            || !string.Equals(current.Header.ContentDigest, contentDigest, StringComparison.Ordinal)
            || current.Header.NodeCount != nodes.Count
            || current.Header.EdgeCount != edges.Count)
        {
            reasons.Add("current_header_mismatch");
        }
        if (!SameNodes(nodes.Values, current.Nodes))
        {
            reasons.Add("current_nodes_mismatch");
        }
        if (!SameEdges(edges.Values, current.Edges))
        {
            reasons.Add("current_edges_mismatch");
        }
        if (current.Header.Viewport != viewport)
        {
            reasons.Add("current_viewport_mismatch");
        }

        return new AuthoringCanvasOperationVerificationResult(
            initial.Header.Id,
            revision,
            journal.Count,
            contentDigest,
            reasons.Count == 0,
            reasons);
    }

    private static bool Matches(
        AuthoringCanvasOperationFact expected,
        IReadOnlyDictionary<Guid, AuthoringCanvasNode> nodes,
        IReadOnlyDictionary<Guid, AuthoringCanvasEdge> edges,
        AuthoringCanvasViewport viewport)
    {
        AuthoringCanvasOperationFact actual = expected.Kind switch
        {
            AuthoringCanvasOperationFactKind.Node when nodes.TryGetValue(expected.Id, out AuthoringCanvasNode? node) =>
                AuthoringCanvasOperationContract.Present(node),
            AuthoringCanvasOperationFactKind.Edge when edges.TryGetValue(expected.Id, out AuthoringCanvasEdge? edge) =>
                AuthoringCanvasOperationContract.Present(edge),
            AuthoringCanvasOperationFactKind.Viewport => AuthoringCanvasOperationContract.Present(viewport),
            _ => AuthoringCanvasOperationContract.Missing(expected.Kind, expected.Id)
        };
        return string.Equals(actual.ContentDigest, expected.ContentDigest, StringComparison.Ordinal);
    }

    private static void Apply(
        AuthoringCanvasOperationFact fact,
        IDictionary<Guid, AuthoringCanvasNode> nodes,
        IDictionary<Guid, AuthoringCanvasEdge> edges,
        ref AuthoringCanvasViewport viewport)
    {
        switch (fact.Kind)
        {
            case AuthoringCanvasOperationFactKind.Node when fact.Exists:
                nodes[fact.Id] = fact.Node!;
                break;
            case AuthoringCanvasOperationFactKind.Node:
                nodes.Remove(fact.Id);
                break;
            case AuthoringCanvasOperationFactKind.Edge when fact.Exists:
                edges[fact.Id] = fact.Edge!;
                break;
            case AuthoringCanvasOperationFactKind.Edge:
                edges.Remove(fact.Id);
                break;
            case AuthoringCanvasOperationFactKind.Viewport:
                viewport = fact.Viewport!.Value;
                break;
        }
    }

    private static void ValidateFinalState(
        IReadOnlyDictionary<Guid, AuthoringCanvasNode> nodes,
        IReadOnlyDictionary<Guid, AuthoringCanvasEdge> edges,
        AuthoringCanvasViewport viewport,
        ICollection<string> reasons)
    {
        try
        {
            AuthoringCanvasContract.ValidateViewport(viewport);
            foreach (AuthoringCanvasNode node in nodes.Values)
            {
                AuthoringCanvasContract.ValidateNode(node);
                if (node.Type == AuthoringCanvasNodeType.GroupFrame
                    && node.MemberNodeIds.Any(member => !nodes.ContainsKey(member)))
                {
                    reasons.Add($"frame_member_missing:{node.Id:D}");
                }
            }
            foreach (AuthoringCanvasEdge edge in edges.Values)
            {
                AuthoringCanvasContract.ValidateEdge(edge);
                if (!nodes.ContainsKey(edge.SourceNodeId) || !nodes.ContainsKey(edge.TargetNodeId))
                {
                    reasons.Add($"edge_endpoint_missing:{edge.Id:D}");
                }
            }
        }
        catch (AuthoringCanvasValidationException exception)
        {
            reasons.Add($"current_fact_invalid:{exception.Code}");
        }
    }

    private static bool SameNodes(
        IEnumerable<AuthoringCanvasNode> expected,
        IEnumerable<AuthoringCanvasNode> actual)
        => expected.Select(AuthoringCanvasContract.ComputeNodeDigest).Order()
            .SequenceEqual(actual.Select(AuthoringCanvasContract.ComputeNodeDigest).Order());

    private static bool SameEdges(
        IEnumerable<AuthoringCanvasEdge> expected,
        IEnumerable<AuthoringCanvasEdge> actual)
        => expected.Select(AuthoringCanvasContract.ComputeEdgeDigest).Order()
            .SequenceEqual(actual.Select(AuthoringCanvasContract.ComputeEdgeDigest).Order());

    private readonly record struct FactKey(AuthoringCanvasOperationFactKind Kind, Guid Id);
}
