import type {WriteTransaction} from 'replicache';

/**
 * A `DisconnectHandler` can modify room state in response to a client
 * disconnecting from the room.  These changes will be synced to all
 * clients of the room just like mutator changes.
 * `write.clientID` will be the id of the disconnected client.
 */
export type DisconnectHandler = (write: WriteTransaction) => Promise<void>;