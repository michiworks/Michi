import { parseTriStateFlag, readRuntimeSetting } from '../../lib/runtimeFlags';

export const STREAMING_MARKDOWN_BLOCKS_STORAGE_KEY = 'michi:ff:streamingMarkdownBlocks';

export function streamingMarkdownBlocksEnabled(): boolean {
  return readRuntimeSetting(STREAMING_MARKDOWN_BLOCKS_STORAGE_KEY, import.meta.env.VITE_STREAMING_MARKDOWN_BLOCKS, parseTriStateFlag) ?? true;
}
