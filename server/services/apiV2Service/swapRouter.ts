import { performance } from 'perf_hooks'
import { Worker } from 'worker_threads'
import { createClient } from 'redis'
import { Trade, Percent, Token, Pool, Route, TickListDataProvider } from '@alcorexchange/alcor-swap-sdk'
import { Router } from 'express'
import { tryParseCurrencyAmount } from '../../../utils/amm'
import { getPools } from '../swapV2Service/utils'

export const swapRouter = Router()

const redis = createClient()
const subscriber = createClient()
subscriber.connect()

const TRADE_LIMITS = { maxNumResults: 1, maxHops: 3 }

const POOLS = {}
const ROUTES_EXPIRATION_TIMES = {}
const ROUTES_CACHE_TIMEOUT = 60 * 10 // 5H
const ROUTES_UPDATING = {} // Объект для отслеживания обновлений кеша

subscriber.subscribe('swap:pool:instanceUpdated', msg => {
  const { chain, buffer } = JSON.parse(msg)
  const pool = Pool.fromBuffer(Buffer.from(buffer, 'hex'))

  if (!POOLS[chain]) return getAllPools(chain)

  if (!pool) {
    console.warn('ADDING NULL POOL TO POOLS MAP!', pool)
  }

  POOLS[chain].set(pool.id, pool)
})

async function getAllPools(chain): Promise<Map<string, Pool>> {
  if (!POOLS[chain]) {
    //const pools = await getPools(chain, true, (p) => p.active && BigInt(p.liquidity) > BigInt(0))
    const pools = await getPools(chain, true, (p) => p.active)
    POOLS[chain] = new Map(pools.map(p => [p.id, p]))
    console.log(POOLS[chain].size, 'initial', chain, 'pools fetched')
  }

  return POOLS[chain]
}

async function getCachedRoutes(chain, inputToken, outputToken, maxHops = 2) {
  if (!redis.isOpen) await redis.connect()

  const cacheKey = `${chain}-${inputToken.id}-${outputToken.id}-${maxHops}`
  const allPools = await getAllPools(chain)
  const liquidPools = Array.from(allPools.values()).filter((p: any) => p.tickDataProvider.ticks.length > 0)

  const redis_routes = await redis.get('routes_' + cacheKey)

  if (!redis_routes) {
    await updateCache(chain, liquidPools, inputToken, outputToken, maxHops, cacheKey)
    return await getCachedRoutes(chain, inputToken, outputToken, maxHops)
  }

  const routes = []
  for (const route of JSON.parse(redis_routes) || []) {
    const pools = route.pools.map(p => allPools.get(p))

    if (pools.every(p => p != undefined)) {
      routes.push(new Route(pools, inputToken, outputToken))
    }
  }

  if (!ROUTES_EXPIRATION_TIMES[cacheKey] || Date.now() > ROUTES_EXPIRATION_TIMES[cacheKey]) {
    if (!ROUTES_UPDATING[cacheKey]) {
      updateCacheInBackground(chain, liquidPools, inputToken, outputToken, maxHops, cacheKey)
    }
  }

  return routes
}

async function updateCache(chain, pools, inputToken, outputToken, maxHops, cacheKey) {
  const input = findToken(pools, inputToken.id)
  const output = findToken(pools, outputToken.id)

  if (!input || !output) {
    throw new Error(`${chain} ${cacheKey} getCachedPools: INVALID input/output:`)
  }

  try {
    ROUTES_UPDATING[cacheKey] = true

    const routes: any = await computeRoutesInWorker(input, output, pools, maxHops)
    const redis_routes = routes.map(({ input, output, pools }) => {
      return {
        input: Token.toJSON(input),
        output: Token.toJSON(output),
        pools: pools.map(p => p.id)
      }
    })

    await redis.set('routes_' + cacheKey, JSON.stringify(redis_routes))
    console.log('cacheUpdated:', cacheKey)

    ROUTES_EXPIRATION_TIMES[cacheKey] = Date.now() + ROUTES_CACHE_TIMEOUT * 1000
    return routes
  } catch (error) {
    console.error('Error computing routes in worker:', error)
    return []
  } finally {
    delete ROUTES_UPDATING[cacheKey]
  }
}

function updateCacheInBackground(chain, pools, inputToken, outputToken, maxHops, cacheKey) {
  setTimeout(() => {
    console.log('update background cache for', cacheKey)
    updateCache(chain, pools, inputToken, outputToken, maxHops, cacheKey).catch((error) =>
      console.error('Error updating cache in background:', error)
    ).then(() => console.log('cache updated in background', cacheKey))
  }, 0)
}

function findToken(pools, tokenID) {
  return pools.find((p) => p.tokenA.id === tokenID)?.tokenA || pools.find((p) => p.tokenB.id === tokenID)?.tokenB
}

function computeRoutesInWorker(input, output, pools, maxHops) {
  return new Promise((resolve, reject) => {
    const worker = new Worker('./server/services/apiV2Service/workers/computeAllRoutesWorker.js', {
      workerData: {
        input: Token.toJSON(input),
        output: Token.toJSON(output),
        pools: pools.map(p => Pool.toBuffer(p)),
        maxHops
      },
    })

    worker.on('message', routes => {
      resolve(routes.map(r => Route.fromBuffer(r)))
      worker.terminate()
    })

    worker.on('error', reject)

    worker.on('exit', (code) => {
      if (code !== 0) reject(new Error(`Worker stopped with exit code ${code}`))
    })
  })
}

swapRouter.get('/getRoute', async (req, res) => {
  const network = req.app.get('network')
  let { v2, trade_type, input, output, amount, slippage, receiver = '<receiver>', maxHops } = <any>req.query

  if (!trade_type || !input || !output) {
    return res.status(403).send('Invalid request')
  }

  if (isNaN(amount)) {
    return res.status(403).send('Invalid amount')
  }

  slippage = slippage ? new Percent(slippage * 100, 10000) : new Percent(30, 10000)

  maxHops = !isNaN(parseInt(maxHops)) ? parseInt(maxHops) : TRADE_LIMITS.maxHops

  const exactIn = trade_type === 'EXACT_INPUT'

  const startTime = performance.now()

  const allPools = await getAllPools(network.name)
  const poolsArray = Array.from(allPools.values())

  const inputToken = findToken(poolsArray, input)
  const outputToken = findToken(poolsArray, output)

  if (!inputToken || !outputToken) {
    return res.status(403).send('Invalid input/output')
  }

  try {
    amount = tryParseCurrencyAmount(amount, exactIn ? inputToken : outputToken)
  } catch (e) {
    return res.status(403).send(e.message)
  }

  if (!amount) {
    return res.status(403).send('Invalid amount')
  }

  const cachedRoutes = await getCachedRoutes(
    network.name,
    inputToken,
    outputToken,
    Math.min(maxHops, 3)
  )

  if (cachedRoutes.length == 0) {
    return res.status(403).send('No route found')
  }

  let trade
  try {
    if (v2) {
      return res.status(403).send('')
      // const nodes = Object.keys(network.client_nodes);
      // [trade] = exactIn
      //   ? await Trade.bestTradeExactInReadOnly(nodes, routes, amount)
      //   : await Trade.bestTradeExactOutReadOnly(nodes, routes, amount);
    } else {
      ;[trade] = exactIn
        ? Trade.bestTradeExactIn(cachedRoutes, amount)
        : Trade.bestTradeExactOut(cachedRoutes, amount)
    }
  } catch (e) {
    console.error('GET ROUTE ERROR', e)
    return res.status(403).send('Get Route error: ' + e.message)
  }

  const endTime = performance.now()

  console.log(
    network.name,
    `find route ${maxHops} hop ${Math.round(
      endTime - startTime
    )} ms ${inputToken.symbol} -> ${outputToken.symbol} v2: ${Boolean(v2)}`
  )

  if (!trade) {
    return res.status(403).send('No route found')
  }

  const method = exactIn ? 'swapexactin' : 'swapexactout'
  const route = trade.route.pools.map((p) => p.id)

  const maxSent = exactIn ? trade.inputAmount : trade.maximumAmountIn(slippage)
  const minReceived = exactIn ? trade.minimumAmountOut(slippage) : trade.outputAmount

  const memo = `${method}#${route.join(',')}#${receiver}#${minReceived.toExtendedAsset()}#0`

  const result = {
    input: trade.inputAmount.toFixed(),
    output: trade.outputAmount.toFixed(),
    minReceived: minReceived.toFixed(),
    maxSent: maxSent.toFixed(),
    priceImpact: trade.priceImpact.toSignificant(2),
    memo,
    route,
    executionPrice: {
      numerator: trade.executionPrice.numerator.toString(),
      denominator: trade.executionPrice.denominator.toString(),
    },
  }

  return res.json(result)
})

export default swapRouter
