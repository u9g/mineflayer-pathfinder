// Runs heap_test.vale's runHeapTest, with the pathfinder's externs stubbed out
const fs = require('fs')
const wasmModule = new WebAssembly.Module(fs.readFileSync(process.argv[2]))
const imports = {}
for (const { module: from, name } of WebAssembly.Module.imports(wasmModule)) {
  imports[from] ??= {}
  imports[from][name] = () => 0
}
const wasm = new WebAssembly.Instance(wasmModule, imports).exports
wasm._initialize?.()
const result = wasm.pathfinder_runHeapTest()
console.log('runHeapTest', result)
process.exit(result === 0 ? 0 : 1)
