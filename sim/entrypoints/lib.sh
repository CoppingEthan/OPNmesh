#!/bin/bash
# Shared helpers for simulation entrypoints.

# Interface that carries an address starting with the given prefix.
iface_for() {
  ip -o -4 addr show | awk -v p="$1" '$4 ~ "^"p {print $2; exit}'
}

log() { printf '[%s] %s\n' "$(hostname)" "$*"; }
