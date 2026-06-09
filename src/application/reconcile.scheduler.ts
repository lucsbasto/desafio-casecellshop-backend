import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { ReconcileUseCase } from './use-cases/reconcile.usecase';
import { APP_CONFIG, AppConfig } from '../infrastructure/config/app-config';

/**
 * Dispara a reconciliação periodicamente (FR-11). Desabilitada em ambiente de
 * teste para não interferir nos cenários determinísticos (usa-se o endpoint
 * POST /admin/reconcile nos testes).
 */
@Injectable()
export class ReconcileScheduler {
  private readonly logger = new Logger(ReconcileScheduler.name);

  constructor(
    private readonly reconcile: ReconcileUseCase,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Interval(15000)
  async tick(): Promise<void> {
    if (this.config.env === 'test') return;
    try {
      await this.reconcile.execute();
    } catch (err) {
      this.logger.error(`Reconciliação periódica falhou: ${(err as Error).message}`);
    }
  }
}
