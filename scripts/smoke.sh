#!/usr/bin/env bash
# Startar en temporär Postgres och rökprovar den körbara tjänsten (admin-verktyg, server, API, nedstängning).
cd "$(dirname "$0")/.."
PG_RUN_CMD="bash scripts/smoke-steps.sh" exec bash scripts/pg-test.sh
