using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.Shared.Contracts.ArticleRelations;

/// <summary>Canonical length-prefixed digest for relation records, candidates, events and receipts.</summary>
public static class ArticleRelationDigest
{
    public static string ComputeRelationIdentity(ArticleRelationRecord record)
    {
        ArgumentNullException.ThrowIfNull(record);
        return Compute(writer =>
        {
            writer.Add(record.IndexVersion);
            writer.Add((byte)record.Kind);
            AddSource(writer, record.Source);
            AddOccurrence(writer, record.Occurrence);
            AddTarget(writer, record.Target);
            AddVisibility(writer, record.Visibility);
            writer.Add((byte)record.Resolution);
            AddCoordinate(writer, record.Coordinate);
        });
    }

    public static string ComputeRelation(ArticleRelationRecord record)
    {
        ArgumentNullException.ThrowIfNull(record);
        return Compute(writer =>
        {
            writer.Add(record.Schema);
            writer.Add(record.SchemaVersion);
            writer.Add(record.RelationIdentity);
            writer.Add(record.IndexVersion);
            writer.Add((byte)record.Kind);
            AddSource(writer, record.Source);
            AddOccurrence(writer, record.Occurrence);
            AddTarget(writer, record.Target);
            AddVisibility(writer, record.Visibility);
            writer.Add((byte)record.Resolution);
            AddCoordinate(writer, record.Coordinate);
        });
    }

    public static string ComputeSet(ArticleRelationSet set)
    {
        ArgumentNullException.ThrowIfNull(set);
        return Compute(writer =>
        {
            writer.Add(set.Schema);
            writer.Add(set.SchemaVersion);
            AddSource(writer, set.Source);
            writer.Add(set.Relations.Count);
            foreach (ArticleRelationRecord relation in set.Relations)
            {
                writer.Add(relation.RelationIdentity);
                writer.Add(relation.RecordDigest);
            }
        });
    }

    public static string ComputeIgnoreDecisionReference(ArticleRelationIgnoreDecisionReference reference)
    {
        ArgumentNullException.ThrowIfNull(reference);
        return Compute(writer =>
        {
            writer.Add(reference.Schema);
            writer.Add(reference.SchemaVersion);
            writer.Add(reference.DecisionIdentity);
            writer.Add(reference.DecisionRevision);
        });
    }

    public static string ComputeCandidateIdentity(ArticleRelationUnlinkedMentionCandidate candidate)
    {
        ArgumentNullException.ThrowIfNull(candidate);
        return Compute(writer =>
        {
            AddSource(writer, candidate.Source);
            AddVisibility(writer, candidate.Visibility);
            AddRange(writer, candidate.MatchedRange);
            writer.Add(candidate.CandidateTargets.Count);
            foreach (ArticleRelationTargetIdentity target in candidate.CandidateTargets)
            {
                AddTargetIdentity(writer, target);
            }
            writer.Add((byte)candidate.MatchRule);
            writer.Add((byte)candidate.MatchReason);
            writer.Add((byte)candidate.Confidence);
            writer.Add((byte)candidate.Ambiguity);
            writer.Add(candidate.IgnoreDecision is not null);
            if (candidate.IgnoreDecision is not null)
            {
                writer.Add(candidate.IgnoreDecision.DecisionIdentity);
                writer.Add(candidate.IgnoreDecision.DecisionRevision);
            }
            writer.Add(candidate.IsAuthoritative);
            AddCoordinate(writer, candidate.Coordinate);
        });
    }

    public static string ComputeCandidate(ArticleRelationUnlinkedMentionCandidate candidate)
    {
        ArgumentNullException.ThrowIfNull(candidate);
        return Compute(writer =>
        {
            writer.Add(candidate.Schema);
            writer.Add(candidate.SchemaVersion);
            writer.Add(candidate.CandidateIdentity);
            AddSource(writer, candidate.Source);
            AddVisibility(writer, candidate.Visibility);
            AddRange(writer, candidate.MatchedRange);
            writer.Add(candidate.CandidateTargets.Count);
            foreach (ArticleRelationTargetIdentity target in candidate.CandidateTargets)
            {
                AddTargetIdentity(writer, target);
            }
            writer.Add((byte)candidate.MatchRule);
            writer.Add((byte)candidate.MatchReason);
            writer.Add((byte)candidate.Confidence);
            writer.Add((byte)candidate.Ambiguity);
            writer.Add(candidate.IgnoreDecision is not null);
            if (candidate.IgnoreDecision is not null)
            {
                AddIgnoreDecision(writer, candidate.IgnoreDecision);
            }
            writer.Add(candidate.IsAuthoritative);
            AddCoordinate(writer, candidate.Coordinate);
        });
    }

    public static string ComputeLifecycleIdentity(ArticleRelationLifecycleEvent lifecycleEvent)
    {
        ArgumentNullException.ThrowIfNull(lifecycleEvent);
        return Compute(writer =>
        {
            writer.Add((byte)lifecycleEvent.Kind);
            writer.Add((byte)lifecycleEvent.Owner);
            writer.Add(lifecycleEvent.ArticleIdentity);
            writer.Add(lifecycleEvent.RevisionIdentity);
            writer.Add(lifecycleEvent.EventRevision);
            writer.Add((byte)lifecycleEvent.Changes);
            writer.Add((byte)lifecycleEvent.Obligations);
            AddCoordinate(writer, lifecycleEvent.Coordinate);
        });
    }

    public static string ComputeLifecycle(ArticleRelationLifecycleEvent lifecycleEvent)
    {
        ArgumentNullException.ThrowIfNull(lifecycleEvent);
        return Compute(writer =>
        {
            writer.Add(lifecycleEvent.Schema);
            writer.Add(lifecycleEvent.SchemaVersion);
            writer.Add(lifecycleEvent.EventIdentity);
            writer.Add((byte)lifecycleEvent.Kind);
            writer.Add((byte)lifecycleEvent.Owner);
            writer.Add(lifecycleEvent.ArticleIdentity);
            writer.Add(lifecycleEvent.RevisionIdentity);
            writer.Add(lifecycleEvent.EventRevision);
            writer.Add((byte)lifecycleEvent.Changes);
            writer.Add((byte)lifecycleEvent.Obligations);
            AddCoordinate(writer, lifecycleEvent.Coordinate);
        });
    }

    public static string ComputeReceipt(ArticleRelationReceipt receipt)
    {
        ArgumentNullException.ThrowIfNull(receipt);
        return Compute(writer =>
        {
            writer.Add(receipt.Schema);
            writer.Add(receipt.SchemaVersion);
            writer.Add(receipt.ReceiptIdentity);
            writer.Add((byte)receipt.Kind);
            AddReceiptContext(writer, receipt.Context);
            writer.Add(receipt.RelationCount);
            writer.Add(receipt.RelationDigests.Count);
            foreach (string digest in receipt.RelationDigests)
            {
                writer.Add(digest);
            }
            writer.Add(receipt.CandidateCount);
            writer.Add(receipt.CandidateDigests.Count);
            foreach (string digest in receipt.CandidateDigests)
            {
                writer.Add(digest);
            }
        });
    }

    public static bool IsSha256(string? value)
    {
        if (value is null || value.Length != 64)
        {
            return false;
        }

        foreach (char character in value)
        {
            if (!((character >= '0' && character <= '9')
                || (character >= 'a' && character <= 'f')))
            {
                return false;
            }
        }

        return true;
    }

    internal static string Compute(Action<CanonicalWriter> write)
    {
        using var stream = new MemoryStream();
        var writer = new CanonicalWriter(stream);
        write(writer);
        return Convert.ToHexStringLower(SHA256.HashData(stream.GetBuffer().AsSpan(0, checked((int)stream.Length))));
    }

    private static void AddSource(CanonicalWriter writer, ArticleRelationSourceFacts source)
    {
        writer.Add(source.ArticleIdentity);
        writer.Add(source.RevisionIdentity);
        writer.Add(source.RevisionNumber);
        writer.Add((byte)source.RevisionKind);
        writer.Add((byte)source.Lifecycle);
        writer.Add((byte)source.Permission);
        AddActor(writer, source.SourceActor);
        writer.Add(source.ContentDigest);
    }

    private static void AddOccurrence(CanonicalWriter writer, ArticleRelationOccurrence occurrence)
    {
        writer.Add(occurrence.LinkText);
        AddRange(writer, occurrence.First);
        AddRange(writer, occurrence.Last);
        writer.Add(occurrence.Count);
    }

    private static void AddRange(CanonicalWriter writer, ArticleRelationSourceRange range)
    {
        writer.Add(range.Start);
        writer.Add(range.End);
        writer.Add(range.MatchedText);
    }

    private static void AddTarget(CanonicalWriter writer, ArticleRelationTargetFacts target)
    {
        writer.Add(target.TargetIdentity is not null);
        if (target.TargetIdentity is not null)
        {
            AddTargetIdentity(writer, target.TargetIdentity);
        }
        writer.Add(target.RevisionIdentity);
        writer.Add(target.RevisionNumber.HasValue);
        if (target.RevisionNumber.HasValue)
        {
            writer.Add(target.RevisionNumber.Value);
        }
        writer.Add(target.RevisionKind.HasValue);
        if (target.RevisionKind.HasValue)
        {
            writer.Add((byte)target.RevisionKind.Value);
        }
        writer.Add(target.Lifecycle.HasValue);
        if (target.Lifecycle.HasValue)
        {
            writer.Add((byte)target.Lifecycle.Value);
        }
        writer.Add((byte)target.Permission);
    }

    private static void AddTargetIdentity(CanonicalWriter writer, ArticleRelationTargetIdentity target)
    {
        writer.Add(target.ArticleIdentity);
        writer.Add((byte)target.Kind);
        writer.Add(target.HeadingIdentity);
        writer.Add(target.BlockAnchorIdentity);
    }

    private static void AddVisibility(CanonicalWriter writer, ArticleRelationVisibilityFacts visibility)
    {
        AddActor(writer, visibility.SourceActor);
        AddActor(writer, visibility.QueryActor);
        writer.Add((byte)visibility.QueryScope);
        writer.Add((byte)visibility.PublicContext);
        writer.Add(visibility.PermissionPolicyDigest);
    }

    private static void AddCoordinate(CanonicalWriter writer, ArticleRelationContractCoordinate coordinate)
    {
        writer.Add(coordinate.ContractVersion);
        writer.Add(coordinate.KindCatalogVersion);
        writer.Add(coordinate.ResolutionCatalogVersion);
        writer.Add(coordinate.VisibilityCatalogVersion);
        writer.Add(coordinate.LifecycleCatalogVersion);
    }

    private static void AddActor(CanonicalWriter writer, ArticleRelationActorContext actor)
    {
        writer.Add(actor.ActorIdentity);
        writer.Add(actor.SiteIdentity);
        writer.Add(actor.PermissionContextDigest);
    }

    private static void AddIgnoreDecision(CanonicalWriter writer, ArticleRelationIgnoreDecisionReference reference)
    {
        writer.Add(reference.Schema);
        writer.Add(reference.SchemaVersion);
        writer.Add(reference.DecisionIdentity);
        writer.Add(reference.DecisionRevision);
        writer.Add(reference.DecisionDigest);
    }

    private static void AddReceiptContext(CanonicalWriter writer, ArticleRelationReceiptContext context)
    {
        writer.Add(context.SourceArticleIdentity);
        writer.Add(context.SourceRevisionIdentity);
        writer.Add(context.SourceRevisionNumber);
        writer.Add((byte)context.SourceRevisionKind);
        AddActor(writer, context.SourceActor);
        AddActor(writer, context.QueryActor);
        writer.Add((byte)context.QueryScope);
        writer.Add(context.WorktreeIdentity);
        writer.Add(context.BuildIdentity);
        writer.Add(context.ParserContract);
        writer.Add(context.RendererContract);
        writer.Add(context.ArticleSchemaVersion);
        writer.Add(context.PermissionPolicyVersion);
        AddCoordinate(writer, context.Coordinate);
        writer.Add(context.ContentDigest);
    }

    internal sealed class CanonicalWriter(MemoryStream stream)
    {
        public void Add(string? value)
        {
            if (value is null)
            {
                Add(-1);
                return;
            }

            byte[] bytes = Encoding.UTF8.GetBytes(value);
            Add(bytes.Length);
            stream.Write(bytes);
        }

        public void Add(bool value) => stream.WriteByte(value ? (byte)1 : (byte)0);

        public void Add(byte value) => stream.WriteByte(value);

        public void Add(int value)
        {
            Span<byte> bytes = stackalloc byte[sizeof(int)];
            BinaryPrimitives.WriteInt32BigEndian(bytes, value);
            stream.Write(bytes);
        }

        public void Add(long value)
        {
            Span<byte> bytes = stackalloc byte[sizeof(long)];
            BinaryPrimitives.WriteInt64BigEndian(bytes, value);
            stream.Write(bytes);
        }
    }
}
