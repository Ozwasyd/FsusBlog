namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly string[] MfaColumns =
    [
        "mfa_totp user_id:uuid sealed_seed:bytea last_step:int8 verified_at:timestamptz retry_after:timestamptz failed_count:int4",
        "mfa_recovery_code user_id:uuid digest:bytea",
        "mfa_setup user_id:uuid generation:int8 session_digest:bytea sealed_seed:bytea expires_at:timestamptz failed_count:int4",
        "mfa_flow digest:bytea user_id:uuid generation:int8 kind:int4 scope:bytea options:text expires_at:timestamptz"
    ];

    private static readonly string[] MfaConstraints =
    [
        "mfa_totp p user_id",
        "mfa_totp f user_id public.passkey_subject:user_id",
        "mfa_totp c sealed_seed octet_length(sealed_seed)=49",
        "mfa_totp c last_step last_step>=0",
        "mfa_totp c failed_count failed_count>=0ANDfailed_count<=5",
        "mfa_recovery_code p user_id,digest",
        "mfa_recovery_code f user_id public.mfa_totp:user_id",
        "mfa_recovery_code c digest octet_length(digest)=32",
        "mfa_setup p user_id",
        "mfa_setup f user_id public.passkey_subject:user_id",
        "mfa_setup c generation generation>0",
        "mfa_setup c session_digest octet_length(session_digest)=32",
        "mfa_setup c sealed_seed octet_length(sealed_seed)=49",
        "mfa_setup c failed_count failed_count>=0ANDfailed_count<=5",
        "mfa_flow p digest",
        "mfa_flow f user_id public.passkey_subject:user_id",
        "mfa_flow c digest octet_length(digest)=32",
        "mfa_flow c generation generation>0",
        "mfa_flow c kind kind>=1ANDkind<=5",
        "mfa_flow c scope octet_length(scope)>=1ANDoctet_length(scope)<=1055",
        "mfa_flow c options octet_length(options)<=8192"
    ];
}
