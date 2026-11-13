export function normalizeNickname(value: string): string | null {
  const nickname = value.trim().replace(/[^\S\r\n\t]+/gu, ' ');
  const forbidden = /[<>\p{Cc}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;
  if (!nickname || nickname.length > 24 || forbidden.test(nickname) || !/[^\s\p{Cf}]/u.test(nickname)) {
    return null;
  }
  return nickname;
}
