import { Controller, Get, Header } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { MetricsService } from './metrics.service';

/** Prometheus endpoint. Excluded from OpenAPI (it is a scraping contract, not a business one). */
@ApiExcludeController()
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4')
  async scrape(): Promise<string> {
    return this.metrics.expose();
  }
}
