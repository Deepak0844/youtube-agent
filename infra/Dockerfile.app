# The studio app: web and worker run from this one image (different commands, see docker-compose.yml).
# Contains what the app starts as child programs: ffmpeg/ffprobe, the Docker CLI (the worker starts the render container
# through the host's socket), pg_dump 17 (backups), and Claude Code (pinned to the version the login flow was tested with).
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl gnupg \
 && rm -rf /var/lib/apt/lists/*

# PGDG's client, because Debian's own pg_dump is 15 and refuses to dump a Postgres 17 server. Own layer, with retries: the key
# download is the one step here that depends on a third-party host.
RUN install -d /usr/share/keyrings \
 && curl -fsSL --retry 5 --retry-all-errors --retry-delay 3 https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /usr/share/keyrings/pgdg.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-17 \
 && apt-get purge -y curl gnupg && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

# Static client binary only; the daemon is the host's.
COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker

RUN npm i -g @anthropic-ai/claude-code@2.1.207 --no-audit --no-fund && claude --version

# The app user. uid/gid are build arguments: on Linux the bind-mounted data folder belongs to the host user, so the wrapper
# (npm run compose:up) passes that uid/gid; the default suits macOS. The base image's own `node` user is removed so a host
# uid of 1000 does not collide with it. /home/app is owned by the app user: a named volume copies that ownership on first
# use, and a root-owned HOME makes claude read as "Not logged in".
ARG APP_UID=10002
ARG APP_GID=10002
RUN (userdel -r node || true) \
 && groupadd -g "$APP_GID" app \
 && useradd -m -u "$APP_UID" -g "$APP_GID" -s /bin/bash app \
 && mkdir /data && chown app:app /data

WORKDIR /app
COPY --chown=app:app package.json package-lock.json ./
# Dev dependencies stay: tsx runs the worker and the setup scripts.
RUN npm ci --no-audit --no-fund && chown -R app:app /app
COPY --chown=app:app . .
ENV NEXT_TELEMETRY_DISABLED=1
USER app
RUN npm run build

ENV NODE_ENV=production \
    HOME=/home/app \
    STORAGE_ROOT=/data
EXPOSE 3000
CMD ["npm", "run", "start:container"]
