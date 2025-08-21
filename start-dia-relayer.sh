#!/bin/bash

# Load environment variables
if [ -f .env ]; then
    source .env
fi

# Check required environment variables
if [ -z "$PRIVATE_KEY" ]; then
    echo "Error: PRIVATE_KEY not set in .env file"
    exit 1
fi

if [ -z "$DIA_RPC_URL" ]; then
    echo "Error: DIA_RPC_URL not set in .env file"
    exit 1
fi

if [ -z "$OPTIMISM_RPC_URL" ]; then
    echo "Error: OPTIMISM_RPC_URL not set in .env file"
    exit 1
fi

if [ -z "$POLYMER_API_KEY" ]; then
    echo "Error: POLYMER_API_KEY not set in .env file"
    exit 1
fi

# DIA_ORACLE_WITH_PROOF_ADDRESS is now hardcoded in config
# Deployed at: 0xe2B4CCC0dd84465531725EAC3C542f271F9C9D35

# Create logs directory if it doesn't exist
mkdir -p logs/dia-oracle

echo "Starting DIA Oracle Relayer..."
echo "DIA Chain ID: 1050"
echo "Optimism Chain ID: 10"
echo "Source Contract: 0xd7EbD2155F2734c6F80c56979CB125712A94F61C"
echo "Destination Contract: 0xe2B4CCC0dd84465531725EAC3C542f271F9C9D35"
echo "Relayer Address: $(cast wallet address $PRIVATE_KEY)"

# Start the relayer with the DIA Oracle config
CONFIG_PATH=./src/config/relayer.config.dia-oracle.json bun run src/main.ts

# Alternative: Run with specific start block if needed
# CONFIG_PATH=./src/config/relayer.config.dia-oracle.json bun run src/main.ts --start-from 1050:12345