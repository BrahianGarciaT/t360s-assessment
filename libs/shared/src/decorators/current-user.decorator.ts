import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthUser, RequestWithUser } from '../auth/jwt-payload.interface';

export const getCurrentUserByContext = (
  context: ExecutionContext,
): AuthUser | undefined => {
  const request = context.switchToHttp().getRequest<RequestWithUser>();

  return request.user;
};

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext) =>
    getCurrentUserByContext(context),
);
