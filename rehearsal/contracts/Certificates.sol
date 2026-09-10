// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * ThePaymaster Certificates — a soulbound token per sealed record.
 *
 * One token is minted for each party's certificate on a sealed transaction,
 * to the address that party proved control of; its id is derived from the
 * record root and the party, so the chain carries a commitment to the sealed
 * record without a name or an amount on it. Tokens cannot move: a certificate
 * belongs to the person it certifies (ERC-5192, always locked). The metadata
 * URI points at ThePaymaster, which serves the certificate's public face; the
 * root itself is what the verifier checks.
 *
 * Only the platform's attestation key may mint. No dependencies, so the
 * bytecode is what it says it is.
 */
contract Certificates {
    string public constant name = "ThePaymaster Certificates";
    string public constant symbol = "TPMC";
    address public owner;
    string public baseURI;

    mapping(uint256 => address) private _ownerOf;
    mapping(address => uint256) private _balance;
    uint256 public total;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    event Locked(uint256 tokenId);
    event OwnershipTransferred(address indexed from, address indexed to);

    modifier onlyOwner() { require(msg.sender == owner, "owner only"); _; }

    constructor(string memory uri) { owner = msg.sender; baseURI = uri; emit OwnershipTransferred(address(0), msg.sender); }

    function setBaseURI(string calldata uri) external onlyOwner { baseURI = uri; }
    function transferOwnership(address next) external onlyOwner { require(next != address(0)); emit OwnershipTransferred(owner, next); owner = next; }

    /// Mint one certificate. The id is chosen off-chain from the record root.
    function mint(address to, uint256 id) external onlyOwner {
        require(to != address(0), "no recipient");
        require(_ownerOf[id] == address(0), "already minted");
        _ownerOf[id] = to;
        _balance[to] += 1;
        total += 1;
        emit Transfer(address(0), to, id);
        emit Locked(id);
    }

    function ownerOf(uint256 id) external view returns (address) { address o = _ownerOf[id]; require(o != address(0), "no such token"); return o; }
    function balanceOf(address a) external view returns (uint256) { require(a != address(0)); return _balance[a]; }
    function locked(uint256 id) external view returns (bool) { require(_ownerOf[id] != address(0), "no such token"); return true; }

    function tokenURI(uint256 id) external view returns (string memory) {
        require(_ownerOf[id] != address(0), "no such token");
        return string(abi.encodePacked(baseURI, _hex(id), ".json"));
    }

    function supportsInterface(bytes4 i) external pure returns (bool) {
        return i == 0x01ffc9a7 || i == 0x80ac58cd || i == 0x5b5e139f || i == 0xb45a3c0e; // 165, 721, 721Metadata, 5192
    }

    // A certificate is not transferable, by anyone, ever.
    function transferFrom(address, address, uint256) external pure { revert("soulbound"); }
    function safeTransferFrom(address, address, uint256) external pure { revert("soulbound"); }
    function safeTransferFrom(address, address, uint256, bytes calldata) external pure { revert("soulbound"); }
    function approve(address, uint256) external pure { revert("soulbound"); }
    function setApprovalForAll(address, bool) external pure { revert("soulbound"); }
    function getApproved(uint256) external pure returns (address) { return address(0); }
    function isApprovedForAll(address, address) external pure returns (bool) { return false; }

    function _hex(uint256 v) internal pure returns (string memory) {
        bytes memory b = new bytes(64);
        bytes16 digits = "0123456789abcdef";
        for (uint256 i = 0; i < 64; i++) { b[63 - i] = digits[v & 0xf]; v >>= 4; }
        return string(b);
    }
}
