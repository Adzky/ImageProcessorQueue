#!/bin/sh
set -e
# Separate database for the backend test suite, so tests never touch demo data.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -c "CREATE DATABASE images_test OWNER $POSTGRES_USER;"
