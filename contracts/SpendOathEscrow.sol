// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title SpendOathEscrow (v2 — real Sepolia deployment)
/// @notice On-chain financial authority for SpendOath (ONE HACK 2026 W3A-1).
///         Owner grants spending authority; authorized agents pay merchants.
///         THE CONTRACT IS THE FINAL ENFORCEMENT LAYER: the hard cap, max
///         transaction limit and destination checks live HERE, in Solidity.
///         A backend firewall may pre-check, but nothing this contract
///         rejects can ever move funds.
///
///         Security model: the agent NEVER holds the owner's key. Agents pay
///         from the escrow's own funds under authority granted by the owner.
///         `pay()` can be called by anyone (frontend, backend relayer, or the
///         agent) — it does not matter, because the authority state is checked
///         entirely on-chain.
contract SpendOathEscrow {
    address public owner;                 // human who funds + grants authority
    address public merchant;              // payment recipient (provider)
    uint256 public budget;                // total authorized spending (wei)
    uint256 public spent;                 // cumulative paid out
    uint256 public maxTransaction;        // per-tx ceiling (wei)
    bool public authorityActive;

    mapping(address => bool) public authorizedAgents;   // registered agent controller addresses
    mapping(bytes32 => bool) public usedKeys;           // idempotency keys — retry can never double-charge

    event AuthorityGranted(address indexed owner, uint256 budget, uint256 maxTransaction, address merchant);
    event AgentAuthorized(address indexed agent);
    event AgentRevoked(address indexed agent);
    event Paid(bytes32 indexed idempotencyKey, address indexed agent, uint256 amount, uint256 totalSpent);
    event HardCapBlocked(address indexed caller, uint256 requested, uint256 remaining);

    error NotOwner();
    error AgentNotAuthorized();
    error AuthorityInactive();
    error ExceedsMaxTransaction(uint256 requested, uint256 max);
    error ExceedsRemainingBudget(uint256 requested, uint256 remaining);
    error InsufficientContractBalance(uint256 requested, uint256 balance);
    error DuplicateKey();
    error ZeroAddress();
    error TransferFailed();

    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }

    constructor(address _merchant) {
        if (_merchant == address(0)) revert ZeroAddress();
        owner = msg.sender;
        merchant = _merchant;
        authorityActive = true;
    }

    /// @notice Owner funds the escrow: deposited wei becomes the authoritative budget.
    function fund() external payable onlyOwner {
        budget = address(this).balance;
        authorityActive = true;
        emit AuthorityGranted(owner, budget, maxTransaction, merchant);
    }

    /// @notice Owner sets per-tx ceiling. Only here, only by owner.
    function setMaxTransaction(uint256 amount) external onlyOwner {
        maxTransaction = amount;
    }

    /// @notice Owner registers an agent controller address. Agent has NO owner key.
    function authorizeAgent(address agent) external onlyOwner {
        authorizedAgents[agent] = true;
        emit AgentAuthorized(agent);
    }

    function revokeAgent(address agent) external onlyOwner {
        authorizedAgents[agent] = false;
        emit AgentRevoked(agent);
    }

    /// @notice Owner can pause authority (kill switch).
    function setAuthorityActive(bool active) external onlyOwner {
        authorityActive = active;
    }

    /// @notice Remaining budget — derived from chain state, nothing to trust off-chain.
    function remaining() external view returns (uint256) {
        return budget - spent;
    }

    /// @notice Agent-initiated payment. THE ON-CHAIN ENFORCEMENT BOUNDARY:
    ///         every check below is Solidity — no frontend value is trusted.
    ///         Callable by an authorized agent controller (or owner relaying).
    function pay(
        bytes32 idempotencyKey,
        uint256 amount,
        address destination
    ) external {
        if (!authorityActive) revert AuthorityInactive();
        if (!authorizedAgents[msg.sender] && msg.sender != owner) revert AgentNotAuthorized();
        if (usedKeys[idempotencyKey]) revert DuplicateKey();                 // no double charge, ever
        if (amount > maxTransaction) revert ExceedsMaxTransaction(amount, maxTransaction);
        uint256 rem = budget - spent;
        if (amount > rem) revert ExceedsRemainingBudget(amount, rem);        // HARD CAP — cannot be bypassed
        if (amount > address(this).balance) revert InsufficientContractBalance(amount, address(this).balance);
        if (destination == address(0)) revert ZeroAddress();

        usedKeys[idempotencyKey] = true;
        spent += amount;                                                     // authoritative accounting

        (bool sent, ) = destination.call{value: amount}("");
        if (!sent) revert TransferFailed();
        emit Paid(idempotencyKey, msg.sender, amount, spent);
    }

    /// @notice Direct-contract-attack probe: view wrapper mirroring pay()'s checks.
    function checkPayment(uint256 amount) external view returns (string memory verdict) {
        if (amount > maxTransaction) return "EXCEEDS_MAX_TRANSACTION";
        if (amount > budget - spent) return "EXCEEDS_REMAINING_BUDGET";
        if (amount > address(this).balance) return "INSUFFICIENT_BALANCE";
        return "WOULD_SUCCEED";
    }

    receive() external payable {
        // Any ETH received (including plain transfers from the owner) counts
        // as budget — the contract balance is the single source of truth.
        budget = address(this).balance;
    }
}
