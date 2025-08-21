# DIA Oracle Cross-Chain Relayer Setup

This relayer bridges Oracle price updates from DIA Chain (ID: 1050) to Optimism (ID: 10) using Polymer's cross-chain proof system.

## Architecture

```
DIA Chain (1050)                    Optimism (10)
┌─────────────────┐                ┌──────────────────────┐
│  DIAOracleV2    │                │ DIAOracleWithProof   │
│  0xd7EbD2...     │ ─────────────> │  (TBD address)       │
└─────────────────┘                └──────────────────────┘
     │                                      │
     └── OracleUpdate Event                 └── setValueWithProof(proof)
         (key, value, timestamp)
```

## Setup Instructions

### 1. Deploy DIAOracleWithProof Contract

```bash
# Deploy to Optimism mainnet
./deploy.sh https://mainnet.optimism.io

# Or deploy to Optimism testnet
./deploy.sh https://sepolia.optimism.io
```

### 2. Configure Environment

Copy the example environment file and fill in your values:

```bash
cp .env.dia-oracle.example .env
```

Edit `.env` with:
- `PRIVATE_KEY`: Your relayer wallet private key
- `DIA_RPC_URL`: RPC endpoint for DIA chain
- `OPTIMISM_RPC_URL`: RPC endpoint for Optimism
- `POLYMER_API_KEY`: Your Polymer API key
- `DIA_ORACLE_WITH_PROOF_ADDRESS`: Address from step 1

### 3. Fund Relayer Wallet

Ensure your relayer wallet has sufficient native tokens on both chains:
- DIA tokens on DIA chain (for reading events)
- ETH on Optimism (for submitting proofs)

### 4. Start the Relayer

```bash
./start-dia-relayer.sh
```

Or with a specific starting block:

```bash
CONFIG_PATH=./src/config/relayer.config.dia-oracle.json bun run src/main.ts --start-from 1050:123456
```

## Configuration Details

### Event Mapping

- **Source Event**: `OracleUpdate(string key, uint128 value, uint128 timestamp)`
  - Contract: `0xd7EbD2155F2734c6F80c56979CB125712A94F61C` on DIA chain
  - Emitted when oracle prices are updated

- **Destination Call**: `setValueWithProof(bytes proof)`
  - Contract: DIAOracleWithProof on Optimism
  - Validates proof and updates price if valid

### Key Features

1. **Proof Validation**: All updates require valid Polymer proofs
2. **Timestamp Checking**: Prevents stale price updates
3. **Chain ID Verification**: Ensures proofs are from DIA chain (1050)
4. **Contract Address Verification**: Validates source is official DIA Oracle

### Monitoring

- Health check endpoint: `http://localhost:3001/health`
- Metrics endpoint: `http://localhost:9091/metrics`
- Logs directory: `./logs/dia-oracle/`

## Testing

1. Monitor DIA Oracle for updates:
```bash
cast logs --address 0xd7EbD2155F2734c6F80c56979CB125712A94F61C --rpc-url $DIA_RPC_URL
```

2. Check relayer logs:
```bash
tail -f logs/dia-oracle/*.log
```

3. Verify prices on Optimism:
```bash
cast call $DIA_ORACLE_WITH_PROOF_ADDRESS "getValue(string)" "BTC/USD" --rpc-url $OPTIMISM_RPC_URL
```

## Troubleshooting

### Common Issues

1. **"Invalid prover address"**: Ensure prover contract exists at `0x95ccEAE71605c5d97A0AC0EA13013b058729d075`

2. **"Proof validation failed"**: Check Polymer API key and network connectivity

3. **"Stale update"**: The incoming price has an older timestamp than stored value

4. **Gas issues**: Adjust `gasMultiplier` in config (default: 1.2 for Optimism)

### Debug Mode

Enable debug logging by setting in config:
```json
"logging": {
  "level": "debug"
}
```

## Security Considerations

1. **Private Key**: Never commit private keys. Use environment variables only.
2. **RPC Endpoints**: Use authenticated/private RPC endpoints in production
3. **Monitoring**: Set up alerts for failed transactions and proof validations
4. **Rate Limiting**: Consider implementing rate limits for high-frequency updates