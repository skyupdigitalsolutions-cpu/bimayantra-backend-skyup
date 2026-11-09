import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { requestId } from './middleware/requestId.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { healthRoutes } from './modules/health/health.routes.js';
import { referenceRoutes } from './modules/reference/reference.routes.js';
import { assistantRoutes, staffRoutes } from './modules/team/team.routes.js';
import { leadRoutes, pipelineRoutes } from './modules/leads/leads.routes.js';
import { customerRoutes } from './modules/customers/customers.routes.js';
import { auditRoutes } from './modules/audit/audit.routes.js';
import { profileRoutes } from './modules/profile/profile.routes.js';
import { fileRoutes } from './modules/files/files.routes.js';
import { kycReviewRoutes, kycRoutes } from './modules/kyc/kyc.routes.js';
import { agentCodeFlagRoutes, insurerCatalogueRoutes, myInsurersRoutes } from './modules/insurers/myInsurers.routes.js';
import { customerDocumentRoutes, documentRoutes, accountDocumentTypeRoutes } from './modules/documents/documents.routes.js';
import { customerVehicleRoutes, vehicleRoutes } from './modules/vehicles/vehicles.routes.js';
import { taskRoutes } from './modules/tasks/tasks.routes.js';
import { notificationRoutes } from './modules/notifications/notifications.routes.js';
import { dashboardRoutes, searchRoutes } from './modules/dashboard/dashboard.routes.js';
import { bestFitRoutes } from './modules/bestfit/bestfit.routes.js';
import { publicQuotationRoutes, quotationRoutes } from './modules/quotations/quotations.routes.js';
import { comparisonRoutes, publicComparisonRoutes } from './modules/quotations/comparisons.routes.js';
import { paymentRoutes, proposalRoutes, quotationPaymentRoutes } from './modules/payments/payments.routes.js';
import { policyRoutes } from './modules/policies/policies.routes.js';
import { renewalRoutes } from './modules/renewals/renewals.routes.js';
import { adminCommsRoutes, commsRoutes, greetingRoutes, walletRoutes, webhookRoutes } from './modules/comms/comms.routes.js';
import { publicReferralRoutes, referralSelfRoutes, referrerRoutes } from './modules/referrals/referrals.routes.js';
import { callRoutes } from './modules/calls/calls.routes.js';
import { integrationRoutes } from './modules/integrations/integrations.routes.js';
import { ruleRoutes } from './modules/comms/rules.js';
// Models used from Stage B on (variants, saved document types): registered here so `db:indexes` builds their rules.
import './modules/catalogue/variant.model.js';
import { featureTableRoutes } from './modules/catalogue/featureTable.routes.js';
import './modules/documents/accountDocType.model.js';
import { adminPlatformAppRoutes, campaignRoutes, hookRoutes, publicFormRoutes, websiteCors } from './modules/campaigns/campaigns.routes.js';
import { adminRoutes, billingRoutes, exportRoutes, skyupGrantRoutes, subscriptionWebhookRoutes, supportGrantRoutes, supportUseRoutes } from './modules/admin/admin.routes.js';
import { correctionRoutes, ocrJobRoutes, adminProductRoutes, advisorPriceRoutes, referencePriceRoutes, approvalRoutes, catalogueInsurerRoutes, ownProductRoutes, productRoutes, productVersionRoutes, templateRoutes, typeRoutes } from './modules/catalogue/catalogue.routes.js';
import { devRoutes } from './modules/dev/dev.routes.js';
import { adminFlagRoutes, flagRoutes } from './modules/flags/flags.routes.js';

/**
 * Request pipeline: request ID → log → security headers → CORS → cookies → body limit → routes.
 * Authentication, the per-user limit (CFG-99), capability checks, read-only mode, validation and
 * idempotency are applied per route.
 */
export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // behind one Nginx hop

  app.use(requestId);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as express.Request).requestId,
      autoLogging: { ignore: (req) => req.url?.startsWith('/health') ?? false },
      quietReqLogger: true,
      serializers: { req: () => undefined, res: () => undefined },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
      customSuccessMessage: (req, res, ms) => `${req.method} ${req.url} ${res.statusCode} ${Math.round(ms)}ms`,
      customErrorMessage: (req, res) => `${req.method} ${req.url} ${res.statusCode} failed`,
    }),
  );
  app.use(helmet());
  // Module 17: website forms post from the advisor's own site (any origin, no cookies, POST only)
  app.use('/v1/hooks/website', websiteCors);
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || env.CORS_ORIGINS.includes(origin)),
      credentials: true, // web sessions are HttpOnly cookies (P-02)
      exposedHeaders: ['X-Request-Id'],
    }),
  );
  app.use(cookieParser());
  // The raw body is kept for webhook signatures (P-42, P-56: a forged webhook changes nothing).
  app.use(express.json({ limit: env.REQUEST_BODY_LIMIT, verify: (req, _res, buf) => { (req as unknown as { rawBody?: Buffer }).rawBody = buf; } }));

  app.use('/health', healthRoutes());

  const api = express.Router();
  api.use('/auth', authRoutes());
  api.use('/reference', referenceRoutes());
  api.use('/assistants', assistantRoutes());
  api.use('/staff', staffRoutes());
  api.use('/pipelines', pipelineRoutes());
  api.use('/leads', leadRoutes());
  api.use('/customers/:customerId/documents', customerDocumentRoutes()); // before /customers
  api.use('/documents', documentRoutes());
  api.use('/customers/:customerId/vehicles', customerVehicleRoutes()); // before /customers
  api.use('/customers/:customerId/best-fit', bestFitRoutes());
  api.use('/vehicles', vehicleRoutes());
  api.use('/tasks', taskRoutes());
  api.use('/notifications', notificationRoutes());
  api.use('/dashboard', dashboardRoutes());
  api.use('/search', searchRoutes());
  api.use('/flags', flagRoutes());
  api.use('/admin/flags', adminFlagRoutes()); // before the general /admin routes
  api.use('/admin/platform-apps', adminPlatformAppRoutes()); // before the general /admin routes
  api.use('/admin/insurers', catalogueInsurerRoutes());
  api.use('/admin/approvals', approvalRoutes());
  api.use('/admin/types', typeRoutes());
  api.use('/admin/templates', templateRoutes());
  api.use('/admin/products', referencePriceRoutes()); // /admin/products/:id/prices… (before the product routes)
  api.use('/admin/products', adminProductRoutes());
  api.use('/admin/product-versions', productVersionRoutes());
  api.use('/products', advisorPriceRoutes()); // /products/:id/prices…
  api.use('/products', productRoutes());
  api.use('/my-products', ownProductRoutes());
  api.use('/catalogue', featureTableRoutes());
  api.use('/account/document-types', accountDocumentTypeRoutes());
  api.use('/quotations', quotationPaymentRoutes()); // /quotations/:id/payment-link, /payments (before the quotation routes)
  api.use('/quotations', quotationRoutes());
  api.use('/payments', paymentRoutes());
  api.use('/proposals', proposalRoutes());
  api.use('/policies', policyRoutes());
  api.use('/renewals', renewalRoutes());
  api.use('/communications', commsRoutes());
  api.use('/greetings', greetingRoutes());
  api.use('/wallet', walletRoutes()); // hidden unless WHATSAPP_WALLET=true
  api.use('/integrations', integrationRoutes()); // the advisor's own MSG91 / Brevo
  api.use('/message-rules', ruleRoutes()); // which template goes out for which trigger
  api.use('/admin/comms', adminCommsRoutes());
  api.use('/webhooks', webhookRoutes());
  api.use('/referrers', referrerRoutes());
  api.use('/referral', referralSelfRoutes());
  api.use('/public/r', publicReferralRoutes());
  api.use('/call-logs', callRoutes());
  api.use('/campaigns', campaignRoutes());
  api.use('/hooks', hookRoutes());
  api.use('/public/forms', publicFormRoutes());
  api.use('/billing', billingRoutes());
  api.use('/exports', exportRoutes());
  api.use('/support-grants', supportGrantRoutes());
  api.use('/admin/support-grants', skyupGrantRoutes()); // change #56 (before the general /admin routes)
  api.use('/support', supportUseRoutes());
  api.use('/admin', adminRoutes());
  api.use('/webhooks/subscription', subscriptionWebhookRoutes());
  api.use('/public/q', publicQuotationRoutes());
  api.use('/comparisons', comparisonRoutes());
  api.use('/public/c', publicComparisonRoutes());
  api.use('/admin/corrections', correctionRoutes());
  api.use('/admin/ocr-jobs', ocrJobRoutes());
  api.use('/customers', customerRoutes());
  api.use('/audit', auditRoutes());
  api.use('/profile', profileRoutes());
  api.use('/files', fileRoutes());
  api.use('/kyc', kycRoutes());
  api.use('/admin/kyc', kycReviewRoutes());
  api.use('/my-insurers', myInsurersRoutes());
  api.use('/insurers', insurerCatalogueRoutes());
  api.use('/admin/agent-code-flags', agentCodeFlagRoutes());
  if (env.DEV_TOOLS && env.NODE_ENV !== 'production') api.use('/dev', devRoutes());
  app.use(env.API_PREFIX, api);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}