// Arranca servidor (puerto 3000) y panel (puerto 5173) juntos.
import { spawn } from 'node:child_process';
const run = (name, cwd, args) => {
  const p = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  p.on('exit', (code) => { console.log(`[${name}] terminó (${code})`); process.exit(code ?? 0); });
  return p;
};
const procs = [run('server', 'server', ['run', 'dev']), run('web', 'web', ['run', 'dev'])];
process.on('SIGINT', () => { procs.forEach((p) => p.kill()); process.exit(0); });
