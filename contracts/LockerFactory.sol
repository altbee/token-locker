// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

import "./Locker.sol";
import "./interfaces/IPair.sol";

/**
 * @notice Locker Factory contract
 */

contract LockerFactory is Ownable, ReentrancyGuard {
    // addresses of locker contracts
    address[] public lockers;
    mapping(address => bool) public isLocker;

    // amount of bnb to create a locker
    uint256 public createFee;
    // amount of bnb for emergency unlock with admin
    uint256 public emergencyUnlockFee;
    // address that createFee and emergencyUnlockFee are sent
    address public feeRecipient;

    event NewLocker(address owner, address locker, uint256 lockerId);

    constructor(
        address _feeRecipient,
        uint256 _createFee,
        uint256 _emergencyUnlockFee
    ) {
        require(_feeRecipient != address(0), "Invalid feeRecipient");

        feeRecipient = _feeRecipient;
        createFee = _createFee;
        emergencyUnlockFee = _emergencyUnlockFee;
    }

    /**
     * @notice return total count of lockers
     */
    function getTotalLockCount() external view returns (uint256) {
        return lockers.length;
    }

    /**
     * @notice return locker address of certain range (lockers[from], ... lockers[to - 1])
     *
     * @param from: Index
     * @param to: Indez
     */
    function getLockAddresses(uint256 from, uint256 to) external view returns (address[] memory) {
        uint256 count = to - from;
        if (to > lockers.length) {
            count = lockers.length - from;
        }
        address[] memory addrs = new address[](count);
        for (uint256 index = 0; index < count; index++) {
            addrs[index] = lockers[index + from];
        }

        return addrs;
    }

    /**
     * @notice update fee info
     *
     * @param _feeRecipient: address of fee recipient
     * @param _createFee: amount of bnb to create a locker
     * @param _emergencyUnlockFee: amount of bnb for emergency unlock with admin
     */
    function setFeeInfo(
        address _feeRecipient,
        uint256 _createFee,
        uint256 _emergencyUnlockFee
    ) external onlyOwner {
        require(_feeRecipient != address(0), "Invalid feeRecipient");

        feeRecipient = _feeRecipient;
        createFee = _createFee;
        emergencyUnlockFee = _emergencyUnlockFee;
    }

    /**
     * @notice approve suggested unlock percent of a locker
     *
     * @param locker: address of locker
     */
    function approveUnlock(address locker) external onlyOwner {
        require(isLocker[locker], "Not a valid locker");

        Locker(locker).approveSuggestedUnlock();
    }

    function getFeeInfo()
        external
        view
        returns (
            address,
            uint256,
            uint256
        )
    {
        return (feeRecipient, createFee, emergencyUnlockFee);
    }

    /**
     * @notice create Locker
     *
     * @param lockType: 0 => simple lock, 1 => vesting
     * @param param1: cliffTime or startTime
     * @param param2: duration or endTime
     * @param param3: periodicity or 0
     * @param token: token address
     * @param isLP: true if it's LP token
     * @param uri: meta data uri
     */
    function createLocker(
        uint256 lockType,
        uint256 param1,
        uint256 param2,
        uint256 param3,
        address token,
        bool isLP,
        string memory uri
    ) external payable nonReentrant {
        require(msg.value == createFee, "Insufficient fee");
        feeRecipient.call{ value: createFee }("");

        require(token != address(0), "Invalid token");
        require(lockType < 2, "Invalid lockType");

        // token check
        IERC20(token).transfer(msg.sender, 0);
        IERC20(token).approve(msg.sender, 0);
        IERC20Metadata(token).decimals();
        IERC20Metadata(token).symbol();
        IERC20Metadata(token).name();

        if (isLP) {
            IPair(token).token0();
            IPair(token).token1();
        }

        if (lockType == 0) {
            // simple lock
            require(param1 > block.timestamp, "Invalid startTime");
            require(param2 > param1, "Invalid endTime");
        } else {
            // vesting
            require(param1 > block.timestamp, "Invalid cliffTime");
            require(param2 > 0, "Invalid duration");
            require(param3 > 0 && param3 <= param2, "Invalid periodicity");
            require(param2 == (param2 / param3) * param3, "Invalid periodicity");
        }

        bytes memory bytecode = type(Locker).creationCode;
        bytes32 salt = keccak256(abi.encodePacked(token, lockType, lockers.length));
        address locker;

        assembly {
            locker := create2(0, add(bytecode, 32), mload(bytecode), salt)
        }

        Locker(locker).initialize(lockType, param1, param2, param3, token, isLP, uri);

        Locker(locker).transferOwnership(msg.sender);

        lockers.push(locker);
        isLocker[locker] = true;

        emit NewLocker(msg.sender, locker, lockers.length - 1);
    }

    /**
     * @notice recover any token on locker contract
     * @dev
     *
     * @param locker: address of locker
     * @param token: address of token to recover
     */
    function recoverTokenFromLocker(address locker, IERC20 token) external onlyOwner {
        require(isLocker[locker], "Not a valid locker");

        Locker(locker).recoverToken(token);

        recoverToken(token);
    }

    /**
     * @notice recover any bnb on this contract
     * @dev
     *
     * @param locker: address of locker
     */
    function recoverBNBFromLocker(address locker) external onlyOwner {
        require(isLocker[locker], "Not a valid locker");

        Locker(locker).recoverBNB();

        recoverBNB();
    }

    /**
     * @notice recover any token on this contract
     * @dev
     *
     * @param token: address of token to recover
     */
    function recoverToken(IERC20 token) public onlyOwner {
        uint256 bal = token.balanceOf(address(this));
        token.transfer(msg.sender, bal);
    }

    /**
     * @notice recover any bnb on this contract
     * @dev
     */
    function recoverBNB() public onlyOwner {
        uint256 bal = address(this).balance;
        msg.sender.call{ value: bal }("");
    }
}
