CREATE TABLE public.site_traffic_daily (
    day date NOT NULL CHECK (isfinite(day)),
    region text NOT NULL CHECK (region ~ '^([A-Z]{2}(-[A-Z0-9]{1,3})?|unknown)$'),
    views bigint NOT NULL CHECK (views > 0),
    PRIMARY KEY (day, region)
);
