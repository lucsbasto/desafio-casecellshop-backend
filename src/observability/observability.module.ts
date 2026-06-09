import { Global, Module } from '@nestjs/common';
import { MetricsService } from './metrics.service';
import { MetricsController } from './metrics.controller';
import { TracingService } from './tracing.service';

/**
 * Global observability module: metrics (prom-client) and tracing (spans).
 * The logger (nestjs-pino) is configured in AppModule via LoggerModule.forRoot.
 */
@Global()
@Module({
  controllers: [MetricsController],
  providers: [MetricsService, TracingService],
  exports: [MetricsService, TracingService],
})
export class ObservabilityModule {}
