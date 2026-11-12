/** A Space page as the terminal shell opens it: its owning backend and workspace come with it. */
export interface OpenNativePageRoute {
  pageId: string;
  workspaceId: string;
  backendConnectionId: string;
}

export const OPEN_NATIVE_PAGE_EVENT = 'michi:open-native-page';

/** Open a native page in the terminal shell while retaining its owning backend and workspace. */
export function openNativePageRoute(route: OpenNativePageRoute): void {
  window.dispatchEvent(new CustomEvent<OpenNativePageRoute>(OPEN_NATIVE_PAGE_EVENT, { detail: route }));
}
