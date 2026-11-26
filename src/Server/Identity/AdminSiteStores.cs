using System.Text.RegularExpressions;

namespace FsusBlog.V2.Server.Administration;

internal sealed class AdminSignInHistoryStore(AdminSessionGate gate)
{
    internal Task<(AdminSignInHistorySnapshot History, string PermissionSession)> RecentSignIns(string? token, CancellationToken ct) =>
        gate.WithLiveAdminPermission(token, async (db, tx, admin) =>
        {
            var signIns = await SqlCommands.QueryList(db, tx, ct, """
                select h.started_at,h.expires_at,h.ended_at,coalesce(h.id=s.sign_in_id,false)
                from public.admin_sign_in h
                join public.admin_session s on s.principal_id=h.principal_id and s.digest=$2
                where h.principal_id=$1 order by h.id desc limit $3
                """, reader =>
            {
                var started = reader.GetUnixMilliseconds(0);
                var expires = reader.GetUnixMilliseconds(1);
                var current = reader.GetBoolean(3);
                if (current != reader.IsDBNull(2) || (current && expires != admin.Snapshot.ExpiresAt))
                    throw new PublicUnavailableException();
                var ended = current ? 0 : reader.GetUnixMilliseconds(2);
                var state = current ? AdminSignInState.Current : ended == expires ? AdminSignInState.Expired : AdminSignInState.Ended;
                return new AdminSignIn(started, expires, ended, state);
            }, admin.Id, admin.Digest, AdminSignInHistory.RetainedSignIns);
            return new AdminSignInHistorySnapshot(admin.Snapshot.Generation, signIns);
        }, ct);
}

internal sealed class AdminCommentRiskStore(AdminSessionGate gate, AdminStepUpService stepUp)
{
    internal Task<(AdminRootCommentPowPolicy State, string PermissionSession)> ReadRootCommentPowPolicy(string? session, CancellationToken ct) =>
        gate.WithLiveAdminPermission(session, async (db, tx, _) =>
        {
            var current = await RootCommentPowPolicy.Read(db, tx, ct);
            return new AdminRootCommentPowPolicy(current.Generation, current.Digest, current.ProofSeconds,
                await current.PreviousSeconds(db, tx, ct));
        }, ct);

    internal Task<byte[]> BeginRootCommentPowStepUp(string? session, AdminRootCommentPowCommand intent, CancellationToken ct) =>
        stepUp.BeginStepUp(session, RootCommentPowIntentDigest(intent),
            (db, tx, _) => CheckRootCommentPowIntent(db, tx, intent, ct), ct, AdminStepUpAction.ActivateRootCommentPow);

    internal Task<byte[]> CompleteRootCommentPowStepUp(string? session, PasskeyLoginRequest assertion, CancellationToken ct) =>
        stepUp.CompleteStepUp(session, assertion, AdminStepUpAction.ActivateRootCommentPow, ct);

    internal Task<(AdminRootCommentPowPolicy State, string PermissionSession)> ApplyRootCommentPowPolicy(string? session,
        AdminRootCommentPowCommand intent, string? proof, CancellationToken ct) =>
        gate.WithLiveAdminPermission(session, async (db, tx, admin) =>
        {
            var current = await CheckRootCommentPowIntent(db, tx, intent, ct, update: true);
            await stepUp.RequireProofAsync(db, tx, admin, proof, RootCommentPowIntentDigest(intent), ct,
                AdminStepUpAction.ActivateRootCommentPow, "A current Passkey proof for this exact root comment policy change is required.");
            var next = await current.Activate(db, tx, admin.Id, intent.ProofSeconds, intent.Rollback, ct);
            return new AdminRootCommentPowPolicy(next.Generation, next.Digest, next.ProofSeconds, current.ProofSeconds);
        }, ct);

    private static async Task<RootCommentPowPolicy> CheckRootCommentPowIntent(NpgsqlConnection db, NpgsqlTransaction tx,
        AdminRootCommentPowCommand intent, CancellationToken ct, bool update = false)
    {
        var current = await RootCommentPowPolicy.Read(db, tx, ct, update);
        if (current.Generation != intent.ExpectedGeneration || current.Digest != intent.ExpectedDigest ||
            (intent.Rollback && await current.PreviousSeconds(db, tx, ct) != intent.ProofSeconds))
            throw new BusinessException(Rejection.Conflict, "The root comment proof policy changed. Check its current settings.");
        if (current.ProofSeconds == intent.ProofSeconds)
            throw new BusinessException(Rejection.Invalid, "Choose a different root comment proof lifetime.");
        return current;
    }

    private static byte[] RootCommentPowIntentDigest(AdminRootCommentPowCommand intent) =>
        SHA256.HashData(Wire.EncodeAdminRootCommentPowCommand(intent));
}

internal sealed class AdminOperationsStore(AdminSessionGate gate)
{
    internal Task<(AdminSiteTraffic Traffic, string PermissionSession)> ReadSiteTraffic(string? token, SiteTraffic traffic, CancellationToken ct) =>
        gate.WithLiveAdminPermission(token, (db, tx, _) => traffic.ReadAsync(db, tx, ct), ct);

    internal Task<(AdminOperationsStatus Status, string PermissionSession)> OperationsStatus(string? token, Publications publications, CancellationToken ct) =>
        gate.WithLiveAdminPermission(token, async (db, tx, _) =>
        {
            var (pending, oldest) = await SqlCommands.QueryRequired(db, tx, ct, """
                select count(*), min(created_at)
                from public.blog_outbox where processed_at is null and kind in ('publish','retract','delete')
                """, r => (r.GetInt64(0), r.IsDBNull(1) ? 0 : r.GetUnixMilliseconds(1)), null);
            var snapshot = publications.Snapshot;
            return new AdminOperationsStatus(snapshot is not null, snapshot?.Watermark ?? 0, pending, oldest);
        }, ct);

    internal Task<(AdminClusterStatus Status, string PermissionSession)> ClusterStatus(string? token,
        AdminClusterIdentity instance, InstanceLease lease, Publications publications, CancellationToken ct) =>
        gate.WithLiveAdminPermission(token, (_, _, _) => Task.FromResult(new AdminClusterStatus(
            1, instance.NodeId, instance.InstanceId, instance.BuildVersion, instance.StartedAt,
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), lease.ObserveAgeMilliseconds(), publications.Snapshot is not null)), ct);

    internal Task<(AdminRiskReadiness Controls, string PermissionSession)> RiskReadiness(string? token,
        InstalledCommentRoutes commentRoutes, bool trustLoopbackProxy, CancellationToken ct) =>
        gate.WithLiveAdminPermission(token, async (db, tx, _) =>
        {
            var replyMode = !commentRoutes.SignedInReply ? 0
                : await CurrentSchema.HasCommentReplySchemaAsync(db, tx, ct) ? 2 : 1;
            if (commentRoutes.RootPowPolicy) await RootCommentPowPolicy.Read(db, tx, ct);
            return new AdminRiskReadiness(1, commentRoutes.RootSubmission ? 1 : 0, replyMode, trustLoopbackProxy ? 1 : 0, 0, 0);
        }, ct);
}

internal static class AdminProtectedChange
{
    internal static async Task Verify(AdminStepUpService stepUp, NpgsqlConnection db, NpgsqlTransaction tx, AdminLiveSession admin,
        string? session, string? proof, byte[] digest, AdminStepUpAction action, string proofMessage, ScopedPow pow, PowScope scope,
        string context, byte[] frame, HttpContext ctx, CancellationToken ct)
    {
        await stepUp.RequireProofAsync(db, tx, admin, proof, digest, ct, action, proofMessage);
        await pow.Consume(db, tx, scope, context, session!, ScopedPow.Source(ctx), frame, ScopedPow.ReadProof(ctx), ct);
    }
}

internal sealed class AdminSitePageStore(AdminSessionGate gate, AdminStepUpService? stepUp = null)
{
    internal Task<byte[]> SitePagesOverview(string? token, SitePages pages, CancellationToken ct) =>
        gate.WithSession(token, async (db, tx, _) => Wire.EncodeAdminSitePages(new(await pages.ConfiguredMaskAsync(db, tx, ct))), ct);

    internal Task<byte[]> SitePage(string? token, SitePages pages, string slug, CancellationToken ct) =>
        gate.WithSession(token, (db, tx, _) => pages.ConfiguredFrame(db, tx, slug, ct), ct);

    internal Task<AdminSitePageRevision> CurrentSitePage(string? session, SitePages pages, string slug, CancellationToken ct) =>
        gate.WithLiveAdmin(session, (db, tx, _) => SitePagePublicationStore.Read(db, tx, pages.EditorBaseline(slug), ct), ct);

    internal AdminProtectedChange<AdminSitePagePublish> Protection() =>
        new(gate, RequireStepUp, AdminStepUpAction.PublishSitePage, PowScope.AdminSitePagePublish, SitePageIntentDigest,
            intent => intent.Slug, (ctx, intent, ct) =>
            {
                var pages = ctx.RequestServices.GetRequiredService<SitePages>();
                return (db, tx) => CurrentSitePage(db, tx, pages, intent, ct);
            });

    internal Task PublishSitePage(string? session, SitePages pages, AdminSitePagePublish intent, byte[] frame,
        string? proof, ScopedPow pow, HttpContext ctx, CancellationToken ct) =>
        gate.WithLiveAdmin(session, async (db, tx, admin) =>
        {
            var stepUpService = RequireStepUp();
            var current = await CurrentSitePage(db, tx, pages, intent, ct, forUpdate: true);
            await AdminProtectedChange.Verify(stepUpService, db, tx, admin, session, proof, SitePageIntentDigest(intent),
                AdminStepUpAction.PublishSitePage, "A current Passkey proof for this exact site page change is required.",
                pow, PowScope.AdminSitePagePublish, intent.Slug, frame, ctx, ct);
            await SitePagePublicationStore.Publish(db, tx, admin.Id, current, intent.Markdown, ct);
            pages.MarkPublished(intent.Slug);
            return true;
        }, ct);

    private AdminStepUpService RequireStepUp() =>
        stepUp ?? throw new InvalidOperationException("Administrator site page editor Step-Up is not configured.");

    private static async Task<AdminSitePageRevision> CurrentSitePage(NpgsqlConnection db, NpgsqlTransaction tx, SitePages pages,
        AdminSitePagePublish intent, CancellationToken ct, bool forUpdate = false)
    {
        var current = await SitePagePublicationStore.Read(db, tx, pages.EditorBaseline(intent.Slug), ct, forUpdate);
        SitePagePublicationStore.RequireMatch(current, intent);
        return current;
    }

    internal static byte[] SitePageIntentDigest(AdminSitePagePublish intent) => SHA256.HashData(Wire.EncodeAdminSitePagePublish(intent));
}

internal sealed class AdminSiteConfigStore(AdminSessionGate gate, AdminStepUpService stepUp)
{
    private const string SiteConfigPowScope = "site";

    internal Task<byte[]> ReadSiteConfig(string? session, PublicSiteConfiguration config, CancellationToken ct) =>
        gate.WithLiveAdmin(session, async (db, tx, _) =>
            Wire.EncodeAdminSiteConfigState(config.ToAdminState(await SiteConfigOverrideStore.Read(db, tx, config, ct))), ct);

    internal AdminProtectedChange<AdminSiteConfigCommand> Protection(PublicSiteConfiguration config) =>
        new(gate, () => stepUp, AdminStepUpAction.UpdateSiteConfig, PowScope.AdminSiteConfig, CommandDigest,
            _ => SiteConfigPowScope, (_, command, ct) => (db, tx) => CheckSiteConfig(db, tx, config, command, ct));

    internal Task SaveSiteConfig(string? session, PublicSiteConfiguration config, Publications publications,
        AdminSiteConfigCommand command, byte[] frame, string? proof, ScopedPow pow, HttpContext ctx, CancellationToken ct) =>
        publications.AdministrativePublication(async invalidate =>
        {
            var saved = await gate.WithLiveAdmin(session, async (db, tx, admin) =>
            {
                var (current, seo, compliance) = await CheckSiteConfig(db, tx, config, command, ct, forUpdate: true);
                await AdminProtectedChange.Verify(stepUp, db, tx, admin, session, proof, CommandDigest(command),
                    AdminStepUpAction.UpdateSiteConfig, "A current Passkey proof for this exact site configuration change is required.",
                    pow, PowScope.AdminSiteConfig, SiteConfigPowScope, frame, ctx, ct);
                var next = await SiteConfigOverrideStore.Save(db, tx, admin.Id, current, seo, compliance, ct);
                invalidate();
                return next;
            }, ct);
            config.ApplyOverride(saved);
            return true;
        }, ct);

    private static async Task<(PublicSiteConfiguration.Snapshot Current, SiteSeo Seo, SiteCompliance Compliance)>
        CheckSiteConfig(NpgsqlConnection db, NpgsqlTransaction tx, PublicSiteConfiguration config, AdminSiteConfigCommand command,
            CancellationToken ct, bool forUpdate = false)
    {
        var current = await SiteConfigOverrideStore.Read(db, tx, config, ct, forUpdate);
        SiteConfigOverrideStore.RequireMatch(current, command);
        var (nextSeo, nextCompliance) = config.ValidateOverride(command);
        if (PublicSiteConfiguration.ComputeDigest(SiteConfigWire.EncodeSeo(nextSeo), SiteConfigWire.EncodeCompliance(nextCompliance)) == current.Digest)
            throw new BusinessException(Rejection.Invalid, "Change at least one site configuration value before saving.");
        return (current, nextSeo, nextCompliance);
    }

    internal static byte[] CommandDigest(AdminSiteConfigCommand command) => SHA256.HashData(Wire.EncodeAdminSiteConfigCommand(command));
}

internal sealed class AdminAppearanceStore(AdminSessionGate gate, AdminStepUpService stepUp)
{
    private const string AppearancePowScope = "site";

    internal Task<byte[]> ReadAppearance(string? session, AppearanceRegistry registry, CancellationToken ct) =>
        gate.WithLiveAdmin(session, async (db, tx, _) =>
        {
            var current = await AppearanceActivationStore.Read(db, tx, registry, ct);
            var previous = await AppearanceActivationStore.Previous(db, tx, current.Revision, ct);
            var canRollback = previous is not null && previous != current.Selected && registry.IsCurrent(previous);
            return Wire.EncodeAdminAppearanceState(new(current.Revision, current.Selected.ThemeDigest, current.Selected.FontDigest,
                registry.IsCurrent(current.Selected), canRollback, previous?.ThemeDigest ?? "", previous?.FontDigest ?? ""));
        }, ct);

    internal Task<byte[]> AppearanceCatalog(string? session, AppearanceRegistry registry, CancellationToken ct) =>
        gate.WithLiveAdmin(session, (_, _, _) => Task.FromResult(Wire.EncodeAdminAppearanceCatalog(
            registry.Available().Select(entry => new AdminAppearancePackage(entry.Id, entry.Version, entry.ArchiveDigest, entry.Font)).ToArray())), ct);

    internal Task<byte[]> AppearanceFontDetail(string? session, AppearanceRegistry registry, string? digest, CancellationToken ct) =>
        gate.WithLiveAdmin(session, (_, _, _) =>
        {
            if (digest is not { Length: WireLimits.AdminAppearanceDigestBytes } ||
                !digest.All(character => character is >= '0' and <= '9' or >= 'a' and <= 'f'))
                throw new BusinessException(Rejection.Invalid, "Choose an exact font archive digest.");
            var detail = registry.FontDetail(digest) ?? throw new BusinessException(Rejection.NotFound, "The font package is unavailable.");
            return Task.FromResult(Wire.EncodeAdminAppearanceFontDetail(new(detail.Id, detail.Version, detail.ArchiveDigest,
                detail.Name ?? "", detail.Family ?? "", detail.LicenseName, detail.LicenseText, detail.FaceWeight, detail.FaceStyle,
                detail.FaceDigest, detail.FaceBytes, detail.UnicodeRange ?? "", detail.Source?.Kind ?? "", detail.Source?.Package ?? "",
                detail.Source?.Version ?? "", detail.Source?.Upstream ?? "")));
        }, ct);

    internal Task<byte[]> AppearanceHistory(string? session, long? before, int limit, CancellationToken ct) =>
        gate.WithLiveAdmin(session, async (db, tx, _) =>
            Wire.EncodeAdminAppearanceHistory(await AppearanceActivationStore.History(db, tx, before, limit, ct), limit), ct);

    internal AdminProtectedChange<AdminAppearanceCommand> Protection(AppearanceRegistry registry) =>
        new(gate, () => stepUp, AdminStepUpAction.ActivateAppearance, PowScope.AdminAppearance, AppearanceIntentDigest,
            _ => AppearancePowScope, (_, command, ct) => (db, tx) => CheckAppearance(db, tx, registry, command, ct));

    internal Task ApplyAppearance(string? session, AppearanceRegistry registry, AdminAppearanceCommand command, byte[] frame,
        string? proof, ScopedPow pow, HttpContext ctx, CancellationToken ct) =>
        gate.WithLiveAdmin(session, async (db, tx, admin) =>
        {
            var (current, next) = await CheckAppearance(db, tx, registry, command, ct, locked: true);
            await AdminProtectedChange.Verify(stepUp, db, tx, admin, session, proof, AppearanceIntentDigest(command),
                AdminStepUpAction.ActivateAppearance, "A current Passkey proof for this exact appearance change is required.",
                pow, PowScope.AdminAppearance, AppearancePowScope, frame, ctx, ct);
            if (!registry.IsCurrent(next)) throw UnapprovedAppearance();
            await AppearanceActivationStore.Change(db, tx, current, next, admin.Id, command.Rollback, ct);
            return true;
        }, ct);

    private static async Task<(AppearanceActivation, AppearanceSelection)> CheckAppearance(NpgsqlConnection db, NpgsqlTransaction tx,
        AppearanceRegistry registry, AdminAppearanceCommand command, CancellationToken ct, bool locked = false)
    {
        var current = await AppearanceActivationStore.Read(db, tx, registry, ct, locked);
        if (current.Revision != command.ExpectedRevision || current.Selected != new AppearanceSelection(command.CurrentTheme, command.CurrentFont))
            throw new BusinessException(Rejection.Conflict, "The active appearance changed. Reload before applying.");
        var next = new AppearanceSelection(command.Theme, command.Font);
        if (command.Rollback && next != await AppearanceActivationStore.Previous(db, tx, current.Revision, ct))
            throw new BusinessException(Rejection.Conflict, "The previous activation has changed or is unavailable.");
        if (next == current.Selected || !registry.IsCurrent(next)) throw UnapprovedAppearance();
        return (current, next);
    }

    private static BusinessException UnapprovedAppearance() => new(Rejection.Invalid, "Choose an available, different signed appearance.");
    private static byte[] AppearanceIntentDigest(AdminAppearanceCommand command) => SHA256.HashData(Wire.EncodeAdminAppearanceCommand(command));
}

internal sealed class AdminHandleProofRequiredException : ProofRequiredException;

internal sealed partial class AdminHandleStore(AdminSessionGate gate, AdminStepUpService stepUp)
{
    [GeneratedRegex("^[a-z][a-z0-9_.-]{0,63}$", RegexOptions.CultureInvariant)]
    private static partial Regex HandlePattern();

    internal Task<byte[]> BeginRenameStepUp(string? session, AdminHandleCommand command, CancellationToken ct)
    {
        var normalized = NormalizeCommand(command);
        return stepUp.BeginStepUp(session, CommandFingerprint(normalized),
            (db, tx, admin) => VerifyRenamePreconditions(db, tx, admin, normalized, lockPrincipal: false, ct),
            ct, AdminStepUpAction.RenameAdminHandle);
    }

    internal Task<byte[]> CompleteRenameStepUp(string? session, PasskeyLoginRequest assertion, CancellationToken ct) =>
        stepUp.CompleteStepUp(session, assertion, AdminStepUpAction.RenameAdminHandle, ct);

    internal Task<(AdminHandleReceipt Receipt, string PermissionSession)> ExecuteRename(
        string? session, string? proof, AdminHandleCommand command, CancellationToken ct)
    {
        var normalized = NormalizeCommand(command);
        var fingerprint = CommandFingerprint(normalized);
        return gate.WithLiveAdminPermission(session, async (db, tx, admin) =>
        {
            await Store.LockCommand(db, tx, admin.Id, normalized.IdempotencyKey, ct);
            if (await SqlCommands.QueryOne(db, tx, ct, """
                select fingerprint, next_handle, happened_at from public.admin_handle_rename_audit
                where principal_id = $1 and command_id = $2
                """, existing => CryptographicOperations.FixedTimeEquals(fingerprint, existing.GetFieldValue<byte[]>(0))
                    ? new AdminHandleReceipt(existing.GetString(1), existing.GetUnixMilliseconds(2), Replayed: true)
                    : throw new BusinessException(Rejection.Conflict, "This administrator command key is already in use."),
                admin.Id, normalized.IdempotencyKey) is { } replayed)
                return replayed;

            if (!await stepUp.ConsumeProofAsync(db, tx, admin, proof, fingerprint, ct, AdminStepUpAction.RenameAdminHandle))
                throw new AdminHandleProofRequiredException();

            var previousHandle = await VerifyRenamePreconditions(db, tx, admin, normalized, lockPrincipal: true, ct);
            try
            {
                if (await SqlCommands.Execute(db, tx, ct, "update public.admin_principal set handle = $2 where id = $1",
                    admin.Id, normalized.NewHandle) != 1)
                    throw AdminSessionGate.Denied();
            }
            catch (PostgresException error) when (error.SqlState == PostgresErrorCodes.UniqueViolation)
            {
                throw new BusinessException(Rejection.Conflict, "This administrator handle is already in use.");
            }

            var happenedAt = await SqlCommands.QueryRequired(db, tx, ct, """
                insert into public.admin_handle_rename_audit (principal_id, command_id, fingerprint, previous_handle, next_handle)
                values ($1, $2, $3, $4, $5) returning happened_at
                """, r => r.GetFieldValue<DateTimeOffset>(0),
                () => new InvalidOperationException("Failed to record administrator handle rename audit."),
                admin.Id, normalized.IdempotencyKey, fingerprint, previousHandle, normalized.NewHandle);

            await SqlCommands.Execute(db, tx, ct, """
                insert into public.admin_identity_audit (principal_id, action, happened_at, actor)
                values ($1, 'rename-handle', $2, $3)
                """, admin.Id, happenedAt, $"{previousHandle}->{normalized.NewHandle}");

            return new AdminHandleReceipt(normalized.NewHandle, happenedAt.ToUnixTimeMilliseconds(), Replayed: false);
        }, ct);
    }

    internal static AdminHandleCommand NormalizeCommand(AdminHandleCommand command)
    {
        if (command.IdempotencyKey == Guid.Empty)
            throw new BusinessException(Rejection.Invalid, "A command idempotency key is required.");
        var expected = (command.ExpectedHandle ?? "").Trim();
        var next = (command.NewHandle ?? "").Trim();
        if (!HandlePattern().IsMatch(expected) || !HandlePattern().IsMatch(next))
            throw new BusinessException(Rejection.Invalid, "Administrator handle must start with a lowercase letter and use only lowercase letters, digits, '.', '_' or '-'.");
        if (string.Equals(expected, next, StringComparison.Ordinal))
            throw new BusinessException(Rejection.Invalid, "The new administrator handle must differ from the current handle.");
        return new AdminHandleCommand(expected, next, command.IdempotencyKey);
    }

    internal static byte[] CommandFingerprint(AdminHandleCommand normalized) =>
        SHA256.HashData(Wire.EncodeAdminHandleCommand(normalized));

    private static async Task<string> VerifyRenamePreconditions(
        NpgsqlConnection db, NpgsqlTransaction tx, AdminLiveSession admin, AdminHandleCommand normalized,
        bool lockPrincipal, CancellationToken ct)
    {
        var currentHandle = (await SqlCommands.Scalar(db, tx, ct,
            "select handle from public.admin_principal where id = $1" + (lockPrincipal ? " for update" : ""),
            admin.Id) as string) ?? throw AdminSessionGate.Denied();
        if (!string.Equals(currentHandle, normalized.ExpectedHandle, StringComparison.Ordinal))
            throw new BusinessException(Rejection.Conflict, "The administrator handle changed before this update completed.");
        if (await SqlCommands.Scalar(db, tx, ct,
            "select 1 from public.admin_principal where handle = $1 and id <> $2", normalized.NewHandle, admin.Id) is not null)
            throw new BusinessException(Rejection.Conflict, "This administrator handle is already in use.");
        return currentHandle;
    }
}
