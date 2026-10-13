import { type Provider } from '@nestjs/common';
import { RELEASE_SETTINGS, type ReleaseSettingsRegistry } from '@buddha/shared';

/**
 * Injection token for the release-settings registry: RELEASE_SETTINGS from @buddha/shared. A token
 * rather than the constant read in place so a suite can run against items of its own
 * (`createTestApp({ releaseSettings })`) while the shipped registry stays empty until the issues
 * that own the values register them (#170).
 */
export const RELEASE_SETTINGS_REGISTRY = Symbol('RELEASE_SETTINGS_REGISTRY');

export const releaseSettingsRegistryProvider: Provider<ReleaseSettingsRegistry> = {
  provide: RELEASE_SETTINGS_REGISTRY,
  useValue: RELEASE_SETTINGS,
};
