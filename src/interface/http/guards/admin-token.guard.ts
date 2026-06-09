import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

/**
 * Minimal bearer-token guard for operational endpoints (e.g. reconciliation),
 * which trigger destructive actions (stock release, job re-enqueue) and must not
 * be publicly callable.
 *
 * Requires `Authorization: Bearer <ADMIN_TOKEN>`. If `ADMIN_TOKEN` is unset
 * (local dev / tests), the guard is disabled so the demo stays frictionless —
 * it logs a warning once so the open state is never silent. In production, set
 * ADMIN_TOKEN. A real deployment would replace this with proper authn/authz.
 */
@Injectable()
export class AdminTokenGuard implements CanActivate {
  private readonly logger = new Logger(AdminTokenGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.ADMIN_TOKEN;
    if (!expected) {
      this.logger.warn('ADMIN_TOKEN não configurado: endpoints admin estão SEM proteção');
      return true;
    }

    const req = context.switchToHttp().getRequest<Request>();
    const header = req.headers.authorization ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || token !== expected) {
      throw new UnauthorizedException('Token admin inválido ou ausente');
    }
    return true;
  }
}
