// Emits the migrate, aws, azure and gcp packs as a PHP array for the hifriendbot.com /migrate/ page.
// Usage: node scripts/gen-migrate-rules-php.mjs > <plugin>/public/templates/migrate-rules.php
import { findPack } from '../build/packs.js';
const esc = (s) => s.split('\\').join('\\\\').split("'").join("\\'");
let php = '<?php\n// Generated from cogmemai-mcp src/packs-cloud.ts (migrate, aws, azure, gcp packs). Regenerate with scripts/gen-migrate-rules-php.mjs; do not edit by hand.\nreturn array(\n';
for (const id of ['migrate', 'aws', 'azure', 'gcp']) {
  const pack = findPack(id);
  php += "    array('id' => '" + id + "', 'group' => '" + esc(pack.name) + "', 'description' => '" + esc(pack.description) + "', 'rules' => array(\n";
  for (const r of pack.rules) {
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
process.stdout.write(php);
