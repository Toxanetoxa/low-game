import type { RoomIdentity } from './presence';
import { isRoomIdentity } from './presence';

const legacyPrefix = 'LGP1.';
const prefix = 'LGP2.';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const tokenPattern = /^[0-9a-f]{32}$/;

export function createInviteToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function privateInviteCode(roomId: string, host: RoomIdentity, token: string): string {
  return `${prefix}${roomId}.${host.id}.${host.key}.${token}`;
}

export function readPrivateInvite(code: string): { id: string; host: RoomIdentity; token?: string } | null {
  const current = code.startsWith(prefix);
  if (!current && !code.startsWith(legacyPrefix)) return null;
  const [id, hostId, key, token, extra] = code.slice(prefix.length).split('.');
  const host = { id: hostId, key };
  if (
    !uuid.test(id) ||
    !isRoomIdentity(host) ||
    extra !== undefined ||
    (current ? !tokenPattern.test(token ?? '') : token !== undefined)
  ) {
    throw new Error('Приглашение повреждено. Попросите друга отправить его ещё раз.');
  }
  return { id, host, token };
}
