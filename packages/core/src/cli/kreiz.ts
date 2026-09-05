#!/usr/bin/env node
/**
 * CLI `kreiz` (cadrage §6/§10) — administration des comptes.
 *
 *   kreiz admin:create            crée un admin (interactif ou flags)
 *   kreiz admin:reset-password    réinitialise le mot de passe et révoque
 *                                 toutes les sessions de l'admin
 *
 * Accès base : `KREIZ_DATABASE_URL` (validé par `parseKreizDatabaseEnv`,
 * API publique data) — aucun credential en dur, aucun secret bootstrap
 * persistant. Les mots de passe sont hachés en Argon2id par le même
 * service que le back-office.
 */
import { createKreizDatabase } from '../data/connection.js';
import { parseKreizDatabaseEnv } from '../data/env.js';
import { createAdminAuthServiceForDatabase } from '../services/admin-auth.js';
import { runAdminCreate, runAdminResetPassword, type CommandIo } from './commands.js';
import { askHidden, askVisible } from './prompts.js';

const HELP = `kreiz — administration Kreiz

Usage :
  kreiz <commande> [options]

Commandes :
  admin:create            Créer un administrateur
  admin:reset-password    Réinitialiser le mot de passe d'un administrateur
                          (révoque toutes ses sessions actives)

Options communes :
  --email <email>         Email de l'admin (sinon demandé)
  --name <nom>            Nom affiché (admin:create uniquement)
  --password <mot-de-passe>  Mot de passe en clair (sinon demandé, masqué).
                          Attention : visible dans l'historique du shell ;
                          préférer le mode interactif ou --password-stdin.
  --password-stdin        Lire le mot de passe depuis stdin (première ligne)
  -h, --help              Cette aide

Environnement :
  KREIZ_DATABASE_URL      URL PostgreSQL (Neon), ex. postgresql://…
`;

type Flags = {
  email?: string;
  name?: string;
  password?: string;
  passwordStdin?: boolean;
};

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {};
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const readValue = (): string => {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error(`Option ${flag} attend une valeur.`);
      }
      index += 1;
      return value;
    };
    switch (flag) {
      case '--email':
        flags.email = readValue();
        break;
      case '--name':
        flags.name = readValue();
        break;
      case '--password':
        flags.password = readValue();
        break;
      case '--password-stdin':
        flags.passwordStdin = true;
        break;
      default:
        throw new Error(`Option inconnue : ${flag}`);
    }
  }
  return flags;
}

async function readPasswordFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const content = Buffer.concat(chunks).toString('utf8');
  const firstLine = content.split(/\r?\n/, 1)[0] ?? '';
  return firstLine.trim();
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const rest = argv.slice(1);

  if (command === undefined || command === '-h' || command === '--help') {
    process.stdout.write(HELP);
    return 0;
  }

  let flags: Flags;
  try {
    flags = parseFlags(rest);
  } catch (error) {
    process.stderr.write(`kreiz : ${error instanceof Error ? error.message : String(error)}\n\n${HELP}`);
    return 1;
  }

  if (flags.password && flags.passwordStdin) {
    process.stderr.write('kreiz : --password et --password-stdin sont exclusifs.\n');
    return 1;
  }
  if (flags.passwordStdin) {
    flags.password = await readPasswordFromStdin();
  }

  // Accès base explicite — le CLI échoue tôt et proprement sans URL.
  let databaseUrl: string;
  try {
    databaseUrl = parseKreizDatabaseEnv(process.env).KREIZ_DATABASE_URL;
  } catch (error) {
    process.stderr.write(
      `kreiz : ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
  const db = createKreizDatabase({ databaseUrl });
  // Pas de secret ici : le CLI n'effectue jamais de login.
  const auth = createAdminAuthServiceForDatabase(db);

  const io: CommandIo = {
    out: (message) => process.stdout.write(`${message}\n`),
    err: (message) => process.stderr.write(`${message}\n`),
    ask: askVisible,
    askHidden,
  };

  let result;
  switch (command) {
    case 'admin:create':
      result = await runAdminCreate(auth, flags, io);
      break;
    case 'admin:reset-password':
      result = await runAdminResetPassword(auth, flags, io);
      break;
    default:
      process.stderr.write(`kreiz : commande inconnue « ${command} ».\n\n${HELP}`);
      return 1;
  }

  if (result.ok) {
    process.stdout.write(`${result.message}\n`);
  } else {
    process.stderr.write(`kreiz : ${result.message}\n`);
  }
  return result.ok ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    // Aucun contenu sensible ne traverse ces messages (pas de mot de passe,
    // pas de hash, pas de token) — les erreurs DB brutes ne sont pas réaffichées.
    process.stderr.write(
      `kreiz : erreur inattendue — ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
