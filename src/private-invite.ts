import type { RoomIdentity } from './presence';
import { isRoomIdentity } from './presence';

const prefix = 'LGP1.';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function privateInviteCode(roomId: string, host: RoomIdentity): string {
  return `${prefix}${roomId}.${host.id}.${host.key}`;
}

export function readPrivateInvite(code: string): { id: string; host: RoomIdentity } | null {
  if (!code.startsWith(prefix)) return null;
  const [id, hostId, key, extra] = code.slice(prefix.length).split('.');
  const host = { id: hostId, key };
  if (!uuid.test(id) || !isRoomIdentity(host) || extra !== undefined) {
    throw new Error('Приглашение повреждено. Попросите друга отправить его ещё раз.');
  }
  return { id, host };
}
