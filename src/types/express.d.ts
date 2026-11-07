import 'express';
import type { AuthContext } from '../modules/rbac/capabilities.js';

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      /** Set by authenticate: the caller, re-checked on every request. */
      auth?: AuthContext;
      /** Set by requireStepUp: the verified step-up OTP behind this sensitive action. */
      stepUpId?: string;
    }
  }
}

export {};
