# The studio app: web and worker run from this one image (different commands, see docker-compose.yml).
# Contains what the app starts as child programs: ffmpeg/ffprobe, pg_dump 17 (backups), and Claude Code (pinned to the version the
# login flow was tested with). No Docker CLI: renders go through the render service (infra/Dockerfile.render-runner), the only
# container with the socket.
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

# On OrbStack the Docker socket's group is root (gid 0), so the worker's app user joins group root to start renders. Make sure that
# group gives it nothing else: drop group-root write bits everywhere (the base image leaves a few, e.g. man folders), and fail the build
# if any remain. The socket itself is mounted at run time, so it keeps its own permissions.
RUN find / -xdev \( -path /proc -o -path /sys -o -path /dev \) -prune -o -group 0 -perm -g+w ! -perm -o+w -exec chmod g-w {} + \
 && test -z "$(find / -xdev \( -path /proc -o -path /sys -o -path /dev \) -prune -o -group 0 -perm -g+w ! -perm -o+w -print)"

WORKDIR /app
COPY --chown=app:app package.json package-lock.json ./
# Dev dependencies stay: tsx runs the worker and the setup scripts.
# onnxruntime-node would download a CUDA binary from a GitHub release that is gone (404); the CPU build ships in the package.
ENV npm_config_onnxruntime_node_install_cuda=skip
RUN npm ci --no-audit --no-fund && chown -R app:app /app
COPY --chown=app:app . .
ENV NEXT_TELEMETRY_DISABLED=1
USER app
RUN npm run build

ENV NODE_ENV=production \
    HOME=/home/app \
    STORAGE_ROOT=/data
# host.docker.internal counts as "this computer" only here: the container's hosts file pins it (voicestudio.ts isLoopbackHost).
ENV YTSTUDIO_IN_CONTAINER=1
EXPOSE 3000
CMD ["npm", "run", "start:container"]
