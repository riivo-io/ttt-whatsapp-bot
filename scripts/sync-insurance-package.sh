#!/usr/bin/env bash
# TTTFG-5168: copy the Insurance and Advice claims code into Tina.
#
# The claims logic has one home: ttt-preseason-agent/src/departments/insurance (SPEC-04/05: one package that Tina and
# the email agent both load). Until the shared package exists (TTTFG-4830), Tina carries a copy of the files it needs in
# src/departments/insurance/. Never edit the copy: change the source, then run this script.
#
#   scripts/sync-insurance-package.sh            copy from ../ttt-preseason-agent (or $INSURANCE_PACKAGE_SRC)
#   scripts/sync-insurance-package.sh --check    exit 1 if the copy differs from the source
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
SRC_REPO="${INSURANCE_PACKAGE_SRC:-$HERE/../ttt-preseason-agent}"
SRC="$SRC_REPO/src/departments/insurance"
DEST="$HERE/src/departments/insurance"
FILES=(walkthrough.ts claim.ts gate.ts understand.ts intent.ts dataverse.ts)

[ -d "$SRC" ] || { echo "No claims package at $SRC" >&2; exit 2; }
COMMIT="$(git -C "$SRC_REPO" log -1 --format=%h -- src/departments/insurance)"

render() {
  printf '%s\n' "// GENERATED COPY of ttt-preseason-agent/src/departments/insurance/$1 (commit $COMMIT). Do not edit here:"
  printf '%s\n' "// change the source and run scripts/sync-insurance-package.sh. Replaced by the shared package in TTTFG-4830."
  cat "$SRC/$1"
}

if [ "${1:-}" = "--check" ]; then
  status=0
  for f in "${FILES[@]}"; do
    if ! diff -q <(render "$f" | tail -n +3) <(tail -n +3 "$DEST/$f" 2>/dev/null) >/dev/null; then
      echo "out of date: src/departments/insurance/$f" >&2
      status=1
    fi
  done
  exit $status
fi

mkdir -p "$DEST"
for f in "${FILES[@]}"; do
  render "$f" > "$DEST/$f"
done
echo "Copied ${#FILES[@]} files from $SRC_REPO at $COMMIT"
