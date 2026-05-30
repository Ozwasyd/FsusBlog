#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${FSUSBLOG_PRODUCTION_ENV_FILE:-$ROOT_DIR/.env.production}"
ENV_TEMPLATE="$ROOT_DIR/.env.production-template"

fail() {
  printf '[production-hosts] failed\n' >&2
  printf -- '- %s\n' "$1" >&2
  exit 1
}

read_env_value() {
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

read_env_values_prefix() {
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

trim_value() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  value="${value%\"}"
  value="${value#\"}"
  value="${value%\'}"
  value="${value#\'}"
  printf '%s\n' "$value"
}

host_from_url() {
  local value
  value="$(trim_value "$1")"
  [[ -n "$value" ]] || return 0
  value="${value#http://}"
  value="${value#https://}"
  value="${value%%/*}"
  value="${value%%:*}"
  printf '%s\n' "$value"
}

normalize_host() {
  local raw="$1"
  local host
  host="$(host_from_url "$raw")"
  host="$(trim_value "$host")"
  host="${host%.}"
  host="${host,,}"
  [[ -n "$host" ]] || return 0

  if [[ "$host" == "*" || "$host" == *"*"* ]]; then
    fail "production host must not be a wildcard: $raw"
  fi
  if [[ "$host" == "localhost" || "$host" == *.localhost ]]; then
    fail "production host must not be localhost: $raw"
  fi
  if [[ "$host" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ || "$host" == *:* || "$host" == "["* || "$host" == *"]"* ]]; then
    fail "production host must be a DNS hostname, not an IP literal: $raw"
  fi
  if [[ ! "$host" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]]; then
    fail "invalid production DNS hostname: $raw"
  fi

  printf '%s\n' "$host"
}

collect_hosts() {
  if [[ -n "${FSUSBLOG_LIVE_HOSTS:-}" ]]; then
    tr ',;' '\n' <<<"$FSUSBLOG_LIVE_HOSTS"
    return
  fi

  local site_base cors_hosts app_hosts seo_base fido_domain fido_origins
  site_base="$(read_env_value SITE_BASEURL)"
  cors_hosts="$(read_env_value CORS_ALLOWED_HOSTS)"
  app_hosts="$(read_env_value APP_ALLOWED_HOSTS)"
  seo_base="$(read_env_value Seo__BaseUrl)"
  fido_domain="$(read_env_value FIDO2_SERVER_DOMAIN)"
  [[ -n "$fido_domain" ]] || fido_domain="$(read_env_value Fido2__ServerDomain)"
  fido_origins="$(read_env_value FIDO2_ORIGINS)"

  [[ -n "$site_base" ]] && host_from_url "$site_base"
  [[ -n "$seo_base" ]] && host_from_url "$seo_base"
  [[ -n "$fido_domain" ]] && host_from_url "$fido_domain"
  if [[ -n "$cors_hosts" ]]; then
    tr ',' '\n' <<<"$cors_hosts" | while read -r origin; do
      [[ -n "$origin" ]] && host_from_url "$origin"
    done
  fi
  if [[ -n "$app_hosts" ]]; then
    tr ';,' '\n' <<<"$app_hosts"
  fi
  if [[ -n "$fido_origins" ]]; then
    tr ';,' '\n' <<<"$fido_origins" | while read -r origin; do
      [[ -n "$origin" ]] && host_from_url "$origin"
    done
  fi
  read_env_values_prefix 'Fido2__Origins__' | while read -r origin; do
    [[ -n "$origin" ]] && host_from_url "$origin"
  done
}

collect_hosts | while read -r candidate; do
  normalize_host "$candidate"
done | sort -u
