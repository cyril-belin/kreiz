import { Node, mergeAttributes } from '@tiptap/core';

/**
 * Node `media` de l'adaptateur Tiptap (slice 6 §10) — la seule partie du
 * système qui connaît à la fois le format Kreiz et le runtime d'édition.
 *
 * Le node stocke **une référence stable** (`mediaId`) et une donnée
 * éditoriale (`caption`) — jamais d'URL présignée, jamais d'URL S3 brute,
 * jamais d'`<img>` sérialisée : la source publique est résolue au rendu par
 * le pipeline média du slice 5. L'insertion passe par le picker (médias
 * `ready`) ; le collage de HTML ne fabrique jamais de node média hors
 * référence valide (`data-media-id`, même forme que le clipboard interne).
 */

/** Informations de miniature fournies par le picker (DOM serveur). */
export interface RichTextMediaInfo {
  thumbnailUrl: string | null;
  alt: string;
  width: number | null;
  height: number | null;
}

export function createRichTextMediaExtension(options: {
  /** Registre id → miniature construit depuis le picker serveur. */
  getMediaInfo: (mediaId: string) => RichTextMediaInfo | undefined;
}) {
  return Node.create({
    name: 'media',
    group: 'block',
    atom: true,
    draggable: true,

    addAttributes() {
      return {
        mediaId: {
          default: '',
          // Forme clipboard interne : `data-media-id` / `data-caption`.
          parseHTML: (element: HTMLElement) => element.getAttribute('data-media-id') ?? '',
        },
        caption: {
          default: '',
          parseHTML: (element: HTMLElement) => element.getAttribute('data-caption') ?? '',
        },
      };
    },

    parseHTML() {
      return [
        {
          tag: 'div[data-media-id]',
          getAttrs: (element) => {
            const id = (element as HTMLElement).getAttribute('data-media-id') ?? '';
            return id.length > 0 ? null : false;
          },
        },
      ];
    },

    renderHTML({ node }) {
      // Sert à la sérialisation clipboard interne ; l'affichage passe par le
      // NodeView ci-dessous.
      return [
        'div',
        mergeAttributes({
          'data-media-id': node.attrs.mediaId,
          'data-caption': node.attrs.caption ?? '',
        }),
      ];
    },

    addNodeView() {
      return ({ node, editor, getPos }) => {
        const container = document.createElement('figure');
        container.className = 'kz-richtext-media';
        container.dataset.mediaId = node.attrs.mediaId;

        const info = options.getMediaInfo(node.attrs.mediaId);
        if (info?.thumbnailUrl) {
          const img = document.createElement('img');
          img.src = info.thumbnailUrl;
          img.alt = '';
          img.loading = 'lazy';
          img.decoding = 'async';
          if (info.width) img.width = info.width;
          if (info.height) img.height = info.height;
          container.appendChild(img);
        } else {
          // Référence inconnue ou média non prêt : état visible et honnête,
          // la référence reste éditable/supprimable (mission §12).
          container.classList.add('kz-richtext-media--missing');
          const placeholder = document.createElement('span');
          placeholder.className = 'kz-richtext-media__placeholder';
          placeholder.textContent = 'Média indisponible ou non prêt';
          container.appendChild(placeholder);
        }

        const caption = document.createElement('input');
        caption.type = 'text';
        caption.className = 'kz-richtext-media__caption';
        caption.placeholder = 'Légende (optionnelle)';
        caption.setAttribute('aria-label', 'Légende de l’image');
        caption.maxLength = 500;
        caption.value = typeof node.attrs.caption === 'string' ? node.attrs.caption : '';
        caption.addEventListener('input', () => {
          const pos = typeof getPos === 'function' ? getPos() : undefined;
          if (typeof pos !== 'number') return;
          const tr = editor.view.state.tr;
          const target = tr.doc.nodeAt(pos);
          if (!target || target.type.name !== 'media') return;
          editor.view.dispatch(
            tr.setNodeMarkup(pos, undefined, { ...target.attrs, caption: caption.value }),
          );
        });
        container.appendChild(caption);

        return {
          dom: container,
          // Les interactions clavier/souris de la légende appartiennent à
          // l'input — jamais au contenteditable (sinon PM avale les frappes).
          stopEvent: (event) => event.composedPath().includes(caption),
          ignoreMutation: () => true,
          update: (updatedNode) => {
            if (updatedNode.type.name !== 'media') return false;
            const nextCaption =
              typeof updatedNode.attrs.caption === 'string' ? updatedNode.attrs.caption : '';
            if (nextCaption !== caption.value) caption.value = nextCaption;
            return true;
          },
        };
      };
    },
  });
}
