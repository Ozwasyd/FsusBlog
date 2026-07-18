#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${FSUSBLOG_PRODUCTION_ENV_FILE:-$ROOT_DIR/.env.production}"
ENV_TEMPLATE="$ROOT_DIR/.env.production.example"

Fail() {
    printf '[production-hosts] failed\n' >&2
    printf -- '- %s\n' "$1" >&2
    exit 1
}

ReadEnvValue() {
    local key="$1"
    local source=""
    if [[ -f "$ENV_FILE" ]]; then
        source="$ENV_FILE"
    elif [[ -f "$ENV_TEMPLATE" ]]; then
        source="$ENV_TEMPLATE"
    fi

    [[ -n "$source" ]] || return 0
    grep -E "^${key}=" "$source" | tail -n 1 | cut -d= -f2- || true
}

ReadEnvValuesPrefix() {
    local prefix="$1"
    local source=""
    if [[ -f "$ENV_FILE" ]]; then
        source="$ENV_FILE"
    elif [[ -f "$ENV_TEMPLATE" ]]; then
        source="$ENV_TEMPLATE"
    fi

    [[ -n "$source" ]] || return 0
    grep -E "^${prefix}" "$source" | cut -d= -f2- || true
}

TrimValue() {
    local value="$1"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    value="${value%\"}"
    value="${value#\"}"
    value="${value%\'}"
    value="${value#\'}"
    printf '%s\n' "$value"
}

HostFromUrl() {
    local value
    value="$(TrimValue "$1")"
    [[ -n "$value" ]] || return 0
    value="${value#http://}"
    value="${value#https://}"
    value="${value%%/*}"
    value="${value%%:*}"
    printf '%s\n' "$value"
}

NormalizeHost() {
    local raw="$1"
    local host
    host="$(HostFromUrl "$raw")"
    host="$(TrimValue "$host")"
    host="${host%.}"
    host="${host,,}"
    [[ -n "$host" ]] || return 0

    if [[ "$host" == "*" || "$host" == *"*"* ]]; then
        Fail "production host must not be a wildcard: $raw"
    fi
    if [[ "$host" == "localhost" || "$host" == *.localhost ]]; then
        Fail "production host must not be localhost: $raw"
    fi
    if [[ "$host" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ || "$host" == *:* || "$host" == "["* || "$host" == *"]"* ]]; then
        Fail "production host must be a DNS hostname, not an IP literal: $raw"
    fi
    if [[ ! "$host" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]]; then
        Fail "invalid production DNS hostname: $raw"
    fi

    printf '%s\n' "$host"
}

CollectHosts() {
    if [[ -n "${FSUSBLOG_LIVE_HOSTS:-}" ]]; then
        tr ',;' '\n' <<<"$FSUSBLOG_LIVE_HOSTS"
        return
    fi

    local siteBase corsHosts appHosts seoBase fidoDomain fidoOrigins
    siteBase="$(ReadEnvValue SITE_BASEURL)"
    corsHosts="$(ReadEnvValue CORS_ALLOWED_HOSTS)"
    appHosts="$(ReadEnvValue APP_ALLOWED_HOSTS)"
    seoBase="$(ReadEnvValue Seo__BaseUrl)"
    fidoDomain="$(ReadEnvValue FIDO2_SERVER_DOMAIN)"
    [[ -n "$fidoDomain" ]] || fidoDomain="$(ReadEnvValue Fido2__ServerDomain)"
    fidoOrigins="$(ReadEnvValue FIDO2_ORIGINS)"

    [[ -n "$siteBase" ]] && HostFromUrl "$siteBase"
    [[ -n "$seoBase" ]] && HostFromUrl "$seoBase"
    [[ -n "$fidoDomain" ]] && HostFromUrl "$fidoDomain"
    if [[ -n "$corsHosts" ]]; then
        tr ',' '\n' <<<"$corsHosts" | while read -r origin; do
            [[ -n "$origin" ]] && HostFromUrl "$origin"
        done
    fi
    if [[ -n "$appHosts" ]]; then
        tr ';,' '\n' <<<"$appHosts"
    fi
    if [[ -n "$fidoOrigins" ]]; then
        tr ';,' '\n' <<<"$fidoOrigins" | while read -r origin; do
            [[ -n "$origin" ]] && HostFromUrl "$origin"
        done
    fi
    ReadEnvValuesPrefix 'Fido2__Origins__' | while read -r origin; do
        [[ -n "$origin" ]] && HostFromUrl "$origin"
    done
}

CollectHosts | while read -r candidate; do
    NormalizeHost "$candidate"
done | sort -u
