// Drives handle.vale: creates a Search in Wasm, keeps it in JS, and steps it across calls.
const fs = require('fs')

const module = new WebAssembly.Module(fs.readFileSync(process.argv[2]))
console.log('imports', WebAssembly.Module.imports(module).map(i => `${i.module}.${i.name}`).join(' '))
console.log('exports', WebAssembly.Module.exports(module).map(e => e.name).join(' '))
const imports = {}
for (const { module: from, name } of WebAssembly.Module.imports(module)) {
  imports[from] ??= {}
  imports[from][name] = (...args) => { throw new Error(`called ${from}.${name}(${args})`) }
}
const { exports } = new WebAssembly.Instance(module, imports)
exports._initialize?.()
const { pathfinder_newSearch: newSearch, pathfinder_step: step, pathfinder_total: total } = exports
console.log('arity newSearch', newSearch.length, 'step', step.length, 'total', total.length)

const search = newSearch(5)
console.log('handle', search)
const steps = [step(search), step(search), step(search)]
console.log('steps', steps, 'total', total(search))
const other = newSearch(100)
step(other)
console.log('after a second search: total', total(search), 'other', total(other))
if (steps.join() !== '1,2,3' || total(search) !== 8 || total(other) !== 101) process.exit(1)
