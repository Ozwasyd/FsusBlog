namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly string[] MediaColumns =
    [
        "private_media id:uuid owner_id:uuid command_id:uuid request_hash:bytea content_hash:bytea name:text format:int2 length:int4 width:int4 height:int4 phase:int2 created_at:timestamptz=now"
    ];

    private static readonly string[] MediaConstraints =
    [
        "private_media p id",
        "private_media u owner_id,command_id",
        "private_media f owner_id public.blog_user:id",
        "private_media c request_hash octet_length(request_hash)=32",
        "private_media c content_hash octet_length(content_hash)=32",
        "private_media c name octet_length(name)>=1ANDoctet_length(name)<=255",
        "private_media c length length>=1ANDlength<=20971520",
        "private_media c format format>=1ANDformat<=2",
        "private_media c width width>=1ANDwidth<=8192",
        "private_media c height height>=1ANDheight<=8192",
        "private_media c phase phase>=0ANDphase<=3"
    ];

    private static string WithWebpFormat(string constraint) => constraint switch
    {
        "private_media c format format>=1ANDformat<=2" or
        "private_media_upload c format format>=1ANDformat<=2" or
        "article_publication_media c format format>=1ANDformat<=2" => constraint[..^1] + "3",
        _ => constraint
    };
}
