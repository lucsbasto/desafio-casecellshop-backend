/**
 * OpenTelemetry bootstrap.
 *
 * IMPORTANTE: este módulo deve ser importado ANTES de qualquer outro (em `main.ts`),
 * para que as auto-instrumentações consigam fazer o patch de `http`/`express` antes
 * de o Nest carregá-los.
 *
 * Comportamento condicional:
 *  - Se `OTEL_EXPORTER_OTLP_ENDPOINT` estiver definido (ex.: no docker-compose, apontando
 *    para o otel-collector), inicia o SDK real e exporta traces via OTLP/HTTP.
 *  - Caso contrário (dev local / testes), é um no-op: o app roda sem collector e os
 *    spans manuais do `TracingService` viram no-op via o tracer global do OpenTelemetry.
 */
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

let sdk: NodeSDK | undefined;

export function startOtel(): void {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return; // sem collector → mantém o desafio executável sem dependências externas

  const serviceName =
    process.env.OTEL_SERVICE_NAME ?? process.env.SERVICE_NAME ?? 'casecellshop-backend';

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? '1.0.0',
    }),
    // OTLPTraceExporter usa OTEL_EXPORTER_OTLP_ENDPOINT do ambiente e adiciona /v1/traces.
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [
      getNodeAutoInstrumentations({
        // fs gera ruído altíssimo; desligado para manter os traces legíveis.
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });

  sdk.start();

  const shutdown = (): void => {
    sdk
      ?.shutdown()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

startOtel();
