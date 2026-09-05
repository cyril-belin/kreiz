import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Copie les assets UI du shell admin (pages .astro, CSS) de `src/` vers
 * `dist/` — tsc ne compile ni ne déplace ces fichiers, mais l'intégration
 * Astro les injecte depuis `dist/` (entrypoints `injectRoute`) et les
 * pages importent leurs modules depuis l'arborescence `dist/`.
 *
 * Idempotent : recopie l'arborescence à chaque build.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcAdmin = join(root, 'src', 'admin');
const distAdmin = join(root, 'dist', 'admin');

if (!existsSync(distAdmin)) {
  mkdirSync(distAdmin, { recursive: true });
}

/**
 * Copie récursive des fichiers non compilés par tsc (.astro, .css).
 * Les .ts éventuels sont exclus : ils passent par tsc.
 */
function copyRecursively(from, to) {
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(target, { recursive: true });
      copyRecursively(source, target);
    } else if (entry.isFile() && /\.(astro|css)$/.test(entry.name)) {
      cpSync(source, target);
    }
  }
}

if (!statSync(srcAdmin).isDirectory()) {
  console.error(`@kreiz/core : ${srcAdmin} introuvable.`);
  process.exit(1);
}

copyRecursively(srcAdmin, distAdmin);
console.log('@kreiz/core : assets admin copiés vers dist/admin.');
