/**
 * Plan de la documentation publique : liste ordonnée des pages (sommaire,
 * surlignage de la page courante, liens précédent/suivant). Les hrefs sont
 * des routes internes SANS le préfixe GitHub Pages — passer par siteUrl().
 */
export interface DocPage {
  /** Identifiant stable — pilote le sommaire et les voisins. */
  id: string;
  /** Route interne, slash final compris (répertoires servis par Pages). */
  href: string;
  label: string;
  description: string;
}

export const docPages: DocPage[] = [
  {
    id: 'home',
    href: '/docs/',
    label: 'Accueil',
    description: "Le point d'entrée : trois façons de commencer selon qui vous êtes.",
  },
  {
    id: 'start',
    href: '/docs/start/',
    label: 'Créer votre premier site',
    description:
      'Dix étapes, du template GitHub au premier contenu publié — à la main ou avec une IA.',
  },
  {
    id: 'concepts',
    href: '/docs/concepts/',
    label: 'Comprendre Kreiz',
    description:
      'Le moteur et votre site, le back-office, Save ≠ Publish — en langage humain.',
  },
  {
    id: 'ai',
    href: '/docs/ai/',
    label: "Kreiz et l'IA",
    description:
      'Le prompt maître à copier et des exemples de demandes pour bien cadrer votre IA.',
  },
  {
    id: 'customize',
    href: '/docs/customize/',
    label: 'Personnaliser votre site',
    description:
      'Style, composants, pages, types de contenu, formulaires : tout vit dans votre Project.',
  },
  {
    id: 'deploy',
    href: '/docs/deploy/',
    label: 'Déployer',
    description:
      'Vercel, variables de production, rebuild après publication, cron de maintenance.',
  },
  {
    id: 'developer',
    href: '/docs/developer/',
    label: 'Documentation développeur',
    description:
      'La couche avancée : architecture, API publique, configuration, opérations.',
  },
];

export interface DocNavGroup {
  title: string;
  pages: DocPage[];
}

/** Sommaire groupé de la barre latérale. */
export const docNavGroups: DocNavGroup[] = [
  {
    title: 'Commencer',
    pages: docPages.filter((page) => ['home', 'start', 'concepts'].includes(page.id)),
  },
  {
    title: 'Au quotidien',
    pages: docPages.filter((page) => ['ai', 'customize', 'deploy'].includes(page.id)),
  },
  {
    title: 'Aller plus loin',
    pages: docPages.filter((page) => page.id === 'developer'),
  },
];

/** Page précédente / suivante dans l'ordre de lecture (hors accueil). */
export function docNeighbors(id: string): { prev?: DocPage; next?: DocPage } {
  const readingOrder = docPages.filter((page) => page.id !== 'home');
  const index = readingOrder.findIndex((page) => page.id === id);
  if (index === -1) return {};
  return {
    prev: index > 0 ? readingOrder[index - 1] : undefined,
    next: index < readingOrder.length - 1 ? readingOrder[index + 1] : undefined,
  };
}
