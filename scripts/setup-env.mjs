import { constants, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);

for (const directory of ['', 'apps/web/']) {
  const source = new URL(`${directory}.env.example`, root);
  const target = new URL(`${directory}.env`, root);

  try {
    copyFileSync(source, target, constants.COPYFILE_EXCL);
    console.info(`Created ${fileURLToPath(target)}`);
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }
  }
}
