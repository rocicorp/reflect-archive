import { test, expect } from "@jest/globals";
import { LogContext, SilentLogger } from "../util/logger";
import { Mocket } from "../util/test-utils";
import { handleClose } from "./close";

test("handleClose deletes client map entry for client id if socket matches", () => {
  const lc = new LogContext(new SilentLogger());
  const client1ID = "clientID1";
  const client1Socket = new Mocket();
  const client2ID = "clientID2";
  const client2Socket = new Mocket();
  const clientMap = new Map(
    Object.entries({
      [client1ID]: {
        socket: client1Socket,
        pending: [],
        userData: { userID: "userID1" },
        clockBehindByMs: 1000,
      },
      [client2ID]: {
        socket: client2Socket,
        pending: [],
        userData: { userID: "userID2" },
        clockBehindByMs: 2000,
      },
    })
  );
  handleClose(lc, clientMap, client1ID, client1Socket);
  // was deleted
  expect(clientMap.get(client1ID)).toBeUndefined();
  expect(clientMap.get(client2ID)).toEqual({
    socket: client2Socket,
    pending: [],
    userData: { userID: "userID2" },
    clockBehindByMs: 2000,
  });
});

test("handleClose does not delete client map entry for client id if socket does not match", () => {
  const lc = new LogContext(new SilentLogger());
  const client1ID = "clientID1";
  const client1Socket1 = new Mocket();
  const client1Socket2 = new Mocket();
  const client2ID = "clientID2";
  const client2Socket = new Mocket();
  const clientMap = new Map(
    Object.entries({
      [client1ID]: {
        socket: client1Socket2,
        pending: [],
        userData: { userID: "userID1" },
        clockBehindByMs: 1000,
      },
      [client2ID]: {
        socket: client2Socket,
        pending: [],
        userData: { userID: "userID2" },
        clockBehindByMs: 2000,
      },
    })
  );
  handleClose(lc, clientMap, client1ID, client1Socket1);
  expect(clientMap.get(client1ID)).toEqual({
    socket: client1Socket2,
    pending: [],
    userData: { userID: "userID1" },
    clockBehindByMs: 1000,
  });
  expect(clientMap.get(client2ID)).toEqual({
    socket: client2Socket,
    pending: [],
    userData: { userID: "userID2" },
    clockBehindByMs: 2000,
  });
});
