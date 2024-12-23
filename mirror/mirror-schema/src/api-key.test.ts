import {describe, expect, test} from '@jest/globals';
import {defaultPermissions, normalizePermissions} from './api-key.js';

describe('api-key', () => {
  test('default permissions', () => {
    expect(defaultPermissions()).toEqual({
      'app:create': false,
      'app:publish': false,
      'env:modify': false,
      'rooms:read': false,
      'rooms:create': false,
      'rooms:close': false,
      'rooms:delete': false,
      'connections:invalidate': false,
    });
  });

  test('normalize permissions', () => {
    expect(normalizePermissions({'app:publish': true})).toEqual({
      'app:create': false,
      'app:publish': true,
      'env:modify': false,
      'rooms:read': false,
      'rooms:create': false,
      'rooms:close': false,
      'rooms:delete': false,
      'connections:invalidate': false,
    });

    expect(() => normalizePermissions({invalid: true})).toThrowError;
  });
});
