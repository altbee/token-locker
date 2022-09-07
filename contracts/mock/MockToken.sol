// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockToken is ERC20 {
    uint8 public dec;

    constructor(
        string memory _name,
        string memory _symbol,
        uint8 _decimals
    ) ERC20(_name, _symbol) {
        _mint(msg.sender, 10000000 ether);

        dec = _decimals;
    }

    function mint(uint256 amount) external {
        _mint(msg.sender, amount);
    }

    function decimals() public view override returns (uint8) {
        return dec;
    }
}
