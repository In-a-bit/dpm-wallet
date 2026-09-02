/**
 * Every action name the audit trail can carry. Operators filter `GET /v1/audit` by this
 * exact string, so a typo at a call site would silently drop an event out of the filter
 * an incident is being investigated with. Naming them here makes that a compile error.
 */
export const AuditAction = {
  VaultInit: "vault.init",
  AddressCreate: "address.create",
  AddressDpmAttestation: "address.dpm_attestation",
  AddressDpmRegister: "address.dpm_register",
  AddressDpmRegistered: "address.dpm_registered",
  SignOrder: "sign.order",
  SignCancel: "sign.cancel",
  MetaAllowance: "meta.allowance",
  MetaRedeem: "meta.redeem",
  MetaSplit: "meta.split",
  MetaMerge: "meta.merge",
  MetaWithdraw: "meta.withdraw",
} as const;

export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];
