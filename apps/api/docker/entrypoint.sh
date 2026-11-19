#!/bin/sh
set -e

# Wait for Postgres (max ~30s) so the container never boots against a missing DB.
i=0
until php -r 'try { new PDO("pgsql:host=".getenv("DB_HOST").";port=".(getenv("DB_PORT") ?: 5432).";dbname=".getenv("DB_DATABASE"), getenv("DB_USERNAME"), getenv("DB_PASSWORD")); } catch (Throwable $e) { exit(1); }' 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -ge 30 ]; then echo "Postgres not reachable after 30s" >&2; exit 1; fi
  sleep 1
done

mkdir -p storage/app/images/uploads storage/app/images/results

if [ "${RUN_MIGRATIONS:-false}" = "true" ]; then
  php artisan migrate --force
fi

exec "$@"
