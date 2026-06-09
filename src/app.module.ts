import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { LoggerModule } from 'nestjs-pino';
import { ApplicationModule } from './application/application.module';
import { APP_CONFIG, AppConfig } from './infrastructure/config/app-config';
import { AdminController } from './interface/http/controllers/admin.controller';
import { CheckoutController } from './interface/http/controllers/checkout.controller';
import { HealthController } from './interface/http/controllers/health.controller';
import { OrdersController } from './interface/http/controllers/orders.controller';
import { ProductsController } from './interface/http/controllers/products.controller';
import { CorrelationMiddleware } from './observability/correlation.middleware';
import { buildLoggerParams } from './observability/logger.config';
import { ObservabilityModule } from './observability/observability.module';

@Module({
  imports: [
    // Reuse the single APP_CONFIG from the DI container (avoids a second loadConfig()).
    LoggerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (cfg: AppConfig) => buildLoggerParams(cfg.serviceName, cfg.logLevel, cfg.env),
    }),
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
