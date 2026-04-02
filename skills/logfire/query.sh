#!/usr/bin/env bash
set -euo pipefail

# LogFire Query API wrapper
# Reads LOGFIRE_READ_TOKEN from .env in current directory
# Usage: query.sh <sql> [limit]

SQL="${1:?Usage: query.sh '<sql>' [limit]}"
LIMIT="${2:-100}"

# Load .env from current working directory
if [[ -f .env ]]; then
    LOGFIRE_READ_TOKEN=$(grep '^LOGFIRE_READ_TOKEN=' .env | cut -d'=' -f2- | tr -d '"' | tr -d "'")
fi

if [[ -z "${LOGFIRE_READ_TOKEN:-}" ]]; then
    echo "ERROR: LOGFIRE_READ_TOKEN not found in .env or environment" >&2
    echo "See https://pydantic.dev/docs/logfire/manage/query-api/#via-cli to generate a read token" >&2
    exit 1
fi

# Determine API base URL from token region
# Token format: pylf_v<version>_<region>_<secret>
REGION=$(echo "$LOGFIRE_READ_TOKEN" | sed -n 's/^pylf_v[0-9]*_\([a-z]*\)_.*/\1/p')
case "$REGION" in
    eu) BASE_URL="https://logfire-eu.pydantic.dev" ;;
    us) BASE_URL="https://logfire-us.pydantic.dev" ;;
    *)  BASE_URL="https://logfire-us.pydantic.dev" ;;
esac

curl -s -G "${BASE_URL}/v1/query" \
    -H "Authorization: Bearer ${LOGFIRE_READ_TOKEN}" \
    --data-urlencode "sql=${SQL}" \
    --data-urlencode "limit=${LIMIT}" \
    --data-urlencode "json_rows=true"
