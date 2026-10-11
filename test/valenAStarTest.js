/* eslint-env mocha */
// The Valen search (lib/valenAStar.js) must find exactly what the JS one (lib/astar.js) finds:
// same status, cost, node counts and path, move for move. Both search random worlds with no
// server, through the same Movements.

const assert = require('assert')
const { Vec3 } = require('vec3')
const nbt = require('prismarine-nbt')
const AStar = require('../lib/astar')
const ValenAStar = require('../lib/valenAStar')
const Movements = require('../lib/movements')
const Move = require('../lib/move')
const goals = require('../lib/goals')

const versions = ['1.16.5', '1.21.4']
const worldsPerVersion = 40
const size = 32 // blocks along x and z, in 2x2 chunks

// A small seeded random, so a failing world can be rebuilt from its seed
function random (seed) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }
}

function fakeBot (version, seed) {
  const registry = require('prismarine-registry')(version)
  const World = require('prismarine-world')(registry)
  const Chunk = require('prismarine-chunk')(registry)
  const Item = require('prismarine-item')(registry)
  const world = new World().sync
  const rand = random(seed)
  const pick = (list) => list[Math.floor(rand() * list.length)]
  const block = (name) => registry.blocksByName[name]
  const minY = registry.supportFeature('tallWorld') ? -64 : 0

  // Ground around y 60 with hills, holes, liquids and blocks the moves treat specially
  const extras = ['water', 'lava', 'sand', 'gravel', 'ladder', 'oak_fence', 'white_carpet', 'oak_slab',
    'cobweb', 'stone', 'oak_planks', 'glass', 'chest', 'oak_fence_gate', 'kelp', 'torch']
    .filter(name => block(name))
  const heights = []
  for (let x = 0; x < size; x++) {
    heights.push([])
    for (let z = 0; z < size; z++) heights[x].push(58 + Math.floor(rand() * 5) + (rand() < 0.1 ? 3 : 0))
  }
  for (let cx = 0; cx < size / 16; cx++) {
    for (let cz = 0; cz < size / 16; cz++) {
      const chunk = new Chunk({ minY, worldHeight: registry.supportFeature('tallWorld') ? 384 : 256 })
      for (let x = 0; x < 16; x++) {
        for (let z = 0; z < 16; z++) {
          const top = heights[cx * 16 + x][cz * 16 + z]
          for (let y = 50; y <= top; y++) {
            const name = y < top ? 'stone' : rand() < 0.15 ? 'dirt' : 'grass_block'
            chunk.setBlockStateId(new Vec3(x, y, z), block(name).defaultState)
          }
          if (rand() < 0.12) {
            const name = pick(extras)
            chunk.setBlockStateId(new Vec3(x, top + 1, z), block(name).defaultState)
            if (rand() < 0.3) chunk.setBlockStateId(new Vec3(x, top + 2, z), block(name).defaultState)
          }
          if (rand() < 0.03) chunk.setBlockStateId(new Vec3(x, top, z), block('air').defaultState)
        }
      }
      world.setColumn(cx, cz, chunk)
    }
  }

  const items = [new Item(registry.itemsByName.diamond_pickaxe.id, 1), new Item(registry.itemsByName.dirt.id, Math.floor(rand() * 4))]
  const bot = {
    registry,
    world,
    game: { minY },
    blockAt: (pos) => world.getBlock(pos),
    inventory: { items: () => items },
    entity: { effects: {} },
    entities: {}
  }
  // As index.js defines it
  bot.pathfinder = {
    bestHarvestTool (block) {
      let fastest = Number.MAX_VALUE
      let bestTool = null
      for (const tool of bot.inventory.items()) {
        const enchants = (tool && tool.nbt) ? nbt.simplify(tool.nbt).Enchantments : []
        const digTime = block.digTime(tool ? tool.type : null, false, false, false, enchants, bot.entity.effects)
        if (digTime < fastest) {
          fastest = digTime
          bestTool = tool
        }
      }
      return bestTool
    }
  }

  const movements = new Movements(bot)
  movements.allowParkour = rand() < 0.8
  movements.allowSprinting = rand() < 0.8
  movements.canDig = rand() < 0.7
  // Entities in the way, as updateCollisionIndex counts them
  for (let i = 0; i < 6; i++) {
    const x = Math.floor(rand() * size)
    const z = Math.floor(rand() * size)
    const y = heights[x][z] + 1
    movements.entityIntersections[`${x},${y},${z}`] = rand() < 0.5 ? 1 : 100
  }

  const start = () => {
    const x = 4 + Math.floor(rand() * 8)
    const z = 4 + Math.floor(rand() * 8)
    return [x, heights[x][z] + 1, z]
  }
  const [sx, sy, sz] = start()
  const [gx, gy, gz] = [Math.floor(rand() * size), 0, Math.floor(rand() * size)]
  const goal = pick([
    () => new goals.GoalBlock(gx, heights[gx][gz] + 1, gz),
    () => new goals.GoalNear(gx, heights[gx][gz] + 1, gz, 2),
    () => new goals.GoalXZ(gx, gz),
    () => new goals.GoalY(gy + 63),
    () => new goals.GoalGetToBlock(gx, heights[gx][gz], gz)
  ])()
  return { movements, goal, start: new Move(sx, sy, sz, movements.countScaffoldingItems(), 0) }
}

// Everything a result says about the search, without its timing or context
function summary (result) {
  const { status, cost, visitedNodes, generatedNodes, path } = result
  return { status, cost, visitedNodes, generatedNodes, path }
}

describe('Valen search', function () {
  this.timeout(120000)

  before(function () {
    if (!require('fs').existsSync(require('path').join(__dirname, '../lib/valen/pathfinder.wasm'))) {
      this.skip() // lib/valen/build.sh hasn't built it
    }
  })

  for (const version of versions) {
    it(`finds the same paths as the JS search in random ${version} worlds`, () => {
      for (let seed = 1; seed <= worldsPerVersion; seed++) {
        const { movements, goal, start } = fakeBot(version, seed)
        assert.ok(ValenAStar.supports(movements))
        const js = new AStar(start, movements, goal, 1e9, 1e9).compute()
        const valen = new ValenAStar(start, movements, goal, 1e9, 1e9).compute()
        assert.deepStrictEqual(summary(valen), summary(js), `seed ${seed}`)
        assert.deepStrictEqual(valen.context.visitedChunks, js.context.visitedChunks, `seed ${seed}`)
      }
    })

    it(`ends a search sliced over ticks on the same result in ${version}`, () => {
      const { movements, goal, start } = fakeBot(version, 7)
      const js = new AStar(start, movements, goal, 1e9, 1e9).compute()
      const search = new ValenAStar(start, movements, goal, 1e9, 0.01)
      let result = search.compute()
      let slices = 1
      while (result.status === 'partial') {
        result = search.compute()
        slices++
      }
      assert.ok(slices > 1, 'the search finished in one slice')
      assert.deepStrictEqual(summary(result), summary(js))
    })
  }

  it('leaves searches it cannot run to JS', () => {
    const { movements } = fakeBot(versions[0], 1)
    movements.exclusionAreasStep.push(() => 0)
    assert.strictEqual(ValenAStar.supports(movements), false)
    const { movements: custom } = fakeBot(versions[0], 1)
    custom.getMoveUp = () => {}
    assert.strictEqual(ValenAStar.supports(custom), false)
  })
})
