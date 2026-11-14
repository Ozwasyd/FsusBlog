namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly string[] PasskeyColumns =
    [
        "passkey_subject user_id:uuid account_id:int4:d user_handle:bytea",
        "passkey_credential credential_id:bytea user_id:uuid public_key:bytea sign_count:int8 backup_eligible:bool backed_up:bool created_at:timestamptz=now last_used_at:timestamptz?",
        "passkey_challenge digest:bytea user_id:uuid? generation:int8? options:text expires_at:timestamptz binding_digest:bytea?"
    ];

    private static readonly string[] PasskeyConstraints =
    [
        "passkey_subject p user_id",
        "passkey_subject u account_id",
        "passkey_subject u user_handle",
        "passkey_subject f user_id public.blog_user:id",
        "passkey_subject c account_id account_id>0",
        "passkey_subject c user_handle octet_length(user_handle)=32",
        "passkey_credential p credential_id",
        "passkey_credential u credential_id,user_id",
        "passkey_credential f user_id public.passkey_subject:user_id",
        "passkey_credential c credential_id octet_length(credential_id)>=1ANDoctet_length(credential_id)<=1023",
        "passkey_credential c public_key octet_length(public_key)>=1ANDoctet_length(public_key)<=16384",
        "passkey_credential c sign_count sign_count>=0ANDsign_count<='4294967295'::bigint",
        "passkey_credential c backed_up,backup_eligible NOTbacked_upORbackup_eligible",
        "passkey_challenge p digest",
        "passkey_challenge f user_id public.passkey_subject:user_id",
        "passkey_challenge c digest octet_length(digest)=32",
        "passkey_challenge c options octet_length(options)>=1ANDoctet_length(options)<=8192",
        "passkey_challenge c binding_digest octet_length(binding_digest)=32",
        "passkey_challenge c user_id,generation,binding_digest user_idISNULLANDgenerationISNULLANDbinding_digestISNULLORuser_idISNOTNULLANDgenerationISNOTNULLANDgeneration>0ANDbinding_digestISNOTNULL",
        "user_session f passkey_credential_id,user_id public.passkey_credential:credential_id,user_id"
    ];
}
