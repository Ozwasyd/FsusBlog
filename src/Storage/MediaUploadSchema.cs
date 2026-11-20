namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    internal const string MediaUploadRelation = "public.private_media_upload";
    private static readonly string[] MediaUploadColumns =
    [
        "private_media_upload id:uuid owner_id:uuid command_id:uuid name:text format:int2 length:int4 part_size:int4 digest:bytea expires_at:timestamptz asset_id:uuid? complete:bool=false",
        "private_media_upload_part upload_id:uuid part:int4 digest:bytea bytes:bytea"
    ];

    private static readonly string[] MediaUploadConstraints =
    [
        "private_media_upload p id",
        "private_media_upload u owner_id,command_id",
        "private_media_upload f owner_id public.admin_principal:id",
        "private_media_upload f asset_id public.private_media:id",
        "private_media_upload c name octet_length(name)>=1ANDoctet_length(name)<=255",
        "private_media_upload c format format>=1ANDformat<=2",
        "private_media_upload c length length>=1ANDlength<=20971520",
        "private_media_upload c part_size part_size>=65536ANDpart_size<=2097152",
        "private_media_upload c digest octet_length(digest)=32",
        "private_media_upload_part p upload_id,part",
        "private_media_upload c complete,asset_id NOTcompleteORasset_idISNOTNULL",
        "private_media_upload_part f upload_id public.private_media_upload:id",
        "private_media_upload_part c part part>=0ANDpart<=319",
        "private_media_upload_part c digest octet_length(digest)=32",
        "private_media_upload_part c bytes octet_length(bytes)>=1ANDoctet_length(bytes)<=2097152"
    ];
}
