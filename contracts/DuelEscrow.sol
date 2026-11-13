// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract DuelEscrow {
    enum Outcome {
        Unset,
        CreatorWon,
        OpponentWon,
        Draw,
        Refunded
    }

    struct Match {
        address creator;
        address opponent;
        uint256 stake;
        uint64 fundingDeadline;
        uint64 settlementDeadline;
        bool funded;
        Outcome outcome;
        Outcome creatorVote;
        Outcome opponentVote;
    }

    error InvalidRules();
    error InvalidMatchId();
    error InvalidOpponent();
    error InvalidStake();
    error InvalidDeadlines();
    error MatchAlreadyExists();
    error MatchNotFound();
    error MatchAlreadyClosed();
    error NotOpponent();
    error AlreadyFunded();
    error FundingExpired();
    error NotPlayer();
    error AlreadyConfirmed();
    error MatchNotFunded();
    error SettlementExpired();
    error InvalidOutcome();
    error RefundNotReady();
    error NothingToWithdraw();
    error WithdrawalFailed();

    event MatchCreated(
        bytes32 indexed key,
        address indexed creator,
        address indexed opponent,
        bytes16 matchId,
        uint256 stake,
        uint64 fundingDeadline,
        uint64 settlementDeadline
    );
    event MatchFunded(bytes32 indexed key);
    event ResultConfirmed(bytes32 indexed key, address indexed player, Outcome outcome);
    event MatchClosed(bytes32 indexed key, Outcome outcome);
    event Withdrawal(address indexed account, uint256 amount);

    bytes32 public immutable rulesHash;
    mapping(bytes32 => Match) public matches;
    mapping(address => uint256) public credits;

    constructor(bytes32 rulesHash_) {
        if (rulesHash_ == bytes32(0)) revert InvalidRules();
        rulesHash = rulesHash_;
    }

    function matchKey(address creator, bytes16 matchId) public pure returns (bytes32) {
        return keccak256(abi.encode(creator, matchId));
    }

    function createMatch(bytes16 matchId, address opponent, uint64 fundingDeadline, uint64 settlementDeadline)
        external
        payable
        returns (bytes32 key)
    {
        if (matchId == bytes16(0)) revert InvalidMatchId();
        if (opponent == address(0) || opponent == msg.sender) revert InvalidOpponent();
        if (msg.value == 0) revert InvalidStake();
        if (fundingDeadline <= block.timestamp || settlementDeadline <= fundingDeadline) revert InvalidDeadlines();

        key = matchKey(msg.sender, matchId);
        if (matches[key].creator != address(0)) revert MatchAlreadyExists();
        matches[key] = Match({
            creator: msg.sender,
            opponent: opponent,
            stake: msg.value,
            fundingDeadline: fundingDeadline,
            settlementDeadline: settlementDeadline,
            funded: false,
            outcome: Outcome.Unset,
            creatorVote: Outcome.Unset,
            opponentVote: Outcome.Unset
        });
        emit MatchCreated(key, msg.sender, opponent, matchId, msg.value, fundingDeadline, settlementDeadline);
    }

    function fundMatch(bytes32 key) external payable {
        Match storage duel = _openMatch(key);
        if (msg.sender != duel.opponent) revert NotOpponent();
        if (duel.funded) revert AlreadyFunded();
        if (block.timestamp >= duel.fundingDeadline) revert FundingExpired();
        if (msg.value != duel.stake) revert InvalidStake();

        duel.funded = true;
        emit MatchFunded(key);
    }

    function confirmResult(bytes32 key, Outcome outcome) external {
        Match storage duel = _openMatch(key);
        bool isCreator = msg.sender == duel.creator;
        if (!isCreator && msg.sender != duel.opponent) revert NotPlayer();
        if (!duel.funded) revert MatchNotFunded();
        if (block.timestamp >= duel.settlementDeadline) revert SettlementExpired();
        if (outcome != Outcome.CreatorWon && outcome != Outcome.OpponentWon && outcome != Outcome.Draw) {
            revert InvalidOutcome();
        }

        Outcome otherVote;
        if (isCreator) {
            if (duel.creatorVote != Outcome.Unset) revert AlreadyConfirmed();
            duel.creatorVote = outcome;
            otherVote = duel.opponentVote;
        } else {
            if (duel.opponentVote != Outcome.Unset) revert AlreadyConfirmed();
            duel.opponentVote = outcome;
            otherVote = duel.creatorVote;
        }
        emit ResultConfirmed(key, msg.sender, outcome);

        if (otherVote != Outcome.Unset) {
            _closeMatch(key, duel, otherVote == outcome ? outcome : Outcome.Refunded);
        }
    }

    function refund(bytes32 key) external {
        Match storage duel = _openMatch(key);
        uint64 deadline = duel.funded ? duel.settlementDeadline : duel.fundingDeadline;
        if (block.timestamp < deadline) revert RefundNotReady();

        _closeMatch(key, duel, Outcome.Refunded);
    }

    function withdraw() external {
        uint256 amount = credits[msg.sender];
        if (amount == 0) revert NothingToWithdraw();

        credits[msg.sender] = 0;
        (bool paid,) = payable(msg.sender).call{value: amount}("");
        if (!paid) revert WithdrawalFailed();
        emit Withdrawal(msg.sender, amount);
    }

    function _closeMatch(bytes32 key, Match storage duel, Outcome outcome) private {
        duel.outcome = outcome;
        if (outcome == Outcome.Draw || outcome == Outcome.Refunded) {
            credits[duel.creator] += duel.stake;
            if (duel.funded) credits[duel.opponent] += duel.stake;
        } else {
            address winner = outcome == Outcome.CreatorWon ? duel.creator : duel.opponent;
            credits[winner] += duel.stake * 2;
        }
        emit MatchClosed(key, outcome);
    }

    function _openMatch(bytes32 key) private view returns (Match storage duel) {
        duel = matches[key];
        if (duel.creator == address(0)) revert MatchNotFound();
        if (duel.outcome != Outcome.Unset) revert MatchAlreadyClosed();
    }
}
