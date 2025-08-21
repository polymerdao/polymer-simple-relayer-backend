import type { Job, JobStatus, RelayerConfig } from '../types/index.js';
import { DatabaseService } from '../services/DatabaseService.js';
import { ProofService } from '../services/ProofService.js';
import { ExecutorService } from '../services/ExecutorService.js';
import { logger } from '../utils/logger.js';
import { metrics, measureTime } from '../utils/metrics.js';

type JobProcessor = (job: Job) => Promise<void>;

export class JobQueue {
  private queue: Job[] = [];
  private processing: boolean = false;
  private processors: Map<JobStatus, JobProcessor> = new Map();
  private processingInterval?: any;
  private proofService: ProofService;
  private maxRetries: number = 3;
  private retryDelayMs: number = 5000;

  constructor(
    private db: DatabaseService,
    private executorServices: Map<string, ExecutorService>,
    proofApiConfig: RelayerConfig['proofApi'],
    chainConfigs: Record<string, { chainId: number }>
  ) {
    this.proofService = new ProofService(proofApiConfig, chainConfigs);
    this.registerProcessors();
    this.loadPendingJobs();
  }

  private registerProcessors() {
    this.processors.set('pending', this.processProofRequest.bind(this));
    this.processors.set('proof_ready', this.processExecution.bind(this));
    this.processors.set('failed', this.processRetry.bind(this));
  }

  private async loadPendingJobs() {
    const pendingJobs = this.db.getPendingJobs();
    this.queue.push(...pendingJobs);
    
    if (pendingJobs.length > 0) {
      logger.info(`Loaded ${pendingJobs.length} pending jobs from database`);
    }
  }

  async addJob(job: Job) {
    this.queue.push(job);
    logger.debug(`Job added to queue`, { jobId: job.id, mapping: job.mapping_name });
  }

  async startProcessing() {
    if (this.processing) {
      logger.warn('Job processing already started');
      return;
    }

    logger.info('Starting job queue processing');
    this.processing = true;

    // Process immediately and then set interval
    await this.processQueue();
    
    this.processingInterval = setInterval(async () => {
      await this.processQueue();
    }, 1000); // Check queue every second
  }

  async stopProcessing() {
    if (!this.processing) return;

    logger.info('Stopping job queue processing');
    this.processing = false;

    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = undefined;
    }
  }

  private async processQueue() {
    if (this.queue.length === 0) {
      // Check for failed jobs that can be retried
      const failedJobs = this.db.getFailedJobs(this.maxRetries);
      if (failedJobs.length > 0) {
        this.queue.push(...failedJobs);
      }
      return;
    }

    // Process jobs in parallel (up to a limit)
    const concurrentLimit = 5;
    const jobsToProcess = this.queue.splice(0, concurrentLimit);

    const processingPromises = jobsToProcess.map(job => this.processJob(job));
    await Promise.allSettled(processingPromises);
  }

  private async processJob(job: Job) {
    if (!job.id) {
      logger.error('Job missing ID, skipping', { 
        uniqueId: job.unique_id,
        mapping: job.mapping_name
      });
      return;
    }

    const processor = this.processors.get(job.status);
    if (!processor) {
      logger.warn(`No processor found for job status: ${job.status}`, { 
        jobId: job.id,
        mapping: job.mapping_name
      });
      return;
    }

    try {
      await measureTime(`job_processing_${job.status}`, async () => {
        await processor(job);
      });
      
      metrics.increment(`jobs_processed_${job.status}`);
      metrics.increment(`jobs_processed_mapping_${job.mapping_name || 'unknown'}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Error processing job: ${errorMessage}`, {
        jobId: job.id,
        status: job.status,
        mapping: job.mapping_name
      });
      
      await this.handleJobError(job, error as Error);
      metrics.increment(`job_errors_${job.status}`);
      metrics.increment(`job_errors_mapping_${job.mapping_name || 'unknown'}`);
    }
  }

  private async processProofRequest(job: Job) {
    if (!job.proof_required) {
      logger.debug(`Job ${job.id} doesn't require proof, moving to execution`, {
        mapping: job.mapping_name
      });
      this.db.updateJobStatus(job.id!, 'proof_ready');
      this.queue.push({ ...job, status: 'proof_ready' });
      return;
    }

    logger.info(`Requesting proof for job ${job.id}`, {
      txHash: job.source_tx_hash,
      chain: job.source_chain
    });

    this.db.updateJobStatus(job.id!, 'proof_requested');

    const eventData = JSON.parse(job.event_data);
    
    // Get the transaction receipt to find the global log index
    let globalLogIndex = eventData.index || 0;
    try {
      const executorService = this.executorServices.get(job.source_chain);
      if (executorService) {
        // Access the provider to get transaction receipt
        const provider = (executorService as any).provider;
        if (provider) {
          const receipt = await provider.getTransactionReceipt(job.source_tx_hash);
          if (receipt && receipt.logs && receipt.logs.length > 0) {
            // Find the log that matches our event by transaction index and log position
            const targetLogIndex = eventData.index || 0;
            if (targetLogIndex < receipt.logs.length) {
              // The logIndex from the receipt is the global log index
              globalLogIndex = receipt.logs[targetLogIndex].index;
              logger.debug(`Found global log index from receipt`, {
                jobId: job.id,
                txHash: job.source_tx_hash,
                eventIndex: eventData.index,
                globalLogIndex,
                totalLogs: receipt.logs.length
              });
            }
          }
        }
      }
    } catch (error) {
      logger.warn(`Could not get transaction receipt for global log index`, {
        txHash: job.source_tx_hash,
        error: error instanceof Error ? error.message : String(error)
      });
      // Fallback to event.index
      globalLogIndex = eventData.index || 0;
    }

    logger.debug(`Using global log index for Polymer proof request`, {
      jobId: job.id,
      globalLogIndex,
      txHash: job.source_tx_hash,
      blockNumber: job.source_block_number
    });

    const proofResponse = await this.proofService.requestProof({
      txHash: job.source_tx_hash,
      chain: job.source_chain,
      blockNumber: job.source_block_number,
      eventIndex: globalLogIndex
    });

    this.db.updateJobStatus(job.id!, 'proof_ready', {
      proof_data: JSON.stringify(proofResponse)
    });

    this.queue.push({ 
      ...job, 
      status: 'proof_ready',
      proof_data: JSON.stringify(proofResponse)
    });

    logger.info(`Proof obtained for job ${job.id}`);
  }

  private async processExecution(job: Job) {
    logger.info(`Executing job ${job.id}: ${job.mapping_name}`, {
      destChain: job.dest_chain,
      destContract: job.dest_address
    });

    this.db.updateJobStatus(job.id!, 'executing');

    const executor = this.executorServices.get(job.dest_chain);
    if (!executor) {
      throw new Error(`No executor service found for chain: ${job.dest_chain}`);
    }

    const eventData = JSON.parse(job.event_data);
    const proofData = job.proof_data ? JSON.parse(job.proof_data) : null;

    const txHash = await executor.executeTransaction({
      contractAddress: job.dest_address,
      method: job.dest_method,
      methodSignature: job.dest_method_signature,
      eventData,
      proofData
    });

    this.db.updateJobStatus(job.id!, 'completed', {
      dest_tx_hash: txHash
    });

    // Calculate end-to-end timing
    const endTime = Date.now();
    const totalDuration = endTime - new Date(job.created_at!).getTime();

    logger.info(`🎉 Job completed end-to-end`, { 
      jobId: job.id,
      mapping: job.mapping_name,
      destTxHash: txHash,
      totalDurationMs: totalDuration,
      totalDurationSeconds: (totalDuration / 1000).toFixed(2),
      eventKey: job.event_args ? JSON.parse(job.event_args).key : 'N/A',
      sourceChain: job.source_chain,
      destChain: job.dest_chain,
      sourceBlock: job.source_block_number,
      sourceTx: job.source_tx_hash
    });

    metrics.increment(`jobs_completed_${job.dest_chain}`);
    metrics.increment(`jobs_completed_mapping_${job.mapping_name || 'unknown'}`);
  }

  private constructMethodSignature(methodName: string, hasProof: boolean): string {
    // This method is now deprecated - method signatures come from the job data
    // Keeping for backward compatibility
    logger.warn('Using deprecated method signature construction', {
      methodName,
      hasProof
    });
    
    if (hasProof) {
      return `${methodName}(bytes data, bytes proof)`;
    } else {
      return `${methodName}(bytes data)`;
    }
  }

  private async processRetry(job: Job) {
    const timeSinceLastRetry = job.last_retry_at 
      ? Date.now() - new Date(job.last_retry_at).getTime()
      : this.retryDelayMs + 1;

    if (timeSinceLastRetry < this.retryDelayMs) {
      // Not ready for retry yet, put back in queue
      this.queue.push(job);
      return;
    }

    if (job.retry_count >= this.maxRetries) {
      logger.error(`Job ${job.id} exceeded max retries, giving up`, {
        mapping: job.mapping_name
      });
      metrics.increment(`jobs_abandoned_${job.mapping_name || 'unknown'}`);
      return;
    }

    logger.info(`Retrying job ${job.id}`, {
      attempt: job.retry_count + 1,
      maxRetries: this.maxRetries
    });

    this.db.incrementRetryCount(job.id!);
    
    // Reset status based on where it failed
    const newStatus: JobStatus = job.proof_required && !job.proof_data ? 'pending' : 'proof_ready';
    this.db.updateJobStatus(job.id!, newStatus);
    
    this.queue.push({ ...job, status: newStatus, retry_count: job.retry_count + 1 });
    metrics.increment(`jobs_retried_${job.mapping_name || 'unknown'}`);
  }

  private async handleJobError(job: Job, error: Error) {
    logger.error(`Job ${job.id} failed: ${error.message}`, {
      retryCount: job.retry_count,
      mapping: job.mapping_name
    });

    this.db.updateJobStatus(job.id!, 'failed', {
      error_message: error.message
    });

    // Add back to queue for retry processing
    this.queue.push({ ...job, status: 'failed' });
  }

  getQueueStats() {
    const stats = {
      queueLength: this.queue.length,
      isProcessing: this.processing,
      jobsByStatus: {} as Record<string, number>,
      jobsByMapping: {} as Record<string, number>
    };

    // Count jobs by status in queue
    this.queue.forEach(job => {
      stats.jobsByStatus[job.status] = (stats.jobsByStatus[job.status] || 0) + 1;
      const mapping = job.mapping_name || 'unknown';
      stats.jobsByMapping[mapping] = (stats.jobsByMapping[mapping] || 0) + 1;
    });

    return stats;
  }
} 