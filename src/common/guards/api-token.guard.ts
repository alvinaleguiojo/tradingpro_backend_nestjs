import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class ApiTokenGuard implements CanActivate {
  private readonly logger = new Logger(ApiTokenGuard.name);

  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const expectedToken = this.configService.get<string>('API_AUTH_TOKEN');

    if (!expectedToken) {
      this.logger.error('API_AUTH_TOKEN is not configured');
      throw new UnauthorizedException('Server authentication is not configured');
    }

    const authHeader = request.headers?.authorization as string | undefined;
    const apiKeyHeader = request.headers?.['x-api-key'] as string | undefined;

    const providedToken = this.extractToken(authHeader) || apiKeyHeader;
    if (!providedToken || providedToken !== expectedToken) {
      throw new UnauthorizedException('Unauthorized');
    }

    return true;
  }

  private extractToken(authHeader?: string): string | null {
    if (!authHeader) return null;
    const [scheme, token] = authHeader.split(' ');
    if (scheme?.toLowerCase() === 'bearer' && token) return token.trim();
    return authHeader.trim();
  }
}
