import { Module } from '@nestjs/common';
import { InfrastructureModule } from '../infrastructure/infrastructure.module';
import { ListProductsUseCase } from './use-cases/list-products.usecase';
import { CheckoutUseCase } from './use-cases/checkout.usecase';
import { CheckoutWorker } from './use-cases/checkout.worker';
import { GetOrderStatusUseCase } from './use-cases/get-order-status.usecase';
import { ReconcileUseCase } from './use-cases/reconcile.usecase';
import { ReconcileScheduler } from './reconcile.scheduler';

/** Camada de aplicação: orquestra as portas. Exporta os use-cases aos controllers. */
@Module({
  imports: [InfrastructureModule],
  providers: [
    ListProductsUseCase,
    CheckoutUseCase,
    CheckoutWorker,
    GetOrderStatusUseCase,
    ReconcileUseCase,
    ReconcileScheduler,
  ],
  exports: [
    ListProductsUseCase,
    CheckoutUseCase,
    GetOrderStatusUseCase,
    ReconcileUseCase,
  ],
})
export class ApplicationModule {}
