# CantorFi liquidation bot

Public reference liquidation bot for [CantorFi](https://www.cantorfi.xyz), a lending protocol on Base made of isolated vaults.

Each CantorFi vault lends one token against collateral in that same token. When a position's debt rises above the vault's liquidation threshold, anyone may repay part or all of the debt with `liquidatePartial` and receive the matching collateral plus the vault's liquidation bonus, minus the protocol share of that bonus.

This bot does exactly that, from your machine and your wallet. Started without a key, it only reads the chain and reports what could be liquidated and for how much. No executor contract, no API key, no CantorFi key.

- Full guide: https://www.cantorfi.xyz/bots
- How liquidations work: https://www.cantorfi.xyz/defi-liquidations
- Protocol documentation: https://www.cantorfi.xyz/docs

## Network values (Base Sepolia)

| Value | Base Sepolia |
| --- | --- |
| Chain id | `84532` |
| Public RPC | `https://sepolia.base.org` |
| Protocol registry | `0x81dEe1B70a19C752c813BE537BCCa440CCafD428` |
| Deployment block | `47408113` |
| USDC vault | `0xafbd36597603bE94b89AEed91f18ba7e5f36A282` |
| WETH vault | `0x0a425605Dd1aE80528De2AA5007e46aA410d87b9` |

The current public deployment of CantorFi is a developer preview on Base Sepolia.

## Read-only quick start

No key, nothing signed. Node.js 20 or later.

```bash
git clone https://github.com/cantorfi/liquidation-bot.git
cd liquidation-bot
npm install

RPC_URL=https://sepolia.base.org \
PROTOCOL_ADDRESS=0x81dEe1B70a19C752c813BE537BCCa440CCafD428 \
FROM_BLOCK=47408113 \
CHAIN_ID=84532 \
npm start -- --once
```

The bot lists every vault and every position that can be liquidated now. Public RPCs cap log queries, so the first pass reads the history in chunks and takes a few minutes; the state file then keeps the borrower list and the next passes take seconds.

## Liquidate with your wallet

Use a wallet dedicated to the bot, holding only the capital you accept to use and some ETH for gas. Add the key and `EXECUTE=1`, then leave it watching:

```bash
RPC_URL=https://sepolia.base.org \
PROTOCOL_ADDRESS=0x81dEe1B70a19C752c813BE537BCCa440CCafD428 \
FROM_BLOCK=47408113 \
CHAIN_ID=84532 \
LIQUIDATOR_PRIVATE_KEY=<your dedicated wallet key> \
EXECUTE=1 \
MAX_REPAY=1000 \
MIN_PROFIT=1 \
npm start
```

`MAX_REPAY` caps the capital engaged per liquidation and `MIN_PROFIT` skips opportunities below your threshold (both in the vault token). The key is read locally by ethers and never leaves your machine.

There is no zero-capital liquidation: your wallet must hold the vault's token (USDC for the USDC vault, WETH for the WETH vault) and a little ETH for gas. The profit is paid in that same token.

## How one pass works

1. **Discover.** The bot reads the vault list from the protocol registry, then every `Borrowed` event since the deployment block. Borrowers are cached in a state file, so later passes only scan new blocks.
2. **Preview.** For each borrower it calls `previewLiquidation`: the exact amount to repay, the collateral you receive, your profit and any bad debt, at the current block. A healthy position returns zero and is skipped.
3. **Liquidate** (only with `EXECUTE=1`). It approves exactly the capital needed, simulates `liquidatePartial` in the latest block, sends it, then resets the approval to zero. A position already repaid or liquidated by someone else fails in simulation and costs nothing.

## Configuration

| Variable | Use | Description |
| --- | --- | --- |
| `RPC_URL` | Required | JSON-RPC endpoint of the CantorFi network. |
| `PROTOCOL_ADDRESS` | Required | CantorFiProtocol registry: the bot lists every vault from it. |
| `FROM_BLOCK` | Required | Protocol deployment block, where the borrower scan starts. |
| `CHAIN_ID` | Recommended | Expected chain id; the bot stops on any other network. |
| `LIQUIDATOR_PRIVATE_KEY` | Execution | Your own wallet. It holds the repayment capital and the gas. Never shared. |
| `EXECUTE` | Execution | Set to 1 to send transactions. Without it the bot only reads and reports. |
| `MAX_REPAY` | Optional | Capital cap per liquidation, in the vault token (default: whole balance). |
| `MIN_PROFIT` | Optional | Minimum profit per liquidation, in the vault token (default 0). |
| `INTERVAL_SECONDS` | Optional | Delay between passes in watch mode (default 30). |
| `CONFIRMATIONS` / `REORG_DEPTH` | Optional | Blocks behind head, and blocks rescanned each pass (defaults 2 and 64). |
| `LOG_RANGE` | Optional | Blocks per `eth_getLogs` request (default 2000, halved automatically if the RPC refuses). |
| `STATE_FILE` | Optional | Borrower cache; keep it so restarts only scan new blocks. |

`--once` runs a single pass and exits; without it the bot runs a pass every `INTERVAL_SECONDS` until Ctrl+C. `--help` prints this list.

## Output

Every line is one JSON event, easy to pipe into your own alerts: `started`, `vault`, `opportunity`, `skipped` (with its reason), `executed` and `error`.

```json
{"event":"started","chainId":"84532","mode":"read-only","liquidator":null}
{"event":"vault","vault":"0xafbd36597603bE94b89AEed91f18ba7e5f36A282","token":"USDC","borrowers":12,"liquidationsPaused":false}
{"event":"opportunity","borrower":"0x…","token":"USDC","repay":"850.000007","receive":"888.250007","profit":"38.25","badDebt":"0.0"}
```

## License

MIT. Provided as-is, without warranty. You pay the gas, you choose the capital at risk.
