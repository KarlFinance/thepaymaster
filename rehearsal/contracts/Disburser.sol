// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/**
 * An atomic distribution: one transaction in, N transfers out, all or nothing.
 *
 * FOR REHEARSAL. This has not been audited and must not hold or move real
 * money until it has been. It is here to prove the shape works against a token
 * that behaves like USDT, and to be the thing an auditor is eventually handed.
 *
 * The design decision worth keeping: funds are never held. Each transfer pulls
 * from the sender and pushes to a recipient inside one call, so there is no
 * moment where this contract has a balance, nothing to sweep if it were
 * compromised, and nothing to argue about when describing custody. It has no
 * owner, no pause, no upgrade path and no withdraw function — deliberately,
 * because every one of those is a way for somebody to take the money.
 *
 * The fee is a recipient like any other. It cannot be skipped, because the
 * whole thing reverts unless every leg succeeds.
 */
contract Disburser {
    error LengthMismatch();
    error NothingToSend();
    error TransferFailed(address token, address to, uint256 amount);

    event Disbursed(
        bytes32 indexed dealId,
        address indexed token,
        address indexed from,
        uint256 total,
        uint256 legs
    );

    /**
     * Send `amounts[i]` of `token` from the caller to `recipients[i]`.
     *
     * The caller must have approved this contract for at least the sum. Note
     * that real USDT will not let an existing non-zero allowance be raised —
     * it has to be set to zero first — so an integration that approves the
     * exact amount each time must zero it in between.
     *
     * `dealId` is carried only so the transaction can be tied back to the
     * paperwork. Nothing on chain depends on it.
     */
    function disburse(
        bytes32 dealId,
        address token,
        address[] calldata recipients,
        uint256[] calldata amounts
    ) external {
        if (recipients.length != amounts.length) revert LengthMismatch();
        if (recipients.length == 0) revert NothingToSend();

        uint256 total;
        for (uint256 i = 0; i < recipients.length; i++) {
            uint256 amount = amounts[i];
            total += amount;
            // Straight from the payer to the payee. Nothing rests here, not
            // even for the length of this loop.
            _pull(token, msg.sender, recipients[i], amount);
        }
        emit Disbursed(dealId, token, msg.sender, total, recipients.length);
    }

    /**
     * transferFrom that copes with tokens which return nothing.
     *
     * Real USDT predates the finalised ERC-20 and omits the boolean, so a call
     * compiled against the standard interface tries to decode a return value
     * that is not there and reverts. The rule that works for both: the call
     * must succeed, and if it returned anything at all that value must be
     * true. Empty return data is taken as success, which is the only reading
     * that lets USDT and a well-behaved token share one code path.
     */
    function _pull(address token, address from, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(0x23b872dd, from, to, amount)   // transferFrom
        );
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) {
            revert TransferFailed(token, to, amount);
        }
    }
}
