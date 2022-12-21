import { isEqual, TextDocument, AttributeMap, Line, EditorRange, Delta, Op } from '@typewriter/document';
import { h, patch, VChild, VNode } from './vdom';
import Editor from '../Editor';
import { FormatType, LineType } from '../typesetting/typeset';
import { applyDecorations } from '../modules/decorations';

const EMPTY_ARR = [];
const BR = h('br', {});
const nodeFormatType = new WeakMap();
const linesType = new WeakMap<AttributeMap, LineType>();
const linesMultiples = new WeakMap<Line, Line[]>();
const linesCombined = new WeakMap<Line[], CombinedData>();
const nodeRanges = new WeakMap<HTMLElement, WeakMap<Node, EditorRange>>();

export type CombinedEntry = Line | Line[];
export type Combined = CombinedEntry[];
interface CombinedData {
  combined: Combined;
  byKey:  Record<string, CombinedEntry>;
}
type LineRanges = [EditorRange, EditorRange];
export interface HTMLLineElement extends HTMLElement {
  key: string;
}

export function getLineNodeStart(root: HTMLElement, node: Node) {
  return nodeRanges.get(root)?.get(node)?.[0] as number;
}

export function getLineNodeEnd(root: HTMLElement, node: Node) {
  return nodeRanges.get(root)?.get(node)?.[1] as number;
}

export function setLineNodesRanges(editor: Editor) {
  const { root, doc } = editor;
  const combined = combineLines(editor, doc.lines);
  const ranges = new WeakMap<Node, EditorRange>();
  for (let i = 0; i < root.children.length; i++) {
    const child = root.children[i] as HTMLLineElement;
    if (!child.key) continue;
    const entry = combined.byKey[child.key];
    if (!entry) continue;
    if (Array.isArray(entry)) {
      // set the range for the entire combined section
      ranges.set(child, [ doc.getLineRange(entry[0])[0], doc.getLineRange(entry[entry.length - 1])[1] ]);

      // set the ranges for each line inside
      const lineElements = child.querySelectorAll(editor.typeset.lines.selector) as any as HTMLLineElement[];
      for (let i = 0; i < lineElements.length; i++) {
        const lineElement = lineElements[i];
        const line = doc.getLineBy(lineElement.key);
        if (!line) continue;
        ranges.set(lineElement, doc.getLineRange(line));
      }
    } else {
      ranges.set(child, doc.getLineRange(entry));
    }
  }
  const lineElements = root.querySelectorAll(editor.typeset.lines.selector) as any as HTMLLineElement[];
  for (let i = 0; i < lineElements.length; i++) {
    const lineElement = lineElements[i];
    if (ranges.has(lineElement) || !lineElement.key) continue;
    const line = doc.getLineBy(lineElement.key);
    ranges.set(lineElement, doc.getLineRange(line));
  }
  nodeRanges.set(root, ranges);
}


export function render(editor: Editor, doc: TextDocument) {
  const { root } = editor;
  editor.dispatchEvent(new Event('rendering'));
  patch(root, renderDoc(editor, doc)) as HTMLElement;
  setLineNodesRanges(editor);
  editor.dispatchEvent(new Event('render'));
  editor.dispatchEvent(new Event('rendered'));
}


export function renderChanges(editor: Editor, oldDoc: TextDocument, newDoc: TextDocument) {
  const { root } = editor;
  // Ranges of line indexes, not document indexes
  const oldCombined = combineLines(editor, oldDoc.lines).combined;
  const newCombined = combineLines(editor, newDoc.lines).combined;
  const [ oldRange, newRange ] = getChangedRanges(oldCombined, newCombined);

  // If the changes include added or deleted lines, expand ranges by 1 on each side to ensure the vdom can rerender
  if (!isEqual(oldRange, newRange)) {
    oldRange[0] = Math.max(0, oldRange[0] - 1);
    newRange[0] = Math.max(0, newRange[0] - 1);
    oldRange[1] = Math.min(oldCombined.length, oldRange[1] + 1);
    newRange[1] = Math.min(newCombined.length, newRange[1] + 1);
    if (root.childNodes.length !== oldCombined.length) {
      // The DOM has changed since we last rendered, adjust the oldRange accordingly to get the correct slice
      oldRange[1] += root.childNodes.length - oldCombined.length;
    }
  }

  const oldSlice = Array.from(root.childNodes).slice(oldRange[0], oldRange[1]);
  const newSlice = newCombined.slice(newRange[0], newRange[1]);
  if (!oldSlice.length && !newSlice.length) return render(editor, newDoc);
  editor.dispatchEvent(new Event('rendering'));
  patch(root, renderCombined(editor, newSlice), oldSlice) as HTMLElement;
  setLineNodesRanges(editor);
  editor.dispatchEvent(new Event('render'));
  editor.dispatchEvent(new Event('rendered'));
}

export function renderDoc(editor: Editor, doc: TextDocument, forHTML?: boolean) {
  return renderCombined(editor, combineLines(editor, doc.lines).combined, forHTML);
}

export function renderCombined(editor: Editor, combined: Combined, forHTML?: boolean) {
  return combined.map(line => renderLine(editor, line, forHTML)).filter(Boolean) as VNode[];
}

export function renderLine(editor: Editor, line: CombinedEntry, forHTML?: boolean) {
  return Array.isArray(line) ? renderMultiLine(editor, line, forHTML) : renderSingleLine(editor, line, forHTML);
}

export function renderSingleLine(editor: Editor, line: Line, forHTML?: boolean) {
  const type = getLineType(editor, line);
  if (!type.render) throw new Error('No render method defined for line');
  const node = type.render(line.attributes as AttributeMap, renderInline(editor, line.content), editor, forHTML);
  applyDecorations(node, line.attributes);
  node.key = line.id;
  return node;
}

export function renderMultiLine(editor: Editor, lines: Line[], forHTML?: boolean) {
  const type = getLineType(editor, lines[0]);
  if (!type.renderMultiple) throw new Error('No render method defined for line');
  const node = type.renderMultiple(lines.map(line => [ line.attributes, renderInline(editor, line.content), line.id ]), editor, forHTML);
  node.key = lines[0].id;
  return node;
}

// Join multi-lines into arrays. Memoize the results.
export function combineLines(editor: Editor, lines: Line[]): CombinedData {
  const cache = linesCombined.get(lines);
  if (cache) return cache;

  const combined: Combined = [];
  const byKey: Record<string, CombinedEntry> = {};
  let collect: Line[] = [];

  lines.forEach((line, i) => {
    const type = getLineType(editor, line);

    if (type.shouldCombine) {
      collect.push(line);
      const next = lines[i + 1];
      if (!next || getLineType(editor, next) !== type || !type.shouldCombine(collect[0].attributes, next.attributes)) {
        // By keeping the last array reference we can optimize updates
        const last = linesMultiples.get(collect[0]);
        if (last && last.length === collect.length && collect.every((v, i) => last[i] === v)) {
          collect = last;
        } else {
          linesMultiples.set(collect[0], collect);
        }
        combined.push(collect);
        byKey[collect[0].id] = collect;
        collect = [];
      }
    } else if (type.render) {
      combined.push(line);
      byKey[line.id] = line;
    }
  });

  const data = { combined, byKey };
  linesCombined.set(lines, data);
  return data;
}

// Most changes will occur to adjacent lines, so the simplistic approach
export function getChangedRanges(oldC: Combined, newC: Combined): LineRanges {
  const oldLength = oldC.length;
  const newLength = newC.length;
  const minLength = Math.min(oldLength, newLength);
  let oldStart = 0, oldEnd = 0, newStart = 0, newEnd = 0;
  for (let i = 0; i < minLength; i++) {
    if (!isSame(oldC[i], newC[i])) {
      oldStart = newStart = i;
      break;
    }
  }
  for (let i = 0; i < minLength; i++) {
    if (!isSame(oldC[oldLength - i - 1], newC[newLength - i - 1])) {
      oldEnd = oldLength - i;
      newEnd = newLength - i;
      break;
    }
  }
  return [[ oldStart, oldEnd ], [ newStart, newEnd ]];
}

interface InlineStackItem {
  type: FormatType
  attributes: AttributeMap
  content?: VChild[]
}

export function renderInline(editor: Editor, delta: Delta, forHTML?: boolean) {
  const { formats, embeds } = editor.typeset;
  let inlineChildren: VChild[] = [];
  let trailingBreak = true;
  
  // The stack allows parent formats to span multiple child formats at render() time
  // This means that the FormatType has a complete understanding of its children and can
  // add additional nodes before or after the actual children.
  let activeStack: InlineStackItem[] = [];

  // Render out all nodes up to the given index.
  // A positive number means that rendered items will be appended to their parent.
  function collapseStack(from = 0) {
    let children: VChild[] | undefined = undefined;

    while (activeStack.length > from) {
      const item = activeStack.pop();
      if (!item || !item.type.render) break;

      children = combineChildren(item.content, children);

      const node = item.type.render(item.attributes, children, editor, forHTML)
      if (node) {
        nodeFormatType.set(node, item.type); // Store for merging
        children = [node];
      }
    }

    if (children) {
      if (activeStack.length === 0) {
        // The stack is fully collapsed and can be appended to the final list
        inlineChildren.push.apply(inlineChildren, children);
      } else {
        // The stack is not yet fully collapsed.
        // Collapsed child gets placed in its parent.
        const last = activeStack[activeStack.length - 1];
        if (last.content) {
          last.content.push.apply(last.content, children)
        } else {
          last.content = children
        }
      }
    }
  }

  // Consideres the type and attributes at a given index, collapsing the stack if necessary
  function insertStackItem(index: number, type: FormatType, attributes: AttributeMap) {
    const active = activeStack[index];
    if (active) {
      if (active.type === type && isEqual(active.attributes[active.type.name], attributes[type.name])) {
        // A new item would match the existing item
        // Nothing needs to happen
        return;
      } else {
        // The new information conflicts and will be a new node.
        collapseStack(index);
      }
    }

    activeStack.push({ type, attributes })
  }

  delta.ops.forEach((op, i, array) => {
    let children: VChild[] = [];
    
    if (typeof op.insert === 'string') {
      const prev = array[i - 1];
      const next = array[i + 1];
      let str: string = op.insert.replace(/  /g, '\xA0 ').replace(/  /g, ' \xA0');
      if (!prev || typeof prev.insert === 'object') str = str.replace(/^ /, '\xA0');
      if (!next || typeof next.insert === 'object' || startsWithSpace(next)) str = str.replace(/ $/, '\xA0');
      trailingBreak = false;
      children.push(str);
    } else if (op.insert) {
      const embed = embeds.findByAttributes(op.insert);
      if (embed?.render) {
        children.push(embed.render(op.insert, EMPTY_ARR, editor, forHTML));
        if (embed.name === 'br') trailingBreak = true;
        else if (!embed.noFill) trailingBreak = false;
      }
    }

    if (op.attributes) {
      let stackIndex = 0;
      // Sort them by the order found in formats
      const sortedKeys = Object.keys(op.attributes).sort((a, b) => formats.priority(a) - formats.priority(b));
      // Add each renderable type to the stack
      sortedKeys.forEach((name, index) => {
        const type = formats.get(name);
        if (type?.render) {
          insertStackItem(stackIndex, type, op.attributes as AttributeMap);
          stackIndex++;
        }
      });

      const last = activeStack[activeStack.length - 1];
      if (last) {
        // Append the new children to any existing children in the last stack item
        last.content = combineChildren(last.content, children);
      }
    } else {
      collapseStack();
      inlineChildren = combineChildren(inlineChildren, children);
    }
  });

  if (activeStack.length > 0) collapseStack();

  if (trailingBreak) inlineChildren.push(BR);

  return inlineChildren;
}


function isSame(oldEntry: CombinedEntry, newEntry: CombinedEntry): boolean {
  if (oldEntry === newEntry) return true;
  return Array.isArray(oldEntry)
    && Array.isArray(newEntry)
    && oldEntry.length === newEntry.length
    && oldEntry.every((b, i) => b === newEntry[i]);
}


function getLineType(editor: Editor, line: Line): LineType {
  let type = linesType.get(line.attributes);
  if (!type) {
    type = editor.typeset.lines.findByAttributes(line.attributes, true);
    linesType.set(line.attributes, type);
  }
  return type;
}

// Appends a new child to a list, merging where appropriate
function addOrMergeChild(list: VChild[], newChild: VChild) {
  if (list.length > 0) {
    const index = list.length - 1;
    const last = list[index];

    if (typeof last !== 'string' && typeof newChild !== 'string'
      && last.type === newChild.type && isEqual(last.props, newChild.props))
    {
      // Join elements that match
      last.children = last.children.concat(newChild.children);
      return;
    } else if (typeof last === 'string' && typeof newChild === 'string') {
      // Combine adjacent text nodes
      list[index] = last + newChild;
      return;
    }
  }
  
  list.push(newChild)
}

// Combines two child lists into one, accounting for either being undefined
function combineChildren(a: VChild[] | undefined, b: VChild[] | undefined): VChild[] {
  if (!a && !b) return [];
  if (!a) return b ?? [];
  if (!b) return a ?? [];
  
  // merge in b into a
  for (const item of b) {
    addOrMergeChild(a, item);
  }
  return a;
}

function startsWithSpace(op: Op) {
  return typeof op.insert === 'string' && op.insert[0] === ' ';
}
