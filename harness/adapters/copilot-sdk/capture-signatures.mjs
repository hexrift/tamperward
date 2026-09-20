// Source-frozen permission-path signatures established by the first corrected credentialed
// hosted-Copilot SDK capture after #615. These are classification authority: changing them requires
// a reviewed source change and a fresh preflight so the new harness bytes are provenance-pinned.
//
// Capture provenance:
//   TamperWard             2.31.0+3671a5e6
//   @github/copilot-sdk    1.0.14
//   copilot-runtime        1.0.85
//   protocol               3
//   model                  gpt-5.4
//   platform               darwin/arm64
//
// The capture established that a bare error.code of "denied" is NOT sufficient authority. The
// runtime reused that code for distinct permission-path outcomes, distinguished by the sanitized
// error-message hash. Classification must bind the host-known path + code + message hash.
export const CONFIRMED_PERMISSION_GATE_SIGNATURES = Object.freeze([
  Object.freeze({
    path: 'returned-reject',
    code: 'denied',
    messageHash: '96ed60fc6898cdfa',
  }),
  Object.freeze({
    path: 'callback-failure',
    code: 'denied',
    messageHash: 'ebf2100b9c49ae12',
  }),
]);

export function permissionSignatureKey({ path, code, messageHash } = {}) {
  if (!path || !code || !messageHash) return undefined;
  return `${path}\u0000${code}\u0000${messageHash}`;
}

export function matchesConfirmedPermissionGateSignature(
  observed,
  confirmed = CONFIRMED_PERMISSION_GATE_SIGNATURES,
) {
  const key = permissionSignatureKey(observed);
  if (!key) return false;
  return confirmed.some((s) => permissionSignatureKey(s) === key);
}
