import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

console.log('Starting backend server...');

const server = spawn(
  'node',
  ['--experimental-strip-types', join(__dirname, 'api/server.ts')],
  {
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'development' },
  },
);

server.on('error', (err) => {
  console.error('Failed to start backend server:', err);
});
