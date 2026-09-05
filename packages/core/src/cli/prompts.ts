/**
 * I/O terminal du CLI `kreiz` — le seul endroit où le terminal est touché.
 *
 * Les réponses sensibles sont masquées via le mode raw de TTY (aucune
 * dépendance, pas d'echo). En l'absence de TTY (pipe), repli sur une
 * lecture de ligne simple — c'est le mode utilisé par les tests et les
 * scripts non interactifs, qui passent alors par `--password`/`--password-stdin`.
 */
import { createInterface } from 'node:readline/promises';

const CTRL_C = '\u0003';
const BACKSPACE = ['\u007f', '\b'];

function readLineRaw(label: string, options: { echo: boolean }): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const stdout = process.stdout;

    if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
      // Entrée non interactive : lecture d'une ligne, sans masquage possible.
      const rl = createInterface({ input: stdin });
      stdout.write(options.echo ? label : `${label} (entrée non interactive, non masquée) `);
      rl.question('')
        .then((answer) => {
          rl.close();
          stdout.write('\n');
          resolve(answer.trim());
        })
        .catch(reject);
      return;
    }

    stdout.write(label);
    let value = '';

    const onSignalInterrupt = () => {
      cleanup();
      stdout.write('\n');
      process.exit(130);
    };

    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === CTRL_C) {
          onSignalInterrupt();
          return;
        }
        if (char === '\r' || char === '\n') {
          cleanup();
          stdout.write('\n');
          resolve(value);
          return;
        }
        if (BACKSPACE.includes(char)) {
          if (value.length > 0) {
            value = value.slice(0, -1);
            if (options.echo) stdout.write('\b \b');
          }
          continue;
        }
        // Ignorer les autres caractères de contrôle.
        if (char < ' ') continue;
        value += char;
        if (options.echo) stdout.write(char);
      }
    };

    function cleanup() {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      stdin.removeListener('SIGINT', onSignalInterrupt);
    }

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.on('SIGINT', onSignalInterrupt);
    stdin.on('data', onData);
  });
}

/** Question à réponse visible (email, nom…). */
export function askVisible(label: string): Promise<string> {
  return readLineRaw(label, { echo: true });
}

/** Question à réponse masquée (mot de passe). */
export function askHidden(label: string): Promise<string> {
  return readLineRaw(label, { echo: false });
}
