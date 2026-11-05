import process from 'node:process';
// Installed tarballs have no hooks; repository checkouts opt into Husky.
import { existsSync } from 'node:fs';
if (existsSync('.git') && process.env.HUSKY !== '0') {
  const { default: husky } = await import('husky');
  process.stdout.write(husky());
}
