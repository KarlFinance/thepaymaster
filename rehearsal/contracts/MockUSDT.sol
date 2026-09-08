// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/**
 * A stand-in for Tether on Ethereum, faithful to its awkwardness.
 *
 * The point of a rehearsal is to fail in the same places the real thing would.
 * A clean ERC-20 would let a distribution sail through on Sepolia and then
 * revert on mainnet, which is worse than not rehearsing at all — it would give
 * false confidence about the one transaction where confidence matters.
 *
 * So this reproduces the three things about real USDT that break naive code:
 *
 *   1. transfer, transferFrom and approve return NOTHING. Real USDT predates
 *      the finalised ERC-20 and omits the boolean. Anything compiled against
 *      the standard interface will try to decode a return value that is not
 *      there and revert.
 *
 *   2. approve refuses to move a non-zero allowance to another non-zero value.
 *      You must set it to zero first. Code that assumes it can raise an
 *      allowance in one call will fail on the second use.
 *
 *   3. There is a blacklist, and Tether uses it. A blacklisted address can
 *      neither send nor receive.
 *
 * Six decimals, like the real one. Mintable, unlike the real one, because the
 * rehearsal needs 350 million of them.
 */
contract MockUSDT {
    string public constant name = "Mock Tether USD";
    string public constant symbol = "USDT";
    uint8 public constant decimals = 6;

    uint256 public totalSupply;
    address public owner;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public isBlackListed;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event AddedBlackList(address indexed user);
    event RemovedBlackList(address indexed user);

    error Frozen(address who);
    error InsufficientBalance(uint256 held, uint256 needed);
    error InsufficientAllowance(uint256 allowed, uint256 needed);
    error UnsafeApprove();
    error NotOwner();

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /** Only here so the rehearsal can start with money in it. */
    function mint(address to, uint256 amount) external onlyOwner {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    /** Tether's blacklist, so the rehearsal can prove the check works. */
    function addBlackList(address who) external onlyOwner {
        isBlackListed[who] = true;
        emit AddedBlackList(who);
    }

    function removeBlackList(address who) external onlyOwner {
        isBlackListed[who] = false;
        emit RemovedBlackList(who);
    }

    // -----------------------------------------------------------------------
    // Note the absent return values throughout. That is the whole point.
    // -----------------------------------------------------------------------

    function transfer(address to, uint256 value) external {
        _move(msg.sender, to, value);
    }

    function transferFrom(address from, address to, uint256 value) external {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed < value) revert InsufficientAllowance(allowed, value);
        // Real USDT does not decrement an allowance set to the maximum, and
        // plenty of integrations rely on that; reproduced here.
        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - value;
        }
        _move(from, to, value);
    }

    /**
     * The one that catches people.
     *
     * Changing a non-zero allowance to another non-zero value is refused, to
     * close the well-known front-running gap. Set it to zero first.
     */
    function approve(address spender, uint256 value) external {
        if (value != 0 && allowance[msg.sender][spender] != 0) revert UnsafeApprove();
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
    }

    function _move(address from, address to, uint256 value) private {
        if (isBlackListed[from]) revert Frozen(from);
        if (isBlackListed[to]) revert Frozen(to);
        uint256 held = balanceOf[from];
        if (held < value) revert InsufficientBalance(held, value);
        unchecked {
            balanceOf[from] = held - value;
            balanceOf[to] += value;
        }
        emit Transfer(from, to, value);
    }
}
