#!/bin/sh
# Run both halves of the control node in one container:
#  - the agent-facing API + Prometheus scrape target (port 8080)
#  - the Next.js admin UI (port 3000, published as the web port by compose)
# The API is what agents pull from; the UI is for humans. They share the
# config dir and data dir via env.
set -eu

mkdir -p "$OPNMESH_STATE_DIR/control" "$OPNMESH_DATA_DIR"

# Seed sites.yml on first boot from the committed example if the operator has
# not provided one yet (they edit it in the UI afterwards).
if [ ! -f "$OPNMESH_STATE_DIR/sites.yml" ] && [ -f ./config/sites.example.yml ]; then
  cp ./config/sites.example.yml "$OPNMESH_STATE_DIR/sites.yml"
fi

PORT=8080 STATE_DIR="$OPNMESH_STATE_DIR" node ./control-server.mjs &
CONTROL_PID=$!

# Next.js standalone entrypoint.
PORT=3000 HOSTNAME=0.0.0.0 node ./server.js &
UI_PID=$!

trap 'kill $CONTROL_PID $UI_PID 2>/dev/null' TERM INT
wait -n $CONTROL_PID $UI_PID
