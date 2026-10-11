#!/bin/sh
# Builds and runs each Valen test here, reporting every result before failing.
#   <name>.vale alone: a program whose main returns 0, or the number of the failed check.
#   <name>.vale with <name>.js: built as a reactor exporting the funcs listed on its
#   "// exports:" line, then driven by node <name>.js <wasm>.
# A "// uses:" line limits the lib/valen sources it's built with, as in "// uses: list.vale", and a
# "// borrow-check: true" line builds it with the borrow checker.
set -u
here=$(cd "$(dirname "$0")" && pwd)
out=$(mktemp -d)
failed=0
for test in "$here"/*.vale; do
  name=$(basename "$test" .vale)
  VALEN_SOURCES=$(sed -n 's#^// uses: ##p' "$test")
  VALEN_BORROW_CHECK=$(sed -n 's#^// borrow-check: ##p' "$test")
  export VALEN_SOURCES VALEN_BORROW_CHECK
  echo "::group::$name"
  if [ -f "$here/$name.js" ]; then
    exports=$(sed -n 's#^// exports: ##p' "$test")
    VALEN_HEADERS="$out/$name-include" "$here/../build.sh" "$out/$name.wasm" "$exports" "$test" &&
      find "$out/$name-include" -name '*.h' -exec sh -c 'echo "--- $1"; grep -v "^#\|^$" "$1"' _ {} \; &&
      node "$here/$name.js" "$out/$name.wasm"
  else
    "$here/../build.sh" "$out/$name.wasm" - "$test" && wasmtime "$out/$name.wasm"
  fi
  code=$?
  echo "::endgroup::"
  if [ $code -eq 0 ]; then echo "PASS $name"; else echo "FAIL $name ($code)"; failed=1; fi
done
exit $failed
