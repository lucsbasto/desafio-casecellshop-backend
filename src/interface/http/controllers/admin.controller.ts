import { Controller, Get, Post } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  ReconcileReport,
  ReconcileUseCase,
} from '../../../application/use-cases/reconcile.usecase';

/** Operational endpoints (manual reconciliation). In production: protected/admin. */
@ApiTags('admin')
@Controller('admin')
export class AdminController {
  constructor(private readonly reconcile: ReconcileUseCase) {}

  @Post('reconcile')
  @ApiOkResponse({ description: 'Executa a reconciliação de pedidos PENDING órfãos' })
  async runReconcile(): Promise<ReconcileReport> {
    return this.reconcile.execute();
  }

  @Get('health')
  @ApiOkResponse({ description: 'Health check simples' })
  health(): { status: string } {
    return { status: 'ok' };
  }
}
