// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "./interfaces/ILockerFactory.sol";

/**
 * @notice
 */
contract Locker is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct UserInfo {
        uint256 amount;
        uint256 claimedAmount;
    }

    struct VoteInfo {
        uint256 amount;
    }

    struct ProposalInfo {
        uint256 id;
        uint256 unlockPercent;
        uint256 startTime;
        uint256 endTime;
        uint256 agree; // total agreed power
        uint256 disagree; // total disagreed power
        uint256 totalPower; // possible total power
        bool passed; // if passed or not
    }

    uint256 private constant MULTIPLIER = 1e4;
    uint256 private constant MIN_PROPOSAL_DURATION = 1 days;
    bool private initialized;
    uint256 private constant PROPOSAL_PASS_PERCENT = 5100; // 51%

    // The factory contract address
    ILockerFactory public factory;

    // uri of metadata
    string public uri;
    bool public isLP;

    // token address
    IERC20 public token;

    mapping(address => UserInfo) public userInfo;

    // proposalId => address => votedPower
    mapping(uint256 => mapping(address => uint256)) public userVote;

    // past proposals
    ProposalInfo[] public proposals;
    // current proposal
    ProposalInfo public proposal;

    // unlock by admin and project owner
    uint256 public suggestedUnlockPercent;

    // set by proposal, or factory and owner
    uint256 public unlockedPercent;

    // 0: simple lock, 1: vesting
    uint256 public lockType;

    // users can deposit funds before cliffTime or startTime
    // for vesting
    uint256 public cliffTime;
    uint256 public duration;
    uint256 public periodicity;
    // for linear lock
    uint256 public startTime;
    uint256 public endTime;

    uint256 public totalDeposited;
    uint256 public totalClaimed;

    event LockerInitialized(
        uint256 lockType,
        uint256 param1,
        uint256 param2,
        uint256 param3,
        address token,
        bool isLP,
        string uri
    );
    event UriChanged(string uri);

    event Deposit(address user, uint256 amount, address beneficiary);
    event Claim(address user, uint256 amount);

    event ProposalCreated(uint256 proposalId, uint256 percent, uint256 endTime);
    event UserVoted(address user, uint256 proposalId, uint256 power, bool agree);
    event ProposalFinalized(uint256 proposalId, uint256 status); // 0: failed, 1: passed
    event EmergencyUnlock(uint256 status, uint256 percent); // 0: by admin and factory, >0: proposalId
    event EmergencyUnlockSuggested(uint256 percent); //

    constructor() {
        factory = ILockerFactory(msg.sender);
    }

    modifier onlyFactory() {
        require(address(factory) == msg.sender, "Not factory");
        _;
    }

    /* external functions */

    /**
     * @notice initialize Locker
     *
     * @param _lockType: 0 => simple lock, 1 => vesting
     * @param _param1: cliffTime or startTime
     * @param _param2: duration or endTime
     * @param _param3: periodicity or 0
     * @param _token: token address
     * @param _isLP: true if it's lp token
     * @param _uri: meta data uri
     */
    function initialize(
        uint256 _lockType,
        uint256 _param1,
        uint256 _param2,
        uint256 _param3,
        address _token,
        bool _isLP,
        string memory _uri
    ) external onlyFactory {
        require(!initialized, "Already initialized");

        initialized = true;

        lockType = _lockType;
        token = IERC20(_token);
        uri = _uri;
        isLP = _isLP;

        if (lockType == 0) {
            startTime = _param1;
            endTime = _param2;
        } else {
            cliffTime = _param1;
            duration = _param2;
            periodicity = _param3;
        }

        emit LockerInitialized(lockType, _param1, _param2, _param3, address(token), isLP, uri);
    }

    /**
     * @notice update metadata uri
     *
     * @param _uri: metadata uri
     */
    function setUri(string memory _uri) external onlyOwner {
        uri = _uri;

        emit UriChanged(uri);
    }

    /**
     * @notice deposit amount of token
     *
     * @param amount: token amount
     */
    function deposit(uint256 amount) external {
        _deposit(msg.sender, amount, msg.sender);
    }

    /**
     * @notice deposit amount of token for beneficiary
     *
     * @param amount: token amount
     * @param beneficiary: beneficiary user
     */
    function depositFor(uint256 amount, address beneficiary) external {
        require(beneficiary != address(0), "Invalid beneficiary");

        _deposit(msg.sender, amount, beneficiary);
    }

    /**
     * @notice deposit amount of token for beneficiary
     *
     * @param amounts: token amounts
     * @param beneficiaries: beneficiary users
     */
    function bulkDepositFor(uint256[] calldata amounts, address[] calldata beneficiaries) external {
        require(amounts.length > 0 && amounts.length == beneficiaries.length, "Invalid params");
        for (uint256 index = 0; index < amounts.length; index++) {
            uint256 amount = amounts[index];
            address beneficiary = beneficiaries[index];
            require(beneficiary != address(0), "Invalid beneficiary");
            _deposit(msg.sender, amount, beneficiary);
        }
    }

    /**
     * @notice claim available tokens
     */
    function claim() external nonReentrant {
        _claimTo(msg.sender);
    }

    function claimTo(address beneficiary) external nonReentrant {
        _claimTo(beneficiary);
    }

    function _claimTo(address user) internal {
        uint256 claimableAmount = getClaimableAmount(user);

        token.safeTransfer(user, claimableAmount);

        totalClaimed += claimableAmount;
        userInfo[user].claimedAmount += claimableAmount;

        emit Claim(user, claimableAmount);
    }

    /**
     * @notice project owner suggested unlock percent
     */
    function suggestUnlock(uint256 _suggestedUnlockPercent) external payable onlyOwner nonReentrant {
        require(_suggestedUnlockPercent > unlockedPercent, "Invalid _suggestedUnlockPercent");
        suggestedUnlockPercent = _suggestedUnlockPercent;

        (address feeRecipient, , uint256 emergencyUnlockFee) = factory.getFeeInfo();
        require(msg.value == emergencyUnlockFee, "Insufficient fee");
        feeRecipient.call{ value: emergencyUnlockFee }("");

        emit EmergencyUnlockSuggested(suggestedUnlockPercent);
    }

    /**
     * @notice Factory approve suggest unlock percent by project owner
     */
    function approveSuggestedUnlock() external onlyFactory {
        require(suggestedUnlockPercent > unlockedPercent, "Invalid");
        unlockedPercent = suggestedUnlockPercent;
        suggestedUnlockPercent = 0;

        emit EmergencyUnlock(0, unlockedPercent);
    }

    function getProposalCount() external view returns (uint256) {
        return proposals.length;
    }

    function getProposals() external view returns (ProposalInfo[] memory) {
        return proposals;
    }

    /**
     * @notice start a proposal to unlock certain percent
     */
    function startProposal(uint256 _unlockPercent, uint256 _endTime) external onlyOwner {
        require(proposal.id == 0, "Can't init a proposal");
        require(_unlockPercent > unlockedPercent, "Invalid _unlockPercent");
        require(_endTime >= block.timestamp + MIN_PROPOSAL_DURATION, "Invalid _endTime");

        proposal.id = proposals.length + 1;
        proposal.unlockPercent = _unlockPercent;
        proposal.startTime = block.timestamp;
        proposal.endTime = _endTime;
        proposal.totalPower = totalDeposited - getUnlockedAmount(totalDeposited);
        proposal.passed = false;

        emit ProposalCreated(proposal.id, proposal.unlockPercent, proposal.endTime);
    }

    /**
     * @notice user votes to a proposal with power
     *
     * @param agree: true/false
     */
    function vote(uint256 power, bool agree) external nonReentrant {
        require(proposal.endTime >= block.timestamp, "Not active");
        uint256 userVoted = userVote[proposal.id][msg.sender];
        require(userVoted + power <= getVotingPower(msg.sender), "Invalid power");

        userVote[proposal.id][msg.sender] += power;

        if (agree) {
            proposal.agree += power;
        } else {
            proposal.disagree += power;
        }

        emit UserVoted(msg.sender, proposal.id, power, agree);
    }

    /**
     * @notice end a proposal
     */
    function endProposal() external onlyOwner {
        require(proposal.id > 0, "No active proposal");
        uint256 passPower = (proposal.totalPower * PROPOSAL_PASS_PERCENT) / MULTIPLIER;

        if (proposal.agree >= passPower) {
            unlockedPercent = proposal.unlockPercent;
            proposal.passed = true;

            emit ProposalFinalized(proposal.id, 1);
            emit EmergencyUnlock(1, unlockedPercent);
        } else {
            require(proposal.disagree >= passPower || proposal.endTime <= block.timestamp, "Can't end yet");
            proposal.passed = false;

            emit ProposalFinalized(proposal.id, 0);
        }

        proposal.endTime = block.timestamp;

        proposals.push(proposal);

        delete proposal;
    }

    /**
     * @notice recover any token on this contract
     * @dev
     *
     * @param _token: address of token to recover
     */
    function recoverToken(IERC20 _token) external onlyFactory {
        require(token != _token, "Not wrong token");
        uint256 bal = _token.balanceOf(address(this));
        _token.transfer(msg.sender, bal);
    }

    /**
     * @notice recover any bnb on this contract
     * @dev
     */
    function recoverBNB() external onlyFactory {
        uint256 bal = address(this).balance;
        msg.sender.call{ value: bal }("");
    }

    /* public functions */

    function getClaimableAmount(address user) public view returns (uint256) {
        return getUnlockedAmount(userInfo[user].amount) - userInfo[user].claimedAmount;
    }

    function getVotingPower(address user) public view returns (uint256) {
        return userInfo[user].amount - getUnlockedAmount(userInfo[user].amount);
    }

    /* internal functions */

    function getUnlockedAmount(uint256 amount) public view returns (uint256) {
        uint256 unlockedAmount;

        if (lockType == 0) {
            // linear lock
            if (block.timestamp >= endTime) {
                unlockedAmount = amount;
            } else if (block.timestamp >= startTime) {
                unlockedAmount = (amount * (block.timestamp - startTime)) / (endTime - startTime);
            }
        } else {
            // vesting
            if (block.timestamp >= cliffTime + duration) {
                unlockedAmount = amount;
            } else if (block.timestamp >= cliffTime) {
                uint256 periodicityCount = duration / periodicity;
                uint256 periodicityAmount = amount / periodicityCount;
                unlockedAmount = ((block.timestamp - cliffTime) / periodicity) * periodicityAmount;
            }
        }

        uint256 emergencyUnlockedAmount = (amount * unlockedPercent) / MULTIPLIER;

        return (unlockedAmount > emergencyUnlockedAmount ? unlockedAmount : emergencyUnlockedAmount);
    }

    function _deposit(
        address funder,
        uint256 amount,
        address beneficiary
    ) internal nonReentrant {
        // for fee token
        uint256 bal = token.balanceOf(address(this));
        token.safeTransferFrom(funder, address(this), amount);
        uint256 realAmount = token.balanceOf(address(this)) - bal;

        userInfo[beneficiary].amount += realAmount;

        totalDeposited += realAmount;

        emit Deposit(funder, realAmount, beneficiary);
    }
}
