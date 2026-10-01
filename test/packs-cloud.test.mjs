/**
 * v3.31.0: cloud and migration packs. Each pack must be well formed, its GUARD
 * patterns must stop the commands they are written for, and ordinary cloud work
 * must pass. Same pure path as the devsecops tests: compileMemoryRules then decide.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PACKS, findPack, validatePack } from '../build/packs.js';
import { compileMemoryRules, decide } from '../build/guard.js';

const rulesFor = (id) => {
  const pack = findPack(id);
  assert.ok(pack, `${id} pack exists`);
  return compileMemoryRules(pack.rules.map((r, i) => ({ id: 2000 + i, memory_type: 'rule', subject: r.subject, content: r.content })));
};

test('the cloud packs are well formed and unique across packs', () => {
  for (const id of ['aws', 'azure', 'gcp', 'migrate']) assert.deepEqual(validatePack(findPack(id)), [], id);
  const subjects = new Set();
  for (const p of PACKS) for (const r of p.rules) {
    assert.ok(!subjects.has(r.subject), `subject ${r.subject} appears in two packs`);
    subjects.add(r.subject);
  }
  assert.ok(subjects.size >= 110, `expected 110+ rules across packs, got ${subjects.size}`);
});

const cases = {
  aws: {
    blocked: [
      'aws iam create-access-key',
      'aws iam create-access-key --user-name ci-bot',
      'aws iam create-user --user-name temp',
      'aws iam attach-role-policy --role-name app --policy-arn arn:aws:iam::aws:policy/PowerUserAccess',
      'aws iam create-policy-version --policy-arn arn:aws:iam::123:policy/IAMFullAccess --policy-document file://p.json',
      'aws ec2 authorize-security-group-ingress --group-id sg-1 --protocol tcp --port 3389 --cidr 0.0.0.0/0',
      'aws ec2 authorize-security-group-ingress --group-id sg-1 --cidr ::/0 --protocol tcp --port 5432',
      'aws s3api delete-public-access-block --bucket data',
      'aws s3api put-public-access-block --bucket data --public-access-block-configuration BlockPublicAcls=false',
      'aws s3 cp site.html s3://bucket/ --acl public-read',
      'aws ec2 disable-ebs-encryption-by-default',
      'aws rds create-db-instance --db-instance-identifier db1 --engine postgres --allocated-storage 20',
      'aws rds modify-db-instance --db-instance-identifier db1 --publicly-accessible',
      'aws rds delete-db-instance --db-instance-identifier db1 --skip-final-snapshot',
      'aws rds modify-db-instance --db-instance-identifier db1 --no-deletion-protection',
      'aws backup delete-backup-vault --backup-vault-name main',
      'aws guardduty delete-detector --detector-id abc',
      'aws securityhub disable-security-hub',
      'aws organizations leave-organization',
      'aws s3api put-bucket-replication --bucket data --replication-configuration file://r.json',
      'aws ec2 modify-subnet-attribute --subnet-id subnet-1 --map-public-ip-on-launch',
      'aws eks update-cluster-config --name prod --resources-vpc-config endpointPublicAccess=true,publicAccessCidrs=0.0.0.0/0',
      'aws ssm put-parameter --name /app/DB_PASSWORD --type String --value hunter2hunter2',
      'aws budgets delete-budget --account-id 1 --budget-name main',
      'aws autoscaling update-auto-scaling-group --auto-scaling-group-name web --max-size 500',
      'aws cloudtrail delete-trail --name org',
    ],
    allowed: [
      'aws s3 ls s3://bucket/',
      'aws s3 sync ./dist s3://bucket/ --delete --dryrun',
      'aws rds create-db-instance --db-instance-identifier db1 --engine postgres --storage-encrypted --allocated-storage 20',
      'aws ec2 authorize-security-group-ingress --group-id sg-1 --protocol tcp --port 443 --cidr 0.0.0.0/0',
      'aws ec2 describe-instances --filters Name=tag:Owner,Values=platform',
      'aws ssm put-parameter --name /app/DB_PASSWORD --type SecureString --value hunter2hunter2',
      'aws iam list-users',
      'aws autoscaling update-auto-scaling-group --auto-scaling-group-name web --max-size 12',
      'aws sts get-caller-identity',
    ],
  },
  azure: {
    blocked: [
      'az role assignment create --assignee bob@example.com --role Owner --scope /subscriptions/abc',
      'az role assignment create --assignee bob@example.com --role Contributor --scope /subscriptions/abc',
      'az ad sp credential reset --id 123',
      'az network nsg rule create -g rg --nsg-name nsg -n ssh --priority 100 --source-address-prefixes 0.0.0.0/0 --destination-port-ranges 22 --access Allow',
      'az network nsg rule create -g rg --nsg-name nsg -n rdp --destination-port-ranges 3389 --source-address-prefixes Internet',
      'az vm open-port -g rg -n vm1 --port 22',
      'az storage account update -n acct --allow-blob-public-access true',
      'az storage container create -n public --public-access blob',
      'az storage account update -n acct --min-tls-version TLS1_0',
      'az sql server update -n srv -g rg --enable-public-network true',
      'az sql server firewall-rule create -g rg -s srv -n all --start-ip-address 0.0.0.0 --end-ip-address 255.255.255.255',
      'az keyvault purge -n kv',
      'az webapp config appsettings set -g rg -n app --settings DB_PASSWORD=hunter2hunter2',
      'az policy assignment delete -n locations',
      'az security pricing create -n VirtualMachines --tier free',
      'az lock delete -n nodelete -g rg',
      'az group delete -n prod-rg --yes',
      'az aks update -g rg -n prod --api-server-authorized-ip-ranges 0.0.0.0/0',
      'az backup protection disable --delete-backup-data true -g rg -v vault -c c -i i',
      'az consumption budget delete --budget-name main',
      'az vm create -g rg -n vm1 --image Ubuntu2204 --public-ip-sku Standard',
    ],
    allowed: [
      'az role assignment create --assignee bob@example.com --role Reader --scope /subscriptions/abc/resourceGroups/rg',
      'az role assignment create --assignee bob@example.com --role Contributor --scope /subscriptions/abc/resourceGroups/rg',
      'az network nsg rule create -g rg --nsg-name nsg -n https --source-address-prefixes Internet --destination-port-ranges 443',
      'az storage account update -n acct --allow-blob-public-access false --min-tls-version TLS1_2',
      'az webapp config appsettings set -g rg -n app --settings DB_PASSWORD=@Microsoft.KeyVault(SecretUri=https://kv.vault.azure.net/secrets/db)',
      'az vm create -g rg -n vm1 --image Ubuntu2204 --public-ip-address ""',
      'az group list',
      'az aks get-credentials -g rg -n prod',
    ],
  },
  gcp: {
    blocked: [
      'gcloud projects add-iam-policy-binding my-proj --member user:bob@example.com --role roles/owner',
      'gcloud projects add-iam-policy-binding my-proj --member=group:devs@example.com --role=roles/editor',
      'gsutil iam ch allUsers:objectViewer gs://bucket',
      'gcloud run deploy api --image gcr.io/p/api --allow-unauthenticated',
      'gcloud iam service-accounts keys create key.json --iam-account sa@p.iam.gserviceaccount.com',
      'gcloud compute firewall-rules create ssh --source-ranges 0.0.0.0/0 --allow tcp:22',
      'gcloud compute firewall-rules create all --allow all --source-ranges=0.0.0.0/0',
      'gsutil acl ch -u AllUsers:R gs://bucket/file',
      'gcloud storage buckets update gs://bucket --no-public-access-prevention',
      'gcloud sql instances patch db1 --assign-ip',
      'gcloud sql instances patch db1 --authorized-networks=0.0.0.0/0',
      'gcloud sql instances patch db1 --no-backup',
      'gcloud sql instances delete db1',
      'gcloud org-policies reset iam.disableServiceAccountKeyCreation --project p',
      'gcloud storage buckets create gs://bucket --location us',
      'gcloud logging buckets update _Default --location global --retention-days 7',
      'gcloud container clusters update prod --enable-legacy-authorization',
      'gcloud container clusters create prod --no-enable-private-nodes',
      'gcloud projects delete my-proj',
      'gcloud billing projects unlink my-proj',
      'gcloud run deploy api --image gcr.io/p/api --set-env-vars API_KEY=sk_live_abcdefgh',
      'gcloud secrets delete db-password',
      'gcloud access-context-manager perimeters delete prod',
      'gcloud compute instances create vm1 --zone us-central1-a --address 34.1.2.3',
    ],
    allowed: [
      'gcloud projects add-iam-policy-binding my-proj --member group:devs@example.com --role roles/viewer',
      'gcloud run deploy api --image gcr.io/p/api --no-allow-unauthenticated --set-secrets API_KEY=api-key:latest',
      'gcloud compute firewall-rules create https --source-ranges 0.0.0.0/0 --allow tcp:443',
      'gcloud compute firewall-rules create ssh-iap --source-ranges 35.235.240.0/20 --allow tcp:22',
      'gcloud storage buckets create gs://bucket --location us-central1',
      'gcloud sql instances patch db1 --no-assign-ip',
      'gcloud logging buckets update audit --location global --retention-days 400',
      'gcloud compute instances create vm1 --zone us-central1-a --no-address --shielded-secure-boot',
      'gcloud config list',
    ],
  },
  migrate: {
    blocked: [
      'aws s3 sync ./data s3://target/ --delete',
      'gsutil -m rsync -d -r ./data gs://target',
      'azcopy sync ./data https://acct.blob.core.windows.net/c --delete-destination true',
      'rclone sync source: target: --delete-during',
      'aws secretsmanager get-secret-value --secret-id prod/db > secrets.json',
      'kubectl get secrets -A -o yaml > all-secrets.yaml',
      'gcloud secrets versions access latest --secret db-password > pw.txt',
      'rm -rf /var/lib/mysql',
      'mysql -e "DROP DATABASE legacy"',
      'terraform destroy -target module.legacy',
    ],
    allowed: [
      'aws s3 sync ./data s3://target/ --delete --dryrun',
      'aws s3 sync ./data s3://target/',
      'gsutil -m rsync -r ./data gs://target',
      'rsync -av --dry-run --delete ./data/ host:/srv/data/',
      'aws secretsmanager get-secret-value --secret-id prod/db',
      'kubectl get secrets -n app',
      'terraform plan',
      'mysql -e "SELECT COUNT(*) FROM orders"',
    ],
  },
};

for (const [id, { blocked, allowed }] of Object.entries(cases)) {
  const rules = rulesFor(id);
  test(`${id}: dangerous commands are stopped`, () => {
    for (const cmd of blocked) {
      const v = decide(cmd, rules);
      assert.ok(v && v.decision !== 'allow', `${id} should stop: ${cmd}`);
    }
  });
  test(`${id}: ordinary work passes`, () => {
    for (const cmd of allowed) {
      const v = decide(cmd, rules);
      assert.ok(!v || v.decision === 'allow', `${id} should allow: ${cmd} (${v && v.decision}: ${(v && (v.rule || v.reason)) || ''})`);
    }
  });
}
