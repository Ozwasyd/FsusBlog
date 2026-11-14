CREATE TABLE public.authoring_recovery_site (
    singleton boolean PRIMARY KEY CHECK (singleton),
    site_id uuid NOT NULL
);

INSERT INTO public.authoring_recovery_site (singleton, site_id)
VALUES (true, pg_catalog.gen_random_uuid());
