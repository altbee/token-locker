import { Contract, ContractFactory } from "ethers";
// We require the Hardhat Runtime Environment explicitly here. This is optional
// but useful for running the script in a standalone fashion through `node <script>`.
// When running the script with `hardhat run <script>` you'll find the Hardhat
// Runtime Environment's members available in the global scope.
import hre, { ethers } from "hardhat";

async function main(): Promise<void> {
  // Hardhat always runs the compile task when running scripts through it.
  // If this runs in a standalone fashion you may want to call compile manually
  // to make sure everything is compiled
  // await run("compile");

  // We get the contract to deploy

  // construction params

  const Multicall2: ContractFactory = await ethers.getContractFactory("Multicall2");
  const multicall2: Contract = await Multicall2.deploy();
  await multicall2.deployed();

  console.log("Multicall2 deployed to:", multicall2.address);

  await hre.run("verify:verify", {
    address: multicall2.address,
    contract: "contracts/utils/Multicall2.sol:Multicall2",
    constructorArguments: [],
  });
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main()
  .then(() => process.exit(0))
  .catch((error: Error) => {
    console.error(error);
    process.exit(1);
  });
