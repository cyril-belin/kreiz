import { Editor } from '@tiptap/core';
import { Link } from '@tiptap/extension-link';
import { StarterKit } from '@tiptap/starter-kit';
import type { KreizRichTextDocument } from '../../domain/content/rich-text/document.js';
import { isAllowedRichTextLinkHref } from '../../domain/content/rich-text/policy.js';
import {
  documentToEditorContent,
  editorJsonToDocument,
} from './document-adapter.js';
import { createRichTextMediaExtension, type RichTextMediaInfo } from './media-extension.js';

/**
 * Îlot d'édition riche (slice 6) — **adaptateur Tiptap ⇄ format Kreiz**.
 *
 * Frontière assumée : ce module est la seule partie du Core (avec le node
 * média) qui importe le runtime Tiptap/ProseMirror. Il tourne uniquement
 * dans l'admin (bundle navigateur séparé) ; le domaine, le stockage et le
 * rendu public ne connaissent que le format canonique Kreiz.
 *
 * Le schéma de l'éditeur est configuré **exactement** comme le contrat du
 * domaine : nodes/marks autorisés uniquement, niveaux de titre 2–3 (le h1
 * appartient au titre du contenu), liens bornés aux protocoles de la
 * politique. Le serveur revalide tout à la soumission — l'éditeur n'est
 * jamais source d'autorité.
 *
 * Progressive enhancement : sans JavaScript, l'`input` caché conserve la
 * valeur serveur et la soumission repart inchangée (aucune corruption) ;
 * l'éditeur n'est qu'une couche d'édition par-dessus.
 */

/** Interface d'un bouton de toolbar — commande, état actif, disponibilité. */
interface ToolbarAction {
  /** La chaîne reçue est retournée — l'appelant termine par `.run()`. */
  run: (chain: ReturnType<Editor['chain']>) => ReturnType<Editor['chain']>;
  isActive?: (editor: Editor) => boolean;
  can?: (editor: Editor) => boolean;
}

const TOOLBAR_ACTIONS: Record<string, ToolbarAction> = {
  paragraph: { run: (c) => c.setParagraph(), isActive: (e) => e.isActive('paragraph') },
  h2: {
    run: (c) => c.toggleHeading({ level: 2 }),
    isActive: (e) => e.isActive('heading', { level: 2 }),
  },
  h3: {
    run: (c) => c.toggleHeading({ level: 3 }),
    isActive: (e) => e.isActive('heading', { level: 3 }),
  },
  bold: { run: (c) => c.toggleBold(), isActive: (e) => e.isActive('bold') },
  italic: { run: (c) => c.toggleItalic(), isActive: (e) => e.isActive('italic') },
  strike: { run: (c) => c.toggleStrike(), isActive: (e) => e.isActive('strike') },
  code: { run: (c) => c.toggleCode(), isActive: (e) => e.isActive('code') },
  'bullet-list': { run: (c) => c.toggleBulletList(), isActive: (e) => e.isActive('bulletList') },
  'ordered-list': { run: (c) => c.toggleOrderedList(), isActive: (e) => e.isActive('orderedList') },
  blockquote: { run: (c) => c.toggleBlockquote(), isActive: (e) => e.isActive('blockquote') },
  hr: { run: (c) => c.setHorizontalRule() },
  unlink: { run: (c) => c.unsetLink(), can: (e) => e.isActive('link') },
  undo: { run: (c) => c.undo(), can: (e) => e.can().undo() },
  redo: { run: (c) => c.redo(), can: (e) => e.can().redo() },
};

/**
 * Lien restreint : seul `href` est **stocké** (target/rel/class/title sont
 * décidés au rendu par la politique Kreiz, jamais persistés depuis
 * l'éditeur) ; le collage et l'auto-détection passent la même validation
 * que le parseur serveur.
 */
const RestrictedLink = Link.extend({
  addAttributes() {
    return {
      href: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('href'),
      },
    };
  },
}).configure({
  openOnClick: false,
  autolink: true,
  linkOnPaste: true,
  protocols: ['http', 'https', 'mailto'],
  defaultProtocol: 'https',
  isAllowedUri: (href) => isAllowedRichTextLinkHref(href),
});

interface EditorHandle {
  root: HTMLElement;
  editor: Editor;
  hidden: HTMLInputElement;
}

function initEditor(
  root: HTMLElement,
  mediaRegistry: Map<string, RichTextMediaInfo>,
  openMediaPicker: (requesting: HTMLElement) => void,
): EditorHandle | null {
  const hidden = root.querySelector<HTMLInputElement>('input[data-role="richtext-value"]');
  const mount = root.querySelector<HTMLElement>('[data-role="richtext-editor"]');
  const toolbar = root.querySelector<HTMLElement>('[data-role="richtext-toolbar"]');
  if (!hidden || !mount) return null;
  const form = root.closest('form');

  let initial: unknown = null;
  try {
    initial = documentToEditorContent(JSON.parse(hidden.value));
  } catch {
    initial = documentToEditorContent(null);
  }

  const editorId = `${hidden.id}-editor`;
  const label = root.dataset.editorLabel ?? 'Zone d’édition';

  const editor = new Editor({
    element: mount,
    extensions: [
      StarterKit.configure({
        // Contrat métier uniquement — pas de schéma implicite (slice 6 §7).
        heading: { levels: [2, 3] },
        link: false, // lien restreint ajouté ci-dessous (href seul stocké)
        underline: false,
      }),
      RestrictedLink,
      createRichTextMediaExtension({ getMediaInfo: (id) => mediaRegistry.get(id) }),
    ],
    content: initial as KreizRichTextDocument,
    editorProps: {
      attributes: {
        id: editorId,
        class: 'kz-richtext__content',
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': label,
      },
    },
  });

  // ——— Synchronisation hidden ⇄ éditeur ———
  let syncTimer: number | null = null;
  const syncNow = () => {
    if (syncTimer !== null) {
      window.clearTimeout(syncTimer);
      syncTimer = null;
    }
    hidden.value = JSON.stringify(editorJsonToDocument(editor.getJSON()));
  };
  editor.on('update', () => {
    if (syncTimer !== null) window.clearTimeout(syncTimer);
    syncTimer = window.setTimeout(syncNow, 250);
  });
  // Capture : même si un autre handler stoppe la propagation, la valeur part
  // synchronisée — le serveur reçoit toujours l'état de l'éditeur.
  form?.addEventListener('submit', syncNow, true);

  // ——— Toolbar ———
  const buttons = toolbar
    ? Array.from(toolbar.querySelectorAll<HTMLButtonElement>('button[data-command]'))
    : [];
  function refreshToolbarState(): void {
    for (const button of buttons) {
      const action = TOOLBAR_ACTIONS[button.dataset.command ?? ''];
      if (!action) continue;
      if (action.isActive) {
        const active = action.isActive(editor);
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
        button.classList.toggle('kz-richtext__button--active', active);
      }
      if (action.can) {
        button.disabled = !action.can(editor);
      }
    }
  }
  for (const button of buttons) {
    const command = button.dataset.command ?? '';
    if (command === 'link') {
      button.addEventListener('click', () => openLinkDialog(handle, editor));
      continue;
    }
    if (command === 'image') {
      button.addEventListener('click', () => openMediaPicker(root));
      continue;
    }
    const action = TOOLBAR_ACTIONS[command];
    if (!action) continue;
    button.addEventListener('click', () => {
      // Une chaîne Tiptap ne s'exécute qu'à l'appel terminal de `.run()`.
      action.run(editor.chain().focus()).run();
      editor.view.focus();
    });
  }
  editor.on('transaction', refreshToolbarState);
  refreshToolbarState();

  const handle: EditorHandle = { root, editor, hidden };
  return handle;
}

/** Dialogue de lien — prérempli avec le lien courant de la sélection. */
function openLinkDialog(handle: EditorHandle, editor: Editor): void {
  const dialog = handle.root.querySelector<HTMLDialogElement>('[data-role="richtext-link-dialog"]');
  const input = handle.root.querySelector<HTMLInputElement>('[data-role="richtext-link-input"]');
  const errorSlot = handle.root.querySelector<HTMLElement>('[data-role="richtext-link-error"]');
  if (!dialog || !input) return;
  const showError = (message: string) => {
    if (errorSlot) {
      errorSlot.textContent = message;
      errorSlot.hidden = message.length === 0;
    }
  };
  input.value = editor.getAttributes('link').href ?? '';
  showError('');
  dialog.showModal();
  input.focus();
  input.select();

  const apply = () => {
    const href = input.value.trim();
    if (!isAllowedRichTextLinkHref(href)) {
      showError('Lien non autorisé — utilisez http(s), mailto ou un chemin interne (/…).');
      return;
    }
    if (editor.state.selection.empty && !editor.isActive('link')) {
      showError('Sélectionnez d’abord le texte à transformer en lien.');
      return;
    }
    editor.chain().focus().setLink({ href }).run();
    dialog.close();
  };
  const remove = () => {
    editor.chain().focus().unsetLink().run();
    dialog.close();
  };

  dialog.querySelector<HTMLButtonElement>('[data-role="richtext-link-apply"]')
    ?.addEventListener('click', apply);
  dialog.querySelector<HTMLButtonElement>('[data-role="richtext-link-remove"]')
    ?.addEventListener('click', remove);
  dialog.querySelector<HTMLButtonElement>('[data-role="richtext-link-cancel"]')
    ?.addEventListener('click', () => dialog.close());
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      apply();
    }
  });
}

/**
 * Point d'entrée : initialise tous les éditeurs de la page, un registre de
 * miniatures partagé (construit depuis le picker serveur) et **un** picker
 * média par page (dialogue natif, focus géré par le navigateur).
 */
function initRichTextRoots(): void {
  const roots = Array.from(
    document.querySelectorAll<HTMLElement>(
      '[data-kreiz-richtext]:not([data-kreiz-richtext-initialized])',
    ),
  );
  if (roots.length === 0) return;

  const mediaRegistry: Map<string, RichTextMediaInfo> = new Map();
  for (const pick of document.querySelectorAll<HTMLButtonElement>('[data-role="richtext-pick"]')) {
    const id = pick.dataset.mediaId;
    if (!id) continue;
    mediaRegistry.set(id, {
      thumbnailUrl: pick.dataset.mediaThumb || null,
      alt: pick.dataset.mediaAlt ?? '',
      width: pick.dataset.mediaWidth ? Number(pick.dataset.mediaWidth) : null,
      height: pick.dataset.mediaHeight ? Number(pick.dataset.mediaHeight) : null,
    });
  }

  const picker = document.querySelector<HTMLDialogElement>('[data-role="richtext-picker"]');
  const handles: EditorHandle[] = [];

  const openMediaPicker = (requesting: HTMLElement) => {
    if (!picker) return;
    const index = handles.findIndex((handle) => handle.root === requesting);
    picker.dataset.requestedBy = String(index);
    picker.showModal();
  };

  for (const root of roots) {
    root.dataset.kreizRichtextInitialized = 'true';
    try {
      const handle = initEditor(root, mediaRegistry, openMediaPicker);
      if (handle) handles.push(handle);
    } catch (error) {
      // Un éditeur qui échoue ne doit ni casser les autres ni corrompre le
      // formulaire : l'input caché serveur reste la source de la soumission.
      console.error('[kreiz] initialisation de l’éditeur riche impossible :', error);
    }
  }

  if (picker) {
    picker.querySelector<HTMLButtonElement>('[data-role="richtext-picker-close"]')
      ?.addEventListener('click', () => picker.close());
    for (const pick of picker.querySelectorAll<HTMLButtonElement>('[data-role="richtext-pick"]')) {
      pick.addEventListener('click', () => {
        const mediaId = pick.dataset.mediaId ?? '';
        const handle = handles[Number(picker.dataset.requestedBy)] ?? null;
        if (!handle || mediaId.length === 0) {
          picker.close();
          return;
        }
        // Le node média porte la référence stable ; la légende démarre vide
        // (donnée éditoriale — saisie dans le node, jamais devinée).
        handle.editor
          .chain()
          .focus()
          .insertContent({ type: 'media', attrs: { mediaId, caption: '' } })
          .run();
        picker.close();
      });
    }
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initRichTextRoots);
} else {
  initRichTextRoots();
}
