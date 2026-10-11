#!/bin/sh
# Compiles the Valen sources in lib/valen, plus any extra .vale files, into a Wasm module.
#   lib/valen/build.sh <out.wasm> <export,export,...> [extra.vale...]
# VALEN_SOURCES limits the lib/valen sources to those files, for example "list.vale hashmap.vale".
# With exports, it builds a WASI reactor exporting those funcs, whose extern funcs are imported
# from "env"; with "-", a command that runs main.
#
# Needs a built Valen compiler (VALEN_DIR, https://github.com/valen-lang/valen) and wasi-sdk
# (WASI_SDK_PATH). .github/workflows/valen.yml sets both up on Ubuntu.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
: "${VALEN_DIR:?set VALEN_DIR to a Valen checkout with valec built}"
: "${WASI_SDK_PATH:?set WASI_SDK_PATH to a wasi-sdk install}"
wasm=$1
exports=$2
shift 2

work=$(mktemp -d)
mkdir "$work/src"
if [ -n "${VALEN_SOURCES:-}" ]; then
  for source in $VALEN_SOURCES; do cp "$here/$source" "$work/src/"; done
else
  cp "$here"/*.vale "$work/src/"
fi
for extra in "$@"; do cp "$extra" "$work/src/"; done

flags=""
if [ "$exports" != "-" ]; then
  # valec links a command around main. A reactor instead stays usable between calls; the
  # externs are left undefined to become imports, and the exported funcs are kept as exports.
  flags="-mexec-model=reactor -Wl,--allow-undefined"
  for name in $(echo "$exports" | tr ',' ' '); do flags="$flags -Wl,--export=pathfinder_$name"; done
fi
cat > "$work/clang" <<WRAPPER
#!/bin/sh
exec "$WASI_SDK_PATH/bin/clang" $flags "\$@"
WRAPPER
chmod +x "$work/clang"

# Without the borrow checker: it doesn't cover pushing to and popping from arrays yet
# (unimplemented!() in Valen's groupify_function.rs), which every growable collection needs.
# Valen's own HashMap tests are built the same way.
"$VALEN_DIR/target/debug/valec" build \
  --no-std \
  --borrow-check false \
  --builtins-dir-override "$VALEN_DIR/Backend/builtins" \
  --clang-override "$work/clang" \
  --target-triple wasm32-wasi \
  --sysroot "$WASI_SDK_PATH/share/wasi-sysroot" \
  --output-dir "$work/build" \
  -o out.wasm \
  pathfinder="$work/src"

cp "$work/build/out.wasm" "$wasm"
# The generated C headers show how each exported func crosses into Wasm
if [ -n "${VALEN_HEADERS:-}" ]; then cp -r "$work/build/include" "$VALEN_HEADERS"; fi
