/**
 * v3.31.0: migrate. The inventory must find what a repository is made of without
 * reading secrets, the plan reply must parse even when fenced or dashed, and the
 * rendered MIGRATION.md must carry every section. Pure tests, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inventory, formatInventory, parsePlan, renderPlan, tidy } from '../build/migrate.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cogmemai-migrate-'));
  const w = (rel, text) => {
    const full = join(root, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, text);
  };
  w('package.json', JSON.stringify({ name: 'shop', dependencies: { express: '4', pg: '8', ioredis: '5', '@aws-sdk/client-s3': '3', stripe: '12' }, devDependencies: { jest: '29' }, scripts: { test: 'jest' } }));
  w('src/server.js', `const db = process.env.DATABASE_URL; const key = process.env.STRIPE_SECRET_KEY; const c = \`\${RESET}\`; fetch('https://api.stripe.com/v1/charges'); fetch('https://hooks.slack.com/x');`);
  w('src/worker.py', `import os\nurl = os.environ["QUEUE_URL"]\ntoken = os.getenv("SLACK_TOKEN")\n`);
  w('Dockerfile', 'FROM node:20\nEXPOSE 3000\nENV PORT=${PORT}\n');
  w('docker-compose.yml', 'services:\n  web:\n    build: .\n    ports:\n      - "3000:3000"\n  db:\n    image: postgres:16\n  cache:\n    image: redis:7\n');
  w('infra/main.tf', 'provider "aws" { region = var.region }\nresource "aws_s3_bucket" "assets" {}\n');
  w('k8s/cron.yaml', 'apiVersion: batch/v1\nkind: CronJob\nmetadata:\n  name: nightly\n');
  w('.github/workflows/ci.yml', 'on:\n  schedule:\n    - cron: "0 3 * * *"\njobs: {}\n');
  w('.env', 'STRIPE_SECRET_KEY=sk_live_SHOULD_NEVER_BE_READ\n');
  w('certs/server.pem', '-----BEGIN PRIVATE KEY-----\nnope\n');
  w('node_modules/left-pad/index.js', 'process.env.IGNORED_IN_DEPS');
  w('package-lock.json', JSON.stringify({ packages: { 'node_modules/x': { funding: 'https://opencollective.com/x' } } }));
  w('README.md', 'See https://docs.example.org and run crontab -e');
  w('tests/app.test.js', 'test("x", () => {});');
  return root;
}

test('inventory finds the stack, keeps names only, and skips dependencies, lockfiles and prose', () => {
  const inv = inventory(fixture());
  const text = formatInventory(inv);
  assert.ok(inv.files >= 12);
  assert.ok(inv.languages.some((l) => l.name === 'JavaScript'));
  assert.ok(inv.frameworks.includes('Express'), 'express');
  assert.ok(inv.frameworks.includes('Stripe'), 'stripe');
  assert.ok(inv.frameworks.includes('Test framework'));
  assert.ok(inv.data_stores.some((d) => d.startsWith('PostgreSQL')), 'postgres from pg and the compose image');
  assert.ok(inv.data_stores.includes('Redis'));
  assert.ok(inv.data_stores.includes('S3-compatible object storage'));
  assert.ok(inv.cloud_sdks.includes('aws'), 'aws from the SDK and the terraform provider');
  assert.ok(inv.infra.terraform && inv.infra.docker && inv.infra.compose && inv.infra.kubernetes, JSON.stringify(inv.infra));
  assert.deepEqual(inv.containers.compose_services, ['cache', 'db', 'web']);
  assert.ok(inv.containers.exposed_ports.includes('3000'));
  assert.ok(inv.ci.includes('GitHub Actions'));
  assert.ok(inv.scheduled_jobs.some((j) => j.includes('CronJob')) && inv.scheduled_jobs.some((j) => j.includes('GitHub Actions schedule')), inv.scheduled_jobs.join('; '));
  assert.ok(inv.env_vars.names.includes('DATABASE_URL') && inv.env_vars.names.includes('STRIPE_SECRET_KEY') && inv.env_vars.names.includes('QUEUE_URL') && inv.env_vars.names.includes('SLACK_TOKEN') && inv.env_vars.names.includes('PORT'));
  assert.ok(!inv.env_vars.names.includes('RESET'), 'a JS template literal is not an environment variable');
  assert.ok(!inv.env_vars.names.includes('IGNORED_IN_DEPS'), 'node_modules is skipped');
  assert.equal(inv.env_vars.secret_like, 2);
  assert.ok(inv.external_hosts.some((h) => h.host === 'api.stripe.com') && inv.external_hosts.some((h) => h.host === 'hooks.slack.com'));
  assert.ok(!inv.external_hosts.some((h) => h.host === 'opencollective.com'), 'lockfile funding links are not integrations');
  assert.ok(!inv.external_hosts.some((h) => h.host === 'docs.example.org'), 'README links are not integrations');
  assert.ok(inv.secrets_risk.some((r) => r.startsWith('.env ')) && inv.secrets_risk.some((r) => r.includes('server.pem')));
  assert.ok(!text.includes('SHOULD_NEVER_BE_READ'), 'secret values never appear in the inventory');
  assert.ok(!inv.scheduled_jobs.some((j) => j.includes('README')), 'crontab in prose is not a job');
  assert.equal(inv.tests, true);
});

test('parsePlan accepts fenced and bare JSON and tidy removes dash separators', () => {
  const plan = parsePlan('```json\n{"summary":"s","phases":[{"name":"P1","work":["a"],"gate":"g"}],"risks":[]}\n```');
  assert.equal(plan.summary, 's');
  assert.equal(parsePlan('Here you go: {"summary":"bare"} thanks').summary, 'bare');
  assert.throws(() => parsePlan('no json here'));
  assert.equal(tidy('Inventory -- done \u2014 now \u2013 next'), 'Inventory: done : now : next');
});

test('renderPlan writes every section with the gate commands', () => {
  const inv = inventory(fixture());
  const plan = {
    summary: 'Small shop.',
    components: [{ component: 'API', today: 'VPS', target: 'ECS', why: 'managed' }],
    phases: [{ name: 'Landing zone', work: ['VPC', 'IAM'], gate: 'VPC exists' }, { name: 'Pilot "cache"', work: ['move redis'], gate: 'parity' }],
    risks: [{ risk: 'Stripe webhooks', likelihood: 'medium', impact: 'high', mitigation: 'replay' }],
    cost_drivers: [{ driver: 'RDS', direction: 'up', note: 'order of tens of dollars' }],
    open_questions: ['PHP version?'],
  };
  const md = renderPlan('# Migration scope: shop to AWS\n\n## Purpose\nMove.\n', plan, inv, 'aws', '2026-10-01');
  for (const h of ['# Migration scope', '# Migration plan: ', '## Summary', '## Components', '## Phases', '### 1. Landing zone', '## Risks', '## Cost drivers', '## Open questions', '## Inventory']) assert.ok(md.includes(h), h);
  assert.ok(md.includes('cogmemai-mcp migrate gate "Landing zone"'));
  assert.ok(md.includes(`cogmemai-mcp migrate gate "Pilot 'cache'"`), 'quotes inside a phase name are swapped so the command stays valid');
  assert.ok(!/[\u2014\u2013]/.test(md));
});
