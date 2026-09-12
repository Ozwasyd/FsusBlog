namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Closed semantic validator shared by command admission and independent journal verification.
/// It validates one sealed command without reading or mutating runtime state.
/// </summary>
internal static class AuthoringCanvasOperationSemantics
{
    internal static void ValidateCommand(AuthoringCanvasClosedCommand command)
    {
        AuthoringCanvasOperationContract.ValidateCommand(command);
        Dictionary<FactKey, AuthoringCanvasOperationFact> before = FactsByKey(command.Before);
        Dictionary<FactKey, AuthoringCanvasOperationFact> after = FactsByKey(command.After);
        if (!before.Keys.SequenceEqual(after.Keys))
        {
            throw new AuthoringCanvasValidationException("canvas_operation_transition_keys_invalid");
        }

        switch (command.Kind)
        {
            case AuthoringCanvasOperationKind.CreateReference:
                ValidateCreate(before, after, static node => node.Type is AuthoringCanvasNodeType.ArticleReference
                    or AuthoringCanvasNodeType.HeadingReference or AuthoringCanvasNodeType.BlockReference);
                break;
            case AuthoringCanvasOperationKind.CreateNote:
                ValidateCreate(before, after, static node => node.Type == AuthoringCanvasNodeType.PlainTextNote);
                break;
            case AuthoringCanvasOperationKind.CreateFrame:
                ValidateCreate(before, after, static node => node.Type == AuthoringCanvasNodeType.GroupFrame);
                break;
            case AuthoringCanvasOperationKind.Move:
                ValidateNodeChanges(before, after, static (left, right) => left with
                {
                    Geometry = right.Geometry with
                    {
                        Width = left.Geometry.Width,
                        Height = left.Geometry.Height
                    }
                });
                break;
            case AuthoringCanvasOperationKind.Resize:
                ValidateNodeChanges(before, after, static (left, right) => left with
                {
                    Geometry = right.Geometry with
                    {
                        X = left.Geometry.X,
                        Y = left.Geometry.Y
                    }
                });
                break;
            case AuthoringCanvasOperationKind.Group:
                ValidateMembership(before, after, added: true);
                break;
            case AuthoringCanvasOperationKind.Ungroup:
                ValidateMembership(before, after, added: false);
                break;
            case AuthoringCanvasOperationKind.Connect:
                ValidateEdgeExistence(before, after, creating: true);
                break;
            case AuthoringCanvasOperationKind.Disconnect:
                ValidateEdgeExistence(before, after, creating: false);
                break;
            case AuthoringCanvasOperationKind.EditEdgeLabel:
                ValidateEdgeLabel(before, after);
                break;
            case AuthoringCanvasOperationKind.EditNote:
                ValidateNote(before, after);
                break;
            case AuthoringCanvasOperationKind.Delete:
                ValidateDelete(before, after);
                break;
            case AuthoringCanvasOperationKind.SetViewport:
                ValidateViewport(before, after);
                break;
            case AuthoringCanvasOperationKind.PinTargetRevision:
                ValidatePin(before, after, pinning: true);
                break;
            case AuthoringCanvasOperationKind.UnpinTargetRevision:
                ValidatePin(before, after, pinning: false);
                break;
            default:
                throw new AuthoringCanvasValidationException("canvas_operation_kind_invalid");
        }
    }

    private static void ValidateCreate(
        IReadOnlyDictionary<FactKey, AuthoringCanvasOperationFact> before,
        IReadOnlyDictionary<FactKey, AuthoringCanvasOperationFact> after,
        Func<AuthoringCanvasNode, bool> typePredicate)
    {
        if (before.Count != 1
            || before.Values.Single() is not { Kind: AuthoringCanvasOperationFactKind.Node, Exists: false }
            || after.Values.Single() is not { Kind: AuthoringCanvasOperationFactKind.Node, Exists: true, Node: not null } created
            || !typePredicate(created.Node))
        {
            throw new AuthoringCanvasValidationException("canvas_operation_create_shape_invalid");
        }
    }

    private static void ValidateNodeChanges(
        IReadOnlyDictionary<FactKey, AuthoringCanvasOperationFact> before,
        IReadOnlyDictionary<FactKey, AuthoringCanvasOperationFact> after,
        Func<AuthoringCanvasNode, AuthoringCanvasNode, AuthoringCanvasNode> allowed)
    {
        if (before.Count is < 1 or > AuthoringCanvasContract.MaxNodesPerCanvas)
        {
            throw new AuthoringCanvasValidationException("canvas_operation_node_batch_invalid");
        }
        foreach ((FactKey key, AuthoringCanvasOperationFact leftFact) in before)
        {
            AuthoringCanvasOperationFact rightFact = after[key];
            if (leftFact is not { Kind: AuthoringCanvasOperationFactKind.Node, Exists: true, Node: not null }
                || rightFact is not { Kind: AuthoringCanvasOperationFactKind.Node, Exists: true, Node: not null }
                || !NodeEqual(allowed(leftFact.Node, rightFact.Node), rightFact.Node)
                || NodeEqual(leftFact.Node, rightFact.Node))
            {
                throw new AuthoringCanvasValidationException("canvas_operation_node_change_invalid");
            }
        }
    }

    private static void ValidateMembership(
        IReadOnlyDictionary<FactKey, AuthoringCanvasOperationFact> before,
        IReadOnlyDictionary<FactKey, AuthoringCanvasOperationFact> after,
        bool added)
    {
        if (before.Count != 1
            || before.Values.Single() is not { Kind: AuthoringCanvasOperationFactKind.Node, Exists: true, Node: not null } left
            || after.Values.Single() is not { Kind: AuthoringCanvasOperationFactKind.Node, Exists: true, Node: not null } right
            || left.Node.Type != AuthoringCanvasNodeType.GroupFrame
            || right.Node.Type != AuthoringCanvasNodeType.GroupFrame
            || !NodeEqual(CopyNode(left.Node, right.Node.MemberNodeIds), right.Node))
        {
            throw new AuthoringCanvasValidationException("canvas_operation_membership_invalid");
        }
        HashSet<Guid> beforeMembers = [.. left.Node.MemberNodeIds];
        HashSet<Guid> afterMembers = [.. right.Node.MemberNodeIds];
        bool valid = added
            ? beforeMembers.IsProperSubsetOf(afterMembers)
            : beforeMembers.IsProperSupersetOf(afterMembers);
        if (!valid)
        {
            throw new AuthoringCanvasValidationException("canvas_operation_membership_direction_invalid");
        }
    }

    private static void ValidateEdgeExistence(
        IReadOnlyDictionary<FactKey, AuthoringCanvasOperationFact> before,
        IReadOnlyDictionary<FactKey, AuthoringCanvasOperationFact> after,
        bool creating)
    {
        if (before.Count != 1
            || before.Values.Single().Kind != AuthoringCanvasOperationFactKind.Edge
            || (creating
                ? before.Values.Single().Exists || after.Values.Single() is not { Exists: true, Edge: not null }
                : !before.Values.Single().Exists || after.Values.Single().Exists))
        {
            throw new AuthoringCanvasValidationException("canvas_operation_edge_transition_invalid");
        }
    }

    private static void ValidateEdgeLabel(
        IReadOnlyDictionary<FactKey, AuthoringCanvasOperationFact> before,
        IReadOnlyDictionary<FactKey, AuthoringCanvasOperationFact> after)
    {
        if (before.Count != 1
            || before.Values.Single() is not { Exists: true, Edge: not null } left
            || after.Values.Single() is not { Exists: true, Edge: not null } right
            || left.Edge.Label == right.Edge.Label
            || (left.Edge with
            {
                Label = right.Edge.Label
            }) != right.Edge)
        {
            throw new AuthoringCanvasValidationException("canvas_operation_edge_label_invalid");
        }
    }

    private static void ValidateNote(
        IReadOnlyDictionary<FactKey, AuthoringCanvasOperationFact> before,
        IReadOnlyDictionary<FactKey, AuthoringCanvasOperationFact> after)
    {
        if (before.Count != 1
            || before.Values.Single() is not { Exists: true, Node: not null } left
            || after.Values.Single() is not { Exists: true, Node: not null } right
            || left.Node.Type != AuthoringCanvasNodeType.PlainTextNote
            || right.Node.Type != AuthoringCanvasNodeType.PlainTextNote
            || left.Node.NoteSource == right.Node.NoteSource
            || !NodeEqual(left.Node with
            {
                NoteSource = right.Node.NoteSource
            }, right.Node))
        {
            throw new AuthoringCanvasValidationException("canvas_operation_note_edit_invalid");
        }
    }

    private static void ValidateDelete(
        IReadOnlyDictionary<FactKey, AuthoringCanvasOperationFact> before,
        IReadOnlyDictionary<FactKey, AuthoringCanvasOperationFact> after)
    {
        bool removed = false;
        foreach ((FactKey key, AuthoringCanvasOperationFact left) in before)
        {
            AuthoringCanvasOperationFact right = after[key];
            if (!left.Exists || (right.Exists && left.Kind != AuthoringCanvasOperationFactKind.Node))
            {
                throw new AuthoringCanvasValidationException("canvas_operation_delete_shape_invalid");
            }
            if (!right.Exists)
            {
                removed = true;
            }
            else if (left.Node is null || right.Node is null
                || left.Node.Type != AuthoringCanvasNodeType.GroupFrame
                || !NodeEqual(CopyNode(left.Node, right.Node.MemberNodeIds), right.Node)
                || !right.Node.MemberNodeIds.All(left.Node.MemberNodeIds.Contains))
            {
                throw new AuthoringCanvasValidationException("canvas_operation_delete_cleanup_invalid");
            }
        }
        if (!removed)
        {
            throw new AuthoringCanvasValidationException("canvas_operation_delete_empty");
        }
    }

    private static void ValidateViewport(
        IReadOnlyDictionary<FactKey, AuthoringCanvasOperationFact> before,
        IReadOnlyDictionary<FactKey, AuthoringCanvasOperationFact> after)
    {
        if (before.Count != 1
            || before.Values.Single() is not { Kind: AuthoringCanvasOperationFactKind.Viewport, Exists: true }
            || after.Values.Single() is not { Kind: AuthoringCanvasOperationFactKind.Viewport, Exists: true }
            || before.Values.Single().ContentDigest == after.Values.Single().ContentDigest)
        {
            throw new AuthoringCanvasValidationException("canvas_operation_viewport_invalid");
        }
    }

    private static void ValidatePin(
        IReadOnlyDictionary<FactKey, AuthoringCanvasOperationFact> before,
        IReadOnlyDictionary<FactKey, AuthoringCanvasOperationFact> after,
        bool pinning)
    {
        if (before.Count != 1
            || before.Values.Single() is not { Kind: AuthoringCanvasOperationFactKind.Node, Exists: true, Node: not null } left
            || after.Values.Single() is not { Kind: AuthoringCanvasOperationFactKind.Node, Exists: true, Node: not null } right
            || left.Node.Type is not (AuthoringCanvasNodeType.ArticleReference
                or AuthoringCanvasNodeType.HeadingReference or AuthoringCanvasNodeType.BlockReference)
            || !NodeEqual(left.Node with
            {
                PinnedTargetRevision = right.Node.PinnedTargetRevision,
                ReferenceState = right.Node.ReferenceState,
                DisplayProjectionReference = right.Node.DisplayProjectionReference
            }, right.Node)
            || (pinning
                ? right.Node.PinnedTargetRevision is not > 0 || right.Node.ReferenceState != AuthoringCanvasReferenceState.Pinned
                : right.Node.PinnedTargetRevision is not null || right.Node.ReferenceState != AuthoringCanvasReferenceState.Current))
        {
            throw new AuthoringCanvasValidationException("canvas_operation_pin_invalid");
        }
    }

    private static Dictionary<FactKey, AuthoringCanvasOperationFact> FactsByKey(
        IReadOnlyList<AuthoringCanvasOperationFact> facts)
        => facts.OrderBy(static fact => fact.Kind).ThenBy(static fact => fact.Id)
            .ToDictionary(static fact => new FactKey(fact.Kind, fact.Id));

    private static bool NodeEqual(AuthoringCanvasNode left, AuthoringCanvasNode right)
        => string.Equals(
            AuthoringCanvasContract.ComputeNodeDigest(left),
            AuthoringCanvasContract.ComputeNodeDigest(right),
            StringComparison.Ordinal);

    private static AuthoringCanvasNode CopyNode(
        AuthoringCanvasNode source,
        IReadOnlyList<Guid> members)
        => new(
            source.Id,
            source.Type,
            source.Order,
            source.Geometry,
            source.TargetArticleId,
            source.TargetHeadingIdentity,
            source.TargetBlockIdentity,
            source.PinnedTargetRevision,
            source.DisplayProjectionReference,
            source.ReferenceState,
            source.NoteSource,
            source.FrameLabel,
            members);

    private readonly record struct FactKey(AuthoringCanvasOperationFactKind Kind, Guid Id);
}
