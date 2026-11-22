namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly SchemaFacts MfaShape = Tables(
        Table("mfa_totp user_id:uuid sealed_seed:bytea last_step:int8 verified_at:timestamptz retry_after:timestamptz failed_count:int4",
            "p user_id",
            "f user_id public.passkey_subject:user_id",
            "c sealed_seed octet_length(sealed_seed)=49",
            "c last_step last_step>=0",
            "c failed_count failed_count>=0ANDfailed_count<=5"),
        Table("mfa_recovery_code user_id:uuid digest:bytea",
            "p user_id,digest",
            "f user_id public.mfa_totp:user_id",
            "c digest octet_length(digest)=32"),
        Table("mfa_setup user_id:uuid generation:int8 session_digest:bytea sealed_seed:bytea expires_at:timestamptz failed_count:int4",
            "p user_id",
            "f user_id public.passkey_subject:user_id",
            "c generation generation>0",
            "c session_digest octet_length(session_digest)=32",
            "c sealed_seed octet_length(sealed_seed)=49",
            "c failed_count failed_count>=0ANDfailed_count<=5"),
        Table("mfa_flow digest:bytea user_id:uuid generation:int8 kind:int4 scope:bytea options:text expires_at:timestamptz",
            "p digest",
            "f user_id public.passkey_subject:user_id",
            "c digest octet_length(digest)=32",
            "c generation generation>0",
            "c kind kind>=1ANDkind<=5",
            "c scope octet_length(scope)>=1ANDoctet_length(scope)<=1055",
            "c options octet_length(options)<=8192"));


}
