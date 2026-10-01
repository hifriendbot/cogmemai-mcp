/**
 * Rule packs: ready-made sets of rules that install into CogmemAi with one command.
 *
 *   cogmemai-mcp rules list
 *   cogmemai-mcp rules show devsecops
 *   cogmemai-mcp rules install devsecops [--global] [--intent] [--dry-run]
 *
 * Each rule is an ordinary rule memory. The first sentence is the rule in plain words
 * (it is what the guard quotes when it blocks something). A `GUARD: <regex>` line makes the
 * rule enforceable on shell commands before they run; rules with no shell shape carry
 * `GUARD: off` so the derivation pass never guesses a pattern from their prose. The judged
 * guard_check and the end-of-turn review read the whole text.
 */

import { CloudStorage } from './storage-cloud.js';
import { syncGuardRules, projectIdFor } from './guard-hooks.js';
import { API_BASE, VERSION, HOOK_FETCH_TIMEOUT_MS } from './config.js';

export interface PackRule {
  subject: string;
  category: string;
  tags: string[];
  content: string;
}

export interface RulePack {
  id: string;
  name: string;
  description: string;
  rules: PackRule[];
  /** Markdown intent document template, installed with --intent when the project has none. */
  intent: string;
}

const G = (re: string) => `GUARD: ${re}`;

const DEVSECOPS: RulePack = {
  id: 'devsecops',
  name: 'DevSecOps',
  description: 'Secrets, infrastructure as code, least privilege, CI/CD gates, change control, data, logging, incident response, and the rules an Ai agent on your infrastructure must obey.',
  rules: [
    // ── Secrets ──────────────────────────────────────────
    {
      subject: 'secrets_never_commit',
      category: 'security',
      tags: ['devsecops', 'secrets'],
      content: `NEVER commit a secret, key file or credential to version control. Private keys, certificates, .env files and tokens stay out of git; a secret that was ever committed counts as leaked even after a revert, so rotate it.
${G('git\\s+(add|commit)\\b[^|]*\\.(env|pem|key|p12|pfx|jks|keystore)\\b')}
${G('\\b(AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9_-]{20,}|xox[abp]-[A-Za-z0-9-]{10,})\\b')}`,
    },
    {
      subject: 'secrets_not_on_command_line',
      category: 'security',
      tags: ['devsecops', 'secrets'],
      content: `NEVER put a secret on a command line or in a file inside the repository. Shell history, process lists and CI logs capture command lines. Read secrets at runtime from the secret manager or an injected environment that is not checked in.
${G('\\b(export|set|setx)\\s+\\w*(SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY)\\w*=\\S{8,}')}`,
    },
    {
      subject: 'secrets_never_printed',
      category: 'security',
      tags: ['devsecops', 'secrets', 'logging'],
      content: `NEVER print, echo, cat or log a secret, even to debug. Redact tokens, passwords and keys in every log line and error message. If you must prove a secret is set, print its length or a hash, not the value.
${G('\\b(echo|printf|cat|less|more)\\b[^|]*\\$\\{?\\w*(SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY)')}`,
    },
    {
      subject: 'secrets_rotate_on_exposure',
      category: 'security',
      tags: ['devsecops', 'secrets', 'incident'],
      content: `If a secret appears in a log, a chat, a diff, a ticket or a screenshot, treat it as exposed: rotate it first and clean up the exposure second. Record the rotation in the incident log. Do not argue about whether anyone saw it.
GUARD: off`,
    },
    {
      subject: 'secrets_manager_only',
      category: 'security',
      tags: ['devsecops', 'secrets'],
      content: `Secrets live only in the approved secret manager (Vault, AWS Secrets Manager, GCP Secret Manager or Azure Key Vault). Never in Slack, tickets, wikis, spreadsheets, shared drives or committed .env files. Applications fetch secrets at start or via injected environment, and every secret has an owner and a rotation date.
GUARD: off`,
    },
    {
      subject: 'secrets_scanning_mandatory',
      category: 'security',
      tags: ['devsecops', 'secrets', 'cicd'],
      content: `Secret scanning runs on every commit and every pipeline, and NEVER gets bypassed. Pre-commit hooks and CI jobs that scan for keys (gitleaks, trufflehog or the platform scanner) are part of the definition of done; skipping hooks with --no-verify is not allowed.
${G('git\\s+(commit|push)\\b[^|]*--no-verify')}`,
    },

    // ── Infrastructure as code ──────────────────────────
    {
      subject: 'iac_only_no_console_changes',
      category: 'backend',
      tags: ['devsecops', 'iac', 'change'],
      content: `Infrastructure changes go through infrastructure as code and a reviewed change; NEVER create or modify cloud resources by hand in a console or with ad-hoc create commands. Anything built outside code is undocumented, unreviewed and will be destroyed by the next apply.
${G('aws\\s+(ec2\\s+run-instances|iam\\s+create-(role|user|policy)|s3api\\s+create-bucket|rds\\s+create-db-instance|lambda\\s+create-function)\\b')}
${G('gcloud\\s+(compute\\s+instances\\s+create|sql\\s+instances\\s+create|iam\\s+service-accounts\\s+create)\\b')}
${G('az\\s+(vm|group|storage\\s+account|sql\\s+server)\\s+create\\b')}`,
    },
    {
      subject: 'iac_plan_then_review_then_apply',
      category: 'backend',
      tags: ['devsecops', 'iac', 'change'],
      content: `ALWAYS produce a plan and have it reviewed before an apply, and NEVER auto-approve an apply from a laptop or an agent session. terraform plan output (or the equivalent preview) is attached to the change; the apply runs from CI after approval.
${G('terraform\\s+(apply|destroy)\\b[^|]*-auto-approve')}
${G('pulumi\\s+(up|destroy)\\b[^|]*(--yes|-y)\\b')}`,
    },
    {
      subject: 'iac_never_destroy_production',
      category: 'backend',
      tags: ['devsecops', 'iac'],
      content: `NEVER run a destroy against a production workspace or stack. Decommissioning production infrastructure is a planned change with a backup, a rollback and a named approver, not a command.
${G('terraform\\s+destroy\\b')}
${G('pulumi\\s+destroy\\b')}
${G('cdk\\s+destroy\\b')}`,
    },
    {
      subject: 'iac_state_is_remote_locked_untouched',
      category: 'backend',
      tags: ['devsecops', 'iac'],
      content: `Infrastructure state is stored remotely, encrypted and locked, and is NEVER edited by hand. No manual state surgery, no force-unlock without the person who holds the lock, no state files in git.
${G('terraform\\s+state\\s+(rm|mv|push|replace-provider)\\b')}
${G('terraform\\s+force-unlock\\b')}`,
    },
    {
      subject: 'iac_pin_versions',
      category: 'backend',
      tags: ['devsecops', 'iac', 'supply-chain'],
      content: `Pin every provider, module, base image and action to a specific version or digest. No floating tags: no latest, no unpinned major versions, no branch references in module sources. Upgrades are deliberate changes with a diff, not surprises on the next run.
GUARD: off`,
    },
    {
      subject: 'iac_required_tags',
      category: 'backend',
      tags: ['devsecops', 'iac', 'cost'],
      content: `Every cloud resource carries the required tags: owner, environment, service and cost center. Untagged resources are rejected by policy checks in the pipeline. Tags are how incidents find an owner and how the bill finds a budget.
GUARD: off`,
    },

    // ── Identity and access ──────────────────────────────
    {
      subject: 'iam_least_privilege',
      category: 'security',
      tags: ['devsecops', 'iam'],
      content: `Grant the least privilege that does the job and NEVER attach administrator or wildcard policies to a user, role, service account or agent. Scope every permission to the actions and resources actually used, and expire anything temporary.
${G('aws\\s+iam\\s+attach-(user|role|group)-policy\\b[^|]*AdministratorAccess')}
${G('gcloud\\s+projects\\s+add-iam-policy-binding\\b[^|]*roles/(owner|editor)\\b')}
${G('az\\s+role\\s+assignment\\s+create\\b[^|]*(Owner|Contributor)\\b')}`,
    },
    {
      subject: 'iam_no_long_lived_keys',
      category: 'security',
      tags: ['devsecops', 'iam', 'secrets'],
      content: `No long-lived access keys for people or automation. Humans use SSO with MFA, workloads use roles or workload identity, CI uses OIDC federation, and anything that must have a static key gets a rotation date under 90 days.
${G('aws\\s+iam\\s+create-access-key\\b')}
${G('gcloud\\s+iam\\s+service-accounts\\s+keys\\s+create\\b')}`,
    },
    {
      subject: 'iam_agents_get_their_own_scoped_identity',
      category: 'security',
      tags: ['devsecops', 'iam', 'agents'],
      content: `An Ai coding agent runs under its own identity with scoped, expiring, mostly read-only credentials. NEVER give an agent production admin, a human's personal credentials, or a key that outlives the task. Everything the agent does is attributable to the agent, not to the person who started it.
GUARD: off`,
    },
    {
      subject: 'iam_nothing_public_by_accident',
      category: 'security',
      tags: ['devsecops', 'iam', 'data'],
      content: `NEVER make a bucket, object, database, snapshot or queue publicly readable or writable. Public access blocks stay on at the account level; anything that must be public goes through the CDN with a reviewed change.
${G('\\bs3(api)?\\b[^|]*--acl\\s+public-read(-write)?\\b')}
${G('s3api\\s+put-public-access-block\\b[^|]*(BlockPublicAcls|BlockPublicPolicy|IgnorePublicAcls|RestrictPublicBuckets)=false')}
${G('gsutil\\s+(iam\\s+ch|acl\\s+ch)\\b[^|]*allUsers')}
${G('aws\\s+(rds|ec2)\\s+modify-(db-)?snapshot-attribute\\b[^|]*--values-to-add\\s+all\\b')}`,
    },
    {
      subject: 'network_no_open_ingress',
      category: 'security',
      tags: ['devsecops', 'network'],
      content: `NEVER open a security group, firewall rule or network ACL to the whole internet on anything except ports 80 and 443 at the edge. Administrative ports (SSH, RDP, database ports) are reachable only through the bastion, the VPN or an identity-aware proxy.
${G('authorize-security-group-ingress\\b[^|]*0\\.0\\.0\\.0/0')}
${G('gcloud\\s+compute\\s+firewall-rules\\s+(create|update)\\b[^|]*0\\.0\\.0\\.0/0')}
${G('az\\s+network\\s+nsg\\s+rule\\s+(create|update)\\b[^|]*(0\\.0\\.0\\.0/0|Internet|\\*)')}`,
    },
    {
      subject: 'iam_mfa_and_no_root_use',
      category: 'security',
      tags: ['devsecops', 'iam'],
      content: `MFA is required on every console, source control account, CI system and registry, and the root or owner account is NEVER used for daily work. Root credentials sit behind hardware keys in a sealed break-glass procedure that is logged and alerted on when used.
GUARD: off`,
    },
    {
      subject: 'access_reviews_and_same_day_offboarding',
      category: 'security',
      tags: ['devsecops', 'iam', 'compliance'],
      content: `Access is reviewed every 90 days and revoked the same day someone leaves or changes role. Every account, key, token and agent identity has a named owner; ownerless access is removed, not inherited.
GUARD: off`,
    },

    // ── CI/CD and supply chain ───────────────────────────
    {
      subject: 'cicd_security_gates_block_merge',
      category: 'backend',
      tags: ['devsecops', 'cicd'],
      content: `Every pipeline runs static analysis, dependency scanning, container scanning and secret scanning, and critical or high findings MUST block the merge. Findings are fixed or formally accepted with an owner and an expiry date, never silenced in bulk.
GUARD: off`,
    },
    {
      subject: 'cicd_never_bypass_protections',
      category: 'backend',
      tags: ['devsecops', 'cicd', 'change'],
      content: `NEVER bypass branch protection: no force push to a protected branch, no admin merge over failing checks, no deleting a required check to get green. If a check is wrong, fix the check in its own reviewed change.
${G('git\\s+push\\b[^|]*(--force|--force-with-lease|-f)\\b[^|]*\\b(main|master|prod|production|release|develop)\\b')}
${G('gh\\s+pr\\s+merge\\b[^|]*--admin\\b')}`,
    },
    {
      subject: 'change_every_production_change_is_reviewed',
      category: 'backend',
      tags: ['devsecops', 'change'],
      content: `Every change to production ships through a pull request reviewed by a human who did not write it. Ai agents open pull requests; they NEVER merge them, approve them, or push straight to a deployable branch.
GUARD: off`,
    },
    {
      subject: 'change_backup_rollback_verify',
      category: 'backend',
      tags: ['devsecops', 'change'],
      content: `Before touching a live system, take a dated backup, write down the rollback, and after the change verify the thing you changed and one thing you did not. A change without a known rollback is not ready; a change nobody verified is not done.
GUARD: off`,
    },
    {
      subject: 'change_freeze_and_on_call',
      category: 'backend',
      tags: ['devsecops', 'change'],
      content: `No production deploys during a declared freeze, and no deploys outside business hours unless the on-call engineer is awake, informed and able to roll back. Emergency changes get a ticket within the hour and a review the next business day.
GUARD: off`,
    },
    {
      subject: 'supply_chain_no_piped_installers',
      category: 'security',
      tags: ['devsecops', 'supply-chain'],
      content: `NEVER pipe a download straight into a shell or interpreter, and never install from an unpinned URL. Download it, read it, verify the checksum or signature, then run it. Lockfiles are committed and dependencies come from the approved registry or mirror.
${G('\\b(curl|wget)\\b[^|]*\\|\\s*(sudo\\s+)?(ba|z|da)?sh\\b')}
${G('\\b(curl|wget)\\b[^|]*\\|\\s*(sudo\\s+)?(python3?|node|perl|ruby)\\b')}`,
    },
    {
      subject: 'containers_hardened',
      category: 'backend',
      tags: ['devsecops', 'containers'],
      content: `Containers run as a non-root user from an approved, pinned base image, with no privileged mode, no host network, and no secrets baked into layers. Images are scanned before they are pushed and rebuilt when the base image patches.
${G('docker\\s+run\\b[^|]*--privileged\\b')}
${G('docker\\s+run\\b[^|]*--network[= ]host\\b')}`,
    },
    {
      subject: 'kubernetes_no_cluster_admin_for_workloads',
      category: 'security',
      tags: ['devsecops', 'kubernetes', 'iam'],
      content: `NEVER bind cluster-admin to a workload, a service account or an agent. Workloads get a namespaced role with the verbs they use; admission policy rejects privileged pods, host mounts and wildcard RBAC.
${G('kubectl\\s+create\\s+clusterrolebinding\\b[^|]*cluster-admin')}
${G('kubectl\\s+create\\s+rolebinding\\b[^|]*--clusterrole[= ]cluster-admin')}`,
    },
    {
      subject: 'kubernetes_production_is_not_a_laptop_target',
      category: 'backend',
      tags: ['devsecops', 'kubernetes', 'change'],
      content: `Destructive actions against a production cluster NEVER run from a laptop or an agent session: deleting namespaces or nodes, draining nodes, scaling to zero, or editing live objects by hand. Production changes go through the pipeline with a reviewed manifest.
${G('kubectl\\s+delete\\s+(ns|namespace|node|pv|persistentvolume)s?\\b')}
${G('kubectl\\s+(drain|cordon)\\b')}
${G('kubectl\\s+scale\\b[^|]*--replicas[= ]0\\b')}`,
    },

    // ── Data ─────────────────────────────────────────────
    {
      subject: 'data_encrypted_everywhere',
      category: 'security',
      tags: ['devsecops', 'data'],
      content: `Data is encrypted at rest with managed keys and in transit with TLS 1.2 or newer; TLS 1.0 and 1.1 and plain HTTP endpoints are not allowed anywhere, including internal services and health checks. Key rotation is automatic and logged.
GUARD: off`,
    },
    {
      subject: 'data_no_production_copies',
      category: 'security',
      tags: ['devsecops', 'data', 'privacy'],
      content: `NEVER copy production data to a laptop, a development environment, an Ai agent's context, or a ticket. Development and test use masked or synthetic fixtures. Debugging against real data happens in production tooling with audit logging, never by exporting it.
${G('\\b(pg_dump|mysqldump|mongodump)\\b[^|]*\\b(prod|production)\\b')}
${G('aws\\s+s3\\s+(cp|sync)\\s+s3://[^\\s]*\\b(prod|production)\\b[^|]*\\s+(\\.|~|/)')}`,
    },
    {
      subject: 'data_destructive_sql_only_through_migrations',
      category: 'backend',
      tags: ['devsecops', 'data', 'change'],
      content: `NEVER run DROP, TRUNCATE, or a DELETE or UPDATE without a WHERE clause against a production database from a shell. Schema and data changes ship as reviewed, reversible migrations with a backup taken first.
${G('\\b(psql|mysql|mariadb|sqlcmd)\\b[^|]*-e\\s*[\'"]?\\s*(DROP|TRUNCATE)\\b')}
${G('\\b(psql|mysql|mariadb|sqlcmd)\\b[^|]*-e\\s*[\'"]?\\s*(DELETE\\s+FROM|UPDATE)\\s+\\w+\\s*[\'"]?\\s*$')}`,
    },
    {
      subject: 'data_minimize_and_retain_by_policy',
      category: 'security',
      tags: ['devsecops', 'data', 'privacy', 'compliance'],
      content: `Collect only the personal data the product needs, keep it only as long as the retention policy says, and delete it on schedule. New fields that hold personal or regulated data (health, payment, identity) need a data owner and a retention entry before they ship.
GUARD: off`,
    },

    // ── Logging and monitoring ───────────────────────────
    {
      subject: 'logs_central_immutable_never_disabled',
      category: 'backend',
      tags: ['devsecops', 'logging'],
      content: `Audit logs (cloud API trails, authentication, admin actions) flow to a central store that is immutable, retained at least one year, and NEVER disabled, even briefly, even to save money. Turning off a trail is an incident.
${G('aws\\s+cloudtrail\\s+(stop-logging|delete-trail|update-trail\\b[^|]*--no-is-multi-region-trail)')}
${G('gcloud\\s+logging\\s+sinks\\s+(delete|update)\\b')}
${G('az\\s+monitor\\s+diagnostic-settings\\s+delete\\b')}`,
    },
    {
      subject: 'logs_never_contain_secrets_or_personal_data',
      category: 'security',
      tags: ['devsecops', 'logging', 'privacy'],
      content: `Logs never contain secrets, tokens, session identifiers, card numbers, health data or other personal data. Structured logging with an allow-list of fields beats free-text logging of request bodies. Redaction is tested, not assumed.
GUARD: off`,
    },
    {
      subject: 'monitoring_alerts_on_security_signals',
      category: 'backend',
      tags: ['devsecops', 'logging', 'monitoring'],
      content: `Alerts fire, and someone owns them, for: repeated authentication failures, IAM and policy changes, new public exposure, disabled logging, root or break-glass use, and cost spikes. An alert with no owner is removed; an alert that pages for nothing is tuned the same week.
GUARD: off`,
    },

    // ── Incident response ────────────────────────────────
    {
      subject: 'incident_declare_early',
      category: 'general',
      tags: ['devsecops', 'incident'],
      content: `When something looks like a security incident, declare it immediately with a severity, an incident commander and a communications owner; NEVER wait for certainty and never hide it. Downgrading a false alarm is cheap; a late declaration is not.
GUARD: off`,
    },
    {
      subject: 'incident_contain_then_preserve_evidence',
      category: 'security',
      tags: ['devsecops', 'incident'],
      content: `Contain first (rotate credentials, revoke sessions, isolate the host), then preserve evidence: snapshot disks, export logs and record timelines BEFORE remediation. NEVER wipe, rebuild or terminate a suspected-compromised host until it is imaged.
GUARD: off`,
    },
    {
      subject: 'incident_blameless_postmortem',
      category: 'general',
      tags: ['devsecops', 'incident'],
      content: `Every incident gets a blameless postmortem within five business days: timeline, impact, root causes, and tracked action items with owners and dates. The review targets the system that let the mistake through, never the person who made it.
GUARD: off`,
    },
    {
      subject: 'incident_regulatory_clock',
      category: 'general',
      tags: ['devsecops', 'incident', 'compliance'],
      content: `If an incident may involve personal, health, payment or customer data, notify legal and the privacy owner the same day. Regulations and contracts start clocks (often 72 hours) from discovery, not from the end of the investigation.
GUARD: off`,
    },

    // ── Ai agents on infrastructure ──────────────────────
    {
      subject: 'agents_guard_before_review_after',
      category: 'general',
      tags: ['devsecops', 'agents'],
      content: `An Ai agent working on infrastructure, data or access MUST call guard_check before any action that is hard to undo and review_work after the work, stop on any deny, and ask a human on any ask. Agents open changes for review; they never approve, merge or deploy their own work, and they never disable or bypass the guard.
GUARD: off`,
    },
  ],
  intent: `# Project intent: platform and security

## Purpose
This project runs and secures the production platform. Changes must keep production available, keep data inside policy, and leave an audit trail a reviewer can follow.

## Invariants
- NEVER commit, print or log a secret; every secret comes from the secret manager.
- NEVER change production infrastructure outside infrastructure as code and a reviewed change.
- NEVER grant administrator or wildcard access; every permission is scoped and expiring.
- NEVER expose a bucket, database, snapshot or admin port to the internet.
- NEVER copy production data to development, a laptop or an agent's context.
- MUST take a dated backup and write down the rollback before touching a live system, and verify afterward.
- MUST keep audit logging on, central and immutable.
- MUST treat any exposed credential as compromised and rotate it first.
- MUST open a pull request for every production change; a human merges it.

## Out of scope
- Application feature work (owned by the product teams).
- Cost optimization that trades away a security control.
- Anything that needs a policy exception; exceptions go through the security owner, not through this project.

## Definition of done
- Plan reviewed, applied from CI, verified in production, tagged, logged, documented in the runbook.
`,
};

export const PACKS: RulePack[] = [DEVSECOPS];

export function findPack(id: string): RulePack | undefined {
  return PACKS.find((p) => p.id === id.toLowerCase());
}

/** Every pack must be installable and enforceable; this is what the test suite checks. */
export function validatePack(pack: RulePack): string[] {
  const problems: string[] = [];
  const subjects = new Set<string>();
  for (const r of pack.rules) {
    if (subjects.has(r.subject)) problems.push(`duplicate subject ${r.subject}`);
    subjects.add(r.subject);
    if (!/^[a-z][a-z0-9_]{3,99}$/.test(r.subject)) problems.push(`bad subject ${r.subject}`);
    if (r.content.length < 40 || r.content.length > 1200) problems.push(`${r.subject}: content length ${r.content.length}`);
    if (/[\u2014\u2013]/.test(r.content)) problems.push(`${r.subject}: em or en dash`);
    const guards = r.content.split('\n').filter((l) => /^GUARD:/i.test(l));
    if (guards.length === 0) problems.push(`${r.subject}: no GUARD line (use GUARD: off for prose-only rules)`);
    for (const g of guards) {
      const pattern = g.replace(/^GUARD:\s*/i, '').trim();
      if (/^(off|none)$/i.test(pattern)) continue;
      try {
        new RegExp(pattern, 'i');
      } catch (e) {
        problems.push(`${r.subject}: bad regex ${pattern}: ${(e as Error).message}`);
      }
    }
  }
  if (/[\u2014\u2013]/.test(pack.intent)) problems.push('intent: em or en dash');
  return problems;
}

async function fetchRuleSubjects(apiKey: string, params: Record<string, string>): Promise<Set<string>> {
  const qs = new URLSearchParams({ memory_type: 'rule', limit: '100', ...params }).toString();
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), HOOK_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}/cogmemai/memories?${qs}`, {
      headers: { Authorization: `Bearer ${apiKey}`, 'User-Agent': `cogmemai-mcp/${VERSION}` },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from /cogmemai/memories`);
    const data = (await res.json()) as { memories?: Array<Record<string, unknown>> };
    const out = new Set<string>();
    for (const m of data.memories || []) if (typeof m.subject === 'string' && m.subject) out.add(m.subject);
    return out;
  } finally {
    clearTimeout(t);
  }
}

export interface InstallOptions {
  apiKey: string;
  cwd: string;
  global?: boolean;
  withIntent?: boolean;
  dryRun?: boolean;
  log?: (line: string) => void;
}

export interface InstallResult {
  projectId: string;
  scope: 'global' | 'project';
  installed: string[];
  skipped: string[];
  failed: Array<{ subject: string; error: string }>;
  intent: 'installed' | 'kept' | 'skipped' | 'failed';
}

/** Install a pack as rule memories, skipping rules the account already has (by subject), then refresh the guard cache. */
export async function installPack(pack: RulePack, opt: InstallOptions): Promise<InstallResult> {
  const log = opt.log || (() => {});
  const scope: 'global' | 'project' = opt.global ? 'global' : 'project';
  const projectId = projectIdFor(opt.cwd);
  const result: InstallResult = { projectId, scope, installed: [], skipped: [], failed: [], intent: 'skipped' };

  const existing = await fetchRuleSubjects(opt.apiKey, scope === 'global' ? { scope: 'global' } : { project_id: projectId });
  const storage = new CloudStorage(opt.apiKey);

  for (const r of pack.rules) {
    if (existing.has(r.subject)) {
      result.skipped.push(r.subject);
      continue;
    }
    if (opt.dryRun) {
      result.installed.push(r.subject);
      continue;
    }
    try {
      await storage.saveMemory({
        content: r.content,
        memory_type: 'rule',
        category: r.category,
        subject: r.subject,
        importance: 10,
        scope,
        project_id: projectId,
        tags: r.tags.slice(0, 5),
      });
      result.installed.push(r.subject);
      log(`  + ${r.subject}`);
    } catch (e) {
      result.failed.push({ subject: r.subject, error: (e as Error).message });
      log(`  ! ${r.subject}: ${(e as Error).message}`);
    }
  }

  if (opt.withIntent) {
    try {
      const cur = (await storage.getIntent({ project_id: projectId })) as { exists?: boolean };
      if (cur && cur.exists) {
        result.intent = 'kept';
      } else if (opt.dryRun) {
        result.intent = 'installed';
      } else {
        await storage.setIntent({ project_id: projectId, content: pack.intent, changed_by: 'user' });
        result.intent = 'installed';
      }
    } catch (e) {
      result.intent = 'failed';
      log(`  ! intent: ${(e as Error).message}`);
    }
  }

  if (!opt.dryRun) {
    try {
      await syncGuardRules(opt.apiKey, projectId);
    } catch {
      /* the next hook run syncs anyway */
    }
  }
  return result;
}

// ── CLI ───────────────────────────────────────────────────────

export async function runRulesCli(args: string[], resolveKey: () => string): Promise<void> {
  const sub = (args[0] || 'list').toLowerCase();

  if (sub === 'list') {
    console.log('Rule packs:');
    for (const p of PACKS) console.log(`  ${p.id.padEnd(12)} ${p.rules.length} rules   ${p.description}`);
    console.log('\nInstall one: cogmemai-mcp rules install <pack> [--global] [--intent] [--dry-run]');
    return;
  }

  const pack = findPack(args[1] || '');
  if ((sub === 'show' || sub === 'install') && !pack) {
    console.error(`Unknown pack "${args[1] || ''}". Run: cogmemai-mcp rules list`);
    process.exit(1);
  }

  if (sub === 'show' && pack) {
    console.log(`${pack.name} pack: ${pack.rules.length} rules\n`);
    for (const r of pack.rules) {
      const guards = r.content.split('\n').filter((l) => /^GUARD:/i.test(l) && !/^GUARD:\s*off/i.test(l)).length;
      console.log(`- ${r.subject} [${r.category}]${guards ? ` (${guards} shell pattern${guards === 1 ? '' : 's'})` : ''}`);
      console.log(`  ${r.content.split('\n')[0]}`);
    }
    console.log('\nIntent template (installed with --intent when the project has none):\n');
    console.log(pack.intent);
    return;
  }

  if (sub === 'install' && pack) {
    const key = resolveKey();
    if (!key) {
      console.error('No CogmemAi API key found. Run `npx cogmemai-mcp setup` first.');
      process.exit(1);
    }
    const global = args.includes('--global');
    const withIntent = args.includes('--intent');
    const dryRun = args.includes('--dry-run');
    const cwd = process.cwd();
    console.log(`${dryRun ? 'Dry run: ' : ''}installing the ${pack.name} pack ${global ? 'globally (every project)' : `for project ${projectIdFor(cwd)}`}${withIntent ? ', with the intent document' : ''}`);
    const r = await installPack(pack, { apiKey: key, cwd, global, withIntent, dryRun, log: (l) => console.log(l) });
    console.log('');
    console.log(`${dryRun ? 'Would install' : 'Installed'} ${r.installed.length} rule${r.installed.length === 1 ? '' : 's'}, skipped ${r.skipped.length} already present${r.failed.length ? `, ${r.failed.length} failed` : ''}.`);
    if (withIntent) console.log(`Intent document: ${r.intent === 'kept' ? 'kept the one the project already has' : r.intent}.`);
    if (!dryRun && r.installed.length) {
      console.log('Guard cache refreshed. Shell patterns block before a command runs; the judged guard_check and the end-of-turn review read the full rules.');
      console.log('Try it: cogmemai-mcp guard test "terraform destroy -auto-approve"');
    }
    if (r.failed.length) process.exit(1);
    return;
  }

  console.log('Usage: cogmemai-mcp rules list | show <pack> | install <pack> [--global] [--intent] [--dry-run]');
}
