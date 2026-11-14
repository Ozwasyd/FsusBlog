#!/usr/bin/env bash
# Sourced by legacy-source.sh. The only MySQL endpoint is the caller's new private directory.
mysql_pid=
mysql_admin=()

check_mysql_tools() {
    if [[ -n "${MYSQL_TOOLS_DIR:-}" ]]; then
        PATH="$MYSQL_TOOLS_DIR:$PATH"
    fi
    command -v mysqld mysql mysqladmin >/dev/null
}

start_mysql_scratch() {
    local dir="$1" basedir provision status_flags
    basedir="$(cd "$(dirname "$(command -v mysqld)")/.." && pwd -P)"
    local common=(--no-defaults --basedir="$basedir" --datadir="$dir/mysql-data")
    if ! mysqld "${common[@]}" --initialize-insecure --log-error="$dir/mysql-init.log"; then
        if [[ -f "$dir/mysql-init.log" ]]; then tail -30 "$dir/mysql-init.log" >&2; fi
        return 1
    fi
    # The private socket is reachable solely by the owner of its containing directory.
    local server=(--socket="$dir/mysql.sock" --pid-file="$dir/mysql.pid" --log-error="$dir/mysql-server.log"
        --skip-networking --mysqlx=OFF --skip-log-bin --default-storage-engine=InnoDB)
    mysqld "${common[@]}" "${server[@]}" &
    mysql_pid=$!
    mysql_admin=(mysql --no-defaults --no-login-paths --protocol=SOCKET --socket="$dir/mysql.sock"
        --user=root --default-character-set=utf8mb4)
    for ((provision=0; provision<100; ++provision)); do
        if [[ -S "$dir/mysql.sock" ]] && "${mysql_admin[@]}" -NB -e 'SELECT 1' >/dev/null 2>&1; then
            status_flags=$("${mysql_admin[@]}" -NB -e 'SELECT VERSION(), @@skip_networking, @@datadir')
            if [[ "$status_flags" == *$'\t1\t'"$dir/mysql-data/" ]]; then
                printf 'Isolated MySQL listening via private socket: %s\n' "$status_flags"
                return 0
            fi
            printf 'Unexpected MySQL server settings: %s\n' "$status_flags" >&2
            return 1
        fi
        kill -0 "$mysql_pid" 2>/dev/null || break
        sleep 0.2
    done
    if [[ -f "$dir/mysql-server.log" ]]; then
        tail -30 "$dir/mysql-server.log" >&2
    fi
    return 1
}

stop_mysql_scratch() {
    local dir="$1" socket_pid pending
    if [[ -n "$mysql_pid" ]] && kill -0 "$mysql_pid" 2>/dev/null; then
        if [[ -S "$dir/mysql.sock" && -f "$dir/mysql.pid" ]] &&
           read -r socket_pid < "$dir/mysql.pid" && [[ "$socket_pid" == "$mysql_pid" ]]; then
            local admin=(--no-defaults --no-login-paths --protocol=SOCKET --socket="$dir/mysql.sock"
                --user=root --connect-timeout=2 --shutdown-timeout=10)
            mysqladmin "${admin[@]}" shutdown || return 1
        else
            # mysql_pid is our direct child; this path covers partial server startup.
            kill -TERM "$mysql_pid" || return 1
        fi
        for ((pending=0; pending<50; ++pending)); do
            if ! kill -0 "$mysql_pid" 2>/dev/null; then break; fi
            sleep 0.2
        done
        if kill -0 "$mysql_pid" 2>/dev/null; then
            return 1
        fi
    fi
    if [[ -n "$mysql_pid" ]]; then wait "$mysql_pid" || true; fi
    # The caller's mktemp directory is private and the server process is stopped.
    find "$dir/mysql-data" -depth -delete 2>/dev/null || [[ ! -e "$dir/mysql-data" ]] || return 1
    find "$dir" -maxdepth 1 -type f -name 'mysql-*.log' -delete
    [[ ! -e "$dir/mysql.sock" && ! -e "$dir/mysql.pid" ]]
}
