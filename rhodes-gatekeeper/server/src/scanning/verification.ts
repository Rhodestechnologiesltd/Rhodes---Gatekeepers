/**
 * Identity verification adapter.
 *
 * No UAE identity-verification service is integrated, because none was specified and none should be
 * assumed. The default adapter reports "unavailable", so visits keep id_status = "scanned" (or "manual").
 *
 * To add an approved service (e.g. one licensed via the relevant UAE authority or an approved vendor):
 *  1. Implement IdentityVerifier using that service's official specification and credentials.
 *  2. Register it in createVerifier() under a new ID_VERIFICATION_PROVIDER value (see config.ts).
 *  3. Only a result of { outcome: 'verified' } may set a visit's id_status to "verified".
 */
export interface VerificationRequest {
  idNumber: string;
  fullName?: string;
  expiryDate?: string;
}

export type VerificationResult =
  | { outcome: 'verified'; reference: string }
  | { outcome: 'not_verified'; reason: string }
  | { outcome: 'unavailable'; reason: string };

export interface IdentityVerifier {
  readonly name: string;
  readonly enabled: boolean;
  verify(req: VerificationRequest): Promise<VerificationResult>;
}

export class NoVerificationService implements IdentityVerifier {
  readonly name = 'none';
  readonly enabled = false;
  async verify(): Promise<VerificationResult> {
    return { outcome: 'unavailable', reason: 'No identity-verification service is configured' };
  }
}

export function createVerifier(provider: 'none'): IdentityVerifier {
  switch (provider) {
    case 'none':
    default:
      return new NoVerificationService();
  }
}
