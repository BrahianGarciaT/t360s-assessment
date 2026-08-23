import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';
import { AuthUser } from '../auth/jwt-payload.interface';

export const getCurrentUserByContext = (
  context: ExecutionContext,
): AuthUser | undefined => {
  const request = context.switchToHttp().getRequest<Request>();

  return request.user;
};

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext) =>
    getCurrentUserByContext(context),
);
