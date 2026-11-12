/** What the Markdown rehype plugins read of a hast node. */
export type HastNode = {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

/** remark-math's markers and KaTeX's output, inline and display. */
const MATH_INLINE_CLASSES = ['katex', 'math', 'math-inline'];
const MATH_DISPLAY_CLASSES = ['katex-display', 'math-display'];

export function hastClassNames(node: HastNode): string[] {
  const value = node.properties?.className;
  if (Array.isArray(value)) return value.map(String);
  return typeof value === 'string' ? value.split(/\s+/) : [];
}

function mathKindOf(names: readonly string[]): 'inline' | 'display' | null {
  if (names.some((name) => MATH_DISPLAY_CLASSES.includes(name))) return 'display';
  if (names.some((name) => MATH_INLINE_CLASSES.includes(name))) return 'inline';
  return null;
}

/** Whether an element is a formula, and which kind; null for anything else. */
export function mathKind(node: HastNode): 'inline' | 'display' | null {
  return node.type === 'element' ? mathKindOf(hastClassNames(node)) : null;
}

/** mathKind for the rendered DOM element (typed by its class list, so code without the DOM lib can import this module). */
export function domMathKind(element: { readonly classList: ArrayLike<string> }): 'inline' | 'display' | null {
  return mathKindOf(Array.from(element.classList));
}

export function hastText(node: HastNode): string {
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(hastText).join('');
}
