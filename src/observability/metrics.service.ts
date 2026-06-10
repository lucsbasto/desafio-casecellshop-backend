import { Injectable } from '@nestjs/common';
import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from 'prom-client';

/**
 * Central Prometheus metrics registry. Exposed at GET /metrics.
 * Covers cache, checkout, queue/worker, ERP, and overselling prevention (SPEC OBS-2).
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  readonly httpRequestDuration: Histogram<string>;
  readonly cacheRequests: Counter<string>;
  readonly checkoutRequests: Counter<string>;
  readonly checkoutDuration: Histogram<string>;
  readonly queueDepth: Gauge<string>;
  readonly workerJobs: Counter<string>;
  readonly workerDuration: Histogram<string>;
  readonly erpCalls: Counter<string>;
  readonly erpDuration: Histogram<string>;
  readonly oversellPrevented: Counter<string>;
  readonly stockReservation: Counter<string>;

  constructor() {
    collectDefaultMetrics({ register: this.registry });

    this.httpRequestDuration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'Latência das requisições HTTP por método, rota e status',
      // Low-cardinality: `route` é o PADRÃO da rota (ex.: /orders/:orderId/status), não a URL concreta.
      labelNames: ['method', 'route', 'status_code'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1, 2],
      registers: [this.registry],
    });
    this.cacheRequests = new Counter({
      name: 'cache_requests_total',
      help: 'Total de acessos ao cache por resultado',
      labelNames: ['result'], // hit | miss | stale
      registers: [this.registry],
    });
    this.checkoutRequests = new Counter({
      name: 'checkout_requests_total',
      help: 'Total de requisições de checkout por desfecho',
      labelNames: ['outcome'], // accepted | conflict | replay | invalid
      registers: [this.registry],
    });
    this.checkoutDuration = new Histogram({
      name: 'checkout_duration_seconds',
      help: 'Duração do handler de checkout (até o 202)',
      buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2],
      registers: [this.registry],
    });
    this.queueDepth = new Gauge({
      name: 'queue_depth',
      help: 'Profundidade atual da fila de checkout',
      registers: [this.registry],
    });
    this.workerJobs = new Counter({
      name: 'worker_jobs_total',
      help: 'Jobs processados pelo worker por resultado',
      labelNames: ['result'], // confirmed | retried | failed
      registers: [this.registry],
    });
    this.workerDuration = new Histogram({
      name: 'worker_duration_seconds',
      help: 'Duração de processamento de um job pelo worker',
      buckets: [0.05, 0.1, 0.3, 0.5, 1, 2, 5],
      registers: [this.registry],
    });
    this.erpCalls = new Counter({
      name: 'erp_calls_total',
      help: 'Chamadas ao ERP por resultado',
      labelNames: ['result'], // success | error
      registers: [this.registry],
    });
    this.erpDuration = new Histogram({
      name: 'erp_call_duration_seconds',
      help: 'Latência das chamadas ao ERP',
      buckets: [0.05, 0.1, 0.3, 0.5, 1, 2],
      registers: [this.registry],
    });
    this.oversellPrevented = new Counter({
      name: 'oversell_prevented_total',
      help: 'Tentativas de reserva negadas por falta de estoque (overselling evitado)',
      registers: [this.registry],
    });
    this.stockReservation = new Counter({
      name: 'stock_reservation_total',
      help: 'Reservas de estoque por resultado',
      labelNames: ['result'], // ok | insufficient
      registers: [this.registry],
    });
  }

  async expose(): Promise<string> {
    return this.registry.metrics();
  }
}
