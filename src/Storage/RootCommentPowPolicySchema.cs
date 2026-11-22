namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly SchemaFacts RootCommentPowPolicyShape = Tables(
        Table("root_comment_pow_policy singleton:bool generation:int8 proof_seconds:int4",
            "p singleton",
            "c singleton singleton",
            "c generation generation>0",
            "c proof_seconds proof_seconds>=60ANDproof_seconds<=120"),
        Table("root_comment_pow_policy_audit generation:int8 principal_id:uuid previous_seconds:int4 proof_seconds:int4 rollback:bool happened_at:timestamptz",
            "p generation",
            "f principal_id public.admin_principal:id",
            "c generation generation>1",
            "c previous_seconds previous_seconds>=60ANDprevious_seconds<=120",
            "c proof_seconds proof_seconds>=60ANDproof_seconds<=120",
            "c previous_seconds,proof_seconds previous_seconds<>proof_seconds"),
        StepUpShape("admin_root_comment_pow_step_up", "action=9"));

    private static readonly RelationGroup RootCommentPowPolicyRelations = new(
        "The root comment proof policy schema is partially installed.",
        "public.root_comment_pow_policy", "public.root_comment_pow_policy_audit", "public.admin_root_comment_pow_step_up");

    private static readonly CatalogInvariant RootCommentPowPolicy = new(
        """
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
            """,
        "The root comment proof policy activation history is incomplete.");
}
