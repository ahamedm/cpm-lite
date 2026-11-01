import type { AuthUser } from './auth.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser;
    correlationId: string;
  }
}
