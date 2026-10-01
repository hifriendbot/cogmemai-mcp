/**
 * Cloud and migration rule packs: aws, azure, gcp and migrate.
 *
 * Same shape as the DevSecOps pack. A rule that says NEVER denies the matching shell
 * command outright; a rule without a prohibition word asks first. Rules with no shell
 * shape carry `GUARD: off`. The per-cloud packs cover naming, access, networking, storage,
 * cost, data residency, backups and logging in that cloud's own CLI; the migrate pack
 * covers the process of moving workloads: inventory, scope, phases, verification, cutover,
 * rollback and decommission. Install the cloud pack for the target plus migrate:
 *
 *   cogmemai-mcp rules install aws
 *   cogmemai-mcp rules install migrate --intent
 *
 * or let `cogmemai-mcp migrate assess --target aws` do both after the assessment.
 */

import type { RulePack } from './packs.js';

const G = (re: string) => `GUARD: ${re}`;

export const AWS: RulePack = {
  id: 'aws',
  name: 'AWS',
  description: 'Accounts, IAM, security groups, S3, RDS, EKS, backups, budgets and regions on AWS, in the shapes the aws CLI takes.',
  rules: [
    {
      subject: 'aws_root_user_locked_down',
      category: 'security',
      tags: ['aws', 'iam'],
      content: `NEVER use the AWS root user for daily work and never create access keys for it. Root has hardware MFA, no keys, and is used only for the handful of tasks that require it, each one logged. Everything else goes through IAM Identity Center roles.
${G('aws\\s+iam\\s+create-access-key\\b(?![^|]*--user-name)')}`,
    },
    {
      subject: 'aws_no_long_lived_access_keys',
      category: 'security',
      tags: ['aws', 'iam', 'secrets'],
      content: `NEVER create long-lived IAM access keys for people or workloads. People sign in through Identity Center with short sessions; workloads assume roles (instance profiles, IRSA, Lambda execution roles, OIDC from CI). A key that must exist is rotated on a schedule and scoped to one task.
${G('aws\\s+iam\\s+create-access-key\\b')}`,
    },
    {
      subject: 'aws_no_iam_users',
      category: 'security',
      tags: ['aws', 'iam'],
      content: `Creating an IAM user needs a written reason; the default is a role. The only standing users are break-glass accounts with hardware MFA, and those are reviewed quarterly.
${G('aws\\s+iam\\s+create-user\\b')}`,
    },
    {
      subject: 'aws_no_admin_or_wildcard_policies',
      category: 'security',
      tags: ['aws', 'iam', 'least-privilege'],
      content: `NEVER attach AdministratorAccess, PowerUserAccess or a policy with Action "*" or Resource "*" to a user, role or group outside the break-glass role. Permissions are scoped to the actions and resources the job needs, and permission boundaries cap what any role can grant.
${G('aws\\s+iam\\s+(attach-(user|role|group)-policy|put-(user|role|group)-policy|create-policy|create-policy-version)\\b[^|]*(AdministratorAccess|PowerUserAccess|IAMFullAccess)\\b')}`,
    },
    {
      subject: 'aws_security_groups_no_world_admin_ports',
      category: 'security',
      tags: ['aws', 'network'],
      content: `NEVER open SSH, RDP or a database port to 0.0.0.0/0 or ::/0 in a security group. Administrative access goes through Systems Manager Session Manager or a bastion behind SSO; databases are reachable only from the application's security group.
${G('aws\\s+ec2\\s+authorize-security-group-ingress\\b[^|]*--cidr\\s+["\']?(0\\.0\\.0\\.0/0|::/0)[^|]*--port\\s+["\']?(22|3389|1433|3306|5432|6379|27017|9200)\\b')}
${G('aws\\s+ec2\\s+authorize-security-group-ingress\\b[^|]*--port\\s+["\']?(22|3389|1433|3306|5432|6379|27017|9200)\\b[^|]*--cidr\\s+["\']?(0\\.0\\.0\\.0/0|::/0)')}`,
    },
    {
      subject: 'aws_s3_public_access_block_stays_on',
      category: 'security',
      tags: ['aws', 's3', 'public-exposure'],
      content: `NEVER remove or weaken the S3 Block Public Access settings at the account or bucket level, and never write a bucket policy with Principal "*". Public content is served through CloudFront with origin access control, not from a public bucket.
${G('aws\\s+s3api\\s+delete-public-access-block\\b')}
${G('aws\\s+s3api\\s+put-public-access-block\\b[^|]*(BlockPublicAcls|IgnorePublicAcls|BlockPublicPolicy|RestrictPublicBuckets)=false')}
${G('aws\\s+s3api\\s+put-bucket-policy\\b[^|]*"Principal"\\s*:\\s*"\\*"')}
${G('aws\\s+s3\\s+(cp|sync)\\b[^|]*--acl\\s+public-read')}`,
    },
    {
      subject: 'aws_encryption_at_rest_by_default',
      category: 'security',
      tags: ['aws', 'encryption'],
      content: `NEVER turn off EBS default encryption, and never create an RDS instance without encrypted storage. Each data class has its own KMS key with a rotation schedule and a key policy that names who may decrypt.
${G('aws\\s+ec2\\s+disable-ebs-encryption-by-default\\b')}
${G('aws\\s+rds\\s+(create-db-instance|create-db-cluster|restore-db-instance-from-s3)\\b(?![^|]*--storage-encrypted)')}`,
    },
    {
      subject: 'aws_rds_never_publicly_accessible',
      category: 'security',
      tags: ['aws', 'rds', 'public-exposure'],
      content: `NEVER make an RDS instance or cluster publicly accessible. Databases live in private subnets and are reached through the application tier, a bastion behind SSO, or Session Manager port forwarding.
${G('aws\\s+rds\\s+(create|modify|restore)-db-(instance|cluster)\\S*\\b[^|]*--publicly-accessible\\b(?!\\s*=?\\s*false)')}`,
    },
    {
      subject: 'aws_rds_deletion_protection_and_final_snapshot',
      category: 'backend',
      tags: ['aws', 'rds', 'backups'],
      content: `NEVER delete a production database without a final snapshot, and never remove deletion protection as part of the same change that deletes. Removing protection is its own reviewed change; the deletion is a second one, after the snapshot is verified restorable.
${G('aws\\s+rds\\s+delete-db-(instance|cluster)\\b[^|]*--skip-final-snapshot')}
${G('aws\\s+rds\\s+modify-db-(instance|cluster)\\b[^|]*--no-deletion-protection')}
${G('aws\\s+ec2\\s+modify-instance-attribute\\b[^|]*--no-disable-api-termination')}`,
    },
    {
      subject: 'aws_backup_plans_cross_region_tested',
      category: 'backend',
      tags: ['aws', 'backups'],
      content: `Every tier-1 data store is in an AWS Backup plan with a cross-region copy and a quarterly restore test that is written down. Deleting a backup vault, a recovery point or a snapshot is a reviewed change, never a cleanup task.
${G('aws\\s+backup\\s+(delete-backup-vault|delete-recovery-point|delete-backup-plan)\\b')}
${G('aws\\s+ec2\\s+delete-snapshot\\b')}`,
    },
    {
      subject: 'aws_detective_controls_stay_on',
      category: 'security',
      tags: ['aws', 'logging', 'monitoring'],
      content: `NEVER disable GuardDuty, Security Hub, Config or Inspector in any account. They are organization-wide, delegated to the security account, and their findings have an owner. Turning one off to make a deploy pass is an incident.
${G('aws\\s+guardduty\\s+(delete-detector|update-detector\\b[^|]*--no-enable)')}
${G('aws\\s+securityhub\\s+disable-security-hub\\b')}
${G('aws\\s+configservice\\s+(stop-configuration-recorder|delete-configuration-recorder|delete-delivery-channel)\\b')}`,
    },
    {
      subject: 'aws_organization_scps_are_the_floor',
      category: 'security',
      tags: ['aws', 'organizations'],
      content: `NEVER detach or delete a service control policy, leave the organization, or move an account out of its organizational unit without the security owner's approval. SCPs are the floor under every account: they deny disabling CloudTrail, creating root keys, leaving the org and using unapproved regions.
${G('aws\\s+organizations\\s+(leave-organization|detach-policy|delete-policy|remove-account-from-organization)\\b')}`,
    },
    {
      subject: 'aws_approved_regions_only',
      category: 'security',
      tags: ['aws', 'data-residency'],
      content: `Resources are created only in the approved regions for their data class, enforced by an SCP, and nothing with personal or regulated data is replicated across regions without the privacy owner's sign-off. Cross-region replication and read replicas are changes, not defaults.
${G('aws\\s+s3api\\s+put-bucket-replication\\b')}
${G('aws\\s+rds\\s+create-db-instance-read-replica\\b[^|]*--source-region')}`,
    },
    {
      subject: 'aws_private_subnets_no_auto_public_ip',
      category: 'security',
      tags: ['aws', 'network'],
      content: `Workloads run in private subnets with egress through NAT or VPC endpoints; subnets do not auto-assign public IPs, and the only public addresses belong to load balancers and NAT gateways. Attaching a public IP to an instance is an exception with a reason.
${G('aws\\s+ec2\\s+modify-subnet-attribute\\b[^|]*--map-public-ip-on-launch\\b(?!\\s*=?\\s*false)')}
${G('aws\\s+ec2\\s+run-instances\\b[^|]*--associate-public-ip-address\\b(?!\\s*=?\\s*false)')}`,
    },
    {
      subject: 'aws_eks_private_endpoint_and_irsa',
      category: 'security',
      tags: ['aws', 'eks', 'kubernetes'],
      content: `NEVER expose an EKS API endpoint to 0.0.0.0/0. The endpoint is private or restricted to the office and CI CIDRs, nodes are in private subnets, and pods get AWS permissions through IAM roles for service accounts, never through node instance profiles with broad rights.
${G('aws\\s+eks\\s+(create-cluster|update-cluster-config)\\b[^|]*publicAccessCidrs=\\[?["\']?0\\.0\\.0\\.0/0')}`,
    },
    {
      subject: 'aws_secrets_in_secrets_manager_only',
      category: 'security',
      tags: ['aws', 'secrets'],
      content: `NEVER store a secret as a plain String parameter, in an environment variable definition, in user data or in a task definition. Secrets live in Secrets Manager or SSM SecureString, are referenced by ARN, and rotate on a schedule.
${G('aws\\s+ssm\\s+put-parameter\\b(?=[^|]*--type\\s+["\']?String\\b)(?=[^|]*(SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY))')}
${G('aws\\s+lambda\\s+(create-function|update-function-configuration)\\b[^|]*--environment\\b[^|]*(SECRET|TOKEN|PASSWORD|API_KEY)\\w*=\\S{8,}')}`,
    },
    {
      subject: 'aws_tags_required_on_every_resource',
      category: 'backend',
      tags: ['aws', 'tagging', 'cost'],
      content: `Every resource carries Owner, Environment, CostCenter and DataClass tags, enforced by a tag policy and Config rule. Untagged resources are reported weekly and reaped after thirty days in non-production. A resource nobody owns is a cost and a risk at once.
GUARD: off`,
    },
    {
      subject: 'aws_budgets_before_first_workload',
      category: 'backend',
      tags: ['aws', 'cost'],
      content: `Every account has an AWS Budget with alerts at 50, 80 and 100 percent, routed to a person, before its first production workload. Cost anomaly detection is on. Deleting a budget is a reviewed change.
${G('aws\\s+budgets\\s+delete-budget\\b')}
${G('aws\\s+ce\\s+delete-anomaly-(monitor|subscription)\\b')}`,
    },
    {
      subject: 'aws_autoscaling_has_a_ceiling',
      category: 'backend',
      tags: ['aws', 'cost', 'autoscaling'],
      content: `Every auto scaling group, Lambda concurrency setting and DynamoDB on-demand table has a ceiling that someone chose on purpose. A runaway loop or a scraper should hit a limit and an alert, not the credit card. Raising a ceiling above a hundred instances is a reviewed change.
${G('aws\\s+autoscaling\\s+(create|update)-auto-scaling-group\\b[^|]*--max-size\\s+["\']?\\d{3,}')}
${G('aws\\s+lambda\\s+put-function-concurrency\\b[^|]*--reserved-concurrent-executions\\s+["\']?\\d{4,}')}`,
    },
    {
      subject: 'aws_cloudtrail_org_trail_immutable',
      category: 'security',
      tags: ['aws', 'logging'],
      content: `The organization trail covers every account and region, writes to a bucket in the security account with object lock and MFA delete, and is never the thing that gets turned off to save money. Log file validation stays on.
${G('aws\\s+cloudtrail\\s+(delete-trail|stop-logging|update-trail\\b[^|]*--no-enable-log-file-validation)')}
${G('aws\\s+s3api\\s+put-object-lock-configuration\\b[^|]*"ObjectLockEnabled"\\s*:\\s*"Disabled"')}`,
    },
  ],
  intent: `# Project intent: AWS platform

## Purpose
Run the workloads of this project on AWS inside the organization's guardrails: private by default, least privilege, encrypted, logged, budgeted and only in approved regions.

## Invariants
- NEVER use root, create long-lived access keys, or attach administrator or wildcard policies.
- NEVER open admin or database ports to the internet, make a database public, or weaken S3 Block Public Access.
- NEVER disable CloudTrail, GuardDuty, Security Hub, Config or a service control policy.
- NEVER create resources outside the approved regions or replicate regulated data across regions without sign-off.
- MUST encrypt at rest with a named KMS key, keep every tier-1 store in a tested backup plan, and tag every resource.
- MUST have a budget with alerts before the first production workload.

## Out of scope
- Application code and release decisions (the product teams).
- Changes to organization-level policies (the platform security owner).

## Definition of done
- Applied from CI through infrastructure as code, verified in the console or CLI, tagged, within budget, documented in the runbook.
`,
};

export const AZURE: RulePack = {
  id: 'azure',
  name: 'Azure',
  description: 'Subscriptions, Entra roles, NSGs, storage accounts, SQL, Key Vault, AKS, Policy, locks and budgets on Azure, in the shapes the az CLI takes.',
  rules: [
    {
      subject: 'azure_no_owner_role_assignments',
      category: 'security',
      tags: ['azure', 'rbac', 'least-privilege'],
      content: `NEVER assign Owner or User Access Administrator to a person, group or service principal; those roles live only on the break-glass accounts with Privileged Identity Management and approval. Contributor at subscription scope needs the platform owner's sign-off; everything else is a scoped built-in or custom role on a resource group.
${G('az\\s+role\\s+assignment\\s+create\\b[^|]*--role\\s+["\']?(Owner|User Access Administrator)\\b')}
${G('az\\s+role\\s+assignment\\s+create\\b[^|]*--role\\s+["\']?Contributor["\']?[^|]*--scope\\s+["\']?/subscriptions/[^/\\s"\']+["\']?(\\s|$)')}`,
    },
    {
      subject: 'azure_managed_identities_over_secrets',
      category: 'security',
      tags: ['azure', 'identity', 'secrets'],
      content: `Workloads authenticate with managed identities or workload identity federation, never with a service principal secret or certificate pasted into configuration. Creating or resetting a service principal credential needs a written reason and an expiry under ninety days.
${G('az\\s+ad\\s+(sp|app)\\s+credential\\s+reset\\b')}
${G('az\\s+ad\\s+sp\\s+create-for-rbac\\b[^|]*--role\\s+["\']?(Owner|Contributor)\\b')}`,
    },
    {
      subject: 'azure_nsg_no_world_admin_ports',
      category: 'security',
      tags: ['azure', 'network'],
      content: `NEVER create a network security group rule that allows SSH, RDP, SQL or any port from Internet, * or 0.0.0.0/0. Administrative access goes through Azure Bastion or a jump host behind Entra sign-in; databases accept traffic only from the application subnet.
${G('az\\s+network\\s+nsg\\s+rule\\s+(create|update)\\b[^|]*--source-address-prefix(es)?\\s+["\']?(\\*|Internet|0\\.0\\.0\\.0/0)["\']?[^|]*--destination-port-range(s)?\\s+["\']?(\\*|22|3389|1433|3306|5432|6379|27017)\\b')}
${G('az\\s+network\\s+nsg\\s+rule\\s+(create|update)\\b[^|]*--destination-port-range(s)?\\s+["\']?(\\*|22|3389|1433|3306|5432|6379|27017)\\b[^|]*--source-address-prefix(es)?\\s+["\']?(\\*|Internet|0\\.0\\.0\\.0/0)')}
${G('az\\s+vm\\s+open-port\\b[^|]*--port\\s+["\']?(\\*|22|3389)\\b')}`,
    },
    {
      subject: 'azure_storage_no_public_blob_access',
      category: 'security',
      tags: ['azure', 'storage', 'public-exposure'],
      content: `NEVER allow anonymous blob access on a storage account or set a container's public access to blob or container. Public content is served through Front Door or a CDN with a private origin; everything else is reached with Entra identities or short-lived SAS tokens.
${G('az\\s+storage\\s+account\\s+(create|update)\\b[^|]*--allow-blob-public-access\\s+["\']?true')}
${G('az\\s+storage\\s+container\\s+(create|set-permission)\\b[^|]*--public-access\\s+["\']?(blob|container)')}`,
    },
    {
      subject: 'azure_storage_https_and_tls12_only',
      category: 'security',
      tags: ['azure', 'storage', 'encryption'],
      content: `NEVER turn off HTTPS-only or lower the minimum TLS version below 1.2 on a storage account, and never disable infrastructure encryption on accounts holding regulated data. Shared key access is off where Entra authorization works.
${G('az\\s+storage\\s+account\\s+(create|update)\\b[^|]*(--https-only\\s+["\']?false|--min-tls-version\\s+["\']?TLS1_[01])')}`,
    },
    {
      subject: 'azure_sql_private_endpoint_only',
      category: 'security',
      tags: ['azure', 'sql', 'public-exposure'],
      content: `NEVER enable public network access on an Azure SQL server, database for PostgreSQL or MySQL flexible server, or add a firewall rule that spans the whole internet. Databases are reached through private endpoints from the application virtual network.
${G('az\\s+(sql|postgres|mysql)\\s+(flexible-)?server\\s+(create|update)\\b[^|]*--(enable-public-network|public-network-access|public-access)\\s+["\']?(true|Enabled|all|0\\.0\\.0\\.0)')}
${G('az\\s+(sql|postgres|mysql)\\s+(flexible-)?server\\s+firewall-rule\\s+create\\b[^|]*--start-ip-address\\s+["\']?0\\.0\\.0\\.0[^|]*--end-ip-address\\s+["\']?255\\.255\\.255\\.255')}`,
    },
    {
      subject: 'azure_key_vault_is_the_only_secret_store',
      category: 'security',
      tags: ['azure', 'secrets', 'key-vault'],
      content: `NEVER delete or purge a Key Vault, disable its purge protection or soft delete, or put a secret anywhere other than Key Vault. Apps read secrets through Key Vault references or managed identity; CI reads them at run time, never at build time into an image.
${G('az\\s+keyvault\\s+(delete|purge)\\b')}
${G('az\\s+keyvault\\s+update\\b[^|]*--enable-purge-protection\\s+["\']?false')}
${G('az\\s+(webapp|functionapp|containerapp)\\s+config\\s+appsettings\\s+set\\b[^|]*(^|\\s|,)\\w*(SECRET|TOKEN|PASSWORD|API_KEY|CONNECTION_?STRING)\\w*=(?!@Microsoft\\.KeyVault)\\S{8,}')}`,
    },
    {
      subject: 'azure_policy_assignments_are_the_floor',
      category: 'security',
      tags: ['azure', 'policy', 'governance'],
      content: `NEVER delete or exempt an Azure Policy assignment at the management group level to make a deploy pass. Policy enforces allowed locations, required tags, no public IPs, no public storage and diagnostic settings on everything. A deploy that Policy blocks is a deploy that needs a different design or a documented exception from the platform owner.
${G('az\\s+policy\\s+(assignment\\s+delete|exemption\\s+create)\\b')}`,
    },
    {
      subject: 'azure_allowed_locations_data_residency',
      category: 'security',
      tags: ['azure', 'data-residency'],
      content: `Resources are created only in the locations Policy allows for their data class, and paired-region replication (geo-redundant storage, SQL geo-replication, Cosmos multi-region) for regulated data needs the privacy owner's sign-off. Residency is decided once, in the scope document, not per deploy.
${G('az\\s+sql\\s+db\\s+replica\\s+create\\b')}
${G('az\\s+cosmosdb\\s+(create|update)\\b[^|]*--locations\\b[^|]*--locations\\b')}`,
    },
    {
      subject: 'azure_defender_and_diagnostics_on',
      category: 'security',
      tags: ['azure', 'logging', 'monitoring'],
      content: `NEVER set Defender for Cloud to the free tier on a production subscription or remove diagnostic settings that ship activity and resource logs to the central Log Analytics workspace. The workspace is in the security subscription with retention of at least one year.
${G('az\\s+security\\s+pricing\\s+create\\b[^|]*--tier\\s+["\']?free')}
${G('az\\s+monitor\\s+log-analytics\\s+workspace\\s+(delete|update\\b[^|]*--retention-time\\s+["\']?[0-9]{1,2}\\b)')}`,
    },
    {
      subject: 'azure_resource_locks_on_production',
      category: 'backend',
      tags: ['azure', 'change-control'],
      content: `NEVER remove a CanNotDelete or ReadOnly lock as part of the same change that deletes or modifies the locked resource, and never delete a production resource group. Removing a lock is its own reviewed change with a rollback; the deletion follows after the backup is verified.
${G('az\\s+(lock|resource\\s+lock|group\\s+lock)\\s+delete\\b')}
${G('az\\s+group\\s+delete\\b')}`,
    },
    {
      subject: 'azure_aks_private_rbac_entra',
      category: 'security',
      tags: ['azure', 'aks', 'kubernetes'],
      content: `NEVER create or update an AKS cluster with RBAC disabled, local accounts enabled, or an API server open to 0.0.0.0/0. Clusters are private or CIDR-restricted, use Entra integration with Azure RBAC, workload identity for pods, and Defender for Containers.
${G('az\\s+aks\\s+(create|update)\\b[^|]*(--disable-rbac|--enable-local-accounts|--api-server-authorized-ip-ranges\\s+["\']?0\\.0\\.0\\.0/0)')}`,
    },
    {
      subject: 'azure_backup_vaults_protected',
      category: 'backend',
      tags: ['azure', 'backups'],
      content: `Every production VM, database and file share is protected by a Recovery Services or Backup vault with soft delete and a quarterly restore test that is written down. Disabling protection with data deletion, or deleting a vault, is a reviewed change, never a cleanup.
${G('az\\s+backup\\s+protection\\s+disable\\b[^|]*--delete-backup-data\\s+["\']?true')}
${G('az\\s+backup\\s+vault\\s+delete\\b')}
${G('az\\s+(sql|postgres|mysql)\\s+(flexible-)?server\\s+(create|update)\\b[^|]*--backup-retention(-days)?\\s+["\']?[0-6]\\b')}`,
    },
    {
      subject: 'azure_budgets_and_cost_alerts',
      category: 'backend',
      tags: ['azure', 'cost'],
      content: `Every subscription has a Cost Management budget with alerts at 50, 80 and 100 percent routed to a person, before its first production workload, and an anomaly alert. Deleting a budget is a reviewed change.
${G('az\\s+consumption\\s+budget\\s+delete\\b')}`,
    },
    {
      subject: 'azure_tags_required',
      category: 'backend',
      tags: ['azure', 'tagging', 'cost'],
      content: `Every resource group and resource carries Owner, Environment, CostCenter and DataClass tags, inherited where Policy allows and enforced by a deny policy where it does not. Untagged resources are reported weekly and removed from non-production after thirty days.
GUARD: off`,
    },
    {
      subject: 'azure_private_endpoints_for_paas',
      category: 'security',
      tags: ['azure', 'network'],
      content: `Platform services (storage, SQL, Key Vault, Cosmos, Service Bus, container registry) are reached over private endpoints from the virtual network, with public network access disabled once the private endpoint works. A service reachable from the internet is an exception with a reason and an expiry.
GUARD: off`,
    },
    {
      subject: 'azure_entra_mfa_and_conditional_access',
      category: 'security',
      tags: ['azure', 'identity'],
      content: `Every human sign-in to the portal, CLI or any administrative role requires phishing-resistant MFA through Conditional Access, and privileged roles are activated just in time through Privileged Identity Management with approval and a time limit. Standing privileged assignments are reviewed monthly and removed.
GUARD: off`,
    },
    {
      subject: 'azure_vm_no_public_ip_by_default',
      category: 'security',
      tags: ['azure', 'network', 'compute'],
      content: `Virtual machines are created without public IP addresses; inbound reaches them through a load balancer, Application Gateway or Bastion. A VM that needs a public address is an exception with a reason, an NSG that allows only the needed port, and an expiry.
${G('az\\s+vm\\s+create\\b[^|]*--public-ip-sku\\b')}`,
    },
  ],
  intent: `# Project intent: Azure platform

## Purpose
Run the workloads of this project on Azure inside the organization's guardrails: private endpoints, scoped roles, managed identities, Key Vault for every secret, Policy as the floor, logged, budgeted and only in allowed locations.

## Invariants
- NEVER assign Owner, create service principal secrets for workloads, or disable RBAC on a cluster.
- NEVER open admin or database ports from the internet, enable public blob access, or enable public network access on a database.
- NEVER delete a Policy assignment, a lock, a Key Vault or a backup vault to make a change pass.
- NEVER create resources outside the allowed locations or geo-replicate regulated data without sign-off.
- MUST keep Defender for Cloud and diagnostic settings on, every production resource backed up and tagged, and a budget with alerts in place.

## Out of scope
- Application code and release decisions (the product teams).
- Management group and Policy definition changes (the platform owner).

## Definition of done
- Deployed from CI through infrastructure as code, verified, tagged, within budget, documented in the runbook.
`,
};

export const GCP: RulePack = {
  id: 'gcp',
  name: 'Google Cloud',
  description: 'Projects, IAM, service accounts, VPC firewall, Cloud Storage, Cloud SQL, GKE, org policies, logging and budgets on Google Cloud, in the shapes gcloud and gsutil take.',
  rules: [
    {
      subject: 'gcp_no_primitive_roles',
      category: 'security',
      tags: ['gcp', 'iam', 'least-privilege'],
      content: `NEVER grant roles/owner or roles/editor on a project, folder or organization to a person, group or service account. Those are break-glass roles. Everyone else gets predefined or custom roles scoped to the resources the job touches, granted to groups, with IAM Conditions and expiry where the role is sensitive.
${G('gcloud\\s+(projects|organizations|resource-manager\\s+folders|alpha\\s+projects|beta\\s+projects)\\s+add-iam-policy-binding\\b[^|]*--role[=\\s]+["\']?roles/(owner|editor)\\b')}`,
    },
    {
      subject: 'gcp_no_allusers_bindings',
      category: 'security',
      tags: ['gcp', 'iam', 'public-exposure'],
      content: `NEVER bind allUsers or allAuthenticatedUsers to any resource. Public web content goes through a load balancer with Cloud CDN or Cloud Armor in front of a private backend; a bucket, function or service with an allUsers binding is an exposure, not a convenience.
${G('(gcloud\\s+[a-z-]+(\\s+[a-z-]+)?\\s+(add-iam-policy-binding|set-iam-policy)|gsutil\\s+iam\\s+ch)\\b[^|]*(allUsers|allAuthenticatedUsers)')}
${G('gcloud\\s+(run|functions)\\s+(deploy|services\\s+update|add-invoker-policy-binding)\\b[^|]*(--allow-unauthenticated|allUsers)')}`,
    },
    {
      subject: 'gcp_no_service_account_keys',
      category: 'security',
      tags: ['gcp', 'iam', 'secrets'],
      content: `NEVER create a user-managed service account key. Workloads on Google Cloud attach a service account; everything outside uses workload identity federation. The organization policy disabling key creation stays on, and any key that exists is rotated and tracked to retirement.
${G('gcloud\\s+iam\\s+service-accounts\\s+keys\\s+create\\b')}`,
    },
    {
      subject: 'gcp_firewall_no_world_admin_ports',
      category: 'security',
      tags: ['gcp', 'network'],
      content: `NEVER create a VPC firewall rule that allows SSH, RDP, a database port or all protocols from 0.0.0.0/0. Administrative access goes through Identity-Aware Proxy TCP forwarding; databases accept traffic only from the application's service account or subnet.
${G('gcloud\\s+compute\\s+firewall-rules\\s+(create|update)\\b[^|]*--source-ranges[=\\s]+["\']?[^|]*0\\.0\\.0\\.0/0[^|]*(--allow[=\\s]+["\']?(all|tcp(:22|:3389|:3306|:5432|:1433|:6379)\\b)|--rules[=\\s]+["\']?(all|tcp:(22|3389|3306|5432|1433|6379)\\b))')}
${G('gcloud\\s+compute\\s+firewall-rules\\s+(create|update)\\b[^|]*(--allow[=\\s]+["\']?(all|tcp(:22|:3389|:3306|:5432|:1433|:6379)\\b)|--rules[=\\s]+["\']?(all|tcp:(22|3389|3306|5432|1433|6379)\\b))[^|]*--source-ranges[=\\s]+["\']?[^|]*0\\.0\\.0\\.0/0')}`,
    },
    {
      subject: 'gcp_buckets_uniform_access_never_public',
      category: 'security',
      tags: ['gcp', 'storage', 'public-exposure'],
      content: `NEVER make a bucket or object public with an ACL, and never turn off uniform bucket-level access. Buckets use uniform access with IAM, public access prevention enforced, and retention or versioning where the data class requires it.
${G('gsutil\\s+(acl|defacl)\\s+(ch|set)\\b[^|]*(public-read|AllUsers|allUsers)')}
${G('gcloud\\s+storage\\s+buckets\\s+(create|update)\\b[^|]*(--no-uniform-bucket-level-access|--no-public-access-prevention)')}`,
    },
    {
      subject: 'gcp_cloudsql_private_ip_only',
      category: 'security',
      tags: ['gcp', 'cloud-sql', 'public-exposure'],
      content: `NEVER give a Cloud SQL instance a public IP or an authorized network of 0.0.0.0/0. Instances use private IP on the shared VPC and are reached through the Cloud SQL Auth Proxy or private service connect with IAM database authentication.
${G('gcloud\\s+sql\\s+instances\\s+(create|patch)\\b[^|]*(--assign-ip\\b|--authorized-networks[=\\s]+["\']?[^|]*0\\.0\\.0\\.0/0)')}`,
    },
    {
      subject: 'gcp_cloudsql_backups_and_deletion_protection',
      category: 'backend',
      tags: ['gcp', 'cloud-sql', 'backups'],
      content: `NEVER turn off automated backups or point-in-time recovery on a production Cloud SQL instance, delete its backups, or remove deletion protection in the same change that deletes it. Restores are tested quarterly and written down.
${G('gcloud\\s+sql\\s+instances\\s+patch\\b[^|]*(--no-backup\\b|--no-enable-point-in-time-recovery|--no-deletion-protection)')}
${G('gcloud\\s+sql\\s+(backups\\s+delete|instances\\s+delete)\\b')}`,
    },
    {
      subject: 'gcp_org_policies_are_the_floor',
      category: 'security',
      tags: ['gcp', 'org-policy', 'governance'],
      content: `NEVER delete or reset an organization policy constraint to make a deploy pass. The floor is: domain restricted sharing, service account key creation disabled, resource location restriction, external IP access restricted, public access prevention on storage, and uniform bucket access required. A blocked deploy needs a different design or a documented exception from the platform owner.
${G('gcloud\\s+(alpha\\s+|beta\\s+)?(resource-manager\\s+)?org-policies\\s+(delete|reset|disable-enforce)\\b')}`,
    },
    {
      subject: 'gcp_resource_locations_data_residency',
      category: 'security',
      tags: ['gcp', 'data-residency'],
      content: `Resources are created only in the locations the organization policy allows for their data class; multi-region and dual-region storage, cross-region Cloud SQL replicas and multi-region Spanner or Firestore for regulated data need the privacy owner's sign-off. Residency is decided in the scope document, not per deploy.
${G('gcloud\\s+sql\\s+instances\\s+create\\b[^|]*--master-instance-name\\b[^|]*--region')}
${G('gcloud\\s+storage\\s+buckets\\s+create\\b[^|]*--location[=\\s]+["\']?(us|eu|asia|nam4|eur4|asia1)["\']?(\\s|$)')}`,
    },
    {
      subject: 'gcp_audit_logs_central_retained',
      category: 'security',
      tags: ['gcp', 'logging'],
      content: `Admin Activity and Data Access audit logs are on for every service that holds data, aggregated through an organization sink to a log bucket in the security project with retention of at least one year and a lock. Shortening retention under a year or deleting the bucket is an incident.
${G('gcloud\\s+logging\\s+buckets\\s+(delete|update\\b[^|]*--retention-days[=\\s]+["\']?[0-9]{1,2}\\b)')}`,
    },
    {
      subject: 'gcp_gke_private_shielded_workload_identity',
      category: 'security',
      tags: ['gcp', 'gke', 'kubernetes'],
      content: `NEVER create or update a GKE cluster with public nodes, legacy authorization, unshielded nodes or a control plane open to 0.0.0.0/0. Clusters are private, use Workload Identity for pods, Binary Authorization for images, and are reached through authorized networks or IAP.
${G('gcloud\\s+container\\s+clusters\\s+(create|update)\\b[^|]*(--no-enable-private-nodes|--enable-legacy-authorization|--no-enable-shielded-nodes|--no-enable-master-authorized-networks|--master-authorized-networks[=\\s]+["\']?[^|]*0\\.0\\.0\\.0/0)')}`,
    },
    {
      subject: 'gcp_project_deletion_and_liens',
      category: 'backend',
      tags: ['gcp', 'change-control'],
      content: `NEVER delete a project or remove a lien from a production project as a cleanup task. Deleting a project is a planned decommission with a backup, a thirty-day read-only period and a named approver; removing the lien is its own reviewed change.
${G('gcloud\\s+projects\\s+delete\\b')}
${G('gcloud\\s+(alpha\\s+)?resource-manager\\s+liens\\s+delete\\b')}`,
    },
    {
      subject: 'gcp_budgets_before_first_workload',
      category: 'backend',
      tags: ['gcp', 'cost'],
      content: `Every billing account and every production project has a budget with alerts at 50, 80 and 100 percent routed to a person, before its first production workload. Unlinking billing or deleting a budget is a reviewed change, because unlinking billing stops the workload.
${G('gcloud\\s+(alpha\\s+|beta\\s+)?billing\\s+(budgets\\s+delete|projects\\s+unlink)\\b')}`,
    },
    {
      subject: 'gcp_secret_manager_only',
      category: 'security',
      tags: ['gcp', 'secrets'],
      content: `NEVER put a secret into a Cloud Run, Cloud Functions or GKE environment variable, a startup script or a container image. Secrets live in Secret Manager, are mounted or referenced by version, and rotate on a schedule. Destroying a secret version is a reviewed change.
${G('gcloud\\s+(run|functions)\\s+(deploy|services\\s+update)\\b[^|]*--(set|update)-env-vars[=\\s]+["\']?[^|]*(SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY)\\w*=\\S{8,}')}
${G('gcloud\\s+secrets\\s+(delete|versions\\s+destroy)\\b')}`,
    },
    {
      subject: 'gcp_labels_required',
      category: 'backend',
      tags: ['gcp', 'labels', 'cost'],
      content: `Every project and resource carries owner, environment, cost-center and data-class labels, and billing export to BigQuery is on so cost per label is a query, not a guess. Unlabeled resources are reported weekly and removed from non-production after thirty days.
GUARD: off`,
    },
    {
      subject: 'gcp_vpc_service_controls_for_data',
      category: 'security',
      tags: ['gcp', 'network', 'data'],
      content: `Projects that hold regulated data sit inside a VPC Service Controls perimeter with Private Google Access, so data cannot be copied to a bucket or dataset outside the perimeter by any identity, including an over-privileged one. Perimeter changes are reviewed by the security owner.
${G('gcloud\\s+access-context-manager\\s+perimeters\\s+(delete|update\\b[^|]*--remove-resources|dry-run\\s+delete)\\b')}`,
    },
    {
      subject: 'gcp_compute_no_external_ip_and_shielded',
      category: 'security',
      tags: ['gcp', 'network', 'compute'],
      content: `Compute instances are created without external IPs and with Shielded VM on; inbound traffic reaches them through a load balancer or IAP, and egress goes through Cloud NAT. An instance that needs an external address is an exception with a reason and an expiry.
${G('gcloud\\s+compute\\s+instances\\s+(create|add-access-config)\\b[^|]*--(address|network-interface[=\\s]+["\']?[^|]*access-config)')}`,
    },
  ],
  intent: `# Project intent: Google Cloud platform

## Purpose
Run the workloads of this project on Google Cloud inside the organization's guardrails: no primitive roles, no service account keys, private IPs, uniform bucket access, org policies as the floor, logged, budgeted and only in allowed locations.

## Invariants
- NEVER grant owner or editor, bind allUsers, or create a service account key.
- NEVER open admin or database ports from 0.0.0.0/0, give a database a public IP, or make a bucket public.
- NEVER delete or reset an org policy, a lien, a log bucket or a backup to make a change pass.
- NEVER create resources outside the allowed locations or replicate regulated data across regions without sign-off.
- MUST keep audit logs on and retained, every production store backed up with a tested restore, every resource labeled, and a budget with alerts in place.

## Out of scope
- Application code and release decisions (the product teams).
- Organization policy and perimeter changes (the platform security owner).

## Definition of done
- Deployed from CI through infrastructure as code, verified, labeled, within budget, documented in the runbook.
`,
};

export const MIGRATE: RulePack = {
  id: 'migrate',
  name: 'Cloud migration',
  description: 'The process rules for moving workloads between environments or clouds: inventory first, scope as the contract, one workload at a time, verified data, rehearsed cutover, tested rollback, gated phases, decommission last.',
  rules: [
    {
      subject: 'migrate_inventory_before_any_move',
      category: 'general',
      tags: ['migrate', 'process'],
      content: `No migration work starts before the assessment is in CogmemAi: the inventory of services, data stores, integrations, secrets, scheduled jobs and traffic, the dependency map, and the scope document. Run cogmemai-mcp migrate assess and read the result before touching anything. A migration without an inventory is a discovery exercise with production traffic as the test harness.
GUARD: off`,
    },
    {
      subject: 'migrate_scope_document_is_the_contract',
      category: 'general',
      tags: ['migrate', 'scope'],
      content: `The migration scope document (the project intent) is the contract: what moves, what stays, what must hold throughout, what is out of scope, and what done means for each phase. Every change to it goes through set_intent with a reason, and every phase is reviewed against it. Work that is not in the scope is not migration work.
GUARD: off`,
    },
    {
      subject: 'migrate_one_workload_at_a_time',
      category: 'general',
      tags: ['migrate', 'process'],
      content: `NEVER plan a big-bang cutover. Workloads move one at a time, lowest risk first, each with its own phase gate, so a failure affects one system and the lesson improves the next move. A dependency that forces two workloads to move together is a finding to write down, not a reason to move everything.
GUARD: off`,
    },
    {
      subject: 'migrate_lift_then_modernize',
      category: 'general',
      tags: ['migrate', 'process'],
      content: `NEVER change the application and the infrastructure in the same step. Move first with the smallest change that runs; modernize (managed services, containers, new frameworks) as a separate project afterwards, with its own scope. Two kinds of change in one cutover means a failure cannot be attributed.
GUARD: off`,
    },
    {
      subject: 'migrate_rollback_rehearsed_before_each_phase',
      category: 'general',
      tags: ['migrate', 'rollback'],
      content: `No phase starts without a written rollback that has been rehearsed: how traffic returns to the source, how data written on the target during the window is reconciled, how long it takes, and who decides. A rollback that has never run is a hope.
GUARD: off`,
    },
    {
      subject: 'migrate_data_verified_by_counts_and_checksums',
      category: 'backend',
      tags: ['migrate', 'data'],
      content: `Data is verified on the target before cutover with row counts per table, checksums or hashes per partition, and a sample of records compared field by field, with the results stored as a memory. "The copy finished without errors" is not verification.
GUARD: off`,
    },
    {
      subject: 'migrate_bulk_sync_never_deletes_without_dry_run',
      category: 'backend',
      tags: ['migrate', 'data'],
      content: `NEVER run a bulk sync with a delete flag without a dry run first and a backup of the destination. Sync tools with --delete remove whatever is missing on the source side, and a wrong path or a swapped argument empties the target.
${G('(aws\\s+s3\\s+sync|gsutil\\s+(-m\\s+)?rsync|azcopy\\s+sync|rclone\\s+(sync|move))\\b(?![^|]*--dry-?run)[^|]*(--delete\\b|--delete-destination|\\s-d\\b)')}
${G('rsync\\b(?![^|]*(--dry-run|\\s-n\\b))[^|]*--delete\\b[^|]*\\s/\\S*(var|srv|home|data)')}`,
    },
    {
      subject: 'migrate_secrets_reissued_not_copied',
      category: 'security',
      tags: ['migrate', 'secrets'],
      content: `NEVER export secrets from the source secret store to a file, a spreadsheet or a chat to move them. Secrets are reissued in the target's secret manager (new credentials, new keys), the application is pointed at them, and the old ones are revoked after cutover. A migration is the moment every credential gets rotated for free.
${G('aws\\s+secretsmanager\\s+(get-secret-value|batch-get-secret-value)\\b[^|]*>\\s*\\S+')}
${G('az\\s+keyvault\\s+secret\\s+(show|download|list)\\b[^|]*>\\s*\\S+')}
${G('gcloud\\s+secrets\\s+versions\\s+access\\b[^|]*>\\s*\\S+')}
${G('(kubectl\\s+get\\s+secrets?\\b[^|]*-o\\s+(yaml|json)[^|]*>\\s*\\S+)')}`,
    },
    {
      subject: 'migrate_data_residency_preserved',
      category: 'security',
      tags: ['migrate', 'data-residency'],
      content: `Data stays in the residency class it has today unless the scope document says otherwise with the privacy owner's sign-off. A migration never moves personal, health, payment or customer data to a region, country or provider the contracts do not allow, even temporarily, even for a staging copy.
GUARD: off`,
    },
    {
      subject: 'migrate_parity_tests_before_traffic',
      category: 'general',
      tags: ['migrate', 'testing'],
      content: `The same test suite runs on the target with the same results before the first percent of traffic moves, plus a smoke test of every integration (payments, email, webhooks, scheduled jobs, third-party APIs) from the target network with the target's identities. Differences are findings to resolve, not notes.
GUARD: off`,
    },
    {
      subject: 'migrate_observability_before_traffic',
      category: 'backend',
      tags: ['migrate', 'monitoring'],
      content: `Dashboards, logs, alerts and an on-call owner exist for the target before it takes traffic, with the source's baseline numbers (latency, error rate, throughput, cost) written down for comparison. A target with no dashboard cannot be judged healthy, so it cannot be cut over.
GUARD: off`,
    },
    {
      subject: 'migrate_cutover_gradual_with_lowered_ttl',
      category: 'general',
      tags: ['migrate', 'cutover'],
      content: `Cutover is gradual (weighted DNS, a load balancer split or a feature flag) with DNS TTLs lowered at least a day ahead, a freeze on schema changes during the window, and a go or no-go call recorded with the numbers. Raising a TTL back or lifting the freeze happens only after the phase gate passes.
GUARD: off`,
    },
    {
      subject: 'migrate_dual_write_or_read_only_window',
      category: 'backend',
      tags: ['migrate', 'data', 'cutover'],
      content: `During cutover the data has exactly one writer: either the source goes read-only for the final sync, or dual writes are in place with reconciliation. NEVER let both sides accept writes without a reconciliation plan, because the divergence is silent and the fix is manual.
GUARD: off`,
    },
    {
      subject: 'migrate_source_kept_read_only_before_decommission',
      category: 'general',
      tags: ['migrate', 'decommission'],
      content: `NEVER decommission, delete or wipe the source environment in the same change as the cutover. The source stays read-only and backed up for at least thirty days after the phase gate passes, then is decommissioned as its own planned change with a named approver and a final backup verified restorable.
${G('\\b(rm\\s+-rf?\\s+\\S*(/var/lib/(mysql|postgresql|mongodb)|/var/www|/srv)|DROP\\s+DATABASE\\b|DROP\\s+SCHEMA\\b)')}
${G('(terraform|tofu)\\s+(destroy|apply\\b[^|]*-destroy)\\b')}`,
    },
    {
      subject: 'migrate_cost_baseline_before_and_after',
      category: 'backend',
      tags: ['migrate', 'cost'],
      content: `The source's monthly cost is written down before the move, a budget with alerts exists on the target before it takes traffic, and the first full month on the target is compared with the baseline and stored as a memory. A migration that does not know what it saved or cost cannot be called finished.
GUARD: off`,
    },
    {
      subject: 'migrate_gate_after_every_phase',
      category: 'general',
      tags: ['migrate', 'review'],
      content: `Every phase ends with cogmemai-mcp migrate gate "<phase>": the work is reviewed against the scope document, and the phase passes only with coverage of at least 80 and no violations. A gate that fails blocks the next phase; the fix is to do the work, not to lower the bar. Results are stored so the whole migration has a record.
GUARD: off`,
    },
  ],
  intent: `# Migration scope

## Purpose
Move the workloads listed below to the target environment with no data loss, no unplanned downtime, and no change to who may see what. Replace the lines below with the assessment's output, or run cogmemai-mcp migrate assess to generate it.

## What moves
- (services, data stores, scheduled jobs, integrations)

## What stays
- (anything explicitly staying behind, and why)

## Invariants
- NEVER move or stage regulated data outside its current residency without the privacy owner's sign-off.
- NEVER cut over a workload whose data has not been verified by counts and checksums on the target.
- NEVER let both source and target accept writes without a reconciliation plan.
- NEVER decommission the source in the same change as the cutover; thirty days read-only first.
- MUST have a rehearsed rollback, parity tests, dashboards and a budget on the target before traffic moves.
- MUST pass the phase gate (coverage 80 or more, no violations) before the next phase starts.

## Phases
1. Inventory and scope (this document, dependency map, cost baseline).
2. Landing zone (accounts, network, identity, logging, budgets, rule packs installed).
3. Pilot workload (lowest risk) moved, verified, cut over, gated.
4. Remaining workloads one at a time, each gated.
5. Decommission after thirty days read-only, final cost comparison.

## Out of scope
- Application modernization (separate project after the move).
- Anything not listed under "What moves".

## Definition of done
- Every workload under "What moves" runs on the target, gates passed, source decommissioned, cost compared with the baseline, runbook updated.
`,
};

export const CLOUD_PACKS: RulePack[] = [AWS, AZURE, GCP, MIGRATE];
