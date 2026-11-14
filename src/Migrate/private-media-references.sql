CREATE TABLE public.article_revision_media (
    article_id integer NOT NULL,
    revision bigint NOT NULL,
    asset_id uuid NOT NULL REFERENCES public.private_media (id),
    PRIMARY KEY (article_id, revision, asset_id),
    FOREIGN KEY (article_id, revision) REFERENCES public.article_revision (article_id, revision)
);

CREATE INDEX article_revision_media_asset ON public.article_revision_media (asset_id);
