// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

interface ILockerFactory {
    function getFeeInfo()
        external
        view
        returns (
            address,
            uint256,
            uint256
        );
}
