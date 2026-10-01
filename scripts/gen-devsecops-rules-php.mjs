// Emits the DevSecOps pack as a PHP array for the hifriendbot.com /devsecops/ page.
// Usage: node scripts/gen-devsecops-rules-php.mjs > <plugin>/public/templates/devsecops-rules.php
import { findPack } from '../build/packs.js';
const pack = findPack('devsecops');
const groups = [
  ['Secrets', /^secrets_/],
  ['Infrastructure as code', /^iac_/],
  ['Identity, access and network', /^(iam_|network_|access_)/],
  ['CI/CD, change control and supply chain', /^(cicd_|change_|supply_)/],
  ['Containers and Kubernetes', /^(containers_|kubernetes_)/],
  ['Data', /^data_/],
  ['Logging and monitoring', /^(logs_|monitoring_)/],
  ['Incident response', /^incident_/],
  ['The agent itself', /^agents_/],
];
const esc = (s) => s.split('\\').join('\\\\').split("'").join("\\'");
let php = '<?php\n// Generated from cogmemai-mcp src/packs.ts (DevSecOps pack, cogmemai-mcp ' + pack.rules.length + ' rules). Regenerate with scripts/gen-devsecops-rules-php.mjs; do not edit by hand.\nreturn array(\n';
let total = 0;
for (const [name, re] of groups) {
  const rules = pack.rules.filter((r) => re.test(r.subject));
  total += rules.length;
  php += "    array('group' => '" + esc(name) + "', 'rules' => array(\n";
  for (const r of rules) {
    const lines = r.content.split('\n');
    const prose = lines.filter((l) => !/^GUARD:/i.test(l)).join(' ').trim();
    const first = prose.split(/(?<=[.!?])\s+/)[0];
    const rest = prose.slice(first.length).trim();
    const guards = lines.filter((l) => /^GUARD:/i.test(l) && !/^GUARD:\s*off/i.test(l)).length;
    php += "        array('subject' => '" + esc(r.subject) + "', 'rule' => '" + esc(first) + "', 'why' => '" + esc(rest) + "', 'patterns' => " + guards + "),\n";
  }
  php += '    )),\n';
}
php += ');\n';
if (total !== pack.rules.length) throw new Error('grouping missed rules: ' + total + ' of ' + pack.rules.length);
process.stdout.write(php);
