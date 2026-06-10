import { Injectable } from '@nestjs/common';
import { type Span as OtelSpan, SpanStatusCode, trace } from '@opentelemetry/api';
import { getCorrelationId } from './correlation';

/**
 * Span-based tracing.
 *
 * Dupla saída, sem mudar a API consumida pelos use-cases:
 *  1. Spans REAIS do OpenTelemetry, via o tracer global. Quando o SDK está ativo
 *     (`OTEL_EXPORTER_OTLP_ENDPOINT` definido — ver `otel.ts`), os spans são exportados
 *     via OTLP ao collector → Jaeger. Sem o SDK, o tracer global é no-op (zero custo,
 *     mantém o desafio executável e os testes verdes sem dependências externas).
 *  2. Ring buffer em memória, usado por `recentSpans()` para diagnóstico/inspeção e testes.
 */
export interface Span {
  name: string;
  end(attrs?: Record<string, unknown>): void;
}

interface FinishedSpan {
  name: string;
  durationMs: number;
  correlationId?: string;
  attributes: Record<string, unknown>;
}

@Injectable()
export class TracingService {
  private readonly tracer = trace.getTracer('casecellshop-backend');

  // Fixed-size ring buffer: O(1) writes, bounded memory, no array reindexing.
  private readonly maxBuffer = 1000;
  private readonly finished: (FinishedSpan | undefined)[] = new Array(this.maxBuffer);
  private writeIdx = 0;
  private count = 0;

  startSpan(name: string, attributes: Record<string, unknown> = {}): Span {
    const startedAt = process.hrtime.bigint();
    const correlationId = getCorrelationId();
    // Span OTel real (no-op quando o SDK não está iniciado). Herda o contexto ativo
    // como pai automaticamente (ex.: span HTTP da auto-instrumentação).
    const otelSpan: OtelSpan = this.tracer.startSpan(name, {
      attributes: toOtelAttrs({ ...attributes, ...(correlationId ? { correlationId } : {}) }),
    });
    const self = this;
    return {
      name,
      end(extra: Record<string, unknown> = {}): void {
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        if (extra.status === 'error') {
          otelSpan.setStatus({
            code: SpanStatusCode.ERROR,
            message: typeof extra.error === 'string' ? extra.error : undefined,
          });
        }
        otelSpan.setAttributes(toOtelAttrs(extra));
        otelSpan.end();
        self.record({
          name,
          durationMs,
          correlationId,
          attributes: { ...attributes, ...extra },
        });
      },
    };
  }

  /** Helper: instruments an async function with a span. */
  async withSpan<T>(
    name: string,
    fn: () => Promise<T>,
    attributes: Record<string, unknown> = {},
  ): Promise<T> {
    const span = this.startSpan(name, attributes);
    try {
      const result = await fn();
      span.end({ status: 'ok' });
      return result;
    } catch (err) {
      span.end({ status: 'error', error: (err as Error).message });
      throw err;
    }
  }

  private record(span: FinishedSpan): void {
    this.finished[this.writeIdx] = span;
    this.writeIdx = (this.writeIdx + 1) % this.maxBuffer;
    if (this.count < this.maxBuffer) this.count++;
  }

  /** Exposed for inspection/diagnostics (and tests). Oldest-to-newest order. */
  recentSpans(): FinishedSpan[] {
    const out: FinishedSpan[] = [];
    const start = this.count < this.maxBuffer ? 0 : this.writeIdx;
    for (let i = 0; i < this.count; i++) {
      const span = this.finished[(start + i) % this.maxBuffer];
      if (span) out.push(span);
    }
    return out;
  }
}

/**
 * OTel só aceita atributos primitivos (string/number/boolean) ou arrays deles.
 * Serializa valores complexos para não derrubar o span.
 */
function toOtelAttrs(attrs: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    out[key] =
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        ? value
        : JSON.stringify(value);
  }
  return out;
}
