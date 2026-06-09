import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { APP_CONFIG, AppConfig } from '../infrastructure/config/app-config';
import { ReconcileUseCase } from './use-cases/reconcile.usecase';

/**
 * Triggers reconciliation periodically (FR-11). Disabled in test environments
 * to avoid interfering with deterministic scenarios (use the
 * POST /admin/reconcile endpoint in tests instead).
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
