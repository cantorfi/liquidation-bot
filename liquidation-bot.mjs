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
  LOG_RANGE                blocks per eth_getLogs request (default 2000)
  STATE_FILE               borrower cache (default ./cantorfi-liquidation-state.json)

Every line of output is one JSON event: vault, opportunity, skipped, executed, error.`

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
]
const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]

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
    stateFile: env.STATE_FILE || './cantorfi-liquidation-state.json',
  }
  if (config.reorgDepth <= config.confirmations) throw new Error('REORG_DEPTH must exceed CONFIRMATIONS')
  return config
}

export class LiquidationBot {
  constructor(config) {
    this.config = config
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl, undefined, { batchMaxCount: 1 })
    this.signer = config.privateKey ? new ethers.Wallet(config.privateKey, this.provider) : null
    this.protocol = new ethers.Contract(config.protocol, PROTOCOL_ABI, this.provider)
    this.tokens = new Map()
    this.state = null
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

  // Every address that ever borrowed from the vault. The set only grows, so a reorg can
  // at worst delay a borrower until the overlap window rescans it.
  async borrowers(vault, head) {
    const key = vault.target.toLowerCase()
    const entry = this.state.vaults[key] ||= { cursor: this.config.fromBlock, borrowers: [] }
    const known = new Set(entry.borrowers)
    const safeHead = head - this.config.confirmations
    let from = Math.max(this.config.fromBlock, entry.cursor - this.config.reorgDepth)
    let chunks = 0
    while (from <= safeHead) {
      const to = Math.min(from + this.logRange - 1, safeHead)
      let logs
      try {
        logs = await vault.queryFilter(vault.filters.Borrowed(), from, to)
      } catch (error) {
        // Public RPCs cap eth_getLogs differently: halve the range and retry the same blocks.
        if (this.logRange === 1) throw error
        this.logRange = Math.max(1, Math.floor(this.logRange / 2))
        continue
      }
      for (const log of logs) known.add(ethers.getAddress(log.args.borrower))
      entry.cursor = to + 1
      from = to + 1
      if (++chunks % 25 === 0) { entry.borrowers = [...known]; await this.save() }
    }
    entry.borrowers = [...known]
    await this.save()
    return entry.borrowers
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
      // else in the meantime costs nothing.
      await vault.liquidatePartial.staticCall(borrower, capital)
      const receipt = await (await vault.liquidatePartial(borrower, capital)).wait()
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
    for (const address of await this.vaults()) {
      const vault = new ethers.Contract(address, VAULT_ABI, this.signer ?? this.provider)
      try {
        const token = await this.token(vault)
        // Older vault versions have no pause flag; the contract still refuses a paused
        // liquidation, and every transaction is simulated first.
        const [borrowers, paused] = await Promise.all([this.borrowers(vault, head), vault.liquidationsPaused().catch(() => false)])
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
        for (const borrower of borrowers) {
          const quote = await vault.previewLiquidation(borrower, capital > 0n ? capital : ethers.MaxUint256)
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

  close() {
    this.provider.destroy()
  }
}

async function main() {
  if (process.argv.includes('--help')) return console.log(HELP)
  const bot = new LiquidationBot(readConfig())
  let stopping = false
  process.on('SIGINT', () => { stopping = true })
  process.on('SIGTERM', () => { stopping = true })
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
