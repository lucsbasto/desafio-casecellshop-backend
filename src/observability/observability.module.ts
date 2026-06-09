import { Global, Module } from '@nestjs/common';
import { MetricsService } from './metrics.service';
import { MetricsController } from './metrics.controller';
import { TracingService } from './tracing.service';

/**
 * Módulo global de observabilidade: métricas (prom-client) e tracing (spans).
 * O logger (nestjs-pino) é configurado no AppModule via LoggerModule.forRoot.
 */
@Global()
@Module({
  controllers: [MetricsController],
  providers: [MetricsService, TracingService],
  exports: [MetricsService, TracingService],
})
export class ObservabilityModule {}
