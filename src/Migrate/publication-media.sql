ALTER TABLE public.article_publication_history
    ADD CONSTRAINT article_publication_history_media_coordinates UNIQUE (article_id, publication_id, revision);

CREATE TABLE public.article_publication_media (
    article_id integer NOT NULL,
    publication_id bigint NOT NULL,
    revision bigint NOT NULL,
    ordinal integer NOT NULL CHECK (ordinal >= 1 AND ordinal <= 32),
    asset_id uuid NOT NULL,
    content_hash bytea NOT NULL CHECK (octet_length(content_hash) = 32),
    format smallint NOT NULL CHECK (format >= 1 AND format <= 2),
    length integer NOT NULL CHECK (length >= 1 AND length <= 20971520),
    width integer NOT NULL CHECK (width >= 1 AND width <= 8192),
    height integer NOT NULL CHECK (height >= 1 AND height <= 8192),
    PRIMARY KEY (article_id, publication_id, ordinal),
    UNIQUE (article_id, publication_id, asset_id),
    UNIQUE (article_id, publication_id, content_hash),
    FOREIGN KEY (article_id, publication_id, revision)
        REFERENCES public.article_publication_history (article_id, publication_id, revision),
    FOREIGN KEY (article_id, revision, asset_id)
        REFERENCES public.article_revision_media (article_id, revision, asset_id)
);
