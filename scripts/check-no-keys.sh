#!/usr/bin/env bash
# CI gate: fail if anything that looks like private key material is committed.
# Public keys are fine (sites.yml holds them by design); private keys never
# enter the repo, the database, or a log line.
set -euo pipefail

fail=0

# 1. PEM/OpenSSH private key blocks anywhere in the tree.
if git grep -nI -e "-----BEGIN .*PRIVATE KEY-----" -- ':!scripts/check-no-keys.sh'; then
  echo "ERROR: PEM private key block found." >&2
  fail=1
fi

# 2. A literal WireGuard private key assigned in any committed config-like file.
#    Generated wg0.conf must load keys via 'wg set %i private-key <path>'; a
#    44-char base64 value on a PrivateKey line is a leaked key. The documented
#    client-template placeholder is exempt.
if git grep -nIE "^[[:space:]]*PrivateKey[[:space:]]*=[[:space:]]*[A-Za-z0-9+/]{43}=" -- ':!scripts/check-no-keys.sh'; then
  echo "ERROR: literal WireGuard private key found on a PrivateKey line." >&2
  fail=1
fi

# 3. private_key-style YAML/JSON fields with inline base64 values.
if git grep -nIE "private_key[\"']?[[:space:]]*[:=][[:space:]]*[\"']?[A-Za-z0-9+/]{43}=" -- ':!scripts/check-no-keys.sh'; then
  echo "ERROR: inline private_key value found." >&2
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  exit 1
fi
echo "OK: no key material found."
