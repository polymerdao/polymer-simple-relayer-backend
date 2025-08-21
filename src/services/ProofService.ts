import axios from 'axios';
import type { ProofRequest, ProofResponse, RelayerConfig } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { metrics, measureTime } from '../utils/metrics.js';

interface PolymerProofRequestParams {
  srcChainId: number;
  srcBlockNumber: number;
  globalLogIndex: number;
}

interface PolymerProofResponse {
  jsonrpc: string;
  id: number;
  result?: number | {
    status: 'complete' | 'pending' | 'error' | 'initialized';
    proof?: string;
  };
  error?: {
    code: number;
    message: string;
  };
}

export class ProofService {
  private baseUrl: string;
  private timeout: number;
  private retryAttempts: number;
  private apiKey?: string;
  private maxPollingAttempts: number = 30;
  private pollingInterval: number = 500; // 500ms between polls
  private initialWait: number = 2000; // Wait 2 seconds before starting to poll
  private chainConfigs: Record<string, { chainId: number }>;

  constructor(config: RelayerConfig['proofApi'], chainConfigs: Record<string, { chainId: number }>) {
    this.baseUrl = config.baseUrl || 'https://proof.testnet.polymer.zone';
    this.timeout = config.timeout;
    this.retryAttempts = config.retryAttempts;
    this.apiKey = config.apiKey;
    this.chainConfigs = chainConfigs;
    
    logger.info('ProofService initialized', {
      baseUrl: this.baseUrl,
      timeout: this.timeout,
      retryAttempts: this.retryAttempts,
    });
  }

  async requestProof(request: ProofRequest): Promise<ProofResponse> {
    return measureTime('proof_request', async () => {
      logger.info('Requesting proof from Polymer', {
        txHash: request.txHash,
        chain: request.chain,
        blockNumber: request.blockNumber,
      });

      // Step 1: Request proof job
      const proofStartTime = Date.now();
      const jobId = await this.requestProofJob(request);
      
      // Step 2: Poll for proof completion
      const proofResult = await this.pollForProof(jobId);
      const proofEndTime = Date.now();
      const proofDuration = proofEndTime - proofStartTime;
      
      logger.info(`⚡ Proof completed`, {
        jobId: request.jobId || 'unknown',
        polymerJobId: jobId,
        proofDurationMs: proofDuration,
        proofDurationSeconds: (proofDuration / 1000).toFixed(2)
      });
      
      // Step 3: Convert to our internal format
      const proofResponse: ProofResponse = {
        proof: proofResult.proof,
        blockHash: '0x' + '0'.repeat(64), // Polymer doesn't provide block hash
        blockNumber: request.blockNumber,
        transactionIndex: 0,
        valid: true,
        metadata: {
          jobId,
          polymerProof: true,
          timestamp: new Date().toISOString()
        }
      };

      logger.info('Proof obtained successfully from Polymer', {
        jobId,
        proofLength: proofResult.proof.length
      });

      metrics.increment('proof_requests_success');
      return proofResponse;
    });
  }

  private async requestProofJob(request: ProofRequest): Promise<number> {
    const chainConfig = this.chainConfigs[request.chain];
    if (!chainConfig) {
      throw new Error(`Chain '${request.chain}' not found in configuration`);
    }

    const requestParams: PolymerProofRequestParams = {
      srcChainId: chainConfig.chainId,
      srcBlockNumber: request.blockNumber,
      globalLogIndex: request.eventIndex
    };

    const requestBody = {
      jsonrpc: '2.0',
      id: 1,
      method: 'polymer_requestProof',
      params: [requestParams]
    };

    for (let attempt = 1; attempt <= this.retryAttempts; attempt++) {
      try {
        logger.debug('Requesting proof job from Polymer', {
          attempt,
          params: requestParams
        });

        const response = await axios.post<PolymerProofResponse>(
          this.baseUrl,
          requestBody,
          {
            timeout: this.timeout,
            headers: {
              'Content-Type': 'application/json',
              ...(this.apiKey && { 'Authorization': `Bearer ${this.apiKey}` })
            }
          }
        );

        if (response.data.error) {
          throw new Error(`Polymer API error: ${response.data.error.message} (code: ${response.data.error.code})`);
        }

        if (typeof response.data.result !== 'number') {
          throw new Error('Invalid response: expected jobID as number');
        }

        const jobId = response.data.result;
        logger.info('Proof job requested successfully', {
          jobId,
          attempt,
        });

        return jobId;

      } catch (error) {
        const isLastAttempt = attempt === this.retryAttempts;
        const errorMessage = error instanceof Error ? error.message : String(error);
        
        logger.warn(`Proof job request failed (attempt ${attempt}/${this.retryAttempts})`, {
          error: errorMessage,
          isLastAttempt
        });

        metrics.increment('proof_job_requests_failed');

        if (isLastAttempt) {
          throw new Error(`Failed to request proof job after ${this.retryAttempts} attempts: ${errorMessage}`);
        }

        // Exponential backoff
        const delay = Math.pow(2, attempt - 1) * 1000;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw new Error('Unexpected error in proof job request');
  }

  private async pollForProof(jobId: number): Promise<{ proof: string; status: string }> {
    logger.info(`Polling for proof completion for job ${jobId}`);

    // Wait 2 seconds before starting to poll (Polymer recommendation)
    logger.debug('Waiting before starting proof polling', { 
      jobId, 
      initialWait: this.initialWait 
    });
    await new Promise(resolve => setTimeout(resolve, this.initialWait));

    for (let attempt = 1; attempt <= this.maxPollingAttempts; attempt++) {
      try {
        const requestBody = {
          jsonrpc: '2.0',
          id: 1,
          method: 'polymer_queryProof',
          params: [jobId]
        };

        logger.debug('Querying proof status', {
          jobId,
          attempt,
          maxAttempts: this.maxPollingAttempts
        });

        const response = await axios.post<PolymerProofResponse>(
          this.baseUrl,
          requestBody,
          {
            timeout: this.timeout,
            headers: {
              'Content-Type': 'application/json',
              ...(this.apiKey && { 'Authorization': `Bearer ${this.apiKey}` })
            }
          }
        );

        if (response.data.error) {
          throw new Error(`Polymer API error: ${response.data.error.message} (code: ${response.data.error.code})`);
        }

        const result = response.data.result;
        if (!result || typeof result === 'number') {
          throw new Error('Invalid response: expected proof status object');
        }

        logger.debug('Proof status response', {
          jobId,
          status: result.status,
          attempt
        });

        switch (result.status) {
          case 'complete':
            if (!result.proof) {
              throw new Error('Proof completed but no proof data provided');
            }
            
            // Decode base64 proof and convert to hex
            const proofBytes = Buffer.from(result.proof, 'base64');
            const proofHex = '0x' + proofBytes.toString('hex');
            
            logger.info(`Proof completed successfully for job ${jobId}`, {
              attempt,
              proofLength: proofHex.length
            });

            return {
              proof: proofHex,
              status: result.status
            };

          case 'pending':
          case 'initialized': // Handle initialized status as pending
            logger.debug('Proof still processing', {
              jobId,
              status: result.status,
              attempt,
              nextPollIn: this.pollingInterval
            });
            
            // Wait before next poll (only if not the last attempt)
            if (attempt < this.maxPollingAttempts) {
              await new Promise(resolve => setTimeout(resolve, this.pollingInterval));
            }
            continue;

          case 'error':
            throw new Error(`Proof generation failed for job ${jobId}`);

          default:
            logger.warn(`Unknown proof status: ${result.status}`, {
              jobId,
              status: result.status,
              attempt
            });
            // Treat unknown status as pending and continue polling
            if (attempt < this.maxPollingAttempts) {
              await new Promise(resolve => setTimeout(resolve, this.pollingInterval));
            }
            continue;
        }

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.warn(`Proof polling attempt ${attempt} failed`, {
          jobId,
          error: errorMessage,
          attempt
        });

        // If it's the last attempt, throw the error
        if (attempt === this.maxPollingAttempts) {
          throw new Error(`Failed to get proof after ${this.maxPollingAttempts} polling attempts: ${errorMessage}`);
        }

        // Wait before retry
        await new Promise(resolve => setTimeout(resolve, this.pollingInterval));
      }
    }

    throw new Error(`Proof polling timeout after ${this.maxPollingAttempts} attempts`);
  }

  // For testing/development - mock proof response
  async mockProof(request: ProofRequest): Promise<ProofResponse> {
    logger.warn('Using mock proof - only for development!', request);
    
    await new Promise(resolve => setTimeout(resolve, 100)); // Simulate API delay
    
    return {
      proof: `0x${'mock'.repeat(32)}`, // Mock hex proof
      blockHash: `0x${'0'.repeat(64)}`,
      blockNumber: request.blockNumber,
      transactionIndex: 0,
      valid: true,
      metadata: {
        mock: true,
        timestamp: new Date().toISOString()
      }
    };
  }

  /**
   * Test connection to Polymer API
   */
  async testConnection(): Promise<boolean> {
    try {
      // Get first available chain for testing
      const firstChain = Object.keys(this.chainConfigs)[0];
      if (!firstChain) {
        throw new Error('No chains configured');
      }

      // Try a simple request to test connectivity
      const testRequest: ProofRequest = {
        chain: firstChain,
        txHash: '0x' + '0'.repeat(64),
        blockNumber: 1,
        eventIndex: 0
      };

      // This will fail but we can check if the API is reachable
      await this.requestProofJob(testRequest);
      return true;
    } catch (error) {
      logger.error('Polymer API connection test failed', {
        error: error instanceof Error ? error.message : String(error)
      });
      return false;
    }
  }
} 