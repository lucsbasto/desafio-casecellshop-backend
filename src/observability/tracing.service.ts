import { Injectable } from '@nestjs/common';
import { getCorrelationId } from './correlation';

/**
 * Lightweight span-based tracing.
 *
 * JUSTIFIED STUB: to keep the challenge runnable without spinning up a collector,
 * we use a custom tracer that records spans with duration and correlates them via
 * correlationId. If `OTEL_EXPORTER_OTLP_ENDPOINT` is defined, the README
 * documents how to plug in the real OpenTelemetry SDK (compatible with Datadog Agent).
 * The API (`startSpan`/`end`) is deliberately OTel-compatible for easy swapping.
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
    this.finished.push(span);
    if (this.finished.length > this.maxBuffer) this.finished.shift();
  }

  /** Exposed for inspection/diagnostics (and tests). */
  recentSpans(): FinishedSpan[] {
    return [...this.finished];
  }
}
