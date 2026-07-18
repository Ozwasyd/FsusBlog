using System.Text.RegularExpressions;

namespace FsusBlog.Server.Infrastructure.SchemaMigration;

public sealed record DestructiveMigrationProof(
    string MigrationId,
    string IntroducedByCommit,
    DateTimeOffset IntroducedAtUtc,
    string EarliestContractRelease,
    DateTimeOffset RollbackWindowEndUtc,
    string RollbackWindowProofArtifact,
    IReadOnlyList<string> RequiredEvidence);

public interface IDestructiveSchemaMigrationStep
{
    DestructiveMigrationProof Proof
    {
        get;
    }
}

public static partial class DestructiveMigrationProofs
{
    internal const int MinimumRollbackWindowDays = 30;

    private static readonly IReadOnlyList<string> s_evidenceRequirements =
    [
        "n_minus_one_qualification_passed",
        "rollback_manifest_sealed",
        "backup_restore_verified",
        "wal_restore_verified",
        "cross_region_restore_verified"
    ];

    private static readonly IReadOnlyDictionary<string, DestructiveMigrationProof> s_proofs =
        new Dictionary<string, DestructiveMigrationProof>(StringComparer.Ordinal)
        {
            ["20260715-post-read-event-retirement"] = Create(
                "20260715-post-read-event-retirement",
                "f661801b8feb5e04ce7d183fb2c0e398fbd26f9b",
                "2026-07-15T10:09:50Z"),
            ["20260418-post-content-cleanup"] = Create(
                "20260418-post-content-cleanup",
                "620685ed839982c043715048e604a739f3610b1f",
                "2026-04-26T13:08:50Z"),
            ["20260418-post-messaging-split"] = Create(
                "20260418-post-messaging-split",
                "620685ed839982c043715048e604a739f3610b1f",
                "2026-04-26T13:08:50Z"),
            ["20260621-post-message-legacy-identity-columns-finalize"] = Create(
                "20260621-post-message-legacy-identity-columns-finalize",
                "8fbd50c65ea89385d0b6150e203354336353dfd6",
                "2026-06-21T10:07:07Z"),
            ["20260418-post-user-session-finalize"] = Create(
                "20260418-post-user-session-finalize",
                "620685ed839982c043715048e604a739f3610b1f",
                "2026-04-26T13:08:50Z"),
            ["20260602-post-user-auth-security-hardening"] = Create(
                "20260602-post-user-auth-security-hardening",
                "c577bc51de327e184245598c009f886832e12e35",
                "2026-06-02T10:33:12Z"),
            ["20260621-pre-sys-user-security-profile-split"] = Create(
                "20260621-pre-sys-user-security-profile-split",
                "9ffe184319285e97b25cfb6fbfa18f418a387da9",
                "2026-06-21T10:14:15Z"),
            ["20260621-post-sys-user-security-profile-split-finalize"] = Create(
                "20260621-post-sys-user-security-profile-split-finalize",
                "9ffe184319285e97b25cfb6fbfa18f418a387da9",
                "2026-06-21T10:14:15Z"),
            ["20260621-post-user-legacy-identity-columns-finalize"] = Create(
                "20260621-post-user-legacy-identity-columns-finalize",
                "6e71ce0f3e9551502f4986044b8cbd002ed02046",
                "2026-06-21T10:21:46Z"),
            ["20260621-post-sys-user-username-finalize"] = Create(
                "20260621-post-sys-user-username-finalize",
                "ee389a37956fd8914d2c71d296eb7a5e7cd78c1b",
                "2026-06-21T12:14:56Z"),
            ["20260621-post-passkey-recovery-key-account-id-finalize"] = Create(
                "20260621-post-passkey-recovery-key-account-id-finalize",
                "4e1b4c46420aae17af69093e3d5c829b8e6f69f9",
                "2026-06-21T10:16:07Z"),
            ["20260621-post-anonymous-credential-account-binding-finalize"] = Create(
                "20260621-post-anonymous-credential-account-binding-finalize",
                "de2607dc47717170eaee539cef0236c50b3555f0",
                "2026-06-21T07:47:26Z"),
            ["20260618-post-anonymous-credential-issuance-audit"] = Create(
                "20260618-post-anonymous-credential-issuance-audit",
                "bd43c80924efdb21e1a61583d1b9cdb673554ee6",
                "2026-06-20T23:23:19Z"),
            ["20260418-post-audit-log"] = Create(
                "20260418-post-audit-log",
                "2e546df18cb8a2ec87f3e432e2d0b413b057890b",
                "2026-05-30T13:41:01Z"),
            ["20260621-post-visit-log-anonymous-attribution-finalize"] = Create(
                "20260621-post-visit-log-anonymous-attribution-finalize",
                "adfa6aaa3b3f137dd8ad4d80e22023a84b2f9e81",
                "2026-06-21T05:13:57Z"),
            ["20260621-post-visit-log-ip-anonymization"] = Create(
                "20260621-post-visit-log-ip-anonymization",
                "dc51971cde5ce7cb2d2eaec078413d716ff56c15",
                "2026-06-21T09:43:16Z"),
            ["20260621-pre-authoring-admin-principal-attribution"] = Create(
                "20260621-pre-authoring-admin-principal-attribution",
                "6592bbe457204598b6f3ce3db53b5cc16708932f",
                "2026-06-21T11:30:37Z"),
            ["20260621-pre-comment-moderation-admin-principal-attribution"] = Create(
                "20260621-pre-comment-moderation-admin-principal-attribution",
                "6ba5e918611866bc3b3b00205396c4280798d121",
                "2026-06-21T08:17:00Z")
        };

    public static DestructiveMigrationProof For(string migrationId)
    {
        if (!s_proofs.TryGetValue(migrationId, out DestructiveMigrationProof? proof))
        {
            throw new ArgumentException(
                "Destructive migration has no reviewed rollback-window proof registration.",
                nameof(migrationId));
        }

        return proof;
    }

    internal static void ValidateDescriptor(
        ISchemaMigrationDescriptor descriptor,
        DateTimeOffset now,
        bool freshBootstrap)
    {
        foreach (SchemaMigrationStep migrationStep in descriptor.Steps)
        {
            if (migrationStep is not DropColumnStep && migrationStep is not DropTableStep)
            {
                continue;
            }

            if (migrationStep is not IDestructiveSchemaMigrationStep step)
            {
                throw new InvalidOperationException(
                    $"schema_destructive_proof_missing:{descriptor.MigrationId}:{migrationStep.Kind}");
            }

            DestructiveMigrationProof proof = step.Proof;
            if (!string.Equals(proof.MigrationId, descriptor.MigrationId, StringComparison.Ordinal))
            {
                throw new InvalidOperationException(
                    $"schema_destructive_proof_descriptor_mismatch:{descriptor.MigrationId}:{proof.MigrationId}");
            }

            if (!CommitShaRegex().IsMatch(proof.IntroducedByCommit)
                || string.IsNullOrWhiteSpace(proof.EarliestContractRelease)
                || string.IsNullOrWhiteSpace(proof.RollbackWindowProofArtifact)
                || proof.RequiredEvidence.Count == 0
                || proof.RequiredEvidence.Any(string.IsNullOrWhiteSpace)
                || proof.RollbackWindowEndUtc - proof.IntroducedAtUtc < TimeSpan.FromDays(MinimumRollbackWindowDays))
            {
                throw new InvalidOperationException(
                    $"schema_destructive_proof_invalid:{descriptor.MigrationId}");
            }

            if (!freshBootstrap && now < proof.RollbackWindowEndUtc)
            {
                throw new InvalidOperationException(
                    $"schema_destructive_rollback_window_open:{descriptor.MigrationId}:{migrationStep.Kind}:{proof.RollbackWindowEndUtc:O}:{proof.RollbackWindowProofArtifact}");
            }
        }
    }

    private static DestructiveMigrationProof Create(
        string migrationId,
        string introducedByCommit,
        string introducedAtUtc)
    {
        DateTimeOffset introducedAt = DateTimeOffset.Parse(
            introducedAtUtc,
            System.Globalization.CultureInfo.InvariantCulture,
            System.Globalization.DateTimeStyles.AssumeUniversal);
        return new DestructiveMigrationProof(
            migrationId,
            introducedByCommit,
            introducedAt,
            migrationId,
            introducedAt.AddDays(MinimumRollbackWindowDays),
            $"docs/schema-migrations/destructive-rollback-window-proofs.json#{migrationId}",
            s_evidenceRequirements);
    }

    [GeneratedRegex("^[0-9a-f]{40}$", RegexOptions.CultureInvariant)]
    private static partial Regex CommitShaRegex();
}
