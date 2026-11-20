// Obsidian-flavoured additions to the Markdown parser:
// ==highlight==, [[wikilinks]] / ![[embeds]], #tags and YAML frontmatter.
import { tags as t } from '@lezer/highlight';

const HighlightDelim = { resolve: 'Highlight', mark: 'HighlightMark' };

export const Highlight = {
  defineNodes: [{ name: 'Highlight' }, { name: 'HighlightMark', style: t.processingInstruction }],
  parseInline: [
    {
      name: 'Highlight',
      parse(cx, next, pos) {
        if (next !== 61 || cx.char(pos + 1) !== 61 || cx.char(pos + 2) === 61) return -1;
        const before = pos > cx.offset ? cx.slice(pos - 1, pos) : ' ';
        const after = cx.slice(pos + 2, pos + 3);
        const sBefore = /\s|^$/.test(before);
        const sAfter = /\s|^$/.test(after);
        return cx.addDelimiter(HighlightDelim, pos, pos + 2, !sAfter, !sBefore);
      },
      after: 'Emphasis',
    },
  ],
};

export const WikiLinks = {
  defineNodes: [{ name: 'WikiLink' }, { name: 'WikiEmbed' }, { name: 'WikiMark', style: t.processingInstruction }],
  parseInline: [
    {
      name: 'WikiLink',
      before: 'Link',
      parse(cx, next, pos) {
        let start = pos;
        let embed = false;
        if (next === 33) {
          if (cx.char(pos + 1) !== 91 || cx.char(pos + 2) !== 91) return -1;
          embed = true;
          start = pos + 1;
        } else if (next !== 91 || cx.char(pos + 1) !== 91) {
          return -1;
        }
        const end = cx.offset + cx.text.length;
        const rest = cx.slice(start + 2, Math.min(end, start + 2 + 400));
        const close = rest.indexOf(']]');
        if (close <= 0) return -1;
        const inner = rest.slice(0, close);
        if (/[\n[\]]/.test(inner)) return -1;
        const innerEnd = start + 2 + close;
        return cx.addElement(
          cx.elt(embed ? 'WikiEmbed' : 'WikiLink', pos, innerEnd + 2, [
            cx.elt('WikiMark', pos, start + 2),
            cx.elt('WikiMark', innerEnd, innerEnd + 2),
          ])
        );
      },
    },
  ],
};

export const Tags = {
  defineNodes: [{ name: 'Tag', style: t.labelName }],
  parseInline: [
    {
      name: 'Tag',
      before: 'Emphasis',
      parse(cx, next, pos) {
        if (next !== 35) return -1;
        if (pos > cx.offset) {
          const p = cx.char(pos - 1);
          if (!(p === 32 || p === 9 || p === 10 || p === 40)) return -1;
        }
        const end = cx.offset + cx.text.length;
        const m = /^#[\p{L}\p{N}_/-]+/u.exec(cx.slice(pos, Math.min(end, pos + 120)));
        if (!m || /^#\d+$/.test(m[0])) return -1;
        return cx.addElement(cx.elt('Tag', pos, pos + m[0].length));
      },
    },
  ],
};

export const Frontmatter = {
  defineNodes: [{ name: 'Frontmatter', block: true }, { name: 'FrontmatterMark', style: t.processingInstruction }],
  parseBlock: [
    {
      name: 'Frontmatter',
      before: 'HorizontalRule',
      parse(cx, line) {
        if (cx.lineStart !== 0 || !/^---\s*$/.test(line.text)) return false;
        const children = [cx.elt('FrontmatterMark', 0, line.text.length)];
        while (cx.nextLine()) {
          if (/^(---|\.\.\.)\s*$/.test(line.text)) {
            const s = cx.lineStart;
            const e = s + line.text.length;
            children.push(cx.elt('FrontmatterMark', s, e));
            cx.nextLine();
            cx.addElement(cx.elt('Frontmatter', 0, e, children));
            return true;
          }
        }
        cx.addElement(cx.elt('Frontmatter', 0, cx.prevLineEnd(), children));
        return true;
      },
    },
  ],
};
