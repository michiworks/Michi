// A leaf module: blocks.ts reads these values at runtime, so nothing here may import its values.
import type { ContainerBlock, NestedPageBlock, PageBlockContent } from './blocks';

/** How containers nest and what they hold; the parser, the block catalog and the renderer all read these. */
export const PAGE_CONTAINER_LIMITS = {
  depth: 2,
  slotBlocks: 20,
  columns: { min: 2, max: 4 },
  tabs: { min: 2, max: 6 },
  regions: { min: 1, max: 12 },
  gridColumns: 12,
} as const;

/** Resource and conversation references, which a container may not hold. */
export const TOP_LEVEL_ONLY_BLOCK_TYPES = ['database-ref', 'page-link', 'component', 'threads', 'conflict', 'home-section', 'view'] as const;
export type TopLevelOnlyBlockType = typeof TOP_LEVEL_ONLY_BLOCK_TYPES[number];

const CONTAINER_TYPES: Readonly<Record<ContainerBlock['type'], true>> = { toggle: true, columns: true, tabs: true, grid: true };

type Container<T> = Extract<T, ContainerBlock>;

function isContainer<T extends { type: string }>(block: T): block is T & Container<PageBlockContent> {
  return Object.prototype.hasOwnProperty.call(CONTAINER_TYPES, block.type);
}

function unknownContainer(block: never): never {
  throw new Error(`Unknown container ${(block as { type: string }).type}`);
}

/** A container's child lists, one per slot (its body, each column, tab or region); none for any other block. */
export function pageChildBlockLists(block: PageBlockContent): NestedPageBlock[][] {
  if (!isContainer(block)) return [];
  switch (block.type) {
    case 'toggle': return [block.blocks];
    case 'columns': return block.columns;
    case 'tabs': return block.tabs.map((tab) => tab.blocks);
    case 'grid': return block.regions.map((region) => region.blocks);
    default: return unknownContainer(block);
  }
}

/** The block with every direct child replaced by `fn(child)`; any other block as it is. */
export function mapPageChildBlocks<T extends PageBlockContent>(block: T, fn: (child: NestedPageBlock) => NestedPageBlock): T {
  if (!isContainer(block)) return block;
  const container: Container<PageBlockContent> = block;
  switch (container.type) {
    case 'toggle': return { ...block, blocks: container.blocks.map(fn) };
    case 'columns': return { ...block, columns: container.columns.map((column) => column.map(fn)) };
    case 'tabs': return { ...block, tabs: container.tabs.map((tab) => ({ ...tab, blocks: tab.blocks.map(fn) })) };
    case 'grid': return { ...block, regions: container.regions.map((region) => ({ ...region, blocks: region.blocks.map(fn) })) };
    default: return unknownContainer(container);
  }
}
