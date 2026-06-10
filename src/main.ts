// DEVE ser o primeiro import: inicia o OpenTelemetry antes de http/express/nest serem
// carregados, para que as auto-instrumentações consigam fazer o patch desses módulos.
import './observability/otel';
import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger as PinoLogger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { loadConfig } from './infrastructure/config/app-config';
import { DomainExceptionFilter } from './interface/http/filters/domain-exception.filter';
import { setupSwagger } from './swagger';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = loadConfig();

  // Structured logger (pino) as the official Nest logger.
  app.useLogger(app.get(PinoLogger));

  // Automatic DTO validation (class-validator) -> standardized 400.
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );
  app.useGlobalFilters(new DomainExceptionFilter());

  setupSwagger(app);

  // Intercepts SIGTERM/SIGINT so OnModuleDestroy hooks (Redis/BullMQ connections)
  // run on graceful shutdown (Docker/Kubernetes).
  app.enableShutdownHooks();

  await app.listen(config.port);
  new Logger('Bootstrap').log(
    `CaseCellShop backend on :${config.port} (Swagger em /docs, métricas em /metrics)`,
  );
}

void bootstrap();
