import { Injectable } from '@nestjs/common';
import { getCorrelationId } from './correlation';

/**
 * Tracing leve baseado em spans.
 *
 * STUB JUSTIFICADO: para manter o desafio executável sem subir um collector,
 * usamos um tracer próprio que registra spans com duração e os correlaciona via
 * correlationId. Se `OTEL_EXPORTER_OTLP_ENDPOINT` estiver definido, o README
 * documenta como plugar o SDK OpenTelemetry real (compatível com Datadog Agent).
 * A API (`startSpan`/`end`) é deliberadamente compatível com OTel para troca fácil.
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
  private readonly finished: FinishedSpan[] = [];
  private readonly maxBuffer = 1000;

  startSpan(name: string, attributes: Record<string, unknown> = {}): Span {
    const startedAt = process.hrtime.bigint();
    const correlationId = getCorrelationId();
    const self = this;
    return {
      name,
      end(extra: Record<string, unknown> = {}): void {
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        self.record({
          name,
          durationMs,
          correlationId,
          attributes: { ...attributes, ...extra },
        });
      },
    };
  }

  /** Helper: instrumenta uma função assíncrona com um span. */
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
    this.finished.push(span);
    if (this.finished.length > this.maxBuffer) this.finished.shift();
  }

  /** Exposto para inspeção/diagnóstico (e testes). */
  recentSpans(): FinishedSpan[] {
    return [...this.finished];
  }
}
