import type { AuthMembership, AuthRegion } from '@cindy/auth-client';

/**
 * Cindy Meka has one installation identity and accepts authenticated sessions
 * from either service realm. Parameters remain for call-site compatibility.
 */
export function canRestoreAuthSessionForMembership(
  buildRegion: AuthRegion,
  sessionRealm: AuthRegion,
  membershipKind: AuthMembership['kind'],
): boolean {
  void buildRegion;
  void sessionRealm;
  void membershipKind;
  return true;
}
