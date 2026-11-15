ALTER TABLE public.private_media
    ALTER COLUMN command_id DROP NOT NULL,
    ALTER COLUMN request_hash DROP NOT NULL,
    ADD COLUMN import_origin_id uuid,
    ADD UNIQUE (import_origin_id, owner_id),
    ADD CONSTRAINT private_media_origin_type CHECK (
        CASE WHEN import_origin_id IS NULL
            THEN command_id IS NOT NULL AND request_hash IS NOT NULL
            ELSE command_id IS NULL AND request_hash IS NULL AND import_origin_id = id AND phase > 0
        END
    );

CREATE TABLE public.private_media_import (
    asset_id uuid PRIMARY KEY,
    owner_id uuid NOT NULL,
    source_site_id uuid NOT NULL,
    target_site_id uuid NOT NULL CHECK (target_site_id <> source_site_id),
    source_owner_id bigint NOT NULL CHECK (source_owner_id > 0),
    activation_sha256 bytea NOT NULL CHECK (octet_length(activation_sha256) = 32),
    plan_sha256 bytea NOT NULL CHECK (octet_length(plan_sha256) = 32),
    projection_sha256 bytea NOT NULL CHECK (octet_length(projection_sha256) = 32),
    custody_manifest_sha256 bytea NOT NULL CHECK (octet_length(custody_manifest_sha256) = 32),
    request_sha256 bytea NOT NULL CHECK (octet_length(request_sha256) = 32),
    prepared_manifest_sha256 bytea NOT NULL CHECK (octet_length(prepared_manifest_sha256) = 32),
    normalizer_sha256 bytea NOT NULL CHECK (octet_length(normalizer_sha256) = 32),
    raw_sha256 bytea NOT NULL CHECK (octet_length(raw_sha256) = 32),
    FOREIGN KEY (asset_id, owner_id) REFERENCES public.private_media(import_origin_id, owner_id)
        DEFERRABLE INITIALLY DEFERRED
);

ALTER TABLE public.private_media ADD FOREIGN KEY (import_origin_id) REFERENCES public.private_media_import(asset_id);

CREATE TABLE public.article_revision_media_import (
    article_id integer NOT NULL,
    revision bigint NOT NULL,
    asset_id uuid NOT NULL REFERENCES public.private_media_import(asset_id),
    source_revision_id bigint NOT NULL CHECK (source_revision_id > 0),
    reference_count integer NOT NULL CHECK (reference_count > 0),
    alt_text text CHECK (char_length(alt_text) <= 256),
    PRIMARY KEY (article_id, revision, asset_id),
    UNIQUE (asset_id, source_revision_id),
    FOREIGN KEY (article_id, revision, asset_id) REFERENCES public.article_revision_media(article_id, revision, asset_id)
);
