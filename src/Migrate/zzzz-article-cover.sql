CREATE TABLE public.article_revision_cover (
    article_id integer NOT NULL,
    revision bigint NOT NULL,
    asset_id uuid NOT NULL,
    PRIMARY KEY (article_id, revision),
    FOREIGN KEY (article_id, revision, asset_id) REFERENCES public.article_revision_media (article_id, revision, asset_id)
);
