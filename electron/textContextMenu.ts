import type { ContextMenuParams, MenuItemConstructorOptions } from 'electron';

type TextMenuParams = Pick<ContextMenuParams, 'selectionText' | 'isEditable' | 'editFlags'>;

/**
 * Electron shows no context menu of its own, so without this a right-click on
 * selected text or in a text field does nothing. Elsewhere it stays that way
 * (null), and the renderer's own menus call preventDefault, so this never fires
 * under them.
 */
export function textContextMenuTemplate(
  params: TextMenuParams,
  lookUp: () => void,
  platform: NodeJS.Platform = process.platform,
): MenuItemConstructorOptions[] | null {
  const hasSelection = params.selectionText.trim().length > 0;
  if (!hasSelection && !params.isEditable) return null;
  const { editFlags } = params;
  const template: MenuItemConstructorOptions[] = [];
  if (hasSelection && platform === 'darwin') template.push({ label: 'Look Up', click: lookUp }, { type: 'separator' });
  if (params.isEditable) template.push({ role: 'cut', enabled: editFlags.canCut });
  template.push({ role: 'copy', enabled: editFlags.canCopy });
  if (params.isEditable) template.push({ role: 'paste', enabled: editFlags.canPaste });
  template.push({ type: 'separator' }, { role: 'selectAll', enabled: editFlags.canSelectAll });
  return template;
}
