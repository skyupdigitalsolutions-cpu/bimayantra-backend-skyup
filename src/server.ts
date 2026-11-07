import { createApp } from './app.js';
import { env } from './config/env.js';
import { loadConfigOverrides, startConfigRefresh, stopConfigRefresh } from './config/cfg.js';
import { logger } from './lib/logger.js';
import { connectMongo, disconnectMongo, findStaleIndexes } from './lib/mongo.js';
import { startSweep, stopSweep } from './modules/notifications/sweep.js';
import { loadFlags, startFlagRefresh, stopFlagRefresh } from './modules/flags/flags.js';
import { loadPlatformApps, startPlatformAppRefresh } from './modules/campaigns/platformApps.js';
import { disconnectRedis, redisCache } from './lib/redis.js';

async function main() {
  await connectMongo();
  // Say where uploaded files go, so a missing FILE_STORAGE setting is obvious at start-up.
  logger.info(env.FILE_STORAGE === 'cloudinary'
    ? `File storage: Cloudinary (cloud ${env.CLOUDINARY_CLOUD_NAME}, folder ${env.CLOUDINARY_FOLDER})`
    : `File storage: local disk (${env.FILE_STORAGE_DIR}). Set FILE_STORAGE=cloudinary in .env to use Cloudinary.`);
  // Importing the app registers every model; then compare the database's indexes with the code.
  const stale = await findStaleIndexes();
  if (stale.length) {
    logger.warn({ stale }, `Found ${stale.length} index(es) not defined by this version (left from an older schema?). `
      + 'They can refuse valid saves. Run `npm run db:indexes` to remove them, or point MONGO_URI at a fresh database.');
  }
  await redisCache().ping();
  await loadConfigOverrides();
  startConfigRefresh();
  await loadFlags();
  startFlagRefresh();
  await loadPlatformApps(); // Meta / LinkedIn / Google app details saved by a SkyUp Admin
  startPlatformAppRefresh();
  if (env.SMS_PROVIDER === 'dev') logger.warn('SMS_PROVIDER=dev: OTP messages go to the test inbox (GET /v1/dev/sms), not to phones.');
  startSweep(); // DSH-11 reminders and bell clean-up, every minute

  const server = createApp().listen(env.PORT, () => {
    logger.info(`Bimayantra API listening on :${env.PORT}${env.API_PREFIX} (${env.NODE_ENV})`);
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    stopConfigRefresh();
    stopFlagRefresh();
    server.close(async () => {
      await Promise.allSettled([disconnectMongo(), disconnectRedis()]);
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 15_000).unref();
  };
  // A rejected promise nobody awaited (for example inside a provider library during a background job, GR-26)
  // must not stop the API for every user: log it with its reason and keep serving.
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason instanceof Error ? { message: reason.message, stack: reason.stack } : reason }, 'Unhandled promise rejection (kept running)');
  });
  process.on('SIGTERM', () => { stopSweep(); shutdown('SIGTERM'); });
  process.on('SIGINT', () => { stopSweep(); shutdown('SIGINT'); });
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start');
  process.exit(1);
});