#!/bin/bash
# Control node placeholder. The data plane must not depend on it: phase-2
# tests kill this container and assert nothing changes. The real control app
# replaces this in phase 3.
set -euo pipefail
echo "control node (placeholder) up"
exec sleep infinity
