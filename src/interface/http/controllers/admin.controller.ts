import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  ReconcileReport,
  ReconcileUseCase,
} from '../../../application/use-cases/reconcile.usecase';
import { AdminTokenGuard } from '../guards/admin-token.guard';

/** Operational endpoints (manual reconciliation). Guarded by AdminTokenGuard. */
@ApiTags('admin')
@Controller('admin')
export class AdminController {
  constructor(private readonly reconcile: ReconcileUseCase) {}

  @Post('reconcile')
  @UseGuards(AdminTokenGuard)
  @ApiBearerAuth()
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
