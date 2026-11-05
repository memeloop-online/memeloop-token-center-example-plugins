import { SnapshotService } from './fetcher.js';
import { createHealthIntelligenceServer } from './httpServer.js';
import { ConcurrencyAdviceService } from './concurrencyService.js';
import { evidencePolicy } from './concurrencyAdvice.js';

const port = Number(process.env.PORT ?? 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer from 1 to 65535');
}

const enabled = process.env.MTC_CONCURRENCY_ADVICE_ENABLED;
if (enabled !== undefined && enabled !== 'true' && enabled !== 'false') throw new Error('invalid advice enabled flag');
const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`missing required private advice configuration: ${name}`);
  return value;
};
const concurrencyService = enabled === 'true' ? new ConcurrencyAdviceService({
  coreOrigin: required('MTC_CORE_ORIGIN'), tenantExternalId: required('MTC_TENANT_EXTERNAL_ID'),
  serviceToken: required('MTC_SERVICE_TOKEN'), readToken: required('MTC_ADVICE_READ_TOKEN'),
  policy: evidencePolicy(JSON.parse(process.env.MTC_CONCURRENCY_EVIDENCE_POLICY ?? '{}') as unknown),
}) : undefined;
const server = createHealthIntelligenceServer({ snapshotService: new SnapshotService(),
  ...(concurrencyService ? { concurrencyService } : {}) });
concurrencyService?.start();
server.listen(port, '0.0.0.0', () => {
  process.stdout.write(`health intelligence API listening on ${port}\n`);
});

const stop = () => {
  void concurrencyService?.stop();
  server.close(() => process.exit(0));
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
