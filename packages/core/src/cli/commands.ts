/**
 * Logique de commandes du CLI `kreiz` — **sans I/O terminal**.
 *
 * Les fonctions reçoivent des entrées déjà assemblées (flags + prompts)
 * et retournent des résultats typés ; l'assemblage interactif est piloté
 * par l'interface `CommandIo` fournie par le bin. Cette séparation permet
 * de tester les commandes sans TTY (cadrage §17, mission slice 2 §28).
 */
import {
  isPasswordAcceptable,
  parseAdminEmail,
  PASSWORD_MIN_LENGTH,
  validatePasswordPolicy,
} from '../domain/auth.js';
import type { AdminAuthService } from '../services/admin-auth.js';

export type CommandIo = {
  /** Sortie standard (progrès, succès). */
  out: (message: string) => void;
  /** Sortie d'erreur (échec). */
  err: (message: string) => void;
  /** Question à réponse visible. */
  ask: (label: string) => Promise<string>;
  /** Question à réponse masquée (mot de passe). */
  askHidden: (label: string) => Promise<string>;
};

export type CommandResult =
  | { ok: true; message: string }
  | { ok: false; message: string };

const PASSWORD_CONFIRM_ATTEMPTS = 3;

/** Demande un mot de passe avec confirmation, en ré-affichant jusqu'à concordance. */
async function askPasswordWithConfirmation(
  io: CommandIo,
  label: string,
): Promise<string | null> {
  for (let attempt = 1; attempt <= PASSWORD_CONFIRM_ATTEMPTS; attempt++) {
    const password = await io.askHidden(label);
    if (!isPasswordAcceptable(password)) {
      const issues = validatePasswordPolicy(password)
        .map((issue) => `- ${issue.message}`)
        .join('\n');
      io.err(`Mot de passe refusé :\n${issues}`);
      continue;
    }
    const confirmed = await io.askHidden('Confirmation du mot de passe : ');
    if (password !== confirmed) {
      io.err('Les deux mots de passe ne correspondent pas.');
      continue;
    }
    return password;
  }
  io.err(`Abandon : pas de mot de passe valide après ${PASSWORD_CONFIRM_ATTEMPTS} essais.`);
  return null;
}

export type AdminCreateInputs = {
  email?: string;
  name?: string;
  password?: string;
};

/**
 * `admin:create` — assemble les entrées (prompt interactif si manquant),
 * valide, crée l'admin. Les valeurs des flags ne sont jamais réaffichées
 * (mot de passe) et l'email est normalisé avant unicité.
 */
export async function runAdminCreate(
  auth: AdminAuthService,
  flags: AdminCreateInputs,
  io: CommandIo,
): Promise<CommandResult> {
  let email = flags.email ?? (await io.ask('Email de l’admin : '));
  const parsedEmail = parseAdminEmail(email);
  if (!parsedEmail) {
    return { ok: false, message: `Email invalide : « ${email.trim()} ».` };
  }
  email = parsedEmail;

  let name = flags.name ?? (await io.ask('Nom affiché : '));
  name = name.trim();
  if (name.length < 1 || name.length > 120) {
    return { ok: false, message: 'Le nom affiché doit contenir entre 1 et 120 caractères.' };
  }

  let password = flags.password ?? null;
  if (password === null) {
    password = await askPasswordWithConfirmation(io, 'Mot de passe : ');
    if (password === null) return { ok: false, message: 'Création abandonnée.' };
  } else if (!isPasswordAcceptable(password, { email })) {
    const issues = validatePasswordPolicy(password, { email })
      .map((issue) => `- ${issue.message}`)
      .join('\n');
    return {
      ok: false,
      message: `Mot de passe refusé (politique : ≥ ${PASSWORD_MIN_LENGTH} caractères) :\n${issues}`,
    };
  }

  const outcome = await auth.createAdmin({ email, name, password });
  switch (outcome.kind) {
    case 'created':
      return {
        ok: true,
        message: `Admin créé : ${outcome.admin.email} (${outcome.admin.name}).`,
      };
    case 'email-exists':
      return { ok: false, message: `Un admin existe déjà avec l’email ${email}.` };
    case 'invalid-password':
      return {
        ok: false,
        message: `Mot de passe refusé :\n${outcome.issues.map((issue) => `- ${issue.message}`).join('\n')}`,
      };
  }
}

export type AdminResetPasswordInputs = {
  email?: string;
  password?: string;
};

/**
 * `admin:reset-password` — nouveau mot de passe puis **révocation de
 * toutes les sessions actives** de l'admin. Refuse proprement un email
 * inconnu (pas d'indice de présence, l'information reste côté CLI).
 */
export async function runAdminResetPassword(
  auth: AdminAuthService,
  flags: AdminResetPasswordInputs,
  io: CommandIo,
): Promise<CommandResult> {
  let email = flags.email ?? (await io.ask('Email de l’admin : '));
  const parsedEmail = parseAdminEmail(email);
  if (!parsedEmail) {
    return { ok: false, message: `Email invalide : « ${email.trim()} ».` };
  }
  email = parsedEmail;

  let password = flags.password ?? null;
  if (password === null) {
    password = await askPasswordWithConfirmation(io, 'Nouveau mot de passe : ');
    if (password === null) return { ok: false, message: 'Réinitialisation abandonnée.' };
  } else if (!isPasswordAcceptable(password, { email })) {
    const issues = validatePasswordPolicy(password, { email })
      .map((issue) => `- ${issue.message}`)
      .join('\n');
    return {
      ok: false,
      message: `Mot de passe refusé (politique : ≥ ${PASSWORD_MIN_LENGTH} caractères) :\n${issues}`,
    };
  }

  const outcome = await auth.resetPassword({ email, password });
  switch (outcome.kind) {
    case 'reset':
      return {
        ok: true,
        message: `Mot de passe réinitialisé pour ${email} — ${outcome.revokedSessions} session(s) révoquée(s).`,
      };
    case 'unknown-admin':
      return { ok: false, message: `Aucun admin avec l’email ${email}.` };
    case 'invalid-password':
      return {
        ok: false,
        message: `Mot de passe refusé :\n${outcome.issues.map((issue) => `- ${issue.message}`).join('\n')}`,
      };
  }
}
