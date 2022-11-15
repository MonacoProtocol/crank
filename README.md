# Monaco Protocol Crank

The process of "cranking" or "crank turning" is required by the Monaco Protocol to drive on-chain Order matching and settlement.

Currently all mainnet crank operators much first be approved by the Monaco Foundation.


## Getting Started

Install dependencies
```shell
npm install
```

Set required environment variables:
```shell
export ANCHOR_WALLET=~/.config/solana/id.json                     # crank operator wallet
export ANCHOR_PROVIDER_URL=https://api.mainnet-beta.solana.com    # default cluster or rpc node url
export ENVIRONMENT=mainnet                                        # target cluster
export PROGRAM_TYPE=stable                                        # program type (stable for mainnet)
```

Run crank once for specific market:
```shell
npm run local-crank MATCH ${MARKET_PUBKEY}                        # crank order matching
npm run local-crank SETTLE ${MARKET_PUBKEY}                       # crank order settlement
```

Run crank in "server" mode, continuously cranking available markets:
```shell
npm run local-start MATCH                                         # crank order matching
npm run local-crank SETTLE                                        # crank order settlement
```