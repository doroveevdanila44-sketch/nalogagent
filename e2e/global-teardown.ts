import fs from 'node:fs';

export default async function globalTeardown(): Promise<void> {
  fs.rmSync('.data/e2e-password', { force: true });
}
