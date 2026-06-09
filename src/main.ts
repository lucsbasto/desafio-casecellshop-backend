import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger as PinoLogger } from 'nestjs-pino';
import { Logger, ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { DomainExceptionFilter } from './interface/http/filters/domain-exception.filter';
import { setupSwagger } from './swagger';
import { loadConfig } from './infrastructure/config/app-config';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = loadConfig();

  // Logger estruturado (pino) como logger oficial do Nest.
  app.useLogger(app.get(PinoLogger));

  // Validação automática dos DTOs (class-validator) -> 400 padronizado.
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );
  app.useGlobalFilters(new DomainExceptionFilter());

  setupSwagger(app);

  await app.listen(config.port);
  new Logger('Bootstrap').log(
    `CaseCellShop backend on :${config.port} (Swagger em /docs, métricas em /metrics)`,
  );
}

void bootstrap();
