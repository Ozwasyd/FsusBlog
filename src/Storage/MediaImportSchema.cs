namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly string[] PrivateMediaImportColumns =
    [
        "private_media id:uuid owner_id:uuid command_id:uuid? request_hash:bytea? content_hash:bytea name:text format:int2 length:int4 width:int4 height:int4 phase:int2 created_at:timestamptz=now import_origin_id:uuid?",
        "private_media_import asset_id:uuid owner_id:uuid source_site_id:uuid target_site_id:uuid source_owner_id:int8 activation_sha256:bytea plan_sha256:bytea projection_sha256:bytea custody_manifest_sha256:bytea request_sha256:bytea prepared_manifest_sha256:bytea normalizer_sha256:bytea raw_sha256:bytea",
        "article_revision_media_import article_id:int4 revision:int8 asset_id:uuid source_revision_id:int8 reference_count:int4 alt_text:text?",
    ];

    private static readonly string[] PrivateMediaImportConstraints =
    [
        "private_media u import_origin_id,owner_id",
        "private_media c import_origin_id,command_id,request_hash,id,phase CASEWHENimport_origin_idISNULLTHENcommand_idISNOTNULLANDrequest_hashISNOTNULLELSEcommand_idISNULLANDrequest_hashISNULLANDimport_origin_id=idANDphase>0END",
        "private_media f import_origin_id public.private_media_import:asset_id",
        "private_media_import p asset_id",
        "private_media_import f asset_id,owner_id public.private_media:import_origin_id,owner_id deferred",
        "private_media_import c target_site_id,source_site_id target_site_id<>source_site_id",
        "private_media_import c source_owner_id source_owner_id>0",
        "private_media_import c activation_sha256 octet_length(activation_sha256)=32",
        "private_media_import c plan_sha256 octet_length(plan_sha256)=32",
        "private_media_import c projection_sha256 octet_length(projection_sha256)=32",
        "private_media_import c custody_manifest_sha256 octet_length(custody_manifest_sha256)=32",
        "private_media_import c request_sha256 octet_length(request_sha256)=32",
        "private_media_import c prepared_manifest_sha256 octet_length(prepared_manifest_sha256)=32",
        "private_media_import c normalizer_sha256 octet_length(normalizer_sha256)=32",
        "private_media_import c raw_sha256 octet_length(raw_sha256)=32",
        "article_revision_media_import p article_id,revision,asset_id",
        "article_revision_media_import u asset_id,source_revision_id",
        "article_revision_media_import f asset_id public.private_media_import:asset_id",
        "article_revision_media_import f article_id,revision,asset_id public.article_revision_media:article_id,revision,asset_id",
        "article_revision_media_import c source_revision_id source_revision_id>0",
        "article_revision_media_import c reference_count reference_count>0",
        "article_revision_media_import c alt_text char_length(alt_text)<=256",
    ];

    private static readonly string[] PrivateMediaImportRelations =
        ["public.private_media_import", "public.article_revision_media_import"];

    private static bool HasPrivateMediaImportOrigin(CatalogPresenceSnapshot catalog) =>
        catalog.HasCompleteRelations("The imported private media origin schema is incomplete.", PrivateMediaImportRelations);
}
