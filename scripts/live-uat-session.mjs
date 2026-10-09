// Keep the delegated credential in memory for follow-up checks, never on disk.
// Only the fixed local UAT module can be invoked; no arbitrary commands/eval.
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
const input = createInterface({input:process.stdin,output:process.stdout});
process.env.PURVIEW_UAT_KEEP_SESSION='1';
async function run() { await import(`./live-tenant-uat.mjs?run=${randomUUID()}`); console.log('UAT_SESSION_READY: enter auto to rerun auto-label checks, or stop to close.'); }
await run();
for await(const line of input) {
  if(line.trim()==='stop') {input.close();process.exit(0);}
  if(line.trim()==='auto') {process.env.PURVIEW_UAT_AUTO_ONLY='1';await run();}
}
