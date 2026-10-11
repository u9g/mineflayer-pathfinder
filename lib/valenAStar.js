// The search of ./astar.js, run by its Valen port in ./valen (built to ./valen/pathfinder.wasm),
// behind the same constructor, compute() and results, so index.js can use either one.
//
// Valen runs the search and the moves of ./movements.js. It asks JS, through the externs below,
// for what lives in mineflayer: block states, each state's properties as Movements.getBlock sees
// them, dig costs (which need the inventory), entities and the goal. Exclusion areas are JS
// callbacks on every block, and a Movements subclass may change any move, so those searches
// stay in JS (see supports).

const fs = require('fs')
const path = require('path')
const { performance } = require('perf_hooks')
const { Vec3 } = require('vec3')
const nbt = require('prismarine-nbt')
const Move = require('./move')
const Movements = require('./movements')

const wasmPath = path.join(__dirname, 'valen', 'pathfinder.wasm')
const statuses = ['success', 'partial', 'timeout', 'noPath']

// The search Valen is calling back into
let active

const externs = {
  pathfinder_blockStateAt (x, y, z) {
    const pos = new Vec3(x, y, z)
    const world = active.movements.bot.world
    return world.getColumnAt(pos) ? world.getBlockStateId(pos) : -1
  },
  pathfinder_stateClimbable: (state) => active.kind(state).climbable,
  pathfinder_stateSafe: (state) => active.kind(state).safe,
  pathfinder_statePhysical: (state) => active.kind(state).physical,
  pathfinder_stateReplaceable: (state) => active.kind(state).replaceable,
  pathfinder_stateLiquid: (state) => active.kind(state).liquid,
  pathfinder_stateCanFall: (state) => active.kind(state).canFall,
  pathfinder_stateOpenable: (state) => active.kind(state).openable,
  pathfinder_stateHasShapes: (state) => active.kind(state).hasShapes,
  pathfinder_stateBreakable: (state) => active.kind(state).breakable,
  pathfinder_stateTop: (state) => active.kind(state).top,
  pathfinder_stateDigCost: (state) => active.digCost(state),
  pathfinder_entitiesAt: (x, y, z) => active.movements.entityIntersections[`${x},${y},${z}`] ?? 0,
  pathfinder_goalHeuristic: (x, y, z) => active.goal.heuristic(new Vec3(x, y, z)),
  pathfinder_goalIsEnd: (x, y, z) => active.goal.isEnd(new Vec3(x, y, z)),
  pathfinder_now: () => performance.now(),
  pathfinder_visitChunk: (chunkX, chunkZ) => { active.visitedChunks.add(`${chunkX},${chunkZ}`) },
  pathfinder_pathMove (x, y, z, remainingBlocks, cost, parkour) {
    active.path.push(new Move(x, y, z, remainingBlocks, cost, [], [], parkour !== 0))
  },
  pathfinder_pathBreak (x, y, z) {
    active.path[active.path.length - 1].toBreak.push(new Vec3(x, y, z))
  },
  pathfinder_pathPlace (x, y, z, dx, dy, dz, jump, useOne, hasReturnPos, returnX, returnY, returnZ) {
    // Only the keys movements.js sets, so the placements are the same objects
    const placement = { x, y, z, dx, dy, dz }
    if (hasReturnPos) placement.returnPos = new Vec3(returnX, returnY, returnZ)
    if (jump) placement.jump = true
    if (useOne) placement.useOne = true
    active.path[active.path.length - 1].toPlace.push(placement)
  }
}

let loaded
function wasm () {
  if (!loaded) loaded = instantiate(fs.readFileSync(wasmPath))
  return loaded
}

// Synchronous, like the rest of the search. The core does no IO; only a Valen panic reaches
// WASI, so those imports just report it.
function instantiate (bytes) {
  const wasmModule = new WebAssembly.Module(bytes)
  const wasi = {
    fd_write (fd, iovs, iovsLen, written) {
      const { memory } = instance.exports
      const view = new DataView(memory.buffer)
      let total = 0
      for (let i = 0; i < iovsLen; i++) {
        const ptr = view.getUint32(iovs + i * 8, true)
        const len = view.getUint32(iovs + i * 8 + 4, true)
        process.stderr.write(Buffer.from(memory.buffer, ptr, len))
        total += len
      }
      view.setUint32(written, total, true)
      return 0
    },
    proc_exit (code) { throw new Error(`pathfinder.wasm exited with code ${code}`) }
  }
  const imports = { env: {} }
  for (const { module: from, name, kind } of WebAssembly.Module.imports(wasmModule)) {
    if (kind !== 'function') continue
    if (from === 'env') {
      if (!externs[name]) throw new Error(`pathfinder.wasm imports ${name}, which valenAStar.js doesn't provide`)
      imports.env[name] = externs[name]
    } else {
      imports[from] ??= {}
      imports[from][name] = (from === 'wasi_snapshot_preview1' && wasi[name]) ||
        (() => { throw new Error(`pathfinder.wasm called unsupported import ${from}.${name}`) })
    }
  }
  const instance = new WebAssembly.Instance(wasmModule, imports)
  instance.exports._initialize?.()
  return instance.exports
}

// Frees a search JS dropped without finishing it, such as one a path reset abandoned
const searches = new FinalizationRegistry((handle) => wasm().pathfinder_endSearch(handle))

class ValenAStar {
  // Whether this search can run in Valen: the module is built, and movements behaves exactly
  // like a plain Movements with no exclusion areas
  static supports (movements) {
    if (!fs.existsSync(wasmPath)) return false
    if (Object.getPrototypeOf(movements) !== Movements.prototype) return false
    for (const name of Object.getOwnPropertyNames(Movements.prototype)) {
      if (Object.prototype.hasOwnProperty.call(movements, name)) return false
    }
    return movements.exclusionAreasStep.length === 0 &&
      movements.exclusionAreasBreak.length === 0 &&
      movements.exclusionAreasPlace.length === 0
  }

  constructor (start, movements, goal, timeout, tickTimeout = 40, searchRadius = -1) {
    this.startTime = performance.now()
    this.movements = movements
    this.goal = goal
    this.visitedChunks = new Set()
    this.kinds = new Map()
    this.digCosts = new Map()
    this.Block = require('prismarine-block')(movements.bot.registry)

    const m = movements
    this.handle = this.call(() => wasm().pathfinder_newSearch(
      m.canDig, m.placeCost, m.liquidCost, m.entityCost, m.dontCreateFlow,
      m.dontMineUnderFallingBlock, m.allow1by1towers, m.allowParkour, m.allowSprinting,
      m.allowEntityDetection, m.canOpenDoors, m.maxDropDown, m.infiniteLiquidDropdownDistance,
      m.bot.game.minY, start.x, start.y, start.z, start.remainingBlocks, timeout, tickTimeout,
      searchRadius))
    searches.register(this, this.handle, this)
  }

  compute () {
    const status = statuses[this.call(() => wasm().pathfinder_computeSearch(this.handle))]
    this.path = []
    this.call(() => wasm().pathfinder_reportPath(this.handle))
    const result = {
      status,
      cost: wasm().pathfinder_searchCost(this.handle),
      time: performance.now() - this.startTime,
      visitedNodes: wasm().pathfinder_visitedNodes(this.handle),
      generatedNodes: wasm().pathfinder_generatedNodes(this.handle),
      path: this.path,
      context: this
    }
    this.path = undefined
    if (status !== 'partial') {
      // index.js only computes again after a partial result
      searches.unregister(this)
      wasm().pathfinder_endSearch(this.handle)
      this.handle = undefined
    }
    return result
  }

  call (fn) {
    const outer = active
    active = this
    try {
      return fn()
    } finally {
      active = outer
    }
  }

  // A block state's properties, as Movements.getBlock works them out for a block
  kind (state) {
    let kind = this.kinds.get(state)
    if (kind) return kind
    const m = this.movements
    const b = this.Block.fromStateId(state, 0)
    const climbable = m.climbables.has(b.type)
    const physical = b.boundingBox === 'block' && !m.fences.has(b.type)
    let top = 0
    for (const shape of b.shapes) top = Math.max(top, shape[4])
    kind = {
      climbable,
      safe: (b.boundingBox === 'empty' || climbable || m.carpets.has(b.type)) && !m.blocksToAvoid.has(b.type),
      physical,
      replaceable: m.replaceables.has(b.type) && !physical,
      liquid: m.liquids.has(b.type) || b.isWaterlogged === true,
      canFall: m.gravityBlocks.has(b.type),
      openable: m.openable.has(b.type),
      hasShapes: b.shapes !== undefined && b.shapes.length !== 0,
      breakable: !!b.type && !m.blocksCantBreak.has(b.type),
      top
    }
    this.kinds.set(state, kind)
    return kind
  }

  // The labor cost of breaking a block in this state, as Movements.safeOrBreak works it out
  digCost (state) {
    let cost = this.digCosts.get(state)
    if (cost !== undefined) return cost
    const m = this.movements
    const block = this.Block.fromStateId(state, 0)
    const tool = m.bot.pathfinder.bestHarvestTool(block)
    const enchants = (tool && tool.nbt) ? nbt.simplify(tool.nbt).Enchantments : []
    const digTime = block.digTime(tool ? tool.type : null, false, false, false, enchants, m.bot.entity.effects)
    cost = (1 + 3 * digTime / 1000) * m.digCost
    this.digCosts.set(state, cost)
    return cost
  }
}

module.exports = ValenAStar
