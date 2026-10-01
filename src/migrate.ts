/**
 * Migrate: the cloud migration playbook.
 *
 *   cogmemai-mcp migrate assess [--target aws|azure|gcp|other] [--path DIR] [--out FILE] [--model ID] [--force] [--no-rules] [--dry-run]
 *   cogmemai-mcp migrate gate "<phase>" [--notes "..."] [--since REF]
 *   cogmemai-mcp migrate status
 *
 * assess reads the repository (no file contents leave the machine except names, dependency
 * names, environment variable NAMES, hostnames and counts), asks the MSGR gateway to write
 * the migration scope document and a plan with risks and cost drivers, stores the scope as
 * the project intent, the plan and risks as memories, installs the migrate pack and the
 * target cloud's pack, and writes MIGRATION.md next to the code.
 *
 * gate reviews a phase of the work against the scope (review_work on the server) and records
 * the result; a phase passes with coverage 80 or more and no violations.
 */

import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative, extname, basename, sep } from 'node:path';
import { execSync } from 'node:child_process';
import { CloudStorage } from './storage-cloud.js';
import { findPack, installPack } from './packs.js';
import { projectIdFor, syncGuardRules } from './guard-hooks.js';
import { API_BASE, VERSION } from './config.js';

// ── Inventory ─────────────────────────────────────────────────

const SKIP_DIRS = new Set(['node_modules', '.git', 'vendor', 'dist', 'build', '.next', '.nuxt', 'target', '.venv', 'venv', '__pycache__', '.cache', 'coverage', '.terraform', 'bower_components', '.idea', '.vscode', 'out', 'tmp', 'logs', 'uploads', 'cache', '.svn', '.hg']);
const MAX_FILES = 30_000;
const MAX_READ_BYTES = 200_000;
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.php', '.rb', '.go', '.java', '.kt', '.cs', '.rs', '.sh', '.bash', '.yml', '.yaml', '.json', '.toml', '.env.example', '.tf', '.tfvars', '.hcl', '.xml', '.gradle', '.properties', '.ini', '.cfg', '.conf', '.txt', '.md', '.sql', '.html', '.twig', '.erb', '.vue', '.svelte', '.scala', '.swift', '.dart', '.ex', '.exs', '.pl', '.ps1']);
const LANG_BY_EXT: Record<string, string> = {
  '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript', '.jsx': 'JavaScript', '.ts': 'TypeScript', '.tsx': 'TypeScript',
  '.py': 'Python', '.php': 'PHP', '.rb': 'Ruby', '.go': 'Go', '.java': 'Java', '.kt': 'Kotlin', '.cs': 'C#', '.rs': 'Rust',
  '.scala': 'Scala', '.swift': 'Swift', '.dart': 'Dart', '.ex': 'Elixir', '.exs': 'Elixir', '.sh': 'Shell', '.bash': 'Shell', '.ps1': 'PowerShell',
  '.sql': 'SQL', '.tf': 'Terraform', '.hcl': 'HCL', '.yml': 'YAML', '.yaml': 'YAML', '.html': 'HTML', '.vue': 'Vue', '.svelte': 'Svelte', '.pl': 'Perl',
};

const DATA_STORE_HINTS: Array<[RegExp, string]> = [
  [/\b(mysql2?|mysqlclient|pymysql|mariadb|doctrine\/dbal|ext-mysqli|ext-pdo_mysql|go-sql-driver\/mysql|mysql-connector)\b/i, 'MySQL or MariaDB'],
  [/\b(pg|psycopg2?|asyncpg|ext-pgsql|ext-pdo_pgsql|lib\/pq|jackc\/pgx|postgres|postgresql|sequelize|typeorm|prisma|knex)\b/i, 'PostgreSQL (or an ORM that targets it)'],
  [/\b(redis|ioredis|predis|ext-redis|go-redis|hiredis|django-redis|cache_redis)\b/i, 'Redis'],
  [/\b(mongodb|mongoose|pymongo|mongo-go-driver|motor|mongo)\b/i, 'MongoDB'],
  [/\b(elasticsearch|opensearch|@elastic\/elasticsearch|elasticsearch-py)\b/i, 'Elasticsearch or OpenSearch'],
  [/\b(amqplib|pika|php-amqplib|rabbitmq|kombu|celery)\b/i, 'RabbitMQ (AMQP)'],
  [/\b(kafkajs|kafka-python|confluent-kafka|sarama|kafka)\b/i, 'Kafka'],
  [/\b(sqlite3?|better-sqlite3|ext-pdo_sqlite)\b/i, 'SQLite'],
  [/\b(memcached|pymemcache|ext-memcached)\b/i, 'Memcached'],
  [/\b(dynamodb|@aws-sdk\/client-dynamodb)\b/i, 'DynamoDB'],
  [/\b(@aws-sdk\/client-s3|aws-sdk|boto3|league\/flysystem-aws-s3|minio|s3fs)\b/i, 'S3-compatible object storage'],
  [/\b(@azure\/storage-blob|azure-storage-blob)\b/i, 'Azure Blob Storage'],
  [/\b(@google-cloud\/storage|google-cloud-storage)\b/i, 'Google Cloud Storage'],
  [/\b(clickhouse|snowflake|bigquery|@google-cloud\/bigquery|redshift)\b/i, 'Analytics warehouse'],
  [/\b(firebase|firestore|@google-cloud\/firestore)\b/i, 'Firestore or Firebase'],
];

const FRAMEWORK_HINTS: Array<[RegExp, string]> = [
  [/\b(next)\b/i, 'Next.js'], [/\b(nuxt)\b/i, 'Nuxt'], [/\b(react|react-dom)\b/i, 'React'], [/\b(vue)\b/i, 'Vue'], [/\b(@angular\/core)\b/i, 'Angular'],
  [/\b(express)\b/i, 'Express'], [/\b(fastify)\b/i, 'Fastify'], [/\b(@nestjs\/core)\b/i, 'NestJS'], [/\b(koa)\b/i, 'Koa'],
  [/\b(django)\b/i, 'Django'], [/\b(flask)\b/i, 'Flask'], [/\b(fastapi)\b/i, 'FastAPI'], [/\b(celery)\b/i, 'Celery workers'],
  [/\b(laravel\/framework)\b/i, 'Laravel'], [/\b(symfony\/)\b/i, 'Symfony'], [/\b(slim\/slim)\b/i, 'Slim'],
  [/\b(rails)\b/i, 'Ruby on Rails'], [/\b(sinatra)\b/i, 'Sinatra'],
  [/\b(gin-gonic\/gin|labstack\/echo|gofiber\/fiber|go-chi\/chi)\b/i, 'Go web framework'],
  [/\b(spring-boot|org\.springframework)\b/i, 'Spring Boot'], [/\b(actix-web|axum|rocket)\b/i, 'Rust web framework'],
  [/\b(electron)\b/i, 'Electron'], [/\b(socket\.io|ws)\b/i, 'WebSockets'], [/\b(puppeteer|playwright)\b/i, 'Headless browser'],
  [/\b(stripe)\b/i, 'Stripe'], [/\b(twilio)\b/i, 'Twilio'], [/\b(sendgrid|@sendgrid\/mail|nodemailer|phpmailer)\b/i, 'Outbound email'],
  [/\b(openai|anthropic|@anthropic-ai\/sdk|langchain|@google\/generative-ai)\b/i, 'LLM API client'],
  [/\b(node-cron|cron|apscheduler|schedule|whenever)\b/i, 'In-process scheduler'],
  [/\b(jest|vitest|mocha|pytest|phpunit|rspec|junit)\b/i, 'Test framework'],
];

const CLOUD_HINTS: Array<[RegExp, string]> = [
  [/\b(aws-sdk|@aws-sdk\/|boto3|botocore|aws-cdk|serverless|aws-lambda|github\.com\/aws\/aws-sdk-go)/i, 'aws'],
  [/\b(@azure\/|azure-identity|azure-storage|azure-functions|azure-mgmt|Microsoft\.Azure|Azure\.)/i, 'azure'],
  [/\b(@google-cloud\/|google-cloud-|google-api-python-client|firebase-admin|cloud\.google\.com\/go)/i, 'gcp'],
  [/\b(cloudflare|wrangler)\b/i, 'cloudflare'],
  [/\b(vercel|@vercel\/)/i, 'vercel'], [/\b(netlify)\b/i, 'netlify'], [/\b(heroku)\b/i, 'heroku'], [/\b(digitalocean|@digitalocean)/i, 'digitalocean'],
];

const ENV_PATTERNS: RegExp[] = [
  /process\.env\.([A-Z][A-Z0-9_]{2,})/g,
  /process\.env\[["']([A-Z][A-Z0-9_]{2,})["']\]/g,
  /os\.environ(?:\.get)?\(?\[?["']([A-Z][A-Z0-9_]{2,})["']/g,
  /os\.getenv\(["']([A-Z][A-Z0-9_]{2,})["']/g,
  /\bgetenv\(["']([A-Z][A-Z0-9_]{2,})["']\)/g,
  /\$_(?:ENV|SERVER)\[["']([A-Z][A-Z0-9_]{2,})["']\]/g,
  /\bENV\[["']([A-Z][A-Z0-9_]{2,})["']\]/g,
  /\bENV\.fetch\(["']([A-Z][A-Z0-9_]{2,})["']/g,
  /os\.Getenv\("([A-Z][A-Z0-9_]{2,})"\)/g,
  /System\.getenv\("([A-Z][A-Z0-9_]{2,})"\)/g,
  /Environment\.GetEnvironmentVariable\("([A-Z][A-Z0-9_]{2,})"\)/g,
];
// ${NAME} means an environment variable only in shell, YAML, env, conf and Terraform files; in JavaScript it is a template literal.
const ENV_INTERP = /\$\{([A-Z][A-Z0-9_]{2,})(?::-[^}]*)?\}/g;
const ENV_INTERP_EXT = new Set(['.sh', '.bash', '.yml', '.yaml', '.env', '.conf', '.cfg', '.ini', '.tf', '.tfvars', '.hcl', '.properties']);
const LOCKFILES = /^(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|Pipfile\.lock|poetry\.lock|Cargo\.lock|go\.sum|Gemfile\.lock)$/;
const SECRET_NAME = /(SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|CLIENT_SECRET|ACCESS_KEY|AUTH|CREDENTIAL|DSN|CONNECTION_?STRING)/i;
const HOST_RE = /https?:\/\/([a-z0-9][a-z0-9.-]*\.[a-z]{2,})(?::\d+)?(?=[/"'\s)]|$)/gi;
const HOST_IGNORE = /^(localhost|example\.(com|org|net)|.*\.example\.(com|org)|www\.w3\.org|schema\.org|json-schema\.org|github\.com|www\.github\.com|raw\.githubusercontent\.com|npmjs\.(com|org)|registry\.npmjs\.org|pypi\.org|packagist\.org|opensource\.org|creativecommons\.org|developer\.mozilla\.org|stackoverflow\.com|en\.wikipedia\.org|fonts\.googleapis\.com|fonts\.gstatic\.com|cdnjs\.cloudflare\.com|unpkg\.com|cdn\.jsdelivr\.net|www\.gnu\.org|apache\.org|www\.apache\.org|yaml\.org|xmlns\.com|purl\.org|tools\.ietf\.org|datatracker\.ietf\.org|www\.ietf\.org)$/i;

export interface Inventory {
  root: string;
  project_id: string;
  files: number;
  source_bytes: number;
  languages: Array<{ name: string; files: number }>;
  manifests: string[];
  dependencies: number;
  frameworks: string[];
  data_stores: string[];
  cloud_sdks: string[];
  infra: Record<string, string[]>;
  containers: { dockerfiles: number; exposed_ports: string[]; compose_services: string[]; compose_images: string[] };
  ci: string[];
  scheduled_jobs: string[];
  env_vars: { total: number; secret_like: number; names: string[] };
  external_hosts: Array<{ host: string; refs: number }>;
  secrets_risk: string[];
  tests: boolean;
  git: { remote: string; commits: number; last_commit: string; contributors: number } | null;
  truncated: boolean;
}

function readText(path: string, max = MAX_READ_BYTES): string {
  try {
    const st = statSync(path);
    if (st.size > max) return readFileSync(path, { encoding: 'utf-8', flag: 'r' }).slice(0, max);
    return readFileSync(path, 'utf-8');
  } catch {
    return '';
  }
}

function git(args: string, cwd: string): string {
  try {
    return execSync(`git ${args}`, { cwd, encoding: 'utf-8', timeout: 8000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return '';
  }
}

function count<T>(map: Map<T, number>, key: T, n = 1): void {
  map.set(key, (map.get(key) || 0) + n);
}

/** Walk the tree and summarize it. Nothing but names, dependency names, env var names, hostnames and counts is kept. */
export function inventory(root: string): Inventory {
  const inv: Inventory = {
    root,
    project_id: projectIdFor(root),
    files: 0,
    source_bytes: 0,
    languages: [],
    manifests: [],
    dependencies: 0,
    frameworks: [],
    data_stores: [],
    cloud_sdks: [],
    infra: {},
    containers: { dockerfiles: 0, exposed_ports: [], compose_services: [], compose_images: [] },
    ci: [],
    scheduled_jobs: [],
    env_vars: { total: 0, secret_like: 0, names: [] },
    external_hosts: [],
    secrets_risk: [],
    tests: false,
    git: null,
    truncated: false,
  };
  const langs = new Map<string, number>();
  const envNames = new Map<string, number>();
  const hosts = new Map<string, number>();
  const depText: string[] = [];
  const infra = new Map<string, string[]>();
  const addInfra = (kind: string, file: string) => {
    const list = infra.get(kind) || [];
    if (list.length < 25) list.push(file);
    infra.set(kind, list);
  };
  const frameworks = new Set<string>();
  const stores = new Set<string>();
  const clouds = new Set<string>();
  const ci = new Set<string>();
  const jobs = new Set<string>();
  const risks = new Set<string>();
  const ports = new Set<string>();
  const composeServices = new Set<string>();
  const composeImages = new Set<string>();

  const stack: string[] = [root];
  while (stack.length) {
    const dir = stack.pop() as string;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      const rel = relative(root, full).split(sep).join('/');
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        if (/^(test|tests|__tests__|spec|specs)$/i.test(e.name)) inv.tests = true;
        stack.push(full);
        continue;
      }
      if (!e.isFile()) continue;
      if (++inv.files > MAX_FILES) {
        inv.truncated = true;
        break;
      }
      const name = e.name;
      const ext = extname(name).toLowerCase();
      let size = 0;
      try {
        size = statSync(full).size;
      } catch {
        /* unreadable */
      }
      if (LANG_BY_EXT[ext]) {
        count(langs, LANG_BY_EXT[ext]);
        inv.source_bytes += size;
      }
      if (/\.(test|spec)\.[jt]sx?$|_test\.(go|py|rb|php)$|Test\.(java|kt|cs|php)$/.test(name)) inv.tests = true;

      // Secrets at rest: names only, never contents.
      if (/^\.env(\..+)?$/.test(name) && !/\.(example|sample|template|dist)$/.test(name)) risks.add(`${rel} (environment file; confirm it is gitignored and never copied to the target)`);
      if (/\.(pem|key|p12|pfx|jks|keystore)$/.test(name) || /^id_(rsa|ed25519|ecdsa)$/.test(name)) risks.add(`${rel} (private key material in the tree)`);
      if (/^(credentials|service-account.*|.*-sa\.json|client_secret.*\.json|serviceAccountKey\.json)$/i.test(name)) risks.add(`${rel} (looks like a cloud credential file)`);

      // Manifests
      let manifest = '';
      if (name === 'package.json') {
        manifest = rel;
        try {
          const pkg = JSON.parse(readText(full));
          const deps = Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) });
          inv.dependencies += deps.length;
          depText.push(deps.join(' '));
          const scripts = pkg.scripts || {};
          if (scripts.test) inv.tests = true;
        } catch {
          /* unparsable package.json */
        }
      } else if (name === 'requirements.txt' || name === 'Pipfile' || name === 'pyproject.toml' || name === 'setup.py') {
        manifest = rel;
        const t = readText(full);
        const deps = t.split('\n').map((l) => l.replace(/[=<>!~\[;#].*$/, '').trim()).filter((l) => /^[A-Za-z0-9_.-]+$/.test(l));
        inv.dependencies += deps.length;
        depText.push(deps.join(' '));
      } else if (name === 'composer.json') {
        manifest = rel;
        try {
          const c = JSON.parse(readText(full));
          const deps = Object.keys({ ...(c.require || {}), ...(c['require-dev'] || {}) });
          inv.dependencies += deps.length;
          depText.push(deps.join(' '));
        } catch {
          /* unparsable */
        }
      } else if (name === 'go.mod' || name === 'Gemfile' || name === 'Cargo.toml' || name === 'pom.xml' || name === 'build.gradle' || name === 'build.gradle.kts' || /\.csproj$/.test(name) || name === 'mix.exs') {
        manifest = rel;
        const t = readText(full);
        depText.push(t.slice(0, 20_000));
        inv.dependencies += (t.match(/^\s*(require|gem|\[dependencies\]|<dependency>|implementation|PackageReference)/gm) || []).length;
      } else if (name === 'wp-config.php' || name === 'wp-settings.php') {
        frameworks.add('WordPress');
        stores.add('MySQL or MariaDB');
        jobs.add('WP-Cron (runs on page views unless DISABLE_WP_CRON and a real cron are set)');
      }
      if (manifest) inv.manifests.push(manifest);

      // Infrastructure and containers
      if (/^Dockerfile(\..+)?$/.test(name) || /\.dockerfile$/i.test(name)) {
        inv.containers.dockerfiles++;
        addInfra('docker', rel);
        for (const m of readText(full).matchAll(/^\s*EXPOSE\s+([\d\s/tcpud]+)/gim)) for (const p of m[1].trim().split(/\s+/)) ports.add(p);
      } else if (/^(docker-)?compose(\..+)?\.ya?ml$/.test(name)) {
        addInfra('compose', rel);
        const t = readText(full);
        const svc = t.match(/^services:\s*$/m);
        if (svc) for (const m of t.matchAll(/^ {2}([a-zA-Z0-9_-]+):\s*$/gm)) composeServices.add(m[1]);
        for (const m of t.matchAll(/^\s*image:\s*["']?([^\s"'#]+)/gm)) composeImages.add(m[1]);
        for (const m of t.matchAll(/^\s*-\s*["']?(\d+):\d+/gm)) ports.add(m[1]);
        depText.push([...composeImages].join(' '));
      } else if (ext === '.tf' || ext === '.tfvars' || ext === '.hcl') {
        addInfra('terraform', rel);
        const t = readText(full);
        for (const m of t.matchAll(/provider\s+"([a-z0-9_-]+)"/g)) clouds.add(m[1] === 'google' ? 'gcp' : m[1] === 'azurerm' ? 'azure' : m[1]);
        for (const m of t.matchAll(/resource\s+"(aws|azurerm|google)_/g)) clouds.add(m[1] === 'google' ? 'gcp' : m[1] === 'azurerm' ? 'azure' : m[1]);
      } else if (ext === '.yml' || ext === '.yaml') {
        const t = readText(full, 60_000);
        if (/^kind:\s*\w+/m.test(t) && /^apiVersion:/m.test(t)) {
          addInfra('kubernetes', rel);
          if (/^kind:\s*CronJob/m.test(t)) jobs.add(`Kubernetes CronJob in ${rel}`);
          if (/^kind:\s*(Secret)\b/m.test(t)) risks.add(`${rel} (Kubernetes Secret manifest in the tree; confirm no literal values are committed)`);
        }
        if (/AWSTemplateFormatVersion|^Resources:\s*$/m.test(t) && /Type:\s*AWS::/.test(t)) {
          addInfra('cloudformation', rel);
          clouds.add('aws');
        }
        if (name === 'Chart.yaml') addInfra('helm', rel);
        if (/^service:\s*\S+/m.test(t) && /^provider:\s*$/m.test(t)) {
          addInfra('serverless', rel);
          if (/name:\s*aws/.test(t)) clouds.add('aws');
        }
        if (/^\s*hosts:\s/m.test(t) && /^\s*tasks:\s*$/m.test(t)) addInfra('ansible', rel);
        if (rel.startsWith('.github/workflows/')) {
          ci.add('GitHub Actions');
          if (/^\s*schedule:\s*$/m.test(t) || /^\s*-\s*cron:/m.test(t)) jobs.add(`GitHub Actions schedule in ${rel}`);
          if (/aws-actions\/configure-aws-credentials/.test(t)) clouds.add('aws');
          if (/azure\/login/.test(t)) clouds.add('azure');
          if (/google-github-actions\/auth/.test(t)) clouds.add('gcp');
        }
        if (name === '.gitlab-ci.yml') ci.add('GitLab CI');
        if (name === 'bitbucket-pipelines.yml') ci.add('Bitbucket Pipelines');
        if (name === '.travis.yml') ci.add('Travis CI');
        if (name === 'azure-pipelines.yml') {
          ci.add('Azure Pipelines');
          clouds.add('azure');
        }
        if (name === 'cloudbuild.yaml' || name === 'cloudbuild.yml') {
          ci.add('Cloud Build');
          clouds.add('gcp');
        }
        if (name === 'app.yaml' && /^runtime:/m.test(t)) {
          addInfra('app-engine', rel);
          clouds.add('gcp');
        }
      } else if (name === 'Jenkinsfile') ci.add('Jenkins');
      else if (name === 'Procfile') addInfra('procfile', rel);
      else if (name === 'Vagrantfile') addInfra('vagrant', rel);
      else if (/\.service$/.test(name) && /\[Service\]/.test(readText(full, 10_000))) addInfra('systemd', rel);
      else if (/^(crontab|cron\.d|.*\.cron)$/i.test(name) || /^cron/i.test(rel.split('/')[0] || '') && /crontab/i.test(name)) jobs.add(`crontab file ${rel}`);
      else if (/^(nginx|httpd|apache2?)\.conf$|\.htaccess$|^sites-(available|enabled)\//.test(rel) || /^\.htaccess$/.test(name)) addInfra('web-server-config', rel);
      else if (name === 'vercel.json' || name === 'netlify.toml' || name === 'fly.toml' || name === 'render.yaml' || name === 'railway.json') addInfra('paas-config', rel);

      // Environment variable names and external hosts from source text
      const envFile = /^\.env(\..+)?$/.test(name);
      if ((TEXT_EXT.has(ext) && ext !== '.md' && ext !== '.txt' && !LOCKFILES.test(name) && !/\.min\.(js|css)$/.test(name)) || envFile || name === 'Dockerfile') {
        if (size > MAX_READ_BYTES || size === 0) continue;
        const t = readText(full);
        for (const re of ENV_PATTERNS) {
          re.lastIndex = 0;
          for (const m of t.matchAll(re)) count(envNames, m[1]);
        }
        if (ENV_INTERP_EXT.has(ext) || envFile || name === 'Dockerfile') {
          ENV_INTERP.lastIndex = 0;
          for (const m of t.matchAll(ENV_INTERP)) count(envNames, m[1]);
        }
        if (ext === '.php') {
          if (/\badd_action\s*\(/.test(t) || /\badd_filter\s*\(/.test(t)) frameworks.add('WordPress (plugin or theme code)');
          if (/\$wpdb->|new\s+mysqli\s*\(|mysqli_connect\s*\(|new\s+PDO\s*\(\s*["']mysql:/.test(t)) stores.add('MySQL or MariaDB');
          if (/pg_connect\s*\(|new\s+PDO\s*\(\s*["']pgsql:/.test(t)) stores.add('PostgreSQL (or an ORM that targets it)');
          if (/new\s+Redis\s*\(|new\s+Predis\\/.test(t)) stores.add('Redis');
          if (/new\s+PDO\s*\(\s*["']sqlite:/.test(t)) stores.add('SQLite');
          if (/\bmail\s*\(|PHPMailer|wp_mail\s*\(/.test(t)) frameworks.add('Outbound email');
          if (/wp_schedule_event\s*\(/.test(t)) jobs.add(`WP-Cron event scheduled in ${rel}`);
        }
        HOST_RE.lastIndex = 0;
        for (const m of t.matchAll(HOST_RE)) {
          const h = m[1].toLowerCase();
          if (!HOST_IGNORE.test(h)) count(hosts, h);
        }
        if (/(^|\s)crontab\s+-|@Scheduled\(|celery\.beat|beat_schedule\s*=|\bcron\.schedule\(|new\s+CronJob\(|schedule\.every\(|BlockingScheduler|BackgroundScheduler/.test(t)) jobs.add(`scheduled work in ${rel}`);
      }
    }
    if (inv.truncated) break;
  }

  const allDeps = depText.join(' ');
  for (const [re, label] of FRAMEWORK_HINTS) if (re.test(allDeps)) frameworks.add(label);
  for (const [re, label] of DATA_STORE_HINTS) if (re.test(allDeps)) stores.add(label);
  for (const [re, label] of CLOUD_HINTS) if (re.test(allDeps)) clouds.add(label);
  for (const img of composeImages) {
    const base = img.split(':')[0].split('/').pop() || '';
    for (const [re, label] of DATA_STORE_HINTS) if (re.test(base)) stores.add(label);
  }

  inv.languages = [...langs].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, files]) => ({ name, files }));
  inv.frameworks = [...frameworks].sort();
  inv.data_stores = [...stores].sort();
  inv.cloud_sdks = [...clouds].sort();
  inv.infra = Object.fromEntries([...infra].sort());
  inv.containers.exposed_ports = [...ports].sort();
  inv.containers.compose_services = [...composeServices].sort();
  inv.containers.compose_images = [...composeImages].sort();
  inv.ci = [...ci].sort();
  inv.scheduled_jobs = [...jobs].sort().slice(0, 20);
  const envSorted = [...envNames].sort((a, b) => b[1] - a[1]).map(([n]) => n);
  inv.env_vars = { total: envSorted.length, secret_like: envSorted.filter((n) => SECRET_NAME.test(n)).length, names: envSorted.slice(0, 60) };
  inv.external_hosts = [...hosts].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([host, refs]) => ({ host, refs }));
  inv.secrets_risk = [...risks].sort().slice(0, 20);
  const remote = git('remote get-url origin', root);
  if (remote || git('rev-parse --is-inside-work-tree', root) === 'true') {
    inv.git = {
      remote: remote.replace(/\/\/[^@]+@/, '//'),
      commits: Number(git('rev-list --count HEAD', root)) || 0,
      last_commit: git('log -1 --format=%cs', root),
      contributors: git('shortlog -sn HEAD', root).split('\n').filter(Boolean).length,
    };
  }
  return inv;
}

export function formatInventory(inv: Inventory): string {
  const lines: string[] = [];
  lines.push(`Project ${inv.project_id}: ${inv.files}${inv.truncated ? '+' : ''} files, ${(inv.source_bytes / 1024).toFixed(0)} KB of source${inv.git ? `, ${inv.git.commits} commits, ${inv.git.contributors} contributor${inv.git.contributors === 1 ? '' : 's'}, last ${inv.git.last_commit}` : ', no git repository'}`);
  lines.push(`Languages: ${inv.languages.map((l) => `${l.name} (${l.files})`).join(', ') || 'none detected'}`);
  lines.push(`Frameworks and libraries: ${inv.frameworks.join(', ') || 'none recognized'}`);
  lines.push(`Data stores: ${inv.data_stores.join(', ') || 'none recognized'}`);
  lines.push(`Cloud SDKs or providers in use: ${inv.cloud_sdks.join(', ') || 'none'}`);
  lines.push(`Infrastructure as code: ${Object.entries(inv.infra).map(([k, v]) => `${k} (${v.length})`).join(', ') || 'none'}`);
  lines.push(`Containers: ${inv.containers.dockerfiles} Dockerfile${inv.containers.dockerfiles === 1 ? '' : 's'}${inv.containers.compose_services.length ? `, compose services: ${inv.containers.compose_services.join(', ')}` : ''}${inv.containers.exposed_ports.length ? `, ports: ${inv.containers.exposed_ports.join(', ')}` : ''}`);
  lines.push(`CI: ${inv.ci.join(', ') || 'none found'}`);
  lines.push(`Scheduled jobs: ${inv.scheduled_jobs.length ? inv.scheduled_jobs.join('; ') : 'none found'}`);
  lines.push(`Environment variables referenced: ${inv.env_vars.total} (${inv.env_vars.secret_like} look like secrets)${inv.env_vars.names.length ? `: ${inv.env_vars.names.slice(0, 40).join(', ')}` : ''}`);
  lines.push(`External hosts referenced: ${inv.external_hosts.map((h) => `${h.host} (${h.refs})`).join(', ') || 'none'}`);
  lines.push(`Secrets risk: ${inv.secrets_risk.length ? inv.secrets_risk.join('; ') : 'no secret-looking files in the tree'}`);
  lines.push(`Tests: ${inv.tests ? 'present' : 'none found'}`);
  return lines.join('\n');
}

// ── Gateway ───────────────────────────────────────────────────

const DEFAULT_MODEL = 'claude-sonnet-4-6';

async function gatewayChat(apiKey: string, projectId: string, model: string, system: string, user: string, maxTokens = 2000): Promise<string> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 120_000);
  try {
    const res = await fetch(`${API_BASE}/msgr/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, 'User-Agent': `cogmemai-mcp/${VERSION}` },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature: 0.2,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        cogmemai: { project_id: projectId, memory: true, include_global: true, guard: false, review: false, learn: false },
      }),
      signal: controller.signal,
    });
    const data = (await res.json().catch(() => ({}))) as { error?: { message?: string }; choices?: Array<{ message?: { content?: string } }> };
    if (!res.ok) throw new Error(data.error?.message || `HTTP ${res.status} from the MSGR gateway`);
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('empty reply from the MSGR gateway');
    return content;
  } finally {
    clearTimeout(t);
  }
}

const SYSTEM = `You are a senior cloud migration architect writing for the team that will do the work and for the Ai agents that will help them. You write plain English, specific to the inventory you are given, with no filler and no marketing. Never invent facts about the system that the inventory does not support; where you must assume, say "assumed". Never use an em dash or en dash character.`;

function scopePrompt(inv: Inventory, target: string): string {
  return `Write the migration scope document for moving this project to ${targetName(target)}. It becomes the project's intent document that every change is reviewed against, so every line must be checkable.

INVENTORY
${formatInventory(inv)}

Write Markdown with exactly these headings and nothing before the first one:
# Migration scope: <project> to ${targetName(target)}
## Purpose
(two or three sentences: what moves, why, and what must be true when it is done)
## What moves
(bullets: each service, data store, scheduled job and integration from the inventory, with its target service on ${targetName(target)}; mark assumptions)
## What stays
(bullets, or "Nothing stays behind" if so)
## Invariants
(8 to 12 bullets, each starting with NEVER or MUST, covering: data residency, data verification by counts and checksums before cutover, a single writer during cutover, rehearsed rollback before each phase, parity tests and dashboards before traffic, secrets reissued in the target's secret manager and never exported, the source kept read-only thirty days before decommission, a budget with alerts before traffic, and the specific risks this inventory shows)
## Phases
(numbered: Inventory and scope; Landing zone; Pilot workload (name the lowest-risk candidate from the inventory); each remaining workload; Decommission. One line of definition of done per phase.)
## Out of scope
(bullets)
## Definition of done
(bullets)

Keep it under 900 words.`;
}

function planPrompt(inv: Inventory, target: string, scope: string): string {
  const phases = /## Phases\s*\n([\s\S]*?)(?=\n## |$)/.exec(scope);
  return `Produce the migration plan, risk register and cost drivers for moving this project to ${targetName(target)}.

INVENTORY
${formatInventory(inv)}
${phases ? `
SCOPE PHASES (use these phase names, in this order)
${phases[1].trim()}
` : ''}
Reply with one JSON object and nothing else, no code fence:
{
  "summary": "three sentences on the shape of the migration and the hardest part",
  "components": [{"component": "name", "today": "how it runs now (from the inventory, or assumed)", "target": "the ${targetName(target)} service", "why": "one clause"}],
  "phases": [{"name": "phase", "work": ["concrete step", "..."], "gate": "what must be true to pass this phase"}],
  "risks": [{"risk": "specific to this inventory", "likelihood": "high|medium|low", "impact": "high|medium|low", "mitigation": "one or two sentences"}],
  "cost_drivers": [{"driver": "what will cost money or save it", "direction": "up|down|same", "note": "why, with the scale (per month, order of magnitude) if it can be reasoned from the inventory"}],
  "open_questions": ["what the team must answer before phase 2"]
}
5 to 8 components, 4 to 6 phases with 3 to 5 steps each, 5 to 8 risks ranked most serious first, 4 to 6 cost drivers, 3 to 5 open questions. Keep every string under 220 characters. No dollar figures unless the inventory supports them; say "order of" when estimating.`;
}

/** Models reach for dashes as separators; the documents use colons. */
export function tidy(text: string): string {
  return text.replace(/\u2014|\u2013/g, ':').replace(/\s+--\s+/g, ': ');
}

function targetName(t: string): string {
  return t === 'aws' ? 'AWS' : t === 'azure' ? 'Azure' : t === 'gcp' ? 'Google Cloud' : t === 'other' ? 'the target environment' : t;
}

export interface Plan {
  summary?: string;
  components?: Array<{ component: string; today: string; target: string; why: string }>;
  phases?: Array<{ name: string; work: string[]; gate: string }>;
  risks?: Array<{ risk: string; likelihood: string; impact: string; mitigation: string }>;
  cost_drivers?: Array<{ driver: string; direction: string; note: string }>;
  open_questions?: string[];
}

export function parsePlan(text: string): Plan {
  const stripped = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('the plan reply held no JSON object');
  return JSON.parse(stripped.slice(start, end + 1)) as Plan;
}

export function renderPlan(scope: string, plan: Plan, inv: Inventory, target: string, when: string): string {
  const out: string[] = [];
  out.push(scope.trim(), '');
  out.push(`# Migration plan: ${inv.project_id} to ${targetName(target)}`, '', `Generated ${when} by cogmemai-mcp ${VERSION} from the repository inventory. Edit freely; the scope above is also stored as the CogmemAi project intent, and \`cogmemai-mcp migrate gate "<phase>"\` reviews work against it.`, '');
  if (plan.summary) out.push('## Summary', '', plan.summary, '');
  if (plan.components?.length) {
    out.push('## Components', '', '| Component | Today | Target | Why |', '|---|---|---|---|');
    for (const c of plan.components) out.push(`| ${c.component} | ${c.today} | ${c.target} | ${c.why} |`);
    out.push('');
  }
  if (plan.phases?.length) {
    out.push('## Phases', '');
    plan.phases.forEach((p, i) => {
      out.push(`### ${i + 1}. ${p.name}`, '');
      for (const w of p.work || []) out.push(`- ${w}`);
      out.push('', `Gate: ${p.gate}`, '', `Run: \`cogmemai-mcp migrate gate "${p.name.replace(/"/g, "'")}"\``, '');
    });
  }
  if (plan.risks?.length) {
    out.push('## Risks', '', '| Risk | Likelihood | Impact | Mitigation |', '|---|---|---|---|');
    for (const r of plan.risks) out.push(`| ${r.risk} | ${r.likelihood} | ${r.impact} | ${r.mitigation} |`);
    out.push('');
  }
  if (plan.cost_drivers?.length) {
    out.push('## Cost drivers', '');
    for (const c of plan.cost_drivers) out.push(`- ${c.driver} (${c.direction}): ${c.note}`);
    out.push('');
  }
  if (plan.open_questions?.length) {
    out.push('## Open questions', '');
    for (const q of plan.open_questions) out.push(`- ${q}`);
    out.push('');
  }
  out.push('## Inventory', '', '```', formatInventory(inv), '```', '');
  return out.join('\n');
}

// ── Assess ────────────────────────────────────────────────────

export interface AssessOptions {
  apiKey: string;
  cwd: string;
  target: string;
  model?: string;
  out?: string;
  force?: boolean;
  rules?: boolean;
  dryRun?: boolean;
  log?: (line: string) => void;
}

export async function assess(opt: AssessOptions): Promise<{ file: string; intent: string; memories: number; rules: string[] }> {
  const log = opt.log || (() => {});
  const target = (opt.target || 'other').toLowerCase();
  const model = opt.model || DEFAULT_MODEL;
  const outFile = opt.out || join(opt.cwd, 'MIGRATION.md');

  log('[1/5] inventory');
  const inv = inventory(opt.cwd);
  log(formatInventory(inv).split('\n').map((l) => '  ' + l).join('\n'));
  if (opt.dryRun) {
    log('Dry run: the inventory above is what would be sent to the gateway (names and counts only). Nothing was written.');
    return { file: outFile, intent: 'skipped', memories: 0, rules: [] };
  }

  const storage = new CloudStorage(opt.apiKey);
  log(`[2/5] scope document (${model})`);
  const scope = tidy(await gatewayChat(opt.apiKey, inv.project_id, model, SYSTEM, scopePrompt(inv, target), 3000));
  log(`[3/5] plan, risks and cost drivers (${model})`);
  const planText = await gatewayChat(opt.apiKey, inv.project_id, model, SYSTEM, planPrompt(inv, target, scope), 4000);
  const plan = parsePlan(tidy(planText));

  const when = new Date().toISOString().slice(0, 10);
  writeFileSync(outFile, renderPlan(scope, plan, inv, target, when), 'utf-8');
  log(`  wrote ${outFile}`);

  log('[4/5] storing the scope as the project intent and the plan as memories');
  let intentState = 'installed';
  try {
    const cur = (await storage.getIntent({ project_id: inv.project_id })) as { exists?: boolean };
    if (cur && cur.exists && !opt.force) {
      intentState = 'kept (the project already has an intent; pass --force to replace it with the migration scope)';
    } else {
      await storage.setIntent({ project_id: inv.project_id, content: scope.trim(), changed_by: 'user' });
      intentState = cur && cur.exists ? 'replaced' : 'installed';
    }
  } catch (e) {
    intentState = `failed (${(e as Error).message})`;
  }
  log(`  intent: ${intentState}`);

  let memories = 0;
  const save = async (body: Record<string, unknown>) => {
    try {
      await storage.saveMemory({ scope: 'project', project_id: inv.project_id, ...body });
      memories++;
    } catch (e) {
      log(`  ! memory ${body.subject}: ${(e as Error).message}`);
    }
  };
  const risks = (plan.risks || []).slice(0, 8);
  await save({
    memory_type: 'decision',
    category: 'infrastructure',
    subject: `migrate_assessment_${target}`,
    importance: 9,
    tags: ['migrate', target, 'assessment'],
    content: `Migration assessment (${when}) for ${inv.project_id} to ${targetName(target)}. ${plan.summary || ''}\nPhases: ${(plan.phases || []).map((p, i) => `${i + 1}. ${p.name} (gate: ${p.gate})`).join('; ')}\nComponents: ${(plan.components || []).map((c) => `${c.component}: ${c.today} -> ${c.target}`).join('; ')}\nOpen questions: ${(plan.open_questions || []).join('; ')}\nFull plan: ${basename(outFile)} in the repository. The scope document is the project intent.`.slice(0, 4000),
  });
  for (let i = 0; i < risks.length; i++) {
    const r = risks[i];
    await save({
      memory_type: 'context',
      category: 'infrastructure',
      subject: `migrate_risk_${i + 1}_${target}`,
      importance: r.impact === 'high' ? 9 : r.impact === 'medium' ? 7 : 5,
      tags: ['migrate', target, 'risk'],
      content: `Migration risk ${i + 1} (${r.likelihood} likelihood, ${r.impact} impact): ${r.risk} Mitigation: ${r.mitigation}`.slice(0, 1500),
    });
  }
  if (plan.cost_drivers?.length) {
    await save({
      memory_type: 'context',
      category: 'infrastructure',
      subject: `migrate_cost_drivers_${target}`,
      importance: 7,
      tags: ['migrate', target, 'cost'],
      content: `Migration cost drivers for ${inv.project_id} to ${targetName(target)} (${when}): ${plan.cost_drivers.map((c) => `${c.driver} (${c.direction}): ${c.note}`).join('; ')}. Write the source's monthly cost baseline next to this before the move and compare after the first full month.`.slice(0, 3000),
    });
  }
  log(`  memories: ${memories} stored`);

  const installed: string[] = [];
  if (opt.rules !== false) {
    log('[5/5] installing rule packs');
    for (const id of ['migrate', target]) {
      const pack = findPack(id);
      if (!pack) continue;
      const r = await installPack(pack, { apiKey: opt.apiKey, cwd: opt.cwd, log: () => {} });
      installed.push(`${id} (${r.installed.length} new, ${r.skipped.length} already present)`);
      log(`  ${id}: ${r.installed.length} new rule${r.installed.length === 1 ? '' : 's'}, ${r.skipped.length} already present${r.failed.length ? `, ${r.failed.length} failed` : ''}`);
    }
    try {
      await syncGuardRules(opt.apiKey, inv.project_id);
    } catch {
      /* next hook run syncs */
    }
  } else {
    log('[5/5] rule packs skipped (--no-rules)');
  }
  return { file: outFile, intent: intentState, memories, rules: installed };
}

// ── Gate ──────────────────────────────────────────────────────

export interface GateOptions {
  apiKey: string;
  cwd: string;
  phase: string;
  notes?: string;
  since?: string;
  log?: (line: string) => void;
}

export interface GateResult {
  passed: boolean;
  coverage: number | null;
  violations: string[];
  uncovered: string[];
  covered: string[];
  summary: string;
  judged: boolean;
  reason?: string;
}

function workDescription(opt: GateOptions): { work: string; files: string[] } {
  const root = git('rev-parse --show-toplevel', opt.cwd) || opt.cwd;
  const since = opt.since || '';
  const parts: string[] = [];
  parts.push(`Migration phase: ${opt.phase}`);
  if (opt.notes) parts.push(`Notes from the team: ${opt.notes}`);
  let files: string[] = [];
  if (git('rev-parse --is-inside-work-tree', root) === 'true') {
    const range = since ? `${since}..HEAD` : '';
    const log = git(`log ${range || '-30'} --format="%cs %s" --no-merges`, root);
    if (log) parts.push(`Commits${since ? ` since ${since}` : ' (last 30)'}:\n${log.split('\n').slice(0, 60).join('\n')}`);
    const stat = git(`diff --stat ${since ? range : 'HEAD~30..HEAD'}`, root) || git('diff --stat', root);
    if (stat) parts.push(`Changed files:\n${stat.split('\n').slice(-80).join('\n')}`);
    files = (git(`diff --name-only ${since ? range : 'HEAD~30..HEAD'}`, root) || git('diff --name-only', root)).split('\n').filter(Boolean).slice(0, 40);
    const dirty = git('status --porcelain', root);
    if (dirty) parts.push(`Uncommitted:\n${dirty.split('\n').slice(0, 40).join('\n')}`);
  }
  const plan = join(root, 'MIGRATION.md');
  if (existsSync(plan)) {
    const t = readText(plan, 60_000);
    const m = new RegExp(`###\\s*\\d+\\.\\s*${opt.phase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*\\n([\\s\\S]*?)(?=\\n###|\\n## |$)`, 'i').exec(t);
    if (m) parts.push(`Planned work for this phase (from MIGRATION.md):\n${m[1].trim().slice(0, 3000)}`);
  }
  return { work: parts.join('\n\n').slice(0, 24_000), files };
}

export async function gate(opt: GateOptions): Promise<GateResult> {
  const storage = new CloudStorage(opt.apiKey);
  const projectId = projectIdFor(opt.cwd);
  const { work, files } = workDescription(opt);
  const r = (await storage.intentCheck({ project_id: projectId, work, files })) as {
    judged?: boolean;
    reason?: string;
    summary?: string;
    covered?: string[];
    uncovered?: string[];
    violations?: Array<{ rule?: string; evidence?: string; text?: string } | string>;
    coverage?: number | null;
  };
  const violations = (r.violations || []).map((v) => (typeof v === 'string' ? v : [v.rule, v.evidence || v.text].filter(Boolean).join(': ')));
  const coverage = typeof r.coverage === 'number' ? r.coverage : null;
  const judged = !!r.judged;
  const passed = judged && coverage !== null && coverage >= 80 && violations.length === 0;
  const result: GateResult = { passed, coverage, violations, uncovered: r.uncovered || [], covered: r.covered || [], summary: r.summary || '', judged, reason: r.reason };
  const when = new Date().toISOString().slice(0, 16).replace('T', ' ');
  try {
    await storage.saveMemory({
      scope: 'project',
      project_id: projectId,
      memory_type: 'context',
      category: 'infrastructure',
      subject: `migrate_gate_${opt.phase.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60)}`,
      importance: passed ? 7 : 9,
      tags: ['migrate', 'gate', passed ? 'passed' : 'failed'],
      content: `Migration gate "${opt.phase}" ${passed ? 'PASSED' : judged ? 'FAILED' : 'NOT JUDGED'} on ${when}: coverage ${coverage === null ? 'n/a' : coverage}, ${violations.length} violation${violations.length === 1 ? '' : 's'}.${result.summary ? ` ${result.summary}` : ''}${violations.length ? ` Violations: ${violations.join(' | ')}` : ''}${result.uncovered.length ? ` Uncovered: ${result.uncovered.join(' | ')}` : ''}${!judged && r.reason ? ` Reason: ${r.reason}` : ''}`.slice(0, 3000),
    });
  } catch {
    /* the gate result is still printed */
  }
  return result;
}

// ── CLI ───────────────────────────────────────────────────────

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : '';
}

export async function runMigrateCli(args: string[], resolveKey: () => string): Promise<void> {
  const sub = (args[0] || 'help').toLowerCase();
  const usage = () => {
    console.log('Usage:');
    console.log('  cogmemai-mcp migrate assess [--target aws|azure|gcp|other] [--path DIR] [--out FILE] [--model ID] [--force] [--no-rules] [--dry-run]');
    console.log('  cogmemai-mcp migrate gate "<phase>" [--notes "..."] [--since REF]');
    console.log('  cogmemai-mcp migrate status');
    console.log('');
    console.log('assess inventories the repository (names and counts only leave the machine), writes the migration scope as the');
    console.log('project intent, the plan and risks as memories and MIGRATION.md, and installs the migrate and target cloud packs.');
    console.log('gate reviews a phase against the scope: it passes with coverage 80 or more and no violations.');
  };

  if (sub === 'help' || sub === '--help' || sub === '-h') return usage();

  if (sub === 'inventory') {
    const cwd = flag(args, '--path') || process.cwd();
    console.log(formatInventory(inventory(cwd)));
    return;
  }

  const key = resolveKey();
  if (!key) {
    console.error('No CogmemAi API key found. Run `npx cogmemai-mcp setup` first.');
    process.exit(1);
  }

  if (sub === 'assess') {
    const target = (flag(args, '--target') || 'other').toLowerCase();
    if (!['aws', 'azure', 'gcp', 'other'].includes(target)) {
      console.error(`Unknown target "${target}". Use aws, azure, gcp or other.`);
      process.exit(1);
    }
    const cwd = flag(args, '--path') || process.cwd();
    const r = await assess({
      apiKey: key,
      cwd,
      target,
      model: flag(args, '--model') || undefined,
      out: flag(args, '--out') || undefined,
      force: args.includes('--force'),
      rules: !args.includes('--no-rules'),
      dryRun: args.includes('--dry-run'),
      log: (l) => console.log(l),
    });
    if (!args.includes('--dry-run')) {
      console.log('');
      console.log(`Done. Plan: ${r.file}. Intent: ${r.intent}. Memories: ${r.memories}.${r.rules.length ? ` Packs: ${r.rules.join(', ')}.` : ''}`);
      console.log('Next: read MIGRATION.md, answer the open questions, then after each phase run: cogmemai-mcp migrate gate "<phase>"');
    }
    return;
  }

  if (sub === 'gate') {
    const phase = args.slice(1).find((a) => !a.startsWith('--') && a !== flag(args, '--notes') && a !== flag(args, '--since')) || '';
    if (!phase) {
      console.error('Name the phase: cogmemai-mcp migrate gate "Pilot workload"');
      process.exit(1);
    }
    console.log(`Reviewing phase "${phase}" against the migration scope...`);
    const r = await gate({ apiKey: key, cwd: process.cwd(), phase, notes: flag(args, '--notes') || undefined, since: flag(args, '--since') || undefined });
    if (!r.judged) {
      console.log(`Not judged${r.reason ? `: ${r.reason}` : ''}. The gate needs a project intent (run migrate assess) and a paid tier for the judged review.`);
      process.exit(2);
    }
    console.log('');
    console.log(`${r.passed ? 'PASSED' : 'FAILED'}: coverage ${r.coverage}, ${r.violations.length} violation${r.violations.length === 1 ? '' : 's'}`);
    if (r.summary) console.log(`  ${r.summary}`);
    for (const v of r.violations) console.log(`  violation: ${v}`);
    for (const u of r.uncovered) console.log(`  uncovered: ${u}`);
    if (!r.passed) {
      console.log('');
      console.log('A phase passes with coverage 80 or more and no violations. Do the uncovered work, fix the violations, run the gate again.');
      process.exit(1);
    }
    return;
  }

  if (sub === 'status') {
    const storage = new CloudStorage(key);
    const projectId = projectIdFor(process.cwd());
    const data = (await storage.listMemories({ project_id: projectId, limit: 100, tags: 'migrate' })) as { memories?: Array<{ subject?: string; content?: string; created_at?: string }> };
    const mems = (data.memories || []).filter((m) => typeof m.subject === 'string' && m.subject.startsWith('migrate_'));
    if (!mems.length) {
      console.log(`No migration memories for ${projectId}. Start with: cogmemai-mcp migrate assess --target aws`);
      return;
    }
    const by = (prefix: string) => mems.filter((m) => (m.subject || '').startsWith(prefix));
    for (const m of by('migrate_assessment')) console.log(`Assessment (${(m.created_at || '').slice(0, 10)}): ${(m.content || '').split('\n')[0]}`);
    const gates = by('migrate_gate');
    console.log(`Gates: ${gates.length}`);
    for (const g of gates) console.log(`  ${(g.created_at || '').slice(0, 10)} ${(g.content || '').split('.')[0]}`);
    const risks = by('migrate_risk');
    console.log(`Risks on record: ${risks.length}`);
    for (const r of risks) console.log(`  ${(r.content || '').slice(0, 160)}`);
    return;
  }

  usage();
}
