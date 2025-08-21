import { ethers } from 'ethers';
import type { ChainConfig, ExecutionParams } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { metrics, measureTime } from '../utils/metrics.js';

export class ExecutorService {
  private provider: ethers.JsonRpcProvider;
  private wallet?: ethers.Wallet;

  constructor(
    private chainName: string,
    private config: ChainConfig
  ) {
    this.provider = new ethers.JsonRpcProvider(config.rpc);
    
    if (config.privateKey) {
      this.wallet = new ethers.Wallet(config.privateKey, this.provider);
    }
  }

  async executeTransaction(params: ExecutionParams): Promise<string> {
    return measureTime(`execution_${this.chainName}`, async () => {
      const executionStartTime = Date.now();
      
      if (!this.wallet) {
        throw new Error(`No wallet configured for chain ${this.chainName}`);
      }

      logger.info(`🚀 Starting transaction execution on ${this.chainName}`, {
        contract: params.contractAddress,
        method: params.method,
        jobId: params.jobId || 'unknown'
      });

      // Create contract instance with generated ABI
      const abi = this.generateExecutionABI(params.method, params.methodSignature);
      const contract = new ethers.Contract(
        params.contractAddress,
        abi,
        this.wallet
      );

      // Prepare transaction data from method signature
      const txData = this.prepareTransactionData(params);
      
      // Estimate gas with multiplier
      const gasEstimate = await contract[params.method].estimateGas(...txData);
      const gasLimit = BigInt(Math.floor(Number(gasEstimate) * this.config.gasMultiplier));

      // Prepare transaction options
      const txOptions: any = {
        gasLimit: this.config.gasLimit || gasLimit.toString()
      };

      // Add EIP-1559 fee data if available
      if (this.config.maxFeePerGas && this.config.maxPriorityFeePerGas) {
        txOptions.maxFeePerGas = this.config.maxFeePerGas;
        txOptions.maxPriorityFeePerGas = this.config.maxPriorityFeePerGas;
      }

      logger.debug('Transaction parameters', {
        gasEstimate: gasEstimate.toString(),
        gasLimit: gasLimit.toString(),
        gasMultiplier: this.config.gasMultiplier,
        txData: txData.length
      });

      // Execute transaction
      const tx = await contract[params.method](...txData, txOptions);
      
      logger.info('Transaction submitted', {
        txHash: tx.hash,
        method: params.method
      });

      // Wait for confirmation with block confirmations
      const receipt = await tx.wait(this.config.blockConfirmations || 1);
      
      if (receipt.status !== 1) {
        throw new Error(`Transaction failed: ${tx.hash}`);
      }

      const executionEndTime = Date.now();
      const executionDuration = executionEndTime - executionStartTime;
      
      logger.info('✅ Transaction confirmed', {
        txHash: tx.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(),
        executionDurationMs: executionDuration,
        executionDurationSeconds: (executionDuration / 1000).toFixed(2),
        jobId: params.jobId || 'unknown'
      });

      metrics.increment(`executions_success_${this.chainName}`);
      return tx.hash;
    });
  }

  private generateExecutionABI(methodName: string, methodSignature?: string): any[] {
    if (methodSignature) {
      // Parse method signature to generate accurate ABI
      return [this.parseMethodSignature(methodSignature)];
    }

    // Fallback to generic ABI
    return [
      {
        type: 'function',
        name: methodName,
        inputs: [
          { name: 'data', type: 'bytes' },
          { name: 'proof', type: 'bytes' }
        ],
        outputs: [],
        stateMutability: 'nonpayable'
      }
    ];
  }

  private parseMethodSignature(signature: string): any {
    // Parse method signature like "releaseTokens(address user, uint256 amount, bytes32 messageId, bytes proof)"
    const match = signature.match(/^(\w+)\(([^)]*)\)$/);
    if (!match) {
      throw new Error(`Invalid method signature: ${signature}`);
    }

    const [, methodName, paramsStr] = match;
    const inputs = paramsStr.trim() ? paramsStr.split(',').map((param, index) => {
      const parts = param.trim().split(' ').filter(p => p.length > 0);
      const type = parts[0];
      const name = parts[1] || `param${index}`;

      return {
        type: type.trim(),
        name: name.trim()
      };
    }) : [];

    return {
      type: 'function',
      name: methodName,
      inputs,
      outputs: [],
      stateMutability: 'nonpayable'
    };
  }

  private prepareTransactionData(params: ExecutionParams): any[] {
    if (params.methodSignature) {
      // Parse method signature to understand parameter types
      const methodAbi = this.parseMethodSignature(params.methodSignature);
      return this.encodeParametersFromEventData(methodAbi.inputs, params.eventData, params.proofData);
    }

    // Fallback to simple encoding
    const encodedEventData = ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes'],
      [JSON.stringify(params.eventData)]
    );

    const encodedProof = params.proofData 
      ? ethers.AbiCoder.defaultAbiCoder().encode(['bytes'], [JSON.stringify(params.proofData)])
      : '0x';

    return [encodedEventData, encodedProof];
  }

  private encodeParametersFromEventData(
    inputs: any[],
    eventData: any,
    proofData?: any
  ): any[] {
    const values: any[] = [];

    for (const input of inputs) {
      if (input.name === 'proof' && input.type === 'bytes') {
        // Special handling for proof parameter - use the actual proof bytes
        if (proofData && proofData.proof) {
          values.push(proofData.proof);
        } else {
          throw new Error('Proof data is required for proof parameter');
        }
      } else if (input.name === 'key' && input.type === 'string') {
        // Extract key from event data
        if (eventData.args && eventData.args.key !== undefined) {
          values.push(eventData.args.key);
        } else {
          throw new Error('Key not found in event data');
        }
      } else if (input.name === 'value' && input.type === 'bytes') {
        // Extract value from event data
        if (eventData.args && eventData.args.value !== undefined) {
          values.push(eventData.args.value);
        } else {
          throw new Error('Value not found in event data');
        }
      } else if (eventData.args && eventData.args[input.name] !== undefined) {
        // Map from event data by parameter name
        values.push(eventData.args[input.name]);
      } else {
        // Try to find parameter in event data by type matching
        const eventArgs = eventData.args || {};
        const matchingValue = Object.values(eventArgs).find((value, index) => {
          // Simple type matching - could be enhanced
          return index < inputs.length;
        });
        
        if (matchingValue !== undefined) {
          values.push(matchingValue);
        } else {
          // Use default value as fallback
          const defaultValue = this.getDefaultValue(input.type);
          logger.warn(`Parameter ${input.name} not found in event data, using default`, {
            parameterName: input.name,
            parameterType: input.type,
            defaultValue
          });
          values.push(defaultValue);
        }
      }
    }

    return values;
  }

  private getDefaultValue(type: string): any {
    if (type.startsWith('uint') || type.startsWith('int')) {
      return 0;
    } else if (type === 'address') {
      return '0x0000000000000000000000000000000000000000';
    } else if (type === 'bool') {
      return false;
    } else if (type === 'bytes' || type.startsWith('bytes')) {
      return '0x';
    } else if (type === 'string') {
      return '';
    } else {
      return '0x';
    }
  }

  async getChainInfo() {
    try {
      const [blockNumber, balance] = await Promise.all([
        this.provider.getBlockNumber(),
        this.wallet ? this.provider.getBalance(this.wallet.address) : Promise.resolve(BigInt(0))
      ]);

      return {
        chainName: this.chainName,
        blockNumber,
        walletAddress: this.wallet?.address,
        balance: ethers.formatEther(balance),
        gasMultiplier: this.config.gasMultiplier,
        blockConfirmations: this.config.blockConfirmations
      };
    } catch (error) {
      logger.error(`Failed to get chain info for ${this.chainName}`, error);
      return null;
    }
  }
} 