import { pino } from 'pino';
import { env } from '../config/env.js';

// Redaction is the last line of defence: no tokens, OTPs or identity numbers in logs (P-01, GR-31, GR-36).
export const logger = pino({
  level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]',
      '*.refreshToken', '*.accessToken', '*.token', '*.otp', '*.pan', '*.aadhaar', '*.mobile',
    ],
    censor: '[REDACTED]',
  },
  ...(env.NODE_ENV === 'development'
    ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname,responseTime' } } }
    : {}),
});
