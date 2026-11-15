using System;
using System.Threading;
using System.Threading.Tasks;
using Npgsql;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly string[] RootCommentPowPolicyColumns =
    [
        "root_comment_pow_policy singleton:bool generation:int8 proof_seconds:int4",
        "root_comment_pow_policy_audit generation:int8 principal_id:uuid previous_seconds:int4 proof_seconds:int4 rollback:bool happened_at:timestamptz",
        "admin_root_comment_pow_step_up digest:bytea principal_id:uuid session_digest:bytea generation:int8 action:int4 body_digest:bytea options:text? expires_at:timestamptz kind:int2"
    ];

    private static readonly string[] RootCommentPowPolicyConstraints =
    [
        "root_comment_pow_policy p singleton",
        "root_comment_pow_policy c singleton singleton",
        "root_comment_pow_policy c generation generation>0",
        "root_comment_pow_policy c proof_seconds proof_seconds>=60ANDproof_seconds<=120",
        "root_comment_pow_policy_audit p generation",
        "root_comment_pow_policy_audit f principal_id public.admin_principal:id",
        "root_comment_pow_policy_audit c generation generation>1",
        "root_comment_pow_policy_audit c previous_seconds previous_seconds>=60ANDprevious_seconds<=120",
        "root_comment_pow_policy_audit c proof_seconds proof_seconds>=60ANDproof_seconds<=120",
        "root_comment_pow_policy_audit c previous_seconds,proof_seconds previous_seconds<>proof_seconds",
        "admin_root_comment_pow_step_up p digest",
        "admin_root_comment_pow_step_up f principal_id public.admin_principal:id",
        "admin_root_comment_pow_step_up f session_digest public.admin_session:digest delete-cascade",
        "admin_root_comment_pow_step_up u session_digest,kind",
        "admin_root_comment_pow_step_up c digest octet_length(digest)=32",
        "admin_root_comment_pow_step_up c session_digest octet_length(session_digest)=32",
        "admin_root_comment_pow_step_up c generation generation>0",
        "admin_root_comment_pow_step_up c action action=9",
        "admin_root_comment_pow_step_up c body_digest octet_length(body_digest)=32",
        "admin_root_comment_pow_step_up c options octet_length(options)>=1ANDoctet_length(options)<=8192",
        "admin_root_comment_pow_step_up c kind,options kind=1ANDoptionsISNOTNULLORkind=2ANDoptionsISNULL"
    ];

    internal static async Task<bool> HasRootCommentPowPolicyAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct)
    {
        await using var command = new NpgsqlCommand("""
            select num_nonnulls(pg_catalog.to_regclass('public.root_comment_pow_policy'),
              pg_catalog.to_regclass('public.root_comment_pow_policy_audit'),pg_catalog.to_regclass('public.admin_root_comment_pow_step_up'))
            """, db, tx);
        return await command.ExecuteScalarAsync(ct) switch
        {
            0 => false,
            3 => true,
            _ => throw new InvalidOperationException("The root comment proof policy schema is partially installed.")
        };
    }

    private static async Task VerifyRootCommentPowPolicyAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct)
    {
        await using var command = new NpgsqlCommand("""
            with audit as (
              select generation,proof_seconds,previous_seconds,rollback,
                lag(generation,1,1::bigint) over history as prior_generation,
                lag(proof_seconds,1,120) over history as prior_seconds,
                lag(previous_seconds) over history as rollback_seconds
              from public.root_comment_pow_policy_audit
              window history as (order by generation)
            )
            select exists (select from public.root_comment_pow_policy p where p.singleton and
                p.generation=coalesce((select max(generation) from audit),1)
                and (p.generation=1 and p.proof_seconds=120 or exists (
                  select from audit a where a.generation=p.generation and a.proof_seconds=p.proof_seconds)))
              and not exists (select from audit where generation<>prior_generation+1 or previous_seconds<>prior_seconds
                or rollback and proof_seconds is distinct from rollback_seconds)
            """, db, tx);
        if (await command.ExecuteScalarAsync(ct) is not true)
            throw new InvalidOperationException("The root comment proof policy activation history is incomplete.");
    }
}
