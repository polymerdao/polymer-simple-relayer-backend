export interface ChainConfig {
  chainId: number;
  rpc: string;
  privateKey: string;
  pollingInterval: number;
  blockConfirmations: number;
  gasMultiplier: number;
  gasLimit?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
}

export interface ContractDeployment {
  address: string;
  type: 'source' | 'destination' | 'both';
  abi?: string | any[]; // Path to ABI file or ABI array
}

export interface SourceEvent {
  contractName: string;
  eventName: string;
  eventSignature: string;
}

export interface DestinationCall {
  contractName: string;
  methodName: string;
  methodSignature: string;
}

export interface EventMapping {
  name: string;
  sourceEvent: SourceEvent;
  destinationCall: DestinationCall;
  destinationResolver: string;
  proofRequired: boolean;
  enabled: boolean;
  eventFilter?: {
    key?: string[];
    [key: string]: any;
  };
}

export interface DestinationResolver {
  type: 'eventParameter' | 'static' | 'custom';
  parameterName?: string;
  mapping?: Record<string, string>;
  destinations?: string[];
  customFunction?: string;
}

export interface RelayerConfig {
  chains: Record<string, ChainConfig>;
  contracts: Record<string, Record<string, ContractDeployment>>;
  eventMappings: EventMapping[];
  destinationResolvers: Record<string, DestinationResolver>;
  proofApi: {
    baseUrl: string;
    timeout: number;
    retryAttempts: number;
    apiKey?: string;
  };
  database: {
    path: string;
  };
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error';
    enableFileLogging: boolean;
    logPath?: string;
  };
}

export interface Job {
  id?: number;
  unique_id: string;
  source_chain: string;
  source_tx_hash: string;
  source_block_number: number;
  dest_chain: string;
  dest_address: string;
  dest_method: string;
  dest_method_signature: string;
  event_data: string;
  proof_data?: string;
  status: JobStatus;
  proof_required: boolean;
  dest_tx_hash?: string;
  retry_count: number;
  error_message?: string;
  created_at: string;
  completed_at?: string;
  last_retry_at?: string;
  mapping_name: string; // Track which mapping created this job
}

export type JobStatus = 'pending' | 'proof_requested' | 'proof_ready' | 'executing' | 'completed' | 'failed';

export interface ProofRequest {
  txHash: string;
  chain: string;
  blockNumber: number;
  eventIndex: number;
}

export interface ProofResponse {
  proof: string;
  blockHash: string;
  blockNumber: number;
  transactionIndex: number;
  valid: boolean;
  metadata?: any;
}

export interface ExecutionParams {
  contractAddress: string;
  method: string;
  methodSignature: string;
  eventData: any;
  proofData?: any;
  gasLimit?: string;
}

// Legacy interfaces for backward compatibility
export interface EventConfig {
  name: string;
  signature: string;
  destinationChain: string;
  destinationAddress: string;
  destinationMethod: string;
  proofRequired: boolean;
}

export interface ContractConfig {
  name: string;
  sourceChain: string;
  sourceAddress: string;
  events: EventConfig[];
  abi?: any[];
} 