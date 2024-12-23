import {describe, expect, test} from '@jest/globals';
import type {ListOptions} from '../storage/storage.js';
import {
  CLOSE_ROOM_PATH,
  CREATE_ROOM_PATH,
  DELETE_ROOM_PATH,
  GET_CONTENTS_ROOM_PATH,
  LEGACY_CLOSE_ROOM_PATH,
  LEGACY_CREATE_ROOM_PATH,
  LEGACY_DELETE_ROOM_PATH,
  fmtPath,
} from './paths.js';
import {convertListOptionKeysToRoomKeys} from './rooms.js';

describe('rooms', () => {
  test('makeCreateRoomPath', () => {
    expect(fmtPath(LEGACY_CREATE_ROOM_PATH, {roomID: 'foo-bar'})).toBe(
      '/api/v1/rooms/foo-bar:create',
    );
    expect(
      fmtPath(CREATE_ROOM_PATH, new URLSearchParams({roomID: 'foo-bar'})),
    ).toBe('/api/v1/rooms:create?roomID=foo-bar');
    expect(
      fmtPath(LEGACY_CREATE_ROOM_PATH, {roomID: 'id\\with/slashes-and:colons'}),
    ).toBe('/api/v1/rooms/id%5Cwith%2Fslashes-and%3Acolons:create');
    expect(fmtPath(LEGACY_CLOSE_ROOM_PATH, {roomID: 'foo-bar'})).toBe(
      '/api/v1/rooms/foo-bar:close',
    );
    expect(
      fmtPath(CLOSE_ROOM_PATH, new URLSearchParams({roomID: 'foo-bar'})),
    ).toBe('/api/v1/rooms:close?roomID=foo-bar');
    expect(
      fmtPath(GET_CONTENTS_ROOM_PATH, new URLSearchParams({roomID: 'foo-bar'})),
    ).toBe('/api/v1/rooms/contents?roomID=foo-bar');
    expect(
      fmtPath(LEGACY_DELETE_ROOM_PATH, {roomID: 'id\\with/slashes-and:colons'}),
    ).toBe('/api/v1/rooms/id%5Cwith%2Fslashes-and%3Acolons:delete');
    expect(
      fmtPath(
        DELETE_ROOM_PATH,
        new URLSearchParams({roomID: 'id\\with/slashes-and:colons'}),
      ),
    ).toBe('/api/v1/rooms:delete?roomID=id%5Cwith%2Fslashes-and%3Acolons');
  });

  describe('convertListOptionKeysToRoomKeys', () => {
    type Case = {
      opts: ListOptions;
      converted: ListOptions;
    };
    const cases: Case[] = [
      {
        opts: {},
        converted: {prefix: 'room/'},
      },
      {
        opts: {prefix: 'foo'},
        converted: {prefix: 'room/foo'},
      },
      {
        opts: {prefix: 'foo', start: {key: ''}},
        converted: {prefix: 'room/foo', start: {key: ''}},
      },
      {
        opts: {prefix: 'foo', start: {key: '', exclusive: true}},
        converted: {prefix: 'room/foo', start: {key: '', exclusive: true}},
      },
      {
        opts: {prefix: 'foo', start: {key: '0', exclusive: false}},
        converted: {
          prefix: 'room/foo',
          start: {key: 'room/0/', exclusive: false},
        },
      },
      {
        opts: {prefix: 'foo', start: {key: '1', exclusive: true}},
        converted: {
          prefix: 'room/foo',
          start: {key: 'room/1/', exclusive: true},
        },
      },
    ];

    cases.forEach(c => {
      test(JSON.stringify(c.opts), () => {
        expect(convertListOptionKeysToRoomKeys(c.opts)).toEqual(c.converted);
      });
    });
  });
});
