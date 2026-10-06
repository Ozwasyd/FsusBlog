using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace FsusBlog.Shared.Contracts.AuthoringCanvas;

/// <summary>
/// Closed, versioned contract for canvas-local operations. Commands carry sealed before/after
/// facts so a transaction adapter can enforce CAS without accepting client-side array mutations.
/// </summary>
public static partial class AuthoringCanvasOperationContract
{
    public const int SchemaVersion = 1;
    public const int MaxCommandsPerTransaction = 10_000;
    public const int MaxFactsPerTransaction = AuthoringCanvasContract.MaxNodesPerCanvas
        + AuthoringCanvasContract.MaxEdgesPerCanvas + 1;
    public const int MaxUndoDepth = 100;
    public static string EmptyHistoryDigest { get; } = HashCanonical(SchemaVersion, "empty-history");

    [GeneratedRegex("^[0-9a-f]{64}$", RegexOptions.CultureInvariant)]
    private static partial Regex DigestPattern();

    public static AuthoringCanvasOperationFact Missing(
        AuthoringCanvasOperationFactKind kind,
        Guid id)
        => SealFact(new AuthoringCanvasOperationFact(kind, id, false));

    public static AuthoringCanvasOperationFact Present(AuthoringCanvasNode node)
        => SealFact(new AuthoringCanvasOperationFact(
            AuthoringCanvasOperationFactKind.Node,
            node.Id,
            true,
            Node: node));

    public static AuthoringCanvasOperationFact Present(AuthoringCanvasEdge edge)
        => SealFact(new AuthoringCanvasOperationFact(
            AuthoringCanvasOperationFactKind.Edge,
            edge.Id,
            true,
            Edge: edge));

    public static AuthoringCanvasOperationFact Present(AuthoringCanvasViewport viewport)
        => SealFact(new AuthoringCanvasOperationFact(
            AuthoringCanvasOperationFactKind.Viewport,
            Guid.Empty,
            true,
            Viewport: viewport));

    public static AuthoringCanvasClosedCommand SealCommand(
        Guid commandId,
        AuthoringCanvasOperationKind kind,
        IReadOnlyList<AuthoringCanvasOperationFact> before,
        IReadOnlyList<AuthoringCanvasOperationFact> after)
    {
        var command = new AuthoringCanvasClosedCommand(commandId, kind, before, after, string.Empty);
        ValidateCommandShape(command, validateDigest: false);
        return command with
        {
            ContentDigest = ComputeCommandDigest(command)
        };
    }

    public static void ValidateRequest(AuthoringCanvasOperationRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (request.RequestId == Guid.Empty
            || request.CanvasId == Guid.Empty
            || request.ExpectedRevision <= 0
            || request.ActorUserId <= 0
            || !DigestPattern().IsMatch(request.ExpectedContentDigest)
            || !DigestPattern().IsMatch(request.ExpectedHistoryDigest)
            || request.Commands.Count is < 1 or > MaxCommandsPerTransaction)
        {
            throw new AuthoringCanvasValidationException("canvas_operation_request_invalid");
        }
        AuthoringCanvasContract.ValidateOwner(request.Owner);

        var commandIds = new HashSet<Guid>();
        int factCount = 0;
        foreach (AuthoringCanvasClosedCommand command in request.Commands)
        {
            ValidateCommandShape(command, validateDigest: true);
            if (!commandIds.Add(command.CommandId))
            {
                throw new AuthoringCanvasValidationException("canvas_operation_command_duplicate");
            }
            factCount = checked(factCount + command.Before.Count + command.After.Count);
            if (factCount > MaxFactsPerTransaction * 2)
            {
                throw new AuthoringCanvasBudgetExceededException("canvas_operation_fact_budget_exceeded");
            }
        }
    }

    public static void ValidateHistoryRequest(AuthoringCanvasHistoryRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (request.RequestId == Guid.Empty
            || request.CanvasId == Guid.Empty
            || request.ActorUserId <= 0
            || request.ExpectedRevision <= 0
            || request.TargetJournalId == Guid.Empty
            || !DigestPattern().IsMatch(request.ExpectedContentDigest)
            || !DigestPattern().IsMatch(request.ExpectedHistoryDigest)
            || !Enum.IsDefined(request.Mode))
        {
            throw new AuthoringCanvasValidationException("canvas_history_request_invalid");
        }
        AuthoringCanvasContract.ValidateOwner(request.Owner);
    }

    public static void ValidateFact(AuthoringCanvasOperationFact fact, bool validateDigest = true)
    {
        ArgumentNullException.ThrowIfNull(fact);
        if (!Enum.IsDefined(fact.Kind)
            || (fact.Kind == AuthoringCanvasOperationFactKind.Viewport
                ? fact.Id != Guid.Empty
                : fact.Id == Guid.Empty))
        {
            throw new AuthoringCanvasValidationException("canvas_operation_fact_identity_invalid");
        }

        if (!fact.Exists)
        {
            if (fact.Node is not null || fact.Edge is not null || fact.Viewport is not null)
            {
                throw new AuthoringCanvasValidationException("canvas_operation_missing_fact_payload");
            }
        }
        else
        {
            switch (fact.Kind)
            {
                case AuthoringCanvasOperationFactKind.Node when fact.Node is not null
                    && fact.Edge is null && fact.Viewport is null && fact.Node.Id == fact.Id:
                    AuthoringCanvasContract.ValidateNode(fact.Node);
                    break;
                case AuthoringCanvasOperationFactKind.Edge when fact.Edge is not null
                    && fact.Node is null && fact.Viewport is null && fact.Edge.Id == fact.Id:
                    AuthoringCanvasContract.ValidateEdge(fact.Edge);
                    break;
                case AuthoringCanvasOperationFactKind.Viewport when fact.Viewport is not null
                    && fact.Node is null && fact.Edge is null:
                    AuthoringCanvasContract.ValidateViewport(fact.Viewport.Value);
                    break;
                default:
                    throw new AuthoringCanvasValidationException("canvas_operation_fact_payload_invalid");
            }
        }

        if (validateDigest && !string.Equals(
            fact.ContentDigest,
            ComputeFactDigest((fact with
            {
                ContentDigest = string.Empty
            })),
            StringComparison.Ordinal))
        {
            throw new AuthoringCanvasValidationException("canvas_operation_fact_digest_invalid");
        }
    }

    public static void ValidateCommand(AuthoringCanvasClosedCommand command)
        => ValidateCommandShape(command, validateDigest: true);

    public static string ComputeFactDigest(AuthoringCanvasOperationFact fact)
    {
        string payloadDigest = fact switch
        {
            { Exists: false } => string.Empty,
            { Kind: AuthoringCanvasOperationFactKind.Node, Node: not null } =>
                AuthoringCanvasContract.ComputeNodeDigest(fact.Node),
            { Kind: AuthoringCanvasOperationFactKind.Edge, Edge: not null } =>
                AuthoringCanvasContract.ComputeEdgeDigest(fact.Edge),
            { Kind: AuthoringCanvasOperationFactKind.Viewport, Viewport: not null } => HashCanonical(
                fact.Viewport.Value.X,
                fact.Viewport.Value.Y,
                fact.Viewport.Value.Zoom),
            _ => throw new AuthoringCanvasValidationException("canvas_operation_fact_payload_invalid")
        };
        return HashCanonical(SchemaVersion, (int)fact.Kind, fact.Id, fact.Exists, payloadDigest);
    }

    public static string ComputeCommandDigest(AuthoringCanvasClosedCommand command)
        => HashCanonical(
            SchemaVersion,
            command.CommandId,
            (int)command.Kind,
            string.Join(',', command.Before.Select(static fact => fact.ContentDigest)),
            string.Join(',', command.After.Select(static fact => fact.ContentDigest)));

    public static string ComputeTransactionDigest(AuthoringCanvasOperationRequest request)
        => HashCanonical(
            SchemaVersion,
            request.RequestId,
            request.CanvasId,
            request.ExpectedRevision,
            request.ExpectedContentDigest,
            request.ExpectedHistoryDigest,
            request.Owner.AdminPrincipalId,
            request.Owner.SiteScope,
            request.ActorUserId,
            string.Join(',', request.Commands.Select(static command => command.ContentDigest)));

    public static string ComputeJournalDigest(AuthoringCanvasOperationJournalEntry entry)
        => HashCanonical(
            SchemaVersion,
            entry.JournalId,
            entry.CanvasId,
            entry.Revision,
            (int)entry.Mode,
            entry.RequestId,
            entry.ActorUserId,
            entry.ParentJournalId,
            entry.TargetJournalId,
            entry.PreviousContentDigest,
            entry.ContentDigest,
            entry.TransactionDigest,
            entry.ReferenceValidationDigest,
            string.Join(',', entry.CommandKinds.Select(static kind => (int)kind)),
            string.Join(',', entry.Commands.Select(static command => command.ContentDigest)),
            string.Join(',', entry.ForwardFacts.Select(static fact => fact.ContentDigest)),
            string.Join(',', entry.InverseFacts.Select(static fact => fact.ContentDigest)),
            string.Join(',', entry.AffectedNodeIds.Order()),
            string.Join(',', entry.AffectedEdgeIds.Order()),
            string.Join(',', entry.TruncatedRedoJournalIds.Order()));

    public static string ComputeReceiptDigest(AuthoringCanvasOperationReceipt receipt)
        => HashCanonical(
            SchemaVersion,
            receipt.ReceiptId,
            receipt.RequestId,
            receipt.CanvasId,
            receipt.Revision,
            (int)receipt.Mode,
            receipt.JournalId,
            receipt.TargetJournalId,
            receipt.CommandCount,
            string.Join(',', receipt.CommandKinds.Select(static kind => (int)kind)),
            string.Join(',', receipt.AffectedNodeIds.Order()),
            string.Join(',', receipt.AffectedEdgeIds.Order()),
            receipt.UndoDepth,
            receipt.RedoDepth,
            (int)receipt.Status,
            string.Join(',', receipt.Reasons),
            receipt.TransactionDigest,
            receipt.JournalDigest,
            receipt.CanvasContentDigest);

    private static AuthoringCanvasOperationFact SealFact(AuthoringCanvasOperationFact fact)
    {
        ValidateFact(fact, validateDigest: false);
        return fact with
        {
            ContentDigest = ComputeFactDigest(fact)
        };
    }

    private static void ValidateCommandShape(AuthoringCanvasClosedCommand command, bool validateDigest)
    {
        ArgumentNullException.ThrowIfNull(command);
        if (command.CommandId == Guid.Empty || !Enum.IsDefined(command.Kind))
        {
            throw new AuthoringCanvasValidationException("canvas_operation_command_invalid");
        }
        foreach (AuthoringCanvasOperationFact fact in command.Before.Concat(command.After))
        {
            ValidateFact(fact);
        }
        EnsureUniqueFacts(command.Before);
        EnsureUniqueFacts(command.After);
        if (validateDigest && !string.Equals(
            command.ContentDigest,
            ComputeCommandDigest((command with
            {
                ContentDigest = string.Empty
            })),
            StringComparison.Ordinal))
        {
            throw new AuthoringCanvasValidationException("canvas_operation_command_digest_invalid");
        }
    }

    private static void EnsureUniqueFacts(IReadOnlyList<AuthoringCanvasOperationFact> facts)
    {
        if (facts.Count == 0 || facts.Count > MaxFactsPerTransaction
            || facts.Select(static fact => (fact.Kind, fact.Id)).Distinct().Count() != facts.Count)
        {
            throw new AuthoringCanvasValidationException("canvas_operation_fact_set_invalid");
        }
    }

    private static string HashCanonical(params object?[] values)
    {
        var canonical = new StringBuilder();
        foreach (object? value in values)
        {
            string text = value switch
            {
                null => "null",
                double number => number.ToString("R", System.Globalization.CultureInfo.InvariantCulture),
                IFormattable formattable => formattable.ToString(null, System.Globalization.CultureInfo.InvariantCulture),
                _ => value.ToString() ?? string.Empty
            };
            canonical.Append(text.Length).Append(':').Append(text).Append(';');
        }
        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(canonical.ToString())));
    }
}

public enum AuthoringCanvasOperationKind
{
    CreateReference = 0,
    CreateNote = 1,
    CreateFrame = 2,
    Move = 3,
    Resize = 4,
    Group = 5,
    Ungroup = 6,
    Connect = 7,
    Disconnect = 8,
    EditEdgeLabel = 9,
    EditNote = 10,
    Delete = 11,
    SetViewport = 12,
    PinTargetRevision = 13,
    UnpinTargetRevision = 14
}

public enum AuthoringCanvasOperationFactKind
{
    Node = 0,
    Edge = 1,
    Viewport = 2
}

public enum AuthoringCanvasJournalMode
{
    Apply = 0,
    Undo = 1,
    Redo = 2
}

public enum AuthoringCanvasOperationStatus
{
    Committed = 0,
    IdempotentReplay = 1,
    RecoveredAfterUnknownCommit = 2,
    BlockedByStaleHistory = 3
}

public sealed record AuthoringCanvasOperationFact(
    AuthoringCanvasOperationFactKind Kind,
    Guid Id,
    bool Exists,
    AuthoringCanvasNode? Node = null,
    AuthoringCanvasEdge? Edge = null,
    AuthoringCanvasViewport? Viewport = null,
    string ContentDigest = "");

public sealed record AuthoringCanvasClosedCommand(
    Guid CommandId,
    AuthoringCanvasOperationKind Kind,
    IReadOnlyList<AuthoringCanvasOperationFact> Before,
    IReadOnlyList<AuthoringCanvasOperationFact> After,
    string ContentDigest);

public sealed record AuthoringCanvasOperationRequest(
    Guid RequestId,
    Guid CanvasId,
    AuthoringCanvasOwner Owner,
    long ActorUserId,
    long ExpectedRevision,
    string ExpectedContentDigest,
    string ExpectedHistoryDigest,
    IReadOnlyList<AuthoringCanvasClosedCommand> Commands);

public sealed record AuthoringCanvasHistoryRequest(
    Guid RequestId,
    Guid CanvasId,
    AuthoringCanvasOwner Owner,
    long ActorUserId,
    long ExpectedRevision,
    string ExpectedContentDigest,
    string ExpectedHistoryDigest,
    Guid TargetJournalId,
    AuthoringCanvasJournalMode Mode);

public sealed record AuthoringCanvasOperationSnapshot(
    AuthoringCanvasDocumentHeader Header,
    IReadOnlyList<AuthoringCanvasNode> Nodes,
    IReadOnlyList<AuthoringCanvasEdge> Edges);

public sealed record AuthoringCanvasOperationPlan(
    Guid RequestId,
    Guid CanvasId,
    AuthoringCanvasOwner Owner,
    long ActorUserId,
    long ExpectedRevision,
    string ExpectedContentDigest,
    AuthoringCanvasJournalMode Mode,
    Guid? TargetJournalId,
    IReadOnlyList<AuthoringCanvasClosedCommand> Commands,
    IReadOnlyList<AuthoringCanvasOperationKind> CommandKinds,
    IReadOnlyList<AuthoringCanvasOperationFact> ForwardFacts,
    IReadOnlyList<AuthoringCanvasOperationFact> InverseFacts,
    IReadOnlyList<Guid> AffectedNodeIds,
    IReadOnlyList<Guid> AffectedEdgeIds,
    IReadOnlyList<Guid> TruncatedRedoJournalIds,
    int ResultNodeCount,
    int ResultEdgeCount,
    string TransactionDigest,
    string ReferenceValidationDigest);

public sealed record AuthoringCanvasOperationJournalEntry(
    Guid JournalId,
    Guid CanvasId,
    long Revision,
    AuthoringCanvasJournalMode Mode,
    Guid RequestId,
    long ActorUserId,
    Guid? ParentJournalId,
    Guid? TargetJournalId,
    string PreviousContentDigest,
    string ContentDigest,
    string TransactionDigest,
    IReadOnlyList<AuthoringCanvasOperationKind> CommandKinds,
    IReadOnlyList<AuthoringCanvasClosedCommand> Commands,
    IReadOnlyList<AuthoringCanvasOperationFact> ForwardFacts,
    IReadOnlyList<AuthoringCanvasOperationFact> InverseFacts,
    IReadOnlyList<Guid> AffectedNodeIds,
    IReadOnlyList<Guid> AffectedEdgeIds,
    IReadOnlyList<Guid> TruncatedRedoJournalIds,
    string ReferenceValidationDigest,
    string JournalDigest);

public sealed record AuthoringCanvasHistoryWindow(
    Guid CanvasId,
    long Revision,
    string CanvasContentDigest,
    string HistoryDigest,
    IReadOnlyList<AuthoringCanvasOperationJournalEntry> UndoEntries,
    IReadOnlyList<AuthoringCanvasOperationJournalEntry> RedoEntries);

public sealed record AuthoringCanvasOperationReceipt(
    Guid ReceiptId,
    Guid RequestId,
    Guid CanvasId,
    long Revision,
    AuthoringCanvasJournalMode Mode,
    Guid JournalId,
    Guid? TargetJournalId,
    int CommandCount,
    IReadOnlyList<AuthoringCanvasOperationKind> CommandKinds,
    IReadOnlyList<Guid> AffectedNodeIds,
    IReadOnlyList<Guid> AffectedEdgeIds,
    int UndoDepth,
    int RedoDepth,
    AuthoringCanvasOperationStatus Status,
    IReadOnlyList<string> Reasons,
    string TransactionDigest,
    string JournalDigest,
    string CanvasContentDigest,
    string ReceiptDigest);

public sealed record AuthoringCanvasOperationRecoveryQuery(
    Guid CanvasId,
    AuthoringCanvasOwner Owner,
    Guid RequestId,
    string TransactionDigest);

public sealed record AuthoringCanvasOperationVerificationResult(
    Guid CanvasId,
    long Revision,
    int VerifiedJournalEntries,
    string ContentDigest,
    bool Valid,
    IReadOnlyList<string> Reasons);

/// <summary>
/// Adapter boundary for the existing canvas database authority. Implementations must atomically
/// CAS the document revision, apply all facts, append one journal entry, and persist idempotency.
/// </summary>
public interface IAuthoringCanvasOperationTransaction
{
    Task<AuthoringCanvasOperationReceipt> CommitAsync(
        AuthoringCanvasOperationPlan plan,
        CancellationToken cancellationToken = default);

    Task<AuthoringCanvasOperationReceipt?> RecoverAsync(
        AuthoringCanvasOperationRecoveryQuery query,
        CancellationToken cancellationToken = default);

    Task<AuthoringCanvasHistoryWindow> ReadHistoryAsync(
        AuthoringCanvasOwner owner,
        Guid canvasId,
        CancellationToken cancellationToken = default);

    Task<IReadOnlyList<AuthoringCanvasOperationJournalEntry>> ReadJournalAsync(
        AuthoringCanvasOwner owner,
        Guid canvasId,
        long afterRevision,
        int limit,
        CancellationToken cancellationToken = default);

    Task<IReadOnlyList<AuthoringCanvasOperationReceipt>> ReadReceiptsAsync(
        AuthoringCanvasOwner owner,
        Guid canvasId,
        long afterRevision,
        int limit,
        CancellationToken cancellationToken = default);
}

public sealed record AuthoringCanvasOperationReferenceValidationRequest(
    Guid RequestId,
    Guid CanvasId,
    long CanvasRevision,
    string CanvasContentDigest,
    AuthoringCanvasOwner Owner,
    IReadOnlyList<AuthoringCanvasNode> References);

public interface IAuthoringCanvasOperationReferenceValidator
{
    Task<string> ValidateAsync(
        AuthoringCanvasOperationReferenceValidationRequest request,
        CancellationToken cancellationToken = default);
}

public sealed class AuthoringCanvasUnknownCommitResultException(Exception? innerException = null)
    : Exception("authoring_canvas_commit_result_unknown", innerException);

public sealed class AuthoringCanvasHistoryConflictException()
    : Exception("authoring_canvas_history_conflict");
