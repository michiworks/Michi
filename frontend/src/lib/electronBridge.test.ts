import { afterEach, expect, expectTypeOf, it, vi } from 'vitest';
import type { DesktopBridge, DesktopCommandContract, DesktopEventContract, DesktopInvokeResult, LegacyDesktopBridge } from 'michi-shared';
import { getElectron, type DesktopResidency, type DesktopResidencyPatch, type ElectronBridge } from './electronBridge';

afterEach(() => vi.unstubAllGlobals());

it('returns no desktop bridge in a browser or server environment', () => {
  vi.stubGlobal('window', undefined);
  expect(getElectron()).toBeNull();
  vi.stubGlobal('window', {});
  expect(getElectron()).toBeNull();
});

it('keeps old builds valid while callers feature-detect newer methods', async () => {
  const legacy: ElectronBridge = { chooseFolder: async () => ({ canceled: true }), saveMarkdown: async () => ({ canceled: true }) };
  vi.stubGlobal('window', { electron: legacy });
  expect(getElectron()).toBe(legacy);
  expect(getElectron()?.terminalCreate).toBeUndefined();
  expect(await getElectron()?.chooseFolder()).toEqual({ canceled: true });
  expectTypeOf<ElectronBridge>().toExtend<LegacyDesktopBridge>();
  expectTypeOf<Awaited<ReturnType<DesktopBridge['terminalCreate']>>>().toEqualTypeOf<DesktopInvokeResult<'terminal:create'>>();
  expectTypeOf<Awaited<ReturnType<DesktopBridge['getBackgroundServiceStatus']>>>().toEqualTypeOf<DesktopInvokeResult<'service:getStatus'>>();
});

it('lets old builds drop a notification target and new ones report its click', () => {
  const legacy: ElectronBridge = { chooseFolder: async () => ({ canceled: true }), saveMarkdown: async () => ({ canceled: true }), showNotification: () => {} };
  vi.stubGlobal('window', { electron: legacy });
  // Feature-detected: without it a click only focuses a window.
  expect(getElectron()?.onAttentionNotificationClick).toBeUndefined();
  expectTypeOf<Parameters<DesktopBridge['showNotification']>>().toEqualTypeOf<DesktopCommandContract['app:showNotification']>();
  expectTypeOf<Parameters<Parameters<DesktopBridge['onAttentionNotificationClick']>[0]>>()
    .toEqualTypeOf<DesktopEventContract['app:attentionNotificationClicked']>();
});

it('keeps the residency calls optional, typed by their desktop channels', () => {
  const legacy: ElectronBridge = { chooseFolder: async () => ({ canceled: true }), saveMarkdown: async () => ({ canceled: true }) };
  vi.stubGlobal('window', { electron: legacy });
  // Older builds have no residency calls: Settings must feature-detect them.
  expect(getElectron()?.getResidency).toBeUndefined();
  expect(getElectron()?.setResidency).toBeUndefined();
  expectTypeOf<Awaited<ReturnType<NonNullable<ElectronBridge['getResidency']>>>>().toEqualTypeOf<DesktopResidency>();
  expectTypeOf<Awaited<ReturnType<NonNullable<ElectronBridge['setResidency']>>>>().toEqualTypeOf<DesktopInvokeResult<'desktop:setResidency'>>();
  expectTypeOf<Parameters<NonNullable<ElectronBridge['setResidency']>>[0]>().toEqualTypeOf<DesktopResidencyPatch>();
});
