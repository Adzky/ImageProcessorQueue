# syntax=docker/dockerfile:1

# ---- base: PHP runtime + extensions + composer (also used by the test service) ----
FROM dunglas/frankenphp:1-php8.4 AS base

RUN install-php-extensions pcntl imagick pdo_pgsql redis intl zip opcache \
 && php -r 'exit(version_compare(PHP_VERSION, "8.4.27", "<") ? 1 : 0);' \
 || (echo "PHP >= 8.4.27 required, got $(php -r 'echo PHP_VERSION;')" >&2 && exit 1)

COPY --from=composer:2 /usr/bin/composer /usr/bin/composer
COPY docker/php.ini $PHP_INI_DIR/conf.d/zz-app.ini
COPY docker/Caddyfile /etc/frankenphp/Caddyfile

ENV COMPOSER_ALLOW_SUPERUSER=1
WORKDIR /app

# ---- app: production image for api / worker / scheduler ----
FROM base AS app

COPY composer.json composer.lock ./
RUN composer install --no-dev --no-scripts --no-autoloader --no-interaction --prefer-dist

COPY . .
RUN composer dump-autoload --optimize --no-dev \
 && php artisan package:discover --ansi \
 && mkdir -p storage/app/images/uploads storage/app/images/results storage/framework/cache storage/framework/views storage/framework/sessions storage/logs bootstrap/cache \
 && chown -R www-data:www-data storage bootstrap/cache

ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["frankenphp", "run", "--config", "/etc/frankenphp/Caddyfile"]
