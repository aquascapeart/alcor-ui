import JSBI from "jsbi"
import { asset } from 'eos-common'

import { fetchAllRows } from '~/utils/eosjs'
import { tryParsePrice, tryParseCurrencyAmount, parseToken, tryParseTick } from '~/utils/amm'
import { Token, Pool, Tick, CurrencyAmount, Price, Position } from '~/assets/libs/swap-sdk'
import { nameToUint64 } from '~/utils'

export const state = () => ({
  pools: [],
  positions: [],

  // TODO move to module
  selectedTokenA: null,
  selectedTokenB: null
})

export const mutations = {
  setPools: (state, pools) => state.pools = pools,
  setPositions: (state, positions) => state.positions = positions
}

export const actions = {
  async init({ dispatch, rootState }) {
    console.log('inited amm')
    await dispatch('fetchPairs')
    await dispatch('fetchPositions')
    console.log('inited amm finish:')
  },

  async placePositions({ state, commit, rootState, dispatch }, owner) {

  },

  async fetchPositions({ state, commit, rootState, dispatch }) {
    const owner = rootState.user?.name

    const positions = []

    for (const pool of state.pools) {
      const rows = await fetchAllRows(this.$rpc, {
        code: rootState.network.amm.contract,
        scope: pool.id,
        table: 'positions',
        key_type: 'i64',
        index_position: 3,
        lower_bound: nameToUint64(owner),
        upper_bound: nameToUint64(owner)
      })

      if (!rows) continue

      rows.map(r => r.pool = pool.id)
      positions.push(...rows)
    }

    commit('setPositions', positions)
  },

  async test({ state, getters, commit, rootState, dispatch }) {
  },

  async fetchPairs({ state, commit, rootState, dispatch }) {
    const { network } = rootState

    const pools = []
    const rows = await fetchAllRows(this.$rpc, { code: network.amm.contract, scope: network.amm.contract, table: 'pools' })

    for (const row of rows) {
      row.ticks = await fetchAllRows(this.$rpc, { code: network.amm.contract, scope: row.id, table: 'ticks' })
      pools.push(row)
    }

    commit('setPools', rows)
  }
}

export const getters = {
  pools(state, getters, rootState) {
    const pools = []

    for (const row of state.pools) {
      const { id, ticks, tokenA, tokenB, fee, liquidity, currSlot: { sqrtPriceX64, tick } } = row
      const TICKS = ticks.map(t => new Tick({ index: t.id, ...t }))
      TICKS.sort((a, b) => a.index - b.index)

      pools.push(new Pool(
        id,
        parseToken(tokenA),
        parseToken(tokenB),
        fee,
        sqrtPriceX64,
        liquidity,
        tick,
        TICKS,
        id
      ))
    }

    return pools
  },

  positions(state, getters, rootState) {
    const positions = []

    for (const { id, liquidity, upper, lower, pool } of state.positions) {
      const poolInstance = getters.pools.find(p => p.id == pool)
      positions.push(new Position({ id, pool: poolInstance, liquidity, tickLower: lower, tickUpper: upper }))
    }

    return positions
  }
}
