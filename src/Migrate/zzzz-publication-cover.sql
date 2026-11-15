CREATE TABLE public.article_publication_cover (
    article_id integer NOT NULL,
    publication_id bigint NOT NULL,
    asset_id uuid NOT NULL,
    PRIMARY KEY (article_id, publication_id),
    FOREIGN KEY (article_id, publication_id, asset_id)
        REFERENCES public.article_publication_media (article_id, publication_id, asset_id)
);

ALTER TABLE public.article_publication_canonical
    DROP CONSTRAINT article_publication_canonical_canonical_version_check,
    ADD CONSTRAINT article_publication_canonical_canonical_version_check CHECK (canonical_version IN (2,3));
