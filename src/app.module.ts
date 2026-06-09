import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { ScheduleModule } from '@nestjs/schedule';

import { ObservabilityModule } from './observability/observability.module';
import { ApplicationModule } from './application/application.module';
import { CorrelationMiddleware } from './observability/correlation.middleware';
import { buildLoggerParams } from './observability/logger.config';
import { loadConfig } from './infrastructure/config/app-config';

import { ProductsController } from './interface/http/controllers/products.controller';
import { CheckoutController } from './interface/http/controllers/checkout.controller';
import { OrdersController } from './interface/http/controllers/orders.controller';
import { AdminController } from './interface/http/controllers/admin.controller';
import { HealthController } from './interface/http/controllers/health.controller';

const cfg = loadConfig();

@Module({
  imports: [
    LoggerModule.forRoot(buildLoggerParams(cfg.serviceName, cfg.logLevel, cfg.env)),
    ScheduleModule.forRoot(),
    ObservabilityModule,
    ApplicationModule,
  ],
  controllers: [
    ProductsController,
    CheckoutController,
    OrdersController,
    AdminController,
    HealthController,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('*');
  }
}
