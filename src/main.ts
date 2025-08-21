import type { RelayerConfig } from './types/index.js';
import { loadConfig, validateConfig } from './utils/configLoader.js';
import { DatabaseService } from './services/DatabaseService.js';
import { ExecutorService } from './services/ExecutorService.js';
import { ChainListener } from './listeners/ChainListener.js';
import { JobQueue } from './queue/JobQueue.js';
import { DestinationResolverService } from './services/DestinationResolver.js';
import { logger } from './utils/logger.js';
import { metrics } from './utils/metrics.js';
import { ProofService } from './services/ProofService.js';

class RelayerApp {
  private config: RelayerConfig;
  private db: DatabaseService;
  private listeners: ChainListener[] = [];
  private executorServices: Map<string, ExecutorService> = new Map();
  private destinationResolver!: DestinationResolverService;
  private proofService!: ProofService;
  private jobQueue!: JobQueue;
  private metricsInterval?: NodeJS.Timeout;

  constructor(config: RelayerConfig) {
    this.config = config;
    this.db = new DatabaseService(this.config.database.path);
    this.setupServices();
  }

  private setupServices() {
    this.setupDestinationResolver();
    this.setupExecutorServices();
    this.setupProofService();
    this.jobQueue = new JobQueue(
        this.db, 
        this.executorServices, 
        this.config.proofApi, 
        this.config.chains
    );
    this.setupChainListeners();
  }

  private validateConfiguration() {
    logger.info('Validating configuration...');
    
    // Use the enhanced config validator
    const errors = validateConfig(this.config);
    
    // Additional destination resolver validation
    const resolverErrors = this.destinationResolver.validateMappings(this.config.eventMappings);
    errors.push(...resolverErrors);

    if (errors.length > 0) {
      logger.error('Configuration validation failed:', { errors: errors });
      throw new Error(`Configuration validation failed:\n${errors.join('\n')}`);
    }

    logger.info('✅ Configuration validation passed');
  }

  private setupDestinationResolver() {
    logger.info('Setting up destination resolver');
    this.destinationResolver = new DestinationResolverService(this.config.destinationResolvers);
    
    logger.debug('Available resolvers:', {
      resolvers: this.destinationResolver.listResolvers()
    });
  }

  private setupExecutorServices() {
    logger.info('Setting up executor services');
    
    Object.entries(this.config.chains).forEach(([chainName, chainConfig]) => {
      const executor = new ExecutorService(chainName, chainConfig);
      this.executorServices.set(chainName, executor);
      logger.debug(`Executor service created for ${chainName}`);
    });
  }

  private setupProofService() {
    logger.info('Setting up proof service');
    this.proofService = new ProofService(this.config.proofApi, this.config.chains);
  }

  private setupChainListeners() {
    logger.info('Setting up chain listeners');
    
    Object.entries(this.config.chains).forEach(([chainName, chainConfig]) => {
      // Check if this chain has any source contracts
      const hasSourceContracts = Object.entries(this.config.contracts).some(([contractName, deployments]) => {
        const deployment = deployments[chainName];
        return deployment && (deployment.type === 'source' || deployment.type === 'both');
      });

      // Check if this chain has any enabled event mappings
      const hasActiveMappings = this.config.eventMappings.some(mapping => {
        const sourceContract = this.config.contracts[mapping.sourceEvent.contractName];
        const deployment = sourceContract?.[chainName];
        return mapping.enabled && deployment && (deployment.type === 'source' || deployment.type === 'both');
      });
      
      if (hasSourceContracts && hasActiveMappings) {
        const listener = new ChainListener(
          chainName,
          chainConfig,
          this.config.contracts,
          this.config.eventMappings,
          this.db,
          this.jobQueue,
          this.destinationResolver
        );
        this.listeners.push(listener);
        
        const activeMappingCount = this.config.eventMappings.filter(mapping => {
          const sourceContract = this.config.contracts[mapping.sourceEvent.contractName];
          const deployment = sourceContract?.[chainName];
          return mapping.enabled && deployment && (deployment.type === 'source' || deployment.type === 'both');
        }).length;
        
        logger.debug(`Listener created for ${chainName}`, {
          contracts: Object.keys(this.config.contracts).filter(name => {
            const deployment = this.config.contracts[name][chainName];
            return deployment && (deployment.type === 'source' || deployment.type === 'both');
          }).length,
          activeMappings: activeMappingCount
        });
      } else {
        logger.debug(`No listener needed for ${chainName} (no source contracts or active mappings)`);
      }
    });

    if (this.listeners.length === 0) {
      logger.warn('No chain listeners created - check your configuration');
    }
  }

  async start() {
    try {
      logger.info('Starting Polymer Relayer', {
        chains: Object.keys(this.config.chains),
        contracts: Object.keys(this.config.contracts),
        eventMappings: this.config.eventMappings.length,
        enabledMappings: this.config.eventMappings.filter(m => m.enabled).length
      });
      
      this.validateConfiguration();
      
      logger.info('Starting Relayer services...');
      await this.jobQueue.startProcessing();
      
      await Promise.all(this.listeners.map(listener => listener.startPolling()));

      logger.info('✅ Relayer started successfully', {
        listeners: this.listeners.length,
        executors: this.executorServices.size,
        activeMappings: this.config.eventMappings.filter(m => m.enabled).length
      });

      this.setupGracefulShutdown();
      this.startMetricsReporting();
      this.logConfigurationSummary();
    } catch (error) {
      logger.error('Failed to start relayer', { error: error instanceof Error ? error.message : String(error) });
      process.exit(1);
    }
  }

  async stop() {
    logger.info('Stopping Relayer...');

    try {
      // Stop job queue processing
      await this.jobQueue.stopProcessing();

      // Stop all listeners
      await Promise.all(
        this.listeners.map(listener => listener.stopPolling())
      );

      // Close database connection
      this.db.close();

      // Clear database file for fresh start next time
      try {
        const fs = await import('fs');
        const dbPath = './relayer.db';
        if (fs.existsSync(dbPath)) {
          fs.unlinkSync(dbPath);
          logger.info('🗑️  Database cleared for fresh restart');
        }
      } catch (error) {
        logger.warn('Could not clear database file', error);
      }

      logger.info('✅ Relayer stopped successfully');
    } catch (error) {
      logger.error('Error during shutdown', error);
    }
  }

  private setupGracefulShutdown() {
    const handleShutdown = async () => {
      logger.info('Received SIGINT, shutting down gracefully...');
      await this.stop();
      
      // Conditionally clear the database
      if (process.env.CLEAR_DB_ON_EXIT === 'true') {
        this.db.clearJobs();
        logger.info('🗑️  Database cleared for fresh restart');
      }
      
      process.exit(0);
    };

    process.on('SIGINT', handleShutdown);
    process.on('SIGTERM', handleShutdown);
  }

  private startMetricsReporting() {
    this.metricsInterval = setInterval(() => {
      logger.info(`\n${metrics.summary()}`);
      
      const queueStats = this.jobQueue.getQueueStats();
      logger.info('Queue Stats', { 
        queueLength: queueStats.queueLength,
        isProcessing: queueStats.isProcessing 
      });

      const dbStats = this.db.getJobStats();
      logger.info('Database Stats', dbStats);
      
    }, 300000); // every 5 minutes
  }

  private logConfigurationSummary() {
    logger.info('=== Configuration Summary ===');
    
    Object.entries(this.config.chains).forEach(([chainName, config]) => {
      logger.info(`Chain: ${chainName}`, {
        chainId: config.chainId,
        pollingInterval: config.pollingInterval,
        blockConfirmations: config.blockConfirmations,
      });
    });

    Object.entries(this.config.contracts).forEach(([contractName, deployments]) => {
      const chainInfo = Object.entries(deployments).map(([chain, deployment]) => 
        `${chain}(${deployment.type})`
      ).join(', ');
      logger.info(`Contract: ${contractName} on ${chainInfo}`);
    });

    this.config.eventMappings.forEach(mapping => {
      if(mapping.enabled) {
        logger.info(`Mapping: ${mapping.name}`, {
          source: `${mapping.sourceEvent.contractName}.${mapping.sourceEvent.eventName}`,
          destination: `${mapping.destinationCall.contractName}.${mapping.destinationCall.methodName}`,
          proof: mapping.proofRequired ? 'required' : 'not_required'
        });
      }
    });

    logger.info('=== End Configuration Summary ===');
  }

  // API for external monitoring
  async getStatus() {
    const chainInfos = await Promise.all(
      this.listeners.map(listener => listener.getChainInfo())
    );

    const executorInfos = await Promise.all(
      Array.from(this.executorServices.entries()).map(async ([chainName, executor]) => {
        const info = await executor.getChainInfo();
        return { chainName, ...info };
      })
    );

    return {
      status: 'running',
      uptime: process.uptime(),
      chains: chainInfos.filter(info => info !== null),
      executors: executorInfos.filter(info => info !== null),
      queue: this.jobQueue.getQueueStats(),
      metrics: metrics.getAll(),
      configuration: {
        eventMappings: this.config.eventMappings.length,
        enabledMappings: this.config.eventMappings.filter(m => m.enabled).length,
        contracts: Object.keys(this.config.contracts).length,
        chains: Object.keys(this.config.chains).length,
        resolvers: this.destinationResolver.listResolvers().length
      }
    };
  }
}

// Start the application
async function main() {
  try {
    const config = loadConfig(process.env.CONFIG_PATH);
    logger.info('Configuration loaded successfully', {
      chains: Object.keys(config.chains).length,
      contracts: Object.keys(config.contracts).length,
      mappings: config.eventMappings.length,
      polymerApiKey: config.proofApi?.apiKey ? config.proofApi.apiKey.substring(0, 8) + '...' : 'not set',
      polymerApiUrl: config.proofApi?.baseUrl || 'not set'
    });

    const app = new RelayerApp(config);
    await app.start();

  } catch (error) {
    logger.error('Application startup failed', { error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  }
}

// Run if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('Failed to start relayer:', error);
    process.exit(1);
  });
}

export { RelayerApp }; 