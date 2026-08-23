import { AuthUser } from './jwt-payload.interface';

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}
