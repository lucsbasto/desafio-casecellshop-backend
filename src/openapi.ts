import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { buildOpenApiDocument } from './swagger';

/**
 * Generates the openapi.json file without starting the HTTP server.
 * Usage: `npm run openapi`.
 */
async function generate(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false });
  await app.init();
  const document = buildOpenApiDocument(app);
  writeFileSync('openapi.json', JSON.stringify(document, null, 2), 'utf-8');
  await app.close();
  // eslint-disable-next-line no-console
  console.log('openapi.json gerado com sucesso');
  process.exit(0);
}

void generate();
