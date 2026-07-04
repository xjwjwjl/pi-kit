# SQLKit Local Docker Test Environment

Use this file only when the user explicitly asks to check, start, repair, or create the local SQLKit test databases. Do **not** inspect or start Docker containers by default during unrelated work.

## Scope

This directory owns a local disposable test environment for SQLKit:

- `dev/docker-compose.yml`
- `dev/sqlkit.env`
- MySQL container: `sqlkit-mysql`
- ClickHouse container: `sqlkit-clickhouse`
- Standard host ports:
  - MySQL: `127.0.0.1:3306`
  - ClickHouse HTTP: `127.0.0.1:8123`
  - ClickHouse TCP: `127.0.0.1:9000`

## Docker Routing

When running from Windows, Git Bash, PowerShell, or cmd.exe, route Docker through WSL:

```bash
WIN_PROJECT="$(cygpath -w "$(pwd)" 2>/dev/null || pwd -W 2>/dev/null || pwd)"
wsl.exe --cd "$WIN_PROJECT" --exec bash -s <<'WSL'
set -euo pipefail
# docker commands here
WSL
```

When already inside WSL/Linux, run `docker` and `docker compose` directly.

## Default Rule

Do not check Docker automatically. Only do the steps below after the user asks for local database containers or test environment verification.

## Check Existing Environment

```bash
docker compose --env-file dev/sqlkit.env -f dev/docker-compose.yml ps
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' | grep -E 'sqlkit-|mysql|clickhouse|mariadb|percona' || true
```

If both `sqlkit-mysql` and `sqlkit-clickhouse` are running and healthy, do not recreate them.

## Create Or Start Containers

Before starting, validate the compose file:

```bash
docker compose --env-file dev/sqlkit.env -f dev/docker-compose.yml config >/tmp/sqlkit-compose.yml
```

Start with local images only:

```bash
docker compose --env-file dev/sqlkit.env -f dev/docker-compose.yml up -d --pull never
```

Do not pull images unless the user explicitly asks. If startup fails because an image is missing, list local images and ask what to use:

```bash
docker images --format 'table {{.Repository}}\t{{.Tag}}\t{{.ID}}\t{{.Size}}' | grep -Ei 'mysql|clickhouse|mariadb|percona' || true
```

## Port Conflicts

The test environment expects standard ports. If another MySQL/ClickHouse test container is occupying `3306`, `8123`, or `9000`, ask before stopping it unless the user explicitly said to stop existing DB containers.

Never run `docker compose down`, `down -v`, `--force-recreate`, container prune, or volume cleanup unless the user asks or confirms that local test data can be discarded.

## Readiness Checks

```bash
docker exec sqlkit-mysql mysqladmin ping -h127.0.0.1 -uroot -p'Ck@2o20...' --silent
docker exec sqlkit-mysql mysql -uroot -p'Ck@2o20...' -e "SELECT VERSION() AS version; SHOW DATABASES LIKE 'sqlkit';"

docker exec sqlkit-clickhouse clickhouse-client --user default --password 'Ck@2o20...' --query "SELECT version(), currentDatabase()"
```

## SQLKit Config

For this local project, `.pi/sqlkit.json` should point to:

```json
{
  "sources": [
    {
      "name": "mysql_local",
      "dialect": "mysql",
      "options": {
        "host": "127.0.0.1",
        "port": 3306,
        "user": "root",
        "password": "Ck@2o20...",
        "database": "sqlkit"
      }
    },
    {
      "name": "clickhouse_local",
      "dialect": "clickhouse",
      "options": {
        "host": "127.0.0.1",
        "port": 8123,
        "user": "default",
        "password": "Ck@2o20...",
        "database": "default"
      }
    }
  ]
}
```

Preserve any intentional user edits to `.pi/sqlkit.json`; read it before changing connection settings.
