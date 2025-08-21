import { ethers } from 'ethers';
import type { ChainConfig, EventMapping, Job, ContractDeployment } from '../types/index.js';
import { DatabaseService } from '../services/DatabaseService.js';
import { JobQueue } from '../queue/JobQueue.js';
import { DestinationResolverService } from '../services/DestinationResolver.js';
import { logger } from '../utils/logger.js';
import { metrics, measureTime } from '../utils/metrics.js';

export class ChainListener {
  private provider: ethers.JsonRpcProvider;
  private contracts: Map<string, ethers.Contract> = new Map();
  private isPolling: boolean = false;
  private pollingInterval?: any;

  constructor(
    private chainName: string,
    private config: ChainConfig,
    private contractDeployments: Record<string, Record<string, ContractDeployment>>,
    private eventMappings: EventMapping[],
    private db: DatabaseService,
    private jobQueue: JobQueue,
    private destinationResolver: DestinationResolverService
  ) {
    this.provider = new ethers.JsonRpcProvider(config.rpc);
    this.initializeContracts();
  }

  private initializeContracts() {
    logger.info(`Initializing contracts for ${this.chainName}`);

    // Get all contracts that are source or both type on this chain
    Object.entries(this.contractDeployments).forEach(([contractName, deployments]) => {
      const deployment = deployments[this.chainName];
      if (!deployment || (deployment.type !== 'source' && deployment.type !== 'both')) {
        return; // Skip if not deployed or not a source on this chain
      }

      // Find event mappings that use this contract as source
      const relevantMappings = this.eventMappings.filter(mapping => 
        mapping.sourceEvent.contractName === contractName && mapping.enabled
      );

      if (relevantMappings.length === 0) {
        logger.debug(`No event mappings found for contract ${contractName} on ${this.chainName}`);
        return;
      }

      // Generate ABI from event mappings
      const abi = this.generateABI(relevantMappings);
      
      const ethersContract = new ethers.Contract(
        deployment.address,
        abi,
        this.provider
      );

      this.contracts.set(contractName, ethersContract);
      
      logger.debug(`Contract ${contractName} initialized`, {
        address: deployment.address,
        eventCount: relevantMappings.length,
        type: deployment.type
      });
    });
  }

  private generateABI(mappings: EventMapping[]): any[] {
    return mappings.map(mapping => ({
      type: 'event',
      name: mapping.sourceEvent.eventName,
      inputs: this.parseEventSignature(mapping.sourceEvent.eventSignature),
      anonymous: false
    }));
  }

  private parseEventSignature(signature: string): any[] {
    // Parse event signature like "TokenLocked(address user, uint256 amount, uint256 destinationChainId, bytes32 messageId)"
    const match = signature.match(/\(([^)]*)\)/);
    if (!match || !match[1].trim()) return [];

    const params = match[1].split(',').map(param => param.trim());
    return params.map((param, index) => {
      const parts = param.split(' ').filter(p => p.length > 0);
      const type = parts[0];
      const indexed = parts.includes('indexed');
      const name = parts[parts.length - 1] || `param${index}`;

      return {
        type: type.replace('indexed', '').trim(),
        name: name,
        indexed: indexed
      };
    });
  }

  async startPolling() {
    if (this.isPolling) {
      logger.warn(`Polling already started for ${this.chainName}`);
      return;
    }

    logger.info(`Starting polling: ${this.chainName}`, {
      interval: this.config.pollingInterval,
      contracts: this.contracts.size,
      confirmations: this.config.blockConfirmations
    });

    this.isPolling = true;

    // Initialize from current block if this is the first time
    const lastProcessedBlock = this.db.getLastProcessedBlock(this.chainName);
    if (lastProcessedBlock === 0) {
      const currentBlock = await this.provider.getBlockNumber();
      const startBlock = currentBlock - this.config.blockConfirmations;
      this.db.updateLastProcessedBlock(this.chainName, startBlock);
      logger.info(`Initialized chain: ${this.chainName}`, {
        startBlock,
        confirmations: this.config.blockConfirmations
      });
    }

    // Initial poll
    await this.pollForEvents();

    // Set up interval polling
    this.pollingInterval = setInterval(async () => {
      try {
        await this.pollForEvents();
      } catch (error) {
        logger.error(`Polling error for ${this.chainName}`, error);
        metrics.increment(`polling_errors_${this.chainName}`);
      }
    }, this.config.pollingInterval);
  }

  async stopPolling() {
    if (!this.isPolling) return;

    logger.info(`Stopping polling for ${this.chainName}`);
    this.isPolling = false;

    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = undefined;
    }
  }

  private async pollForEvents() {
    await measureTime(`polling_${this.chainName}`, async () => {
      const currentBlock = await this.provider.getBlockNumber();
      const lastProcessedBlock = this.db.getLastProcessedBlock(this.chainName);

      // Account for block confirmations
      const safeBlock = currentBlock - this.config.blockConfirmations;
      
      if (safeBlock <= lastProcessedBlock) {
        logger.debug(`No new confirmed blocks for ${this.chainName}`, {
          current: currentBlock,
          safe: safeBlock,
          lastProcessed: lastProcessedBlock,
          confirmations: this.config.blockConfirmations
        });
        return;
      }

      const fromBlock = lastProcessedBlock + 1;
      const toBlock = Math.min(safeBlock, fromBlock + 100); // Process max 100 blocks at once

      logger.debug(`Processing blocks for ${this.chainName}: ${fromBlock} -> ${toBlock}`);

      for (const [contractName, contract] of this.contracts) {
        await this.processContractEvents(contractName, contract, fromBlock, toBlock);
      }

      // Update last processed block
      this.db.updateLastProcessedBlock(this.chainName, toBlock);
      metrics.increment(`blocks_processed_${this.chainName}`, toBlock - fromBlock + 1);
    });
  }

  private async processContractEvents(
    contractName: string,
    contract: ethers.Contract,
    fromBlock: number,
    toBlock: number
  ) {
    // Get all event mappings for this contract
    const contractMappings = this.eventMappings.filter(mapping => 
      mapping.sourceEvent.contractName === contractName && mapping.enabled
    );

    for (const mapping of contractMappings) {
      try {
        const filter = contract.filters[mapping.sourceEvent.eventName]();
        const events = await contract.queryFilter(filter, fromBlock, toBlock);

        if (events.length > 0) {
          logger.debug(`Found ${events.length} ${mapping.sourceEvent.eventName} events on ${contractName}`);
        }

        for (const event of events) {
          await this.processEvent(event as ethers.EventLog, mapping, contractName);
        }

        metrics.increment(`events_processed_${this.chainName}_${mapping.sourceEvent.eventName}`, events.length);
      } catch (error) {
        logger.error(`Error processing events for ${contractName}:${mapping.sourceEvent.eventName}`, error);
        metrics.increment(`event_processing_errors_${this.chainName}`);
      }
    }
  }

  private async processEvent(
    event: ethers.EventLog,
    mapping: EventMapping,
    contractName: string
  ) {
    // Apply event filters if configured
    if (mapping.eventFilter) {
      const eventArgs = event.args ? event.args.toObject() : {};
      
      // Filter by key if specified (for OracleUpdate events)
      if (mapping.eventFilter.key && Array.isArray(mapping.eventFilter.key)) {
        const eventKey = eventArgs.key;
        if (eventKey && !mapping.eventFilter.key.includes(eventKey)) {
          logger.debug(`Skipping event due to key filter`, { 
            eventKey, 
            allowedKeys: mapping.eventFilter.key 
          });
          return;
        }
      }
    }

    const jobId = `${this.chainName}-${event.transactionHash}-${event.index || 0}`;
    const eventFirstSeenTime = Date.now();

    // Check if already processed
    const existingJob = this.db.getJobByUniqueId(jobId);
    if (existingJob) {
      logger.debug(`Skipping duplicate event`, { jobId });
      return;
    }

    // Log when event is first detected
    const eventArgs = event.args ? event.args.toObject() : {};
    logger.info(`🔍 Event first detected`, {
      jobId,
      eventType: mapping.sourceEvent.eventName,
      contractName: contractName,
      chain: this.chainName,
      blockNumber: event.blockNumber,
      transactionHash: event.transactionHash,
      eventKey: eventArgs.key || 'N/A',
      timestamp: new Date(eventFirstSeenTime).toISOString()
    });

    // Prepare event data for destination resolver.
    // Use .toObject() to get a plain object with only named properties.
    const eventData = {
      name: mapping.sourceEvent.eventName,
      args: eventArgs,
      blockNumber: event.blockNumber,
      transactionIndex: event.transactionIndex,
      index: event.index || 0,
      firstSeenTime: eventFirstSeenTime
    };

    try {
      // Resolve destination chains
      const destinationChains = await this.destinationResolver.resolveDestinations(
        mapping,
        eventData,
        this.chainName
      );

      if (destinationChains.length === 0) {
        logger.warn('No destination chains resolved for event', { 
          mapping: mapping.name,
          sourceTx: event.transactionHash
        });
      }

      // Create a job for each destination chain
      for (const destChain of destinationChains) {
        await this.createJobForDestination(jobId, event, mapping, destChain, eventData);
      }

    } catch (error) {
      logger.error('Error processing event', {
        mapping: mapping.name,
        sourceTx: event.transactionHash,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async createJobForDestination(
    baseJobId: string,
    event: ethers.EventLog,
    mapping: EventMapping,
    destChain: string,
    eventData: any
  ) {
    const { destAddress, destMethod, destMethodSignature } = this.getDestinationCallDetails(mapping, destChain);

    const uniqueId = `${baseJobId}-${destChain}`;

    if (this.db.getJobByUniqueId(uniqueId)) {
      logger.debug(`Duplicate job detected, skipping`, { uniqueId });
      return;
    }

    // Custom BigInt replacer for serialization
    const replacer = (key: string, value: any) =>
      typeof value === 'bigint' ? value.toString() : value;

    const job: Omit<Job, 'id'> = {
      unique_id: uniqueId,
      source_chain: this.chainName,
      source_tx_hash: event.transactionHash,
      source_block_number: event.blockNumber,
      dest_chain: destChain,
      dest_address: destAddress,
      dest_method: destMethod,
      dest_method_signature: destMethodSignature,
      event_data: JSON.stringify(eventData, replacer),
      status: 'pending',
      proof_required: mapping.proofRequired,
      retry_count: 0,
      created_at: new Date().toISOString(),
      mapping_name: mapping.name
    };

    const jobId = this.db.createJob(job);
    this.jobQueue.addJob({ ...job, id: jobId });

    logger.info(`Created job: ${mapping.name}`, {
      jobId,
      sourceTx: event.transactionHash,
      sourceChain: this.chainName,
      destChain,
    });
    
    metrics.increment(`jobs_created_${this.chainName}_${destChain}`);
  }

  private getDestinationCallDetails(mapping: EventMapping, destChain: string): {
    destAddress: string,
    destMethod: string,
    destMethodSignature: string
  } {
    const destContractDeployment = this.contractDeployments[mapping.destinationCall.contractName]?.[destChain];
    if (!destContractDeployment) {
      throw new Error(`Contract ${mapping.destinationCall.contractName} not configured for destination chain ${destChain}`);
    }

    if (destContractDeployment.type !== 'destination' && destContractDeployment.type !== 'both') {
      throw new Error(`Contract ${mapping.destinationCall.contractName} on ${destChain} is not configured as a destination`);
    }

    return {
      destAddress: destContractDeployment.address,
      destMethod: mapping.destinationCall.methodName,
      destMethodSignature: mapping.destinationCall.methodSignature
    };
  }

  async getChainInfo() {
    try {
      const [blockNumber, chainId] = await Promise.all([
        this.provider.getBlockNumber(),
        this.provider.getNetwork().then((n: any) => n.chainId)
      ]);

      return {
        chainName: this.chainName,
        blockNumber,
        chainId: Number(chainId),
        lastProcessedBlock: this.db.getLastProcessedBlock(this.chainName),
        isPolling: this.isPolling,
        contractsMonitored: this.contracts.size,
        activeMappings: this.eventMappings.filter(m => m.enabled).length
      };
    } catch (error) {
      logger.error(`Failed to get chain info for ${this.chainName}`, error);
      return null;
    }
  }
} 