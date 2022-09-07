import { waitSeconds } from "./utils/index";
import { Contract, ContractFactory } from "ethers";
// We require the Hardhat Runtime Environment explicitly here. This is optional
// but useful for running the script in a standalone fashion through `node <script>`.
// When running the script with `hardhat run <script>` you'll find the Hardhat
// Runtime Environment's members available in the global scope.
import hre, { ethers, network } from "hardhat";
import config from "./config";

async function main(): Promise<void> {
  // Hardhat always runs the compile task when running scripts through it.
  // If this runs in a standalone fashion you may want to call compile manually
  // to make sure everything is compiled
  // await run("compile");

  // We get the contract to deploy

  // construction params
  const networkParams = (config as any)[network.name];
  const params = [networkParams.feeRecipient, networkParams.createFee, networkParams.emergencyUnlockFee];

  const LockerFactory: ContractFactory = await ethers.getContractFactory("LockerFactory");
  const lockerFactory: Contract = await LockerFactory.deploy(...params);
  await lockerFactory.deployed();

  console.log("LockerFactory deployed to:", lockerFactory.address);

  await waitSeconds(20);

  await hre.run("verify:verify", {
    address: lockerFactory.address,
    constructorArguments: params,
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
