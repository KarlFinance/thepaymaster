// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/**
 * A contract wallet that answers EIP-1271, for testing the platform against
 * something real rather than a mock of our own reasoning.
 *
 * It implements both forms, because Safe v1.0.0 answers the older
 * isValidSignature(bytes,bytes) and later versions the bytes32 one, and a
 * sender with an old Safe should not have to migrate it mid-transaction.
 *
 * The rule here is deliberately the simplest thing that is still real: one
 * owner, an ordinary ECDSA signature over the hash the platform supplies. That
 * makes this a genuine test of whether the platform computes the right digest
 * and encodes the call correctly — a contract that just returned the magic
 * value would prove neither.
 */
contract Signer1271 {
    address public immutable owner;

    bytes4 private constant MAGIC        = 0x1626ba7e;  // (bytes32,bytes)
    bytes4 private constant MAGIC_LEGACY = 0x20c13b0b;  // (bytes,bytes)

    constructor(address who) { owner = who; }

    function isValidSignature(bytes32 hash, bytes calldata signature)
        external view returns (bytes4)
    {
        return _ok(hash, signature) ? MAGIC : bytes4(0);
    }

    function isValidSignature(bytes calldata data, bytes calldata signature)
        external view returns (bytes4)
    {
        // The older form is handed the data itself. The platform passes the
        // already-hashed message, which is what Safe's own callers do.
        bytes32 hash = data.length == 32 ? abi.decode(data, (bytes32))
                                         : keccak256(data);
        return _ok(hash, signature) ? MAGIC_LEGACY : bytes4(0);
    }

    function _ok(bytes32 hash, bytes calldata sig) private view returns (bool) {
        if (sig.length != 65) return false;
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (v < 27) v += 27;
        return ecrecover(hash, v, r, s) == owner;
    }
}
