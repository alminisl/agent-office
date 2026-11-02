// Invoked only through the temporary executable created by fakeClaude().
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const index = args.indexOf('--session-id');
if (index === -1) process.exit(0); // startup MCP probe
const id = args[index + 1];
const dir = process.env.FAKE_CLAUDE_CONTROL;
const release = path.join(dir, `${id}.release`);
const finish = () => {
  if (!fs.existsSync(release)) return;
  watcher.close();
  clearTimeout(limit);
  process.stdout.write(JSON.stringify({ result: 'Fixture completed', total_cost_usd: 0 }));
};
const watcher = fs.watch(dir, finish);
const limit = setTimeout(() => process.exit(2), 30000);
fs.writeFileSync(path.join(dir, `${id}.pid`), String(process.pid));
finish();
