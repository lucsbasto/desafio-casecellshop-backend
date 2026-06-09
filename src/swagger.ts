import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';

/** Shared OpenAPI configuration (used by both the runtime and the export). */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('CaseCellShop Backend')
    .setDescription(
      'Catálogo com cache, checkout assíncrono (202) e status de pedido. Desafio Pleno Backend.',
    )
    .setVersion('1.0.0')
    .addTag('catalog', 'Vitrine de produtos (cache com TTL)')
    .addTag('checkout', 'Início de compra assíncrona')
    .addTag('orders', 'Acompanhamento de pedidos')
    .addTag('admin', 'Operações (reconciliação)')
    .build();
  return SwaggerModule.createDocument(app, config);
}

export function setupSwagger(app: INestApplication): OpenAPIObject {
  const document = buildOpenApiDocument(app);
  SwaggerModule.setup('docs', app, document);
  return document;
}
