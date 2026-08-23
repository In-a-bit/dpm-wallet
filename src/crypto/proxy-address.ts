import {
  concatHex,
  getAddress,
  getCreate2Address,
  keccak256,
  toFunctionSelector,
  type Address,
  type Hex,
} from "viem";

/**
 * The two halves of the clone init code that `FactoryLib.computeCreationCode` assembles
 * in the `proxy-factories` repo. The factory address is spliced between them, and the
 * implementation address follows, giving a 99-byte header plus 68 bytes of constructor
 * data. Reproducing it byte-for-byte is what lets a proxy address be derived without a
 * chain call — a single wrong byte yields a plausible address that nothing deploys to.
 */
const CLONE_PREFIX = "0x3d3d606380380380913d393d73" as const;
const CLONE_MIDDLE = "0x5af4602a57600080fd5b602d8060366000396000f3363d3d373d3d3d363d73" as const;
const CLONE_SUFFIX = "0x5af43d82803e903d91602b57fd5bf3" as const;

/**
 * `abi.encodeWithSignature("cloneConstructor(bytes)", new bytes(0))`: the selector, the
 * offset to the single dynamic argument, and that argument's zero length.
 */
const EMPTY_BYTES_OFFSET: Hex = `0x${(32).toString(16).padStart(64, "0")}`;
const EMPTY_BYTES_LENGTH: Hex = `0x${"0".repeat(64)}`;

const CLONE_CONSTRUCTOR_DATA = concatHex([
  toFunctionSelector("cloneConstructor(bytes)"),
  EMPTY_BYTES_OFFSET,
  EMPTY_BYTES_LENGTH,
]);

export type ProxyFactoryConfig = {
  proxyFactory: Address;
  proxyImplementation: Address;
};

/**
 * Derives a wallet's on-chain proxy address. Deterministic in the EOA, so the address can
 * be returned at creation time before the proxy is ever deployed.
 */
export function deriveProxyAddress(eoaAddress: Address, config: ProxyFactoryConfig): Address {
  return getCreate2Address({
    from: config.proxyFactory,
    salt: proxySalt(eoaAddress),
    bytecodeHash: keccak256(cloneInitCode(config)),
  });
}

/**
 * `keccak256(abi.encodePacked(msgSender))` — the 20 address bytes, not a 32-byte word.
 * `ProxyWalletFactory` hashes the packed address, so padding it would derive a different
 * proxy for every wallet.
 */
function proxySalt(eoaAddress: Address): Hex {
  return keccak256(getAddress(eoaAddress));
}

function cloneInitCode(config: ProxyFactoryConfig): Hex {
  return concatHex([
    CLONE_PREFIX,
    config.proxyFactory,
    CLONE_MIDDLE,
    config.proxyImplementation,
    CLONE_SUFFIX,
    CLONE_CONSTRUCTOR_DATA,
  ]);
}
