#!/bin/sh
# Clones the primary once, then runs a hot standby that streams from it and reports itself as $1
# (the name synchronous_standby_names refers to). Settings match the primary's, which a standby needs.
set -e
if [ ! -s "$PGDATA/PG_VERSION" ]; then
  until pg_basebackup -h primary -U postgres -D "$PGDATA" -X stream; do sleep 1; done
  touch "$PGDATA/standby.signal"
  echo "primary_conninfo = 'host=primary user=postgres password=$PGPASSWORD application_name=$1'" >> "$PGDATA/postgresql.auto.conf"
fi
exec postgres -c hba_file=/etc/postgresql/pg_hba.conf -c max_connections=300
