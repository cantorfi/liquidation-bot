#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// CantorFi liquidation bot — public reference client.
//
// Anyone can liquidate an unhealthy CantorFi vault position: `liquidatePartial` is
// permissionless. This bot finds those positions and, only when you opt in, repays them
// with your own capital and wallet. No executor contract, no API key, no CantorFi key.
//
//   Read-only (no key):  RPC_URL=… PROTOCOL_ADDRESS=… FROM_BLOCK=… node liquidation-bot.mjs --once
//   Execute:             add LIQUIDATOR_PRIVATE_KEY=… EXECUTE=1
//
// Provided as-is, without warranty. You pay the gas, you choose the capital at risk.

import { readFile, writeFile, rename } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { ethers } from 'ethers'

const HELP = `CantorFi liquidation bot

  node liquidation-bot.mjs --once   one pass, then exit
  node liquidation-bot.mjs          one pass every INTERVAL_SECONDS; Ctrl+C stops

Required
  RPC_URL                  JSON-RPC endpoint of the CantorFi network
  PROTOCOL_ADDRESS         CantorFiProtocol contract (lists every vault)
  FROM_BLOCK               protocol deployment block (first block scanned for borrowers)

Execution (optional — without these the bot only reads and reports)
  LIQUIDATOR_PRIVATE_KEY   your own wallet; it holds the repayment capital and the gas
  EXECUTE=1                explicit opt-in to send transactions

Optional
  CHAIN_ID                 expected chain id; the bot stops on any other network
  MAX_REPAY                capital cap per liquidation, in vault token units (default: whole balance)
  MIN_PROFIT               minimum profit per liquidation, in vault token units (default 0)
  INTERVAL_SECONDS         delay between passes (default 30)
  CONFIRMATIONS            blocks behind head before a borrower is scanned (default 2)
  REORG_DEPTH              blocks rescanned on every pass (default 64)
  LOG_RANGE                blocks per eth_getLogs request (default 2000, lowered to the RPC's limit)
  SCAN_PARALLEL            block ranges requested at a time during the scan (default 16)
  STATE_FILE               borrower cache (default ./cantorfi-liquidation-state.json)

Every line of output is one JSON event: started, scan, vault, opportunity, skipped, executed, error.`

const PROTOCOL_ABI = [
  'function vaultCount() view returns (uint256)',
  'function getAllVaults(uint256 offset, uint256 limit) view returns (address[])',
]
const VAULT_ABI = [
  'event Borrowed(address indexed borrower, uint256 amount)',
  'event Liquidated(address indexed liquidator, address indexed borrower, uint256 debtRepaid, uint256 collateralSeized, uint256 collateralRemaining)',
  'function token() view returns (address)',
  'function liquidationsPaused() view returns (bool)',
  'function previewLiquidation(address borrower, uint256 maxRepayAmount) view returns (uint256 repayAmount, uint256 collateralSeized, uint256 liquidatorPayout, uint256 protocolFee, uint256 badDebt)',
  'function liquidatePartial(address borrower, uint256 maxRepayAmount)',
  'function getTotalDebt(address user) view returns (uint256)',
]
const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]

const BORROWED = ethers.id('Borrowed(address,uint256)')
// Multicall3 sits at this address on every major chain: READ_BATCH positions are read per request.
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11'
const MULTICALL = new ethers.Interface(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[])'])
const READ_BATCH = 200

// The RPC's own words ("eth_getLogs is limited to a 200 range", "pruned history unavailable").
// ethers hides them behind "could not coalesce error", or in the body of an HTTP 413.
function rpcMessage(error) {
  let stated
  try { stated = JSON.parse(error.info.responseBody).error.message } catch { stated = error?.info?.responseBody }
  return stated || error?.error?.message || error?.info?.error?.message || error?.shortMessage || error?.message || String(error)
}

// Public RPCs cap eth_getLogs differently and say so: "limited to a 200 range", "maximum block
// range: 50000", "ranges over 100 blocks", "up to a 10 block range".
function rangeLimit(message) {
  const found = /(\d[\d,]*)\s*(?:block|range)|(?:range|blocks)\D{0,10}(\d[\d,]*)/i.exec(message)
  return found ? Number((found[1] ?? found[2]).replaceAll(',', '')) : 0
}

const emit = (event, fields = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }, (_key, value) => typeof value === 'bigint' ? value.toString() : value))

function integer(name, fallback, minimum) {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`)
  return value
}

function readConfig() {
  const env = process.env
  if (!env.RPC_URL) throw new Error('RPC_URL is required')
  if (!ethers.isAddress(env.PROTOCOL_ADDRESS)) throw new Error('PROTOCOL_ADDRESS must be a contract address')
  if (env.EXECUTE === '1' && !env.LIQUIDATOR_PRIVATE_KEY) throw new Error('EXECUTE=1 needs LIQUIDATOR_PRIVATE_KEY')
  for (const name of ['MAX_REPAY', 'MIN_PROFIT']) {
    if (env[name] !== undefined && !/^\d+(\.\d+)?$/.test(env[name])) throw new Error(`${name} must be a positive decimal amount`)
  }
  const config = {
    rpcUrl: env.RPC_URL,
    protocol: ethers.getAddress(env.PROTOCOL_ADDRESS),
    fromBlock: integer('FROM_BLOCK', 0, 0),
    chainId: env.CHAIN_ID ? BigInt(integer('CHAIN_ID', 0, 1)) : null,
    execute: env.EXECUTE === '1',
    privateKey: env.LIQUIDATOR_PRIVATE_KEY || null,
    maxRepay: env.MAX_REPAY ?? null,
    minProfit: env.MIN_PROFIT ?? '0',
    intervalMs: integer('INTERVAL_SECONDS', 30, 5) * 1000,
    confirmations: integer('CONFIRMATIONS', 2, 0),
    reorgDepth: integer('REORG_DEPTH', 64, 1),
    logRange: integer('LOG_RANGE', 2000, 1),
    scanParallel: integer('SCAN_PARALLEL', 16, 1),
    stateFile: env.STATE_FILE || './cantorfi-liquidation-state.json',
  }
  if (config.reorgDepth <= config.confirmations) throw new Error('REORG_DEPTH must exceed CONFIRMATIONS')
  return config
}

export class LiquidationBot {
  constructor(config) {
    this.config = config
    // No request cache: ethers would otherwise answer a nonce, balance or allowance read with a
    // value up to 250 ms old, which is stale right after a transaction on a fast chain.
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl, undefined, { batchMaxCount: 1, cacheTimeout: -1 })
    this.signer = config.privateKey ? new ethers.Wallet(config.privateKey, this.provider) : null
    this.protocol = new ethers.Contract(config.protocol, PROTOCOL_ABI, this.provider)
    this.tokens = new Map()
    this.state = null
    this.stopped = false
    this.logRange = config.logRange
  }

  async initialize() {
    const { chainId } = await this.provider.getNetwork()
    if (this.config.chainId !== null && chainId !== this.config.chainId) throw new Error(`wrong network: chain ${chainId}, expected ${this.config.chainId}`)
    if (await this.provider.getCode(this.config.protocol) === '0x') throw new Error('PROTOCOL_ADDRESS has no contract on this network')
    const scope = `${chainId}:${this.config.protocol.toLowerCase()}`
    try {
      const saved = JSON.parse(await readFile(this.config.stateFile, 'utf8'))
      this.state = saved.scope === scope ? saved : null
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    this.state ||= { version: 1, scope, vaults: {} }
    emit('started', {
      chainId, protocol: this.config.protocol, mode: this.config.execute ? 'execute' : 'read-only',
      liquidator: this.signer?.address ?? null,
    })
  }

  async save() {
    const pending = `${this.config.stateFile}.pending`
    await writeFile(pending, JSON.stringify(this.state), { mode: 0o600 })
    await rename(pending, this.config.stateFile)
  }

  async vaults() {
    const count = Number(await this.protocol.vaultCount())
    const addresses = []
    for (let offset = 0; offset < count; offset += 100) addresses.push(...await this.protocol.getAllVaults(offset, 100))
    return addresses
  }

  async token(vault) {
    const key = vault.target.toLowerCase()
    if (!this.tokens.has(key)) {
      const address = await vault.token()
      const erc20 = new ethers.Contract(address, ERC20_ABI, this.signer ?? this.provider)
      const [symbol, decimals] = await Promise.all([erc20.symbol(), erc20.decimals()])
      this.tokens.set(key, { erc20, address, symbol, decimals: Number(decimals) })
    }
    return this.tokens.get(key)
  }

  // Every address with a Borrowed event, per vault. One eth_getLogs covers all the vaults and
  // SCAN_PARALLEL block ranges are requested at a time. The scan only adds addresses, so a reorg
  // can at worst delay a borrower until the overlap window rescans it; forget() drops the
  // positions that are closed.
  async scan(vaults, head) {
    this.lastScan = null
    const entries = new Map(vaults.map((vault) => {
      const key = vault.target.toLowerCase()
      return [key, this.state.vaults[key] ||= { cursor: this.config.fromBlock, borrowers: [] }]
    }))
    const known = new Map([...entries].map(([key, entry]) => [key, new Set(entry.borrowers)]))
    const recent = new Map([...entries.keys()].map((key) => [key, new Set()]))
    if (!entries.size) return known
    const save = async (cursor) => {
      for (const [key, entry] of entries) {
        entry.borrowers = [...known.get(key)]
        if (cursor > entry.cursor) entry.cursor = cursor
      }
      await this.save()
    }
    const filter = { address: [...entries.keys()], topics: [BORROWED] }
    const safeHead = head - this.config.confirmations
    // The last block no reorg can change any more; forget() reads the debts there.
    const settled = safeHead - this.config.reorgDepth
    // A vault listed for the first time restarts the scan at FROM_BLOCK for every vault: same
    // number of requests as scanning it alone.
    let from = Math.max(this.config.fromBlock, Math.min(...[...entries.values()].map((entry) => entry.cursor)) - this.config.reorgDepth)
    let rounds = 0
    while (from <= safeHead && !this.stopped) {
      const ranges = []
      for (let start = from; start <= safeHead && ranges.length < this.config.scanParallel; start += this.logRange) {
        ranges.push([start, Math.min(start + this.logRange - 1, safeHead)])
      }
      let pages
      try {
        pages = await Promise.all(ranges.map(([fromBlock, toBlock]) => this.provider.getLogs({ ...filter, fromBlock, toBlock })))
      } catch (error) {
        const message = rpcMessage(error)
        if (this.logRange === 1) throw new Error(`eth_getLogs refused block ${from}: ${message}`)
        // Take the limit the RPC states; without one, halve the range and retry the same blocks.
        const limit = rangeLimit(message)
        this.logRange = limit >= 1 && limit < this.logRange ? limit : Math.floor(this.logRange / 2)
        continue
      }
      for (const log of pages.flat()) {
        const key = log.address.toLowerCase()
        const borrower = ethers.getAddress(ethers.dataSlice(log.topics[1], 12))
        known.get(key)?.add(borrower)
        if (log.blockNumber > settled) recent.get(key)?.add(borrower)
      }
      from = ranges.at(-1)[1] + 1
      if (++rounds % 25 === 0) {
        await save(from)
        emit('scan', { block: from, head: safeHead, blocksPerRequest: this.logRange })
      }
    }
    await save(from)
    this.lastScan = { settled, recent, complete: from > safeHead }
    return new Map([...known].map(([key, borrowers]) => [key, [...borrowers]]))
  }

  // One vault function read for many borrowers: READ_BATCH of them per request through
  // Multicall3, one request each on a chain without it. A read the vault refuses is null.
  async readAll(vault, method, argsOf, borrowers, blockTag = 'latest') {
    this.batched ??= await this.provider.getCode(MULTICALL3) !== '0x'
    const requests = borrowers.map((borrower) => vault.interface.encodeFunctionData(method, argsOf(borrower)))
    const decode = (data) => { try { return vault.interface.decodeFunctionResult(method, data) } catch { return null } }
    const answers = []
    if (!this.batched) {
      for (const data of requests) {
        answers.push(await this.provider.call({ to: vault.target, data, blockTag }).then(decode, (error) => {
          if (error.code === 'CALL_EXCEPTION') return null
          throw error
        }))
      }
      return answers
    }
    for (let index = 0; index < requests.length; index += READ_BATCH) {
      const calls = requests.slice(index, index + READ_BATCH).map((callData) => ({ target: vault.target, allowFailure: true, callData }))
      const data = await this.provider.call({ to: MULTICALL3, data: MULTICALL.encodeFunctionData('aggregate3', [calls]), blockTag })
      const [replies] = MULTICALL.decodeFunctionResult('aggregate3', data)
      for (const reply of replies) answers.push(reply.success ? decode(reply.returnData) : null)
    }
    return answers
  }

  // Only the positions that still owe something stay listed.
  // An address whose debt was zero REORG_DEPTH blocks behind the scan, and that has not borrowed
  // since, leaves the list: no reorg can undo it, and borrowing again emits a Borrowed event that
  // the scan picks up. Otherwise every address that ever borrowed would be read on every pass.
  async forget(vaults, borrowersOf) {
    const { settled, recent, complete } = this.lastScan ?? {}
    if (!complete || settled < this.config.fromBlock) return
    let forgotten = false
    for (const vault of vaults) {
      const key = vault.target.toLowerCase()
      const candidates = borrowersOf.get(key).filter((borrower) => !recent.get(key).has(borrower))
      if (!candidates.length) continue
      // No answer (older vault version, RPC without that block's state): the address stays.
      const debts = await this.readAll(vault, 'getTotalDebt', (borrower) => [borrower], candidates, settled).catch(() => [])
      const closed = new Set(candidates.filter((_borrower, index) => debts[index]?.[0] === 0n))
      if (!closed.size) continue
      const open = borrowersOf.get(key).filter((borrower) => !closed.has(borrower))
      borrowersOf.set(key, open)
      this.state.vaults[key].borrowers = open
      forgotten = true
    }
    if (forgotten) await this.save()
  }

  async liquidate(vault, token, borrower, capital) {
    const spender = vault.target
    const erc20 = token.erc20
    try {
      const current = await erc20.allowance(this.signer.address, spender)
      if (current !== capital) {
        if (current > 0n) await (await erc20.approve(spender, 0n)).wait()
        await (await erc20.approve(spender, capital)).wait()
      }
      // Simulated in the latest block first: a position repaid or liquidated by someone
      // else in the meantime costs nothing. The vault accrues interest once per second, so a
      // transaction estimated in the second of the vault's last operation needs more gas when
      // it lands in the next one: half as much again is allowed, unused gas is not charged.
      const gas = await vault.liquidatePartial.estimateGas(borrower, capital)
      const receipt = await (await vault.liquidatePartial(borrower, capital, { gasLimit: gas * 3n / 2n })).wait()
      if (receipt.status !== 1) throw new Error('transaction reverted')
      const event = receipt.logs.map((log) => { try { return vault.interface.parseLog(log) } catch { return null } })
        .find((log) => log?.name === 'Liquidated')
      return { hash: receipt.hash, debtRepaid: event?.args.debtRepaid, collateralSeized: event?.args.collateralSeized }
    } finally {
      // Never leave a standing approval on your wallet.
      if (await erc20.allowance(this.signer.address, spender) > 0n) await (await erc20.approve(spender, 0n)).wait()
    }
  }

  async runOnce() {
    if (!this.state) await this.initialize()
    const head = await this.provider.getBlockNumber()
    const results = []
    const vaults = (await this.vaults()).map((address) => new ethers.Contract(address, VAULT_ABI, this.signer ?? this.provider))
    let borrowersOf
    try {
      borrowersOf = await this.scan(vaults, head)
      await this.forget(vaults, borrowersOf)
    } catch (error) {
      emit('error', { message: error.shortMessage || error.message })
      return results
    }
    // Stopped during the scan: progress is saved, the next start resumes there.
    if (this.stopped) return results
    for (const vault of vaults) {
      const address = vault.target
      try {
        const token = await this.token(vault)
        const borrowers = borrowersOf.get(address.toLowerCase())
        // Older vault versions have no pause flag; the contract still refuses a paused
        // liquidation, and every transaction is simulated first.
        const paused = await vault.liquidationsPaused().catch(() => false)
        const format = (value) => ethers.formatUnits(value, token.decimals)
        let capital = ethers.MaxUint256
        if (this.config.execute) {
          const balance = await token.erc20.balanceOf(this.signer.address)
          const cap = this.config.maxRepay === null ? balance : ethers.parseUnits(this.config.maxRepay, token.decimals)
          capital = balance < cap ? balance : cap
        }
        emit('vault', { vault: address, token: token.symbol, borrowers: borrowers.length, liquidationsPaused: paused,
          ...(this.config.execute ? { capital: format(capital) } : {}) })
        const minProfit = ethers.parseUnits(this.config.minProfit, token.decimals)
        // Every position is previewed in a few grouped requests; a position that comes out
        // liquidatable is previewed again alone, with the capital left after earlier liquidations.
        const preview = (borrower) => [borrower, capital > 0n ? capital : ethers.MaxUint256]
        const healthy = await this.readAll(vault, 'previewLiquidation', preview, borrowers)
        for (const [index, borrower] of borrowers.entries()) {
          if (this.stopped) return results
          if (healthy[index]?.repayAmount === 0n) continue
          const quote = await vault.previewLiquidation(...preview(borrower))
          if (quote.repayAmount === 0n) continue
          const profit = quote.liquidatorPayout > quote.repayAmount ? quote.liquidatorPayout - quote.repayAmount : 0n
          const opportunity = { vault: address, borrower, token: token.symbol, repay: format(quote.repayAmount),
            receive: format(quote.liquidatorPayout), profit: format(profit), badDebt: format(quote.badDebt) }
          emit('opportunity', opportunity)
          const skip = !this.config.execute ? null
            : paused ? 'liquidations_paused'
            : capital === 0n ? 'no_capital'
            : profit < minProfit ? 'below_min_profit'
            : await this.provider.getBalance(this.signer.address) === 0n ? 'no_gas' : null
          if (!this.config.execute) { results.push({ ...opportunity, outcome: 'reported' }); continue }
          if (skip) { emit('skipped', { vault: address, borrower, reason: skip }); results.push({ ...opportunity, outcome: skip }); continue }
          try {
            const done = await this.liquidate(vault, token, borrower, capital)
            emit('executed', { vault: address, borrower, token: token.symbol, tx: done.hash,
              debtRepaid: done.debtRepaid === undefined ? null : format(done.debtRepaid),
              collateralSeized: done.collateralSeized === undefined ? null : format(done.collateralSeized) })
            results.push({ ...opportunity, outcome: 'executed', tx: done.hash })
            capital = await token.erc20.balanceOf(this.signer.address)
            if (this.config.maxRepay !== null) {
              const cap = ethers.parseUnits(this.config.maxRepay, token.decimals)
              if (capital > cap) capital = cap
            }
          } catch (error) {
            emit('skipped', { vault: address, borrower, reason: error.shortMessage || error.message })
            results.push({ ...opportunity, outcome: 'failed' })
          }
        }
      } catch (error) {
        emit('error', { vault: address, message: error.shortMessage || error.message })
      }
    }
    return results
  }

  // Ctrl+C: the scan stops at its next request, a liquidation in progress is finished first.
  stop() {
    this.stopped = true
  }

  close() {
    this.provider.destroy()
  }
}

async function main() {
  if (process.argv.includes('--help')) return console.log(HELP)
  const bot = new LiquidationBot(readConfig())
  let stopping = false
  const stop = () => { stopping = true; bot.stop() }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  try {
    do {
      await bot.runOnce()
      if (process.argv.includes('--once')) break
      for (let waited = 0; waited < bot.config.intervalMs && !stopping; waited += 1000) await new Promise((resolve) => setTimeout(resolve, 1000))
    } while (!stopping)
  } finally {
    bot.close()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    emit('error', { message: error.shortMessage || error.message })
    process.exitCode = 1
  })
}
